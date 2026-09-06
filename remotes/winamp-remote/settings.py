import configparser
import os

FILENAME = "config.ini"

TEMPLATE = """; Winamp Remote settings.
; Restart the server after changing anything here.

[httpq]
; The password you set in the httpQ plugin inside Winamp.
password = 1234
; Where the plugin listens. Change only if Winamp runs on another machine.
host = 127.0.0.1
port = 4800

[server]
; The port this remote is served on.
port = 8000
; How many playlist titles to ask the plugin for at once.
; Do not go above 10: httpQ is single threaded and starts dropping connections.
workers = 6

[library]
; Folders reachable from the Media library window, one per line, indented.
; An empty list exposes the whole disk, which you do not want.
roots =
    C:\\Music

[tags]
; The encoding the plugin answers in. Windows in Russian locale uses cp1251.
; Try utf-8 if titles arrive as garbage.
encoding = cp1251
"""

DEFAULTS = {
    "httpq": {"password": "1234", "host": "127.0.0.1", "port": "4800"},
    "server": {"port": "8000", "workers": "6"},
    "library": {"roots": ""},
    "tags": {"encoding": "cp1251"},
}


class Settings:
    def __init__(self, path, parser, fresh):
        self.path = path
        self.fresh = fresh

        self.httpq_password = self._text(parser, "httpq", "password")
        self.httpq_host = self._text(parser, "httpq", "host")
        self.httpq_port = self._number(parser, "httpq", "port")

        self.listen_port = self._number(parser, "server", "port")
        self.workers = max(1, min(self._number(parser, "server", "workers"), 16))

        self.encoding = self._text(parser, "tags", "encoding")
        self.roots = self._lines(parser, "library", "roots")

    def _text(self, parser, block, key):
        raw = parser.get(block, key, fallback=DEFAULTS[block][key])
        return raw.strip()

    def _number(self, parser, block, key):
        try:
            return int(self._text(parser, block, key))
        except ValueError:
            return int(DEFAULTS[block][key])

    def _lines(self, parser, block, key):
        raw = parser.get(block, key, fallback="")
        found = []
        for piece in raw.replace("\r", "").split("\n"):
            piece = piece.strip()
            if piece and not piece.startswith((";", "#")):
                found.append(piece)
        return found


def load(base_dir):
    path = os.path.join(base_dir, FILENAME)
    fresh = False

    if not os.path.isfile(path):
        try:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(TEMPLATE)
            fresh = True
        except OSError:
            pass

    parser = configparser.ConfigParser(interpolation=None)
    for block, values in DEFAULTS.items():
        parser[block] = dict(values)

    try:
        parser.read(path, encoding="utf-8")
    except (configparser.Error, OSError):
        pass

    return Settings(path, parser, fresh)
