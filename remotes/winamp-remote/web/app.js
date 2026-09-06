(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var timeBox = $("time"), titleBox = $("title"), lamp = $("lamp"), flags = $("flags");
  var posbar = $("posbar"), marquee = titleBox.parentNode;
  var vol = $("vol"), volout = $("volout");
  var queuePanel = $("queue-panel"), queue = $("queue"), search = $("search");
  var browsePanel = $("browse-panel"), browse = $("browse");
  var sleepPanel = $("sleep-panel");
  var player = $("player");

  var CHUNK = 100;

  var mode = "pc";
  var duration = 0, playing = false, anchorPos = 0, anchorAt = 0;
  var seeking = false, noteUntil = 0, volSentAt = 0, volTrail = null;
  var knownTitle = "", listPos = -1, listTotal = 0;
  var queueList = null, queueBusy = false, queueStart = 0, queueEnd = 0;
  var searching = false, searchTimer = null, queueKicked = false;
  var silence = null, flagLine = "connecting";
  var dragging = false, currentPath = "", browseUp = null;
  var holding = false, beat = 0;
  var resume = null, wasMode = -1, fileTitle = "";

  function api(path) {
    return fetch("api/" + path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("offline");
      return r;
    });
  }

  function text(command, params) {
    return api(command + (params ? "?" + params : "")).then(function (r) { return r.text(); });
  }

  function json(path) {
    return api(path).then(function (r) { return r.json(); });
  }

  function send(command, params) {
    return text(command, params).catch(function () {
      setLamp("dead", "offline");
      throw new Error("offline");
    });
  }

  function setLamp(kind, label) {
    lamp.className = "lamp" + (kind ? " " + kind : "");
    if (label !== undefined) setFlags(label);
  }

  function setFlags(text) {
    flagLine = text;
    if (Date.now() >= noteUntil) flags.textContent = text;
  }

  function note(label) {
    noteUntil = Date.now() + 900;
    flags.textContent = label;
  }

  function setTitle(value, bad) {
    if (titleBox.textContent !== value) {
      titleBox.textContent = value;
      titleBox.classList.remove("roll");
      requestAnimationFrame(fitMarquee);
    }
    titleBox.classList.toggle("err", !!bad);
  }

  function fitMarquee() {
    var overflow = titleBox.scrollWidth - marquee.clientWidth;
    if (overflow > 8) {
      titleBox.style.setProperty("--shift", (-overflow - 6) + "px");
      titleBox.classList.add("roll");
    } else {
      titleBox.classList.remove("roll");
    }
  }

  function clock(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    var whole = Math.floor(seconds);
    return Math.floor(whole / 60) + ":" + (whole % 60 < 10 ? "0" : "") + (whole % 60);
  }

  function paintBar(position) {
    timeBox.textContent = clock(position);
    var share = duration > 0 ? Math.min(position / duration, 1) * 100 : 0;
    posbar.style.background =
      "linear-gradient(90deg, #2c5468 0%, #2c5468 " + share + "%, #050a0e " + share + "%, #050a0e 100%)";
  }

  function tick() {
    if (Date.now() >= noteUntil && flags.textContent !== flagLine) {
      flags.textContent = flagLine;
    }

    beat += 1;
    if (beat % 2 === 0) markSession();

    if (seeking) return;

    if (mode === "phone") {
      duration = isFinite(player.duration) ? player.duration : 0;
      posbar.disabled = duration === 0;
      posbar.max = duration || 100;
      posbar.value = Math.min(player.currentTime, posbar.max);
      paintBar(player.currentTime);
      return;
    }

    if (duration === 0) return;
    var position = Math.min(playing ? anchorPos + (Date.now() - anchorAt) / 1000 : anchorPos, duration);
    posbar.value = position;
    paintBar(position);
  }

  function paintStars(count) {
    var box = $("tag-rating");
    box.textContent = "";
    if (!count) return;

    var lit = document.createElement("span");
    lit.className = "stars";
    lit.textContent = "\u2605".repeat(count);
    var dim = document.createElement("span");
    dim.className = "stars off";
    dim.textContent = "\u2605".repeat(5 - count);
    box.appendChild(lit);
    box.appendChild(dim);
  }

  function loadArt(position) {
    var box = $("art-box"), img = $("art");
    img.onload = function () {
      box.classList.remove("blank");
      describe();
    };
    img.onerror = function () {
      box.classList.add("blank");
      describe();
    };
    img.src = "api/cover?index=" + position + "&n=" + encodeURIComponent(knownTitle);
  }

  var facts = {};

  function describe() {
    if (!("mediaSession" in navigator)) return;
    var art = $("art-box").classList.contains("blank")
      ? []
      : [{ src: $("art").src, sizes: "512x512" }];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: facts.songname || knownTitle || "Winamp",
        artist: facts.artist || "",
        album: facts.album || "",
        artwork: art
      });
      markSession();
    } catch (e) {}
  }

  function loadDetails(position) {
    json("tags?index=" + position).then(function (tags) {
      facts = tags;
      $("tag-title").textContent = tags.songname || "";
      $("tag-artist").textContent = tags.artist || "";
      $("tag-album").textContent = tags.album || "";
      $("tag-year").textContent = tags.year || "";
      $("tag-genre").textContent = tags.genre || "";
      paintStars(tags.rating || 0);

      fileTitle = tags.artist && tags.songname
        ? tags.artist + " \u2013 " + tags.songname
        : (tags.songname || "");
      if (fileTitle && mode === "pc") setTitle(fileTitle);

      var bits = [];
      if (duration > 0) bits.push(clock(duration));
      if (tags.bitrate > 0) bits.push(tags.bitrate + " kbps");
      if (tags.samplerate > 0) {
        bits.push((tags.samplerate > 1000 ? Math.round(tags.samplerate / 1000) : tags.samplerate) + " khz");
      }
      if (tags.channels === 1) bits.push("mono");
      else if (tags.channels >= 2) bits.push("stereo");

      setFlags(bits.join("  \u00b7  "));
      loadArt(position);
    }).catch(function () {});
  }

  function paintSleep(info) {
    var badge = $("sleep-left");
    if (!badge) return;
    if (!info || !info.active) {
      badge.textContent = "";
      Array.prototype.forEach.call(sleepPanel.querySelectorAll("button"), function (b) {
        b.setAttribute("aria-pressed", "false");
      });
      return;
    }
    badge.textContent = Math.ceil(info.left / 60) + " min left";
  }

  function refresh() {
    return json("state").then(function (state) {
      listTotal = state.total;
      playing = state.mode === 1;
      paintSleep(state.sleep);

      if (mode === "pc") {
        setLamp(playing ? "on" : state.mode === 3 ? "hold" : "");
        duration = state.duration > 0 ? state.duration : 0;
        anchorPos = state.position > 0 ? state.position / 1000 : 0;
        anchorAt = Date.now();

        if (!seeking) {
          posbar.disabled = duration === 0;
          posbar.max = duration || 100;
          posbar.value = Math.min(anchorPos, posbar.max);
          paintBar(anchorPos);
        }
        setTitle(fileTitle || state.title || "Winamp");
      }

      if (!queueKicked) {
        queueKicked = true;
        if (queuePanel.open) openAt(Math.max(state.pos, 0));
      }

      if (mode === "pc" && typeof state.volume === "number" &&
          !dragging && Date.now() - volSentAt > 1500) {
        var loud = Math.round(state.volume * 100 / 255);
        if (Math.abs(loud - Number(vol.value)) > 1) {
          vol.value = loud;
          showVol();
        }
      }

      if (state.file !== currentPath) {
        currentPath = state.file || "";
        markBrowse();
      }

      if (resume && state.pos >= 0 && state.pos !== resume.added) resume = null;

      if (mode === "pc" && resume && state.mode === 0 && wasMode === 1 &&
          state.pos === resume.added) {
        afterGuest();
      }
      wasMode = state.mode;

      if (state.pos >= 0 && state.pos !== listPos) {
        listPos = state.pos;
        if (queueEnd > queueStart && queuePanel.open && !searching &&
            (listPos < queueStart || listPos >= queueEnd)) {
          openAt(listPos);
        } else {
          markCurrent(false);
        }
      }

      if (mode === "pc" && state.title !== knownTitle) {
        knownTitle = state.title;
        fileTitle = "";
        loadDetails(state.pos);
      }

      markSession();
    }).catch(function () {
      setLamp("dead", "offline");
      if (mode === "pc") {
        setTitle("player offline", true);
        playing = false;
        duration = 0;
        posbar.disabled = true;
        paintBar(0);
      }
    });
  }

  function silentLoop() {
    if (silence) return silence;

    var rate = 8000, seconds = 30;
    var frames = rate * seconds;
    var buffer = new ArrayBuffer(44 + frames);
    var view = new DataView(buffer);

    function ascii(at, value) {
      for (var i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
    }

    ascii(0, "RIFF");
    view.setUint32(4, 36 + frames, true);
    ascii(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    ascii(36, "data");
    view.setUint32(40, frames, true);
    for (var i = 0; i < frames; i++) view.setUint8(44 + i, 128);

    silence = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    return silence;
  }

  function holdSession() {
    if (mode !== "pc" || !player.paused) return;
    holding = true;
    player.loop = true;
    player.volume = 1;
    player.src = silentLoop();
    player.play().catch(function () {});
  }

  function keepAlive() {
    if (!holding || mode !== "pc") return;
    if (player.paused) player.play().catch(function () {});
  }

  function markSession() {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.playbackState = playing ? "playing" : "paused";

    if (duration > 0) {
      var spot = mode === "phone" ? player.currentTime
        : Math.min(playing ? anchorPos + (Date.now() - anchorAt) / 1000 : anchorPos, duration);
      try {
        navigator.mediaSession.setPositionState({
          duration: duration,
          position: Math.max(0, Math.min(spot, duration)),
          playbackRate: 1
        });
      } catch (e) {}
    }
  }

  var actions = {
    play: function () {
      if (mode === "phone") {
        if (player.src && !player.loop) player.play().catch(function () {});
        return Promise.resolve();
      }
      return send("play");
    },
    pause: function () {
      if (mode === "phone") { player.pause(); return Promise.resolve(); }
      return send("pause");
    },
    stop: function () {
      if (mode === "phone") { player.pause(); player.currentTime = 0; return Promise.resolve(); }
      return send("stop");
    },
    prev: function () {
      if (mode === "phone") return playIndex(Math.max(listPos - 1, 0));
      return send("prev");
    },
    next: function () {
      if (mode === "phone") return playIndex(Math.min(listPos + 1, listTotal - 1));
      if (afterGuest()) return Promise.resolve();
      return send("next");
    }
  };

  var names = { prev: "previous", play: "play", pause: "pause", stop: "stop", next: "next" };

  Array.prototype.forEach.call(document.querySelectorAll(".pads button"), function (b) {
    b.addEventListener("click", function () {
      var cmd = b.dataset.cmd;
      note(names[cmd]);
      holdSession();
      actions[cmd]().then(function () {
        if (mode === "pc") setTimeout(refresh, 350);
      }).catch(function () {});
    });
  });

  function goTo(position) {
    if (position < 0 || (listTotal && position >= listTotal)) return Promise.resolve();
    return send("setplaylistpos", "index=" + position)
      .then(function () { return send("play"); })
      .then(function () { setTimeout(refresh, 350); })
      .catch(function () {});
  }

  function afterGuest() {
    if (!resume || listPos !== resume.added) return false;
    var back = resume.origin + 1;
    resume = null;
    if (back <= 0 || back >= listTotal) return false;
    note("back to playlist");
    goTo(back);
    return true;
  }

  function playIndex(position) {
    if (position < 0) return Promise.resolve();
    listPos = position;
    markCurrent(false);
    loadDetails(position);

    player.loop = false;
    player.src = "api/stream?index=" + position;
    knownTitle = "";
    fileTitle = "";
    setTitle("track " + (position + 1));
    return player.play().catch(function () {});
  }

  posbar.addEventListener("pointerdown", function () { seeking = true; });
  posbar.addEventListener("input", function () { paintBar(Number(posbar.value)); });

  posbar.addEventListener("change", function () {
    var position = Number(posbar.value);
    seeking = false;

    if (mode === "phone") {
      if (isFinite(player.duration)) player.currentTime = position;
      return;
    }

    anchorPos = position;
    anchorAt = Date.now();
    send("jumptotime", "ms=" + Math.round(position * 1000))
      .then(function () { setTimeout(refresh, 350); })
      .catch(function () {});
  });

  function showVol() {
    volout.textContent = vol.value + "%";
  }

  function asLevel(percent) {
    return Math.round(Number(percent) * 255 / 100);
  }

  function pushVolume() {
    volSentAt = Date.now();
    note("volume " + volout.textContent);
    if (mode === "phone") {
      player.volume = Number(vol.value) / 100;
      return;
    }
    send("setvolume", "level=" + asLevel(vol.value)).catch(function () {});
  }

  vol.addEventListener("pointerdown", function () { dragging = true; });
  window.addEventListener("pointerup", function () { dragging = false; });

  vol.addEventListener("input", function () {
    showVol();
    var gap = Date.now() - volSentAt;
    clearTimeout(volTrail);
    if (gap >= 150) pushVolume();
    else volTrail = setTimeout(pushVolume, 150 - gap);
  });

  function toggle(id, command, status, label) {
    var b = $(id);
    b.addEventListener("click", function () {
      var on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      note(label + (on ? " on" : " off"));
      send(command, "enable=" + (on ? 1 : 0)).catch(function () {});
    });
    text(status).then(function (value) {
      b.setAttribute("aria-pressed", value.trim() === "1" ? "true" : "false");
    }).catch(function () {});
  }

  function trackRow(name, position) {
    var li = document.createElement("li");
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = name;
    b.dataset.num = String(position + 1);
    li.dataset.index = String(position);
    b.addEventListener("click", function () {
      note("track " + (position + 1));
      holdSession();
      if (mode === "phone") return playIndex(position);
      send("setplaylistpos", "index=" + position)
        .then(function () { return send("play"); })
        .then(function () { setTimeout(refresh, 350); })
        .catch(function () {});
    });
    li.appendChild(b);
    return li;
  }

  function markCurrent(recenter) {
    Array.prototype.forEach.call(queue.querySelectorAll("li"), function (li) {
      li.classList.toggle("now", Number(li.dataset.index) === listPos);
    });

    if (!recenter || !queuePanel.open) return;

    var active = queue.querySelector("li.now");
    if (!active) return;

    var wanted = active.offsetTop - (queue.clientHeight - active.offsetHeight) / 2;
    queue.scrollTop = Math.max(0, Math.min(wanted, queue.scrollHeight - queue.clientHeight));
  }

  function paintCount() {
    $("queue-total").textContent = listTotal ? listTotal + " tracks" : "";
    $("queue-count").textContent = listTotal
      ? "showing " + (queueStart + 1) + "\u2013" + queueEnd
      : "";
  }

  function paintIndexing(info) {
    var hint = $("index-hint");
    if (!info) return;
    if (info.building) hint.textContent = "Indexing " + info.loaded + " of " + info.total + " for search";
    else if (info.ready) hint.textContent = "";
    else hint.textContent = "Search index not built yet";
  }

  function fetchChunk(offset, how) {
    if (queueBusy || offset < 0 || searching) return;
    queueBusy = true;
    $("queue-count").textContent = "loading";

    var mark = null;
    if (how === "reset") {
      queue.innerHTML = '<p class="empty">Loading\u2026</p>';
      queueList = null;
    } else if (queueList) {
      mark = document.createElement("li");
      mark.className = "pending";
      mark.textContent = "Loading\u2026";
      if (how === "prepend") queueList.insertBefore(mark, queueList.firstChild);
      else queueList.appendChild(mark);
    }

    json("playlist?offset=" + offset + "&limit=" + CHUNK).then(function (data) {
      var titles = data.tracks || [];
      listTotal = data.total || 0;
      paintIndexing(data.index);
      if (data.pos >= 0) listPos = data.pos;

      if (mark && mark.parentNode) mark.parentNode.removeChild(mark);
      mark = null;

      if (how === "reset") {
        if (!titles.length) {
          queue.innerHTML = '<p class="empty">Playlist is empty.</p>';
          $("queue-count").textContent = "";
          return;
        }
        queue.innerHTML = "";
        queueList = document.createElement("ol");
        queue.appendChild(queueList);
        queueStart = data.offset;
        queueEnd = data.offset;
      }

      if (!queueList) return;

      if (how === "prepend") {
        var before = queue.scrollHeight;
        var anchor = queueList.firstChild;
        titles.forEach(function (name, i) {
          queueList.insertBefore(trackRow(name, data.offset + i), anchor);
        });
        queueStart = data.offset;
        queue.scrollTop += queue.scrollHeight - before;
      } else {
        titles.forEach(function (name, i) {
          queueList.appendChild(trackRow(name, data.offset + i));
        });
        queueEnd = data.offset + titles.length;
      }

      paintCount();
      markCurrent(how === "reset");
    }).catch(function () {
      if (how === "reset") queue.innerHTML = '<p class="empty">Could not read the playlist.</p>';
    }).then(function () {
      if (mark && mark.parentNode) mark.parentNode.removeChild(mark);
      queueBusy = false;
      if (!searching) paintCount();
    });
  }

  function openAt(position) {
    fetchChunk(Math.max(0, Math.floor(Math.max(position, 0) / CHUNK) * CHUNK), "reset");
  }

  function runSearch(needle) {
    searching = true;
    queue.innerHTML = '<p class="empty">Searching\u2026</p>';
    $("queue-total").textContent = "";
    $("queue-count").textContent = "searching";

    json("search?limit=80&q=" + encodeURIComponent(needle)).then(function (data) {
      paintIndexing(data.index);
      var hits = data.hits || [];

      if (!hits.length) {
        queue.innerHTML = '<p class="empty">' +
          (data.index && data.index.building ? "Still indexing, try again in a moment." : "Nothing found.") +
          "</p>";
        return;
      }

      queue.innerHTML = "";
      var list = document.createElement("ol");
      hits.forEach(function (hit) { list.appendChild(trackRow(hit.title, hit.index)); });
      queue.appendChild(list);
      queueList = null;
      $("queue-total").textContent = hits.length + " matches";
      $("queue-count").textContent = "of " + listTotal;
      markCurrent(false);
    }).catch(function () {
      queue.innerHTML = '<p class="empty">Search failed.</p>';
    });
  }

  search.addEventListener("input", function () {
    clearTimeout(searchTimer);
    var needle = search.value.trim();

    if (!needle) {
      searching = false;
      openAt(listPos);
      return;
    }
    searchTimer = setTimeout(function () { runSearch(needle); }, 250);
  });

  $("search-clear").addEventListener("click", function () {
    search.value = "";
    searching = false;
    openAt(listPos);
  });

  queue.addEventListener("scroll", function () {
    if (!queueList || queueBusy || searching) return;
    if (queue.scrollTop < 80 && queueStart > 0) {
      fetchChunk(Math.max(0, queueStart - CHUNK), "prepend");
    } else if (queue.scrollTop + queue.clientHeight >= queue.scrollHeight - 80 && queueEnd < listTotal) {
      fetchChunk(queueEnd, "append");
    }
  });

  queuePanel.addEventListener("toggle", function () {
    if (!queuePanel.open) return;
    if (!queueList && !searching) {
      queueKicked = true;
      openAt(Math.max(listPos, 0));
    } else {
      markCurrent(true);
    }
  });

  function markBrowse() {
    Array.prototype.forEach.call(browse.querySelectorAll("li"), function (li) {
      li.classList.toggle("now", !!currentPath && li.dataset.path === currentPath);
    });
  }

  function folderRow(label, path, kind) {
    var li = document.createElement("li");
    li.dataset.path = path;
    var b = document.createElement("button");
    b.type = "button";
    b.className = kind;
    b.textContent = label;
    b.addEventListener("click", function () {
      if (kind === "file") {
        holdSession();
        if (mode === "phone") {
          player.loop = false;
          player.src = "api/stream?path=" + encodeURIComponent(path);
          setTitle(label);
          player.play().catch(function () {});
          note("playing on client");
          return;
        }
        note("queued");
        json("enqueue?play=1&path=" + encodeURIComponent(path))
          .then(function (data) {
            resume = { added: data.index, origin: data.origin };
            wasMode = 1;
            setTimeout(refresh, 400);
          })
          .catch(function () {});
        return;
      }
      openFolder(path);
    });
    li.appendChild(b);
    return li;
  }

  function openFolder(path) {
    browse.innerHTML = '<p class="empty">Reading\u2026</p>';

    json("browse?path=" + encodeURIComponent(path || "")).then(function (data) {
      if (data.error) {
        browse.innerHTML = '<p class="empty">Cannot open that folder.</p>';
        return;
      }

      browseUp = data.parent || null;
      $("browse-up").disabled = !browseUp;

      var list = document.createElement("ol");
      data.folders.forEach(function (item) {
        list.appendChild(folderRow(item.name, item.path, "folder"));
      });
      data.files.forEach(function (item) {
        list.appendChild(folderRow(item.name, item.path, "file"));
      });

      if (!list.childNodes.length) {
        browse.innerHTML = '<p class="empty">Empty folder.</p>';
        return;
      }

      browse.innerHTML = "";
      browse.appendChild(list);
      browse.scrollTop = 0;
      markBrowse();

      $("browse-where").textContent = data.path || "";
    }).catch(function () {
      browse.innerHTML = '<p class="empty">Could not read the library.</p>';
    });
  }

  $("browse-up").addEventListener("click", function () {
    if (browseUp) openFolder(browseUp);
  });

  browsePanel.addEventListener("toggle", function () {
    if (browsePanel.open && !browse.querySelector("ol")) openFolder("");
  });

  Array.prototype.forEach.call(sleepPanel.querySelectorAll(".timers button"), function (b) {
    b.addEventListener("click", function () {
      var minutes = Number(b.dataset.min);
      var call = minutes > 0 ? "sleep?action=arm&minutes=" + minutes : "sleep?action=cancel";

      Array.prototype.forEach.call(sleepPanel.querySelectorAll(".timers button"), function (other) {
        other.setAttribute("aria-pressed", String(other === b && minutes > 0));
      });

      json(call).then(paintSleep).catch(function () {});
    });
  });

  function setMode(next) {
    mode = next;
    $("mode-pc").classList.toggle("on", next === "pc");
    $("mode-pc").setAttribute("aria-pressed", String(next === "pc"));
    $("mode-phone").classList.toggle("on", next === "phone");
    $("mode-phone").setAttribute("aria-pressed", String(next === "phone"));

    if (next === "phone") {
      holding = false;
      player.pause();
      player.loop = false;
      player.removeAttribute("src");
      player.load();
      vol.value = Math.round(player.volume * 100);
      showVol();
      setTitle("pick a track");
      setLamp("", "client idle");
      duration = 0;
      paintBar(0);
    } else {
      holding = false;
      player.pause();
      player.loop = false;
      player.removeAttribute("src");
      player.load();
      knownTitle = "";
      holdSession();
      text("getvolume").then(function (level) {
        var value = parseInt(level, 10);
        if (!isNaN(value)) { vol.value = value; showVol(); }
      }).catch(function () {});
      refresh();
    }
  }

  $("mode-pc").addEventListener("click", function () { setMode("pc"); });
  $("mode-phone").addEventListener("click", function () { setMode("phone"); });

  player.addEventListener("play", function () {
    if (mode === "phone") setLamp("on", "playing on client");
  });

  player.addEventListener("pause", function () {
    if (mode === "phone" && !player.ended) setLamp("hold", "paused");
    else keepAlive();
  });

  player.addEventListener("ended", keepAlive);
  player.addEventListener("ended", function () {
    if (mode === "phone") actions.next();
  });

  function seekTo(seconds) {
    var spot = Math.max(0, Math.min(seconds, duration || seconds));
    if (mode === "phone") {
      if (isFinite(player.duration)) player.currentTime = spot;
      return;
    }
    anchorPos = spot;
    anchorAt = Date.now();
    send("jumptotime", "ms=" + Math.round(spot * 1000))
      .then(function () { setTimeout(refresh, 350); })
      .catch(function () {});
  }

  function here() {
    if (mode === "phone") return player.currentTime;
    return playing ? anchorPos + (Date.now() - anchorAt) / 1000 : anchorPos;
  }

  if ("mediaSession" in navigator) {
    var relay = function (run) {
      return function (event) {
        try { run(event); } catch (e) {}
        setTimeout(keepAlive, 60);
        if (mode === "pc") setTimeout(refresh, 350);
      };
    };

    var wire = {
      play: relay(function () { actions.play().catch(function () {}); }),
      pause: relay(function () { actions.pause().catch(function () {}); }),
      stop: relay(function () { actions.stop().catch(function () {}); }),
      previoustrack: relay(function () { actions.prev().catch(function () {}); }),
      nexttrack: relay(function () { actions.next().catch(function () {}); }),
      seekbackward: relay(function (event) { seekTo(here() - ((event && event.seekOffset) || 10)); }),
      seekforward: relay(function (event) { seekTo(here() + ((event && event.seekOffset) || 10)); }),
      seekto: relay(function (event) { if (event && event.seekTime != null) seekTo(event.seekTime); })
    };
    Object.keys(wire).forEach(function (key) {
      try { navigator.mediaSession.setActionHandler(key, wire[key]); }
      catch (e) {}
    });
  }

  var isDesktop = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (isDesktop) {
    vol.addEventListener('wheel', function(e) {
      e.preventDefault();
      var step = 2;
      var delta = e.deltaY > 0 ? -step : step;

      vol.value = Math.max(0, Math.min(100, Number(vol.value) + delta));
      showVol();
      pushVolume();
    }, { passive: false });

    posbar.addEventListener('wheel', function(e) {
      e.preventDefault();
      var step = 5;
      var delta = e.deltaY > 0 ? -step : step;

      var currentPos = here();
      seekTo(currentPos + delta);
    }, { passive: false });
  }

  ["pointerdown", "keydown"].forEach(function (kind) {
    document.addEventListener(kind, function once() {
      document.removeEventListener(kind, once);
      holdSession();
    });
  });

  toggle("shuffle", "shuffle", "shuffle_status", "shuffle");
  toggle("repeat", "repeat", "repeat_status", "repeat");

  text("getvolume").then(function (level) {
    var value = parseInt(level, 10);
    if (!isNaN(value)) { vol.value = Math.round(value * 100 / 255); showVol(); }
  }).catch(function () {});

  document.addEventListener("keydown", function (event) {
    var spot = document.activeElement;
    if (spot && (spot.tagName === "INPUT" || spot.tagName === "TEXTAREA")) {
      if (event.key === "Escape") spot.blur();
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;

    var step = 2;
    var handled = true;

    switch (event.key) {
      case " ":
        note(playing ? "pause" : "play");
        holdSession();
        (playing ? actions.pause() : actions.play());
        if (mode === "pc") setTimeout(refresh, 350);
        break;
      case "ArrowLeft":
        note("previous");
        holdSession();
        actions.prev();
        break;
      case "ArrowRight":
        note("next");
        holdSession();
        actions.next();
        break;
      case "ArrowUp":
        vol.value = Math.min(Number(vol.value) + step, 100);
        showVol();
        pushVolume();
        break;
      case "ArrowDown":
        vol.value = Math.max(Number(vol.value) - step, 0);
        showVol();
        pushVolume();
        break;
      case "/":
        queuePanel.open = true;
        search.focus();
        search.select();
        break;
      default:
        handled = false;
    }

    if (handled) event.preventDefault();
  });

  window.addEventListener("resize", fitMarquee);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });

  refresh();
  setInterval(tick, 250);
  setInterval(function () { if (!seeking) refresh(); }, 2000);
})();
