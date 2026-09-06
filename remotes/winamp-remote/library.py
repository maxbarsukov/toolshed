import os
import threading
import time

import tags

BATCH = 200


class Index:
    def __init__(self, plugin):
        self.plugin = plugin
        self.titles = []
        self.total = 0
        self.ready = False
        self.building = False
        self.lock = threading.Lock()

    def status(self):
        return {
            "ready": self.ready,
            "building": self.building,
            "loaded": len(self.titles),
            "total": self.total,
        }

    def start(self):
        with self.lock:
            if self.building:
                return
            self.building = True
        threading.Thread(target=self._build, daemon=True).start()

    def _build(self):
        try:
            total = self.plugin.number("getlistlength") or 0
            self.total = total

            bulk = self.plugin.bulk_titles()
            if len(bulk) > 1:
                self.titles = bulk
                self.total = max(total, len(bulk))
                self.ready = True
                return

            collected = []
            for start in range(0, total, BATCH):
                collected.extend(self.plugin.titles(start, min(start + BATCH, total)))
                self.titles = collected
            self.ready = True
        finally:
            self.building = False

    def invalidate(self, total):
        if total != self.total:
            self.titles = []
            self.total = total
            self.ready = False

    def window(self, offset, limit):
        if self.ready:
            return self.titles[offset:offset + limit]
        return self.plugin.titles(offset, offset + limit)

    def search(self, needle, limit):
        needle = needle.strip().lower()
        if not needle or not self.titles:
            return []

        words = needle.split()
        hits = []
        for index, name in enumerate(self.titles):
            low = name.lower()
            if all(word in low for word in words):
                hits.append({"index": index, "title": name})
                if len(hits) >= limit:
                    break
        return hits


class Browser:
    def __init__(self, roots):
        self.roots = [os.path.abspath(root) for root in roots if root]

    def allowed(self, path):
        if not self.roots:
            return True
        target = os.path.abspath(path)
        return any(
            target == root or target.startswith(root + os.sep)
            for root in self.roots
        )

    def listing(self, path):
        if not path:
            if len(self.roots) == 1:
                path = self.roots[0]
            else:
                return {
                    "path": "",
                    "parent": None,
                    "folders": [{"name": root, "path": root} for root in self.roots],
                    "files": [],
                }

        if not self.allowed(path) or not os.path.isdir(path):
            return {"path": path, "parent": None, "folders": [], "files": [], "error": True}

        folders = []
        files = []

        try:
            for entry in sorted(os.scandir(path), key=lambda item: item.name.lower()):
                if entry.name.startswith("."):
                    continue
                if entry.is_dir():
                    folders.append({"name": entry.name, "path": entry.path})
                elif tags.is_audio(entry.name):
                    files.append({"name": entry.name, "path": entry.path})
        except OSError:
            return {"path": path, "parent": None, "folders": [], "files": [], "error": True}

        parent = os.path.dirname(path.rstrip(os.sep))
        if not self.allowed(parent) or parent == path:
            parent = None

        return {"path": path, "parent": parent, "folders": folders, "files": files}


class SleepTimer:
    def __init__(self, plugin):
        self.plugin = plugin
        self.deadline = 0
        self.timer = None

    def status(self):
        left = int(self.deadline - time.time()) if self.deadline else 0
        return {"active": left > 0, "left": max(left, 0)}

    def arm(self, minutes):
        self.cancel()
        if minutes <= 0:
            return self.status()
        self.deadline = time.time() + minutes * 60
        self.timer = threading.Timer(minutes * 60, self._fire)
        self.timer.daemon = True
        self.timer.start()
        return self.status()

    def cancel(self):
        if self.timer:
            self.timer.cancel()
        self.timer = None
        self.deadline = 0
        return self.status()

    def _fire(self):
        self.deadline = 0
        self.timer = None

        start = self.plugin.number("getvolume")
        if start is None:
            start = 255

        steps = 20
        for step in range(steps, -1, -1):
            self.plugin.text("setvolume", [("level", str(int(start * step / steps)))])
            time.sleep(0.4)

        self.plugin.text("stop")
        self.plugin.text("setvolume", [("level", str(start))])
