import http.server
import json
import mimetypes
import os
import re
import socket
import socketserver
import sys
import urllib.parse

import httpq
import library
import settings as config
import tags

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")

SETTINGS = config.load(BASE_DIR)

HTTPQ_HOST = SETTINGS.httpq_host
HTTPQ_PORT = SETTINGS.httpq_port
HTTPQ_PASS = SETTINGS.httpq_password

LISTEN_PORT = SETTINGS.listen_port
TAG_ENCODING = SETTINGS.encoding
WORKERS = SETTINGS.workers

MUSIC_ROOTS = SETTINGS.roots

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/x-icon", ".ico")

TAG_FIELDS = ["songname", "artist", "album", "year", "genre", "comment", "rating"]

ALLOWED = {
    "play", "pause", "stop", "next", "prev", "fadeoutandstop",
    "setvolume", "getvolume", "volumeup", "volumedown",
    "shuffle", "repeat", "shuffle_status", "repeat_status",
    "getcurrenttitle", "isplaying", "getversion",
    "getoutputtime", "jumptotime",
    "getlistlength", "getlistpos", "setplaylistpos",
    "getplaylisttitle", "getplaylistfile",
}

RANGE = re.compile(r"bytes=(\d*)-(\d*)")

plugin = httpq.Plugin(HTTPQ_HOST, HTTPQ_PORT, HTTPQ_PASS, TAG_ENCODING, WORKERS)
index = library.Index(plugin)
browser = library.Browser(MUSIC_ROOTS)
sleeper = library.SleepTimer(plugin)


def file_for(raw_index):
    position = raw_index if raw_index is not None else plugin.number("getlistpos")
    return tags.resolve(plugin.file_at(position)), position


def track_tags(raw_index):
    found = dict.fromkeys(TAG_FIELDS, "")
    found.update(plugin.plugin_tags(TAG_FIELDS))
    found.update(plugin.stream_info())

    path, _ = file_for(raw_index)
    if path:
        seconds = plugin.number("getoutputtime", [("frmt", "1")]) or 0
        for key, value in tags.read(path, seconds, TAG_ENCODING).items():
            if value and not found.get(key):
                found[key] = value

    for slot in ("samplerate", "bitrate", "channels"):
        found[slot] = found.get(slot) or 0

    try:
        found["rating"] = int(found.get("rating") or 0)
    except ValueError:
        found["rating"] = 0

    found.pop("lyrics", None)
    return found


def playlist_page(offset, limit):
    state = plugin.state()
    total = state["total"]
    index.invalidate(total)

    offset = max(offset, 0)
    limit = max(1, min(limit, 400))
    titles = index.window(offset, min(limit, max(total - offset, 0)))

    return {
        "tracks": titles,
        "offset": offset,
        "total": total,
        "pos": -1 if state["index"] is None else state["index"],
        "index": index.status(),
    }


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "WinampRemote/2.0"
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        try:
            if route in ("/", "/index.html"):
                self.serve_page()
            elif route == "/probe":
                self.send_html(probe_report())
            elif route.startswith("/api/"):
                self.serve_api(route[5:], query)
            else:
                self.serve_static(route.lstrip("/"))
        except (BrokenPipeError, ConnectionResetError):
            pass

    def serve_api(self, name, query):
        def one(key, fallback=None):
            values = query.get(key)
            return values[0] if values else fallback

        def whole(key):
            value = one(key)
            try:
                return int(value)
            except (TypeError, ValueError):
                return None

        if name == "state":
            return self.send_json(self.state_payload())

        if name == "tags":
            return self.send_json(track_tags(whole("index")))

        if name == "cover":
            return self.serve_cover(whole("index"))

        if name == "stream":
            return self.serve_stream(whole("index"), one("path"))

        if name == "playlist":
            return self.send_json(playlist_page(whole("offset") or 0, whole("limit") or 100))

        if name == "search":
            if not index.ready and not index.building:
                index.start()
            return self.send_json({
                "hits": index.search(one("q", ""), whole("limit") or 60),
                "index": index.status(),
            })

        if name == "reindex":
            index.titles = []
            index.ready = False
            index.start()
            return self.send_json(index.status())

        if name == "browse":
            return self.send_json(browser.listing(one("path", "")))

        if name == "enqueue":
            path = one("path", "")
            if not path or not browser.allowed(path):
                return self.send_error(403, "Path not allowed")
            spot = plugin.enqueue(path, one("play") == "1")
            index.ready = False
            return self.send_json(spot)

        if name == "sleep":
            action = one("action", "status")
            if action == "arm":
                return self.send_json(sleeper.arm(whole("minutes") or 0))
            if action == "cancel":
                return self.send_json(sleeper.cancel())
            return self.send_json(sleeper.status())

        if name in ALLOWED:
            params = [(key, values[0]) for key, values in query.items() if key != "p"]
            return self.send_text(plugin.loud(name, params))

        self.send_error(403, "Command not allowed")

    def state_payload(self):
        state = plugin.state()
        position = state.pop("index")
        state["pos"] = -1 if position is None else position
        state["sleep"] = sleeper.status()
        state["indexing"] = index.status()
        return state

    def serve_cover(self, raw_index):
        path, _ = file_for(raw_index)
        art = tags.cover(path)

        if not art:
            return self.send_error(404, "No cover")

        mime, data = art
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def serve_stream(self, raw_index, direct):
        path = direct if direct else file_for(raw_index)[0]

        if not tags.usable(path) or not browser.allowed(path):
            return self.send_error(404, "No file")

        try:
            if not os.path.isfile(path):
                raise OSError
            size = os.path.getsize(path)
        except (OSError, ValueError):
            return self.send_error(404, "No file")

        start, end = 0, size - 1
        partial = False

        header = self.headers.get("Range", "")
        match = RANGE.match(header)
        if match:
            first, last = match.group(1), match.group(2)
            if first:
                start = min(int(first), size - 1)
            if last:
                end = min(int(last), size - 1)
            if not first and last:
                start = max(size - int(last), 0)
                end = size - 1
            partial = True

        length = max(end - start + 1, 0)

        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", tags.audio_mime(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", "bytes {0}-{1}/{2}".format(start, end, size))
        self.end_headers()

        with open(path, "rb") as handle:
            handle.seek(start)
            left = length
            while left > 0:
                block = handle.read(min(65536, left))
                if not block:
                    break
                self.wfile.write(block)
                left -= len(block)

    def serve_page(self):
        target = os.path.join(WEB_DIR, "index.html")
        try:
            with open(target, "rb") as handle:
                markup = handle.read().decode("utf-8")
        except OSError:
            return self.send_error(404, "Missing web/index.html")

        for name, attr in (("style.css", "href"), ("app.js", "src")):
            try:
                stamp = int(os.path.getmtime(os.path.join(WEB_DIR, name)))
            except OSError:
                continue
            markup = markup.replace(
                '{0}="{1}"'.format(attr, name),
                '{0}="{1}?v={2}"'.format(attr, name, stamp))

        self.send_blob(markup.encode("utf-8"), "text/html; charset=utf-8")

    def serve_static(self, name):
        safe = os.path.normpath(name).replace("\\", "/").lstrip("/")
        if not safe or safe.startswith(".."):
            return self.send_error(404, "Not found")

        target = os.path.join(WEB_DIR, safe)
        if not os.path.abspath(target).startswith(WEB_DIR + os.sep):
            return self.send_error(404, "Not found")

        try:
            with open(target, "rb") as handle:
                body = handle.read()
        except OSError:
            return self.send_error(404, "Missing web/{0}".format(safe))

        mime = mimetypes.guess_type(safe)[0] or "application/octet-stream"
        if mime.startswith("text/") or mime.endswith(("json", "javascript", "manifest")):
            mime += "; charset=utf-8"

        cache = "no-store" if safe.endswith((".html", ".css", ".js")) else "max-age=86400"

        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload):
        self.send_blob(json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

    def send_text(self, value):
        self.send_blob(value.encode("utf-8"), "text/plain; charset=utf-8")

    def send_html(self, markup):
        self.send_blob(markup.encode("utf-8"), "text/html; charset=utf-8")

    def send_blob(self, body, mime):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


def escape(value):
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def probe_report():
    position = plugin.number("getlistpos") or 0
    here = str(position)

    checks = [
        ("getcurrenttitle", []),
        ("getlistpos", []),
        ("getlistlength", []),
        ("getid3tag", []),
        ("getid3tag_artist", []),
        ("getinfo", [("frmt", "1")]),
        ("getplaylisttitle", []),
        ("getplaylisttitle", [("index", here)]),
        ("getplaylistfile", [("index", here)]),
        ("getoutputtime", [("frmt", "1")]),
        ("shuffle_status", []),
        ("getvolume", []),
    ]

    rows = []
    for command, params in checks:
        query = "&".join("{0}={1}".format(k, v) for k, v in params)
        label = command + ("?" + query if query else "")
        answer = plugin.loud(command, params)
        verdict = "empty" if answer == "" else ("refused" if answer == "0" else "ok")
        rows.append("<tr><td>{0}</td><td class=v>{1}</td><td>{2}</td></tr>".format(
            escape(label), verdict, escape(answer) or "&nbsp;"))

    raw_path = plugin.file_at(position)
    path = tags.resolve(raw_path)
    frames = tags.frame_list(path) if path else []
    found = tags.read(path, 0, TAG_ENCODING) if path else {}

    shape, offset, magic = "?", 0, ""
    if path and os.path.isfile(path):
        try:
            with open(path, "rb") as handle:
                shape, offset = tags.sniff_format(handle)
                handle.seek(offset)
                magic = handle.read(4).decode("latin-1", errors="replace")
        except Exception as problem:
            shape = "! {0}".format(problem)

    rows.append("<tr><td>path from plugin</td><td class=v>{0}</td><td>{1}</td></tr>".format(
        "mangled" if "?" in raw_path else "clean", escape(raw_path)))
    rows.append("<tr><td>path resolved</td><td class=v>{0}</td><td>{1}</td></tr>".format(
        "ok" if path and os.path.isfile(path) else "missing", escape(path)))
    rows.append("<tr><td>container</td><td class=v>{0}</td><td>magic {1} at offset {2}</td></tr>".format(
        escape(shape), escape(repr(magic)), offset))
    rows.append("<tr><td>tags parsed</td><td class=v>{0}</td><td>{1}</td></tr>".format(
        len([k for k, v in found.items() if v]),
        escape(", ".join("{0}={1}".format(k, v) for k, v in found.items() if v)) or "&nbsp;"))
    rows.append("<tr><td>id3 frames</td><td class=v>{0}</td><td>{1}</td></tr>".format(
        len(frames), escape(", ".join("{0}({1})".format(n, s) for n, s in frames)) or "&nbsp;"))
    rows.append("<tr><td>rating frame</td><td class=v>{0}</td><td>{1}</td></tr>".format(
        "ok" if found.get("rating") else "absent",
        escape(str(found.get("rating", ""))) or "POPM not written by your Winamp"))
    rows.append("<tr><td>cover</td><td class=v>{0}</td><td>&nbsp;</td></tr>".format(
        "ok" if path and tags.cover(path) else "absent"))

    return (
        "<!DOCTYPE html><html><head><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>httpQ probe</title><style>"
        "body{background:#12171c;color:#dbe9f2;font:13px ui-monospace,monospace;padding:16px}"
        "table{border-collapse:collapse;width:100%}"
        "td{border-bottom:1px solid #2c343c;padding:6px 8px;vertical-align:top;word-break:break-word}"
        "td.v{color:#7fa0b4;width:6em}h1{font-size:15px;margin:0 0 12px}"
        "</style></head><body><h1>httpQ probe &mdash; play a track first</h1><table>"
        + "".join(rows) + "</table></body></html>"
    )


QUIET = (
    ConnectionResetError,
    ConnectionAbortedError,
    BrokenPipeError,
    TimeoutError,
)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        if issubclass(sys.exc_info()[0] or Exception, QUIET):
            return
        super().handle_error(request, client_address)


def local_address():
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


def main():
    if SETTINGS.fresh:
        print("Created {0}".format(SETTINGS.path))
        print("Open it, set your httpQ password and music folders, then start again.\n")

    if HTTPQ_PASS == "1234":
        print("The httpQ password in config.ini is still the default one.\n")

    version = plugin.loud("getversion")
    if version.startswith("!") or version == "0":
        print("Winamp is not answering on {0}:{1}.".format(HTTPQ_HOST, HTTPQ_PORT))
        print("Start Winamp and enable the httpQ plugin.")
    else:
        print("Winamp answered: {0}".format(version))

    print("Settings:      {0}".format(SETTINGS.path))
    print("Library roots: {0}".format(", ".join(MUSIC_ROOTS) or "whole disk"))

    address = local_address()
    print("\nOn this computer:  http://localhost:{0}".format(LISTEN_PORT))
    print("In your network:   http://{0}:{1}".format(address, LISTEN_PORT))
    print("Diagnostics:       http://localhost:{0}/probe".format(LISTEN_PORT))
    print("\nStop with Ctrl+C.")

    index.start()

    try:
        Server(("0.0.0.0", LISTEN_PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    except OSError as problem:
        print("\nCould not start on port {0}: {1}".format(LISTEN_PORT, problem))
        sys.exit(1)


if __name__ == "__main__":
    main()
