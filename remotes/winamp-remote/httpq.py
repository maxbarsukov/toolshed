import concurrent.futures
import re
import time
import urllib.parse
import urllib.request

SPLIT = re.compile(r"<br\s*/?>", re.IGNORECASE)


class Plugin:
    def __init__(self, host, port, password, encoding="cp1251", workers=6, timeout=4):
        self.host = host
        self.port = port
        self.password = password
        self.encoding = encoding
        self.workers = workers
        self.timeout = timeout
        self.can = {"id3": None, "info": None, "bulk_list": None}

    def url(self, command, params=()):
        query = list(params)
        query.append(("p", self.password))

        pieces = []
        for key, value in query:
            raw = str(value).encode(self.encoding, errors="replace")
            pieces.append("{0}={1}".format(key, urllib.parse.quote(raw, safe=",")))

        return "http://{0}:{1}/{2}?{3}".format(self.host, self.port, command, "&".join(pieces))

    def raw(self, command, params=()):
        with urllib.request.urlopen(self.url(command, params), timeout=self.timeout) as answer:
            return answer.read()

    def text(self, command, params=()):
        try:
            raw = self.raw(command, params)
        except Exception:
            return ""
        value = raw.decode(self.encoding, errors="replace").replace("\x00", "").strip()
        return "" if value == "0" else value

    def loud(self, command, params=()):
        try:
            raw = self.raw(command, params)
        except Exception as problem:
            return "! {0}".format(problem)
        return raw.decode(self.encoding, errors="replace").replace("\x00", "").strip()

    def number(self, command, params=()):
        try:
            raw = self.raw(command, params)
        except Exception:
            return None
        try:
            return int(raw.decode("ascii", errors="replace").strip())
        except ValueError:
            return None

    def state(self):
        mode = self.number("isplaying")
        spot = self.number("getlistpos")
        return {
            "mode": 0 if mode is None else mode,
            "title": self.text("getcurrenttitle"),
            "position": self.number("getoutputtime", [("frmt", "0")]) or 0,
            "duration": self.number("getoutputtime", [("frmt", "1")]) or 0,
            "index": spot,
            "total": self.number("getlistlength") or 0,
            "volume": self.number("getvolume"),
            "file": self.file_at(spot),
        }

    def stream_info(self):
        if self.can["info"] is False:
            return {}

        found = {}
        for name, slot in (("0", "samplerate"), ("1", "bitrate"), ("2", "channels")):
            value = self.number("getinfo", [("frmt", name)])
            if not value and self.can["info"] is None:
                value = self.number("getinfo", [("a", name)])
            found[slot] = value or 0

        if self.can["info"] is None:
            self.can["info"] = any(found.values())

        return found if any(found.values()) else {}

    def plugin_tags(self, fields):
        if self.can["id3"] is False:
            return {}

        found = {}
        bulk = self.text("getid3tag")
        parts = [piece.strip() for piece in SPLIT.split(bulk)] if bulk else []

        if len(parts) >= 5:
            for index, name in enumerate(fields):
                if index < len(parts) and parts[index] != "0":
                    found[name] = parts[index]
        else:
            for name in fields:
                value = self.text("getid3tag_" + name)
                if value:
                    found[name] = value

        if self.can["id3"] is None:
            self.can["id3"] = any(found.values())

        return found

    def file_at(self, index):
        if index is None or index < 0:
            return ""
        return self.text("getplaylistfile", [("index", str(index))])

    def title_at(self, index):
        name = self.text("getplaylisttitle", [("index", str(index))])
        if not name:
            name = self.text("getplaylisttitle", [("a", str(index))])
        return name or "track {0}".format(index + 1)

    def bulk_titles(self):
        if self.can["bulk_list"] is False:
            return []

        parts = [piece.strip() for piece in SPLIT.split(self.text("getplaylisttitle"))]
        while parts and not parts[-1]:
            parts.pop()

        if self.can["bulk_list"] is None:
            self.can["bulk_list"] = len(parts) > 1

        return parts if len(parts) > 1 else []

    def titles(self, offset, stop):
        span = range(max(offset, 0), max(stop, 0))
        if not span:
            return []
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=self.workers) as pool:
                return list(pool.map(self.title_at, span))
        except Exception:
            return [self.title_at(index) for index in span]

    def enqueue(self, path, play_now):
        origin = self.number("getlistpos")
        before = self.number("getlistlength") or 0
        self.text("playfile", [("file", path)])

        spot = before
        for _ in range(20):
            time.sleep(0.1)
            grown = self.number("getlistlength")
            if grown is not None and grown > before:
                spot = grown - 1
                break

        if play_now:
            self.text("setplaylistpos", [("index", str(spot))])
            self.text("play")

        return {"index": spot, "origin": -1 if origin is None else origin}
