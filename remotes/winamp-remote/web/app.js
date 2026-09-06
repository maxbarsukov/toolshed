(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var journal = null;

  function watch(text) {
    if (!journal) return;
    var stamp = new Date().toISOString().slice(14, 23);
    var line = document.createElement("div");
    line.textContent = stamp + "  " + text;
    journal.insertBefore(line, journal.firstChild);
    while (journal.childNodes.length > 60) {
      journal.removeChild(journal.lastChild);
    }
  }

  if (/(^|[?&])debug=1/.test(location.search)) {
    journal = document.createElement("div");
    journal.id = "journal";
    document.body.appendChild(journal);
    watch("journal on");
  }

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
  var flagLine = "connecting";
  var dragging = false, currentPath = "", browseUp = null;
  var beat = 0, armed = -1;
  var resume = null, wasMode = -1, fileTitle = "", loadedFor = -2;

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
    var began = Date.now();
    var label = command + (params ? "?" + params : "");

    return text(command, params).then(function (answer) {
      watch("sent " + label + " -> " + answer.trim().slice(0, 12) +
            " in " + (Date.now() - began) + "ms");
      return answer;
    }).catch(function (problem) {
      watch("FAILED " + label + " after " + (Date.now() - began) +
            "ms: " + (problem && problem.message ? problem.message : "?"));
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
    if (beat % 8 === 0) alignMirror();

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

    box.classList.add("blank");
    img.removeAttribute("src");

    img.onload = function () {
      box.classList.remove("blank");
      describe();
    };
    img.onerror = function () {
      box.classList.add("blank");
      describe();
    };
    img.src = "api/cover?index=" + position + "&n=" + Date.now();
  }

  var facts = {};

  var shown = "";

  function describe() {
    if (!("mediaSession" in navigator)) return;

    var art = $("art-box").classList.contains("blank") ? "" : $("art").src;
    var title = facts.songname || knownTitle || "Winamp Remote";
    var stamp = title + "|" + (facts.artist || "") + "|" + (facts.album || "") + "|" + art;

    if (stamp === shown) return;
    shown = stamp;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: facts.artist || "",
        album: facts.album || "",
        artwork: art ? [{ src: art, sizes: "512x512" }] : []
      });
      markSession();
    } catch (e) {}
  }

  function setPlaying(value) {
    playing = value;
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = value ? "playing" : "paused";
    }
    anchorAt = Date.now();
    markSession();
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

  var IDLE_HINT = "minutes";

  function paintSleep(info) {
    var field = $("sleep-custom"), setter = $("sleep-set");
    if (!field || !setter) return;

    var live = !!(info && info.active);

    if (!live) {
      Array.prototype.forEach.call(sleepPanel.querySelectorAll("button"), function (b) {
        b.setAttribute("aria-pressed", "false");
      });
    }

    sleepPanel.classList.toggle("armed", live);
    field.disabled = live;
    setter.disabled = live;

    if (!live) {
      field.placeholder = IDLE_HINT;
      return;
    }

    var minutes = Math.ceil(info.left / 60);
    field.value = "";
    field.placeholder = minutes + (minutes === 1 ? " minute left" : " minutes left");
  }

  function refresh() {
    return json("state").then(function (state) {
      listTotal = state.total;
      playing = state.mode === 1;
      winampMode = state.mode;
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
        setTitle(fileTitle || state.title || "Winamp Remote");
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

      if (mode === "pc" && (state.pos !== loadedFor || state.title !== knownTitle)) {
        loadedFor = state.pos;
        knownTitle = state.title;
        fileTitle = "";
        loadDetails(state.pos);
      }

      if (mode === "pc") alignMirror();

      markSession();
      wireSession();
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

  var mine = 0, winampMode = -1;

  function selfPlay() {
    mine += 1;
    return player.play().catch(function (problem) {
      mine = Math.max(0, mine - 1);
      watch("own play refused: " + problem.name);
    });
  }

  function selfPause() {
    mine += 1;
    player.pause();
  }

  function ours() {
    if (mine <= 0) return false;
    mine -= 1;
    return true;
  }

  var toldAt = -1, toldLen = -1;

  function markSession() {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.playbackState =
      mode === "phone" ? (player.paused ? "paused" : "playing")
                       : (playing ? "playing" : "paused");

    if (duration <= 0) return;

    var spot = mode === "phone"
      ? player.currentTime
      : Math.min(playing ? anchorPos + (Date.now() - anchorAt) / 1000 : anchorPos, duration);

    var place = Math.max(0, Math.min(spot, duration));
    if (duration === toldLen && Math.abs(place - toldAt) < 2) return;

    toldLen = duration;
    toldAt = place;

    try {
      navigator.mediaSession.setPositionState({
        duration: duration,
        position: place,
        playbackRate: 1
      });
    } catch (e) {}
  }

  var hum = null;

  function humTrack() {
    if (hum) return hum;

    var rate = 8000, seconds = 60, frames = rate * seconds;
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

    for (var i = 0; i < frames; i++) {
      view.setUint8(44 + i, 128 + (Math.sin(i / 40) > 0 ? 1 : 0));
    }

    hum = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    watch("carrier built: " + seconds + "s, " + Math.round(frames / 1024) + " KB, no network");
    return hum;
  }

  var awake = false;

  function wake() {
    if (mode !== "pc") return;

    if (player.src !== humTrack()) {
      player.loop = true;
      player.volume = 1;
      player.src = hum;
      watch("carrier attached at full volume, silent by content");
    }

    if (!player.paused) return;

    selfPlay().then(function () {
      awake = true;
      watch("carrier playing, session live");
      wireSession();
      describe();
      markSession();
    }).catch(function (problem) {
      watch("carrier refused: " + problem.name + " (needs a tap)");
    });
  }

  function alignMirror() {
    if (mode !== "pc" || !awake) return;

    if (playing && player.paused) {
      watch("align: winamp plays, carrier stopped -> starting");
      selfPlay();
      return;
    }

    if (!playing && !player.paused) {
      watch("align: winamp paused, carrier runs -> stopping");
      selfPause();
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
      if (afterGuest()) { watch("next: returning to playlist instead"); return Promise.resolve(); }
      return send("next");
    }
  };

  var names = { prev: "previous", play: "play", pause: "pause", stop: "stop", next: "next" };

  var expects = { play: true, pause: false, stop: false };

  Array.prototype.forEach.call(document.querySelectorAll(".pads button"), function (b) {
    b.addEventListener("click", function () {
      var cmd = b.dataset.cmd;
      note(names[cmd]);
      if (cmd in expects && mode === "pc") setPlaying(expects[cmd]);
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
    loadedFor = -2;
    setTitle("track " + (position + 1));
    return player.play().then(function () {
      wireSession();
      describe();
    }).catch(function () {});
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
        if (mode === "phone") {
          player.loop = false;
          player.volume = Number(vol.value) / 100;
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

  function armSleep(minutes, source) {
    var call = minutes > 0 ? "sleep?action=arm&minutes=" + minutes : "sleep?action=cancel";

    Array.prototype.forEach.call(sleepPanel.querySelectorAll("button"), function (other) {
      other.setAttribute("aria-pressed", String(other === source && minutes > 0));
    });

    json(call).then(paintSleep).catch(function () {});
  }

  Array.prototype.forEach.call(sleepPanel.querySelectorAll(".timers button[data-min]"), function (b) {
    b.addEventListener("click", function () {
      $("sleep-custom").value = "";
      armSleep(Number(b.dataset.min), b);
    });
  });

  function armCustom() {
    var field = $("sleep-custom");
    var minutes = Math.round(Number(field.value));

    if (!minutes || minutes < 1) {
      field.focus();
      return;
    }

    minutes = Math.min(minutes, 720);
    field.value = minutes;
    field.blur();
    armSleep(minutes, $("sleep-set"));
  }

  $("sleep-set").addEventListener("click", armCustom);

  $("sleep-custom").addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      armCustom();
    }
  });

  function setMode(next) {
    mode = next;
    $("mode-pc").classList.toggle("on", next === "pc");
    $("mode-pc").setAttribute("aria-pressed", String(next === "pc"));
    $("mode-phone").classList.toggle("on", next === "phone");
    $("mode-phone").setAttribute("aria-pressed", String(next === "phone"));

    if (next === "phone") {
      awake = false;
      mine = 0;
      player.pause();
      player.loop = false;
      player.removeAttribute("src");
      player.load();
      player.volume = 1;
      vol.value = 100;
      showVol();
      setTitle("pick a track");
      setLamp("", "client idle");
      duration = 0;
      paintBar(0);
    } else {
      awake = false;
      mine = 0;
      player.pause();
      player.loop = false;
      player.removeAttribute("src");
      player.load();
      player.volume = 1;
      knownTitle = "";
      loadedFor = -2;
      text("getvolume").then(function (level) {
        var value = parseInt(level, 10);
        if (!isNaN(value)) { vol.value = value; showVol(); }
      }).catch(function () {});
      refresh();
    }
  }

  $("mode-pc").addEventListener("click", function () { setMode("pc"); });
  $("mode-phone").addEventListener("click", function () { setMode("phone"); });

  setInterval(function () {
    if (mine > 0) mine = 0;
  }, 5000);

  player.addEventListener("play", function () {
    if (mode === "phone") {
      setLamp("on", "playing on client");
      return;
    }

    if (ours() || !awake) return;

    if (winampMode === 1) {
      watch("carrier started, winamp already playing, nothing to do");
      return;
    }

    var command = winampMode === 3 ? "pause" : "play";
    watch("mirror -> winamp: resume via " + command + " (winamp mode " + winampMode + ")");
    playing = true;
    send(command).then(function () { setTimeout(refresh, 350); }).catch(function () {});
  });

  player.addEventListener("pause", function () {
    if (mode === "phone") {
      if (!player.ended) setLamp("hold", "paused");
      return;
    }

    if (ours() || !awake || player.ended) return;

    if (winampMode !== 1) {
      watch("carrier stopped, winamp not playing (mode " + winampMode + "), nothing to do");
      return;
    }

    watch("mirror -> winamp: pause (winamp mode " + winampMode + ")");
    playing = false;
    send("pause").then(function () { setTimeout(refresh, 350); }).catch(function () {});
  });

  ["play", "pause", "ended", "stalled", "suspend", "emptied", "error", "waiting"]
    .forEach(function (kind) {
      player.addEventListener(kind, function () {
        watch("audio: " + kind + (player.error ? " code " + player.error.code : ""));
      });
    });

  document.addEventListener("visibilitychange", function () {
    watch("page " + (document.hidden ? "hidden" : "visible") +
          " | audio " + (player.paused ? "paused" : "playing"));
  });

  document.addEventListener("freeze", function () { watch("PAGE FROZEN by browser"); });
  document.addEventListener("resume", function () { watch("page resumed"); });

  function dropSession() {
    awake = false;
    armed = -1;
    try { player.pause(); } catch (e) {}

    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.metadata = null;
      ["play", "pause", "stop", "previoustrack", "nexttrack",
       "seekbackward", "seekforward", "seekto"].forEach(function (key) {
        navigator.mediaSession.setActionHandler(key, null);
      });
    } catch (e) {}
  }

  window.addEventListener("pagehide", function (event) {
    watch("pagehide, persisted=" + event.persisted + " (session kept)");
  });

  window.addEventListener("beforeunload", function () {
    watch("unloading, dropping session");
    dropSession();
  });
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

  var sessionReady = false;

  function resumeCommand() {
    return winampMode === 3 ? "pause" : "play";
  }

  function wireSession() {
    if (sessionReady || !("mediaSession" in navigator)) return;

    var act = function (name, run) {
      return function (event) {
        watch("action: " + name + " (winamp mode " + winampMode + ")");
        try { run(event); } catch (e) { watch("action threw: " + e.message); }
        setTimeout(refresh, 400);
      };
    };

    var wire = {
      play: act("play", function () {
        setPlaying(true);
        if (winampMode === 1) return;
        send(resumeCommand()).catch(function () {});
      }),
      pause: act("pause", function () {
        setPlaying(false);
        if (winampMode !== 1) return;
        send("pause").catch(function () {});
      }),
      stop: act("stop", function () {
        setPlaying(false);
        send("stop").catch(function () {});
      }),
      previoustrack: act("previoustrack", function () { actions.prev().catch(function () {}); }),
      nexttrack: act("nexttrack", function () { actions.next().catch(function () {}); }),
      seekbackward: act("seekbackward", function (event) {
        seekTo(here() - ((event && event.seekOffset) || 10));
      }),
      seekforward: act("seekforward", function (event) {
        seekTo(here() + ((event && event.seekOffset) || 10));
      }),
      seekto: act("seekto", function (event) {
        if (event && event.seekTime != null) seekTo(event.seekTime);
      })
    };

    var good = 0, bad = [];
    Object.keys(wire).forEach(function (key) {
      try {
        navigator.mediaSession.setActionHandler(key, wire[key]);
        good += 1;
      } catch (e) {
        bad.push(key);
      }
    });

    sessionReady = true;
    watch("handlers set once: " + good + (bad.length ? ", refused: " + bad.join(",") : ""));
  }

  var isDesktop = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  if (isDesktop) {
    vol.addEventListener("wheel", function (event) {
      event.preventDefault();
      var delta = event.deltaY > 0 ? -2 : 2;

      vol.value = Math.max(0, Math.min(100, Number(vol.value) + delta));
      showVol();
      pushVolume();
    }, { passive: false });

    posbar.addEventListener("wheel", function (event) {
      if (posbar.disabled) return;
      event.preventDefault();
      seekTo(here() + (event.deltaY > 0 ? -5 : 5));
    }, { passive: false });
  }

  ["pointerdown", "keydown"].forEach(function (kind) {
    document.addEventListener(kind, function () {
      if (!awake) wake();
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
        (playing ? actions.pause() : actions.play());
        if (mode === "pc") setTimeout(refresh, 350);
        break;
      case "ArrowLeft":
        note("previous");
        actions.prev();
        break;
      case "ArrowRight":
        note("next");
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
