import os
import re

GENRE_TAG = re.compile(r"^\((\d+)\)")

GENRES = (
    "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge",
    "Hip-Hop", "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B",
    "Rap", "Reggae", "Rock", "Techno", "Industrial", "Alternative", "Ska",
    "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient",
    "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical",
    "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
    "Alt. Rock", "Bass", "Soul", "Punk", "Space", "Meditative",
    "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic", "Darkwave",
    "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream",
    "Southern Rock", "Comedy", "Cult", "Gangsta Rap", "Top 40",
    "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret",
    "New Wave", "Psychedelic", "Rave", "Showtunes", "Trailer", "Lo-Fi",
    "Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical",
    "Rock & Roll", "Hard Rock",
)

FRAME_MAP = {
    "TIT2": "songname", "TT2": "songname",
    "TPE1": "artist", "TP1": "artist",
    "TALB": "album", "TAL": "album",
    "TYER": "year", "TYE": "year", "TDRC": "year",
    "TCON": "genre", "TCO": "genre",
    "TRCK": "number", "TRK": "number",
    "COMM": "comment",
    "POPM": "rating",
    "USLT": "lyrics", "ULT": "lyrics",
}

ART_FRAMES = ("APIC", "PIC")
ART_NAMES = ("folder.jpg", "cover.jpg", "front.jpg", "folder.png", "cover.png")
MIME_BY_MAGIC = ((b"\xff\xd8\xff", "image/jpeg"), (b"\x89PNG", "image/png"))

AUDIO_EXT = (".mp3", ".ogg", ".flac", ".m4a", ".wma", ".wav", ".aac", ".opus")

MPEG_RATES = {
    3: (44100, 48000, 32000),
    2: (22050, 24000, 16000),
    0: (11025, 12000, 8000),
}

MIME_BY_EXT = {
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg",
    ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac",
    ".wav": "audio/wav", ".wma": "audio/x-ms-wma",
}

_tags = {}
_art = {}


def audio_mime(path):
    return MIME_BY_EXT.get(os.path.splitext(path)[1].lower(), "application/octet-stream")


def is_audio(name):
    return name.lower().endswith(AUDIO_EXT)


def sniff_mime(data):
    for magic, mime in MIME_BY_MAGIC:
        if data.startswith(magic):
            return mime
    return "application/octet-stream"


def clean(value):
    return value.replace("\x00", " ").strip()


def decode_text(data, marker, fallback):
    try:
        if marker == 1:
            return data.decode("utf-16", errors="replace")
        if marker == 2:
            return data.decode("utf-16-be", errors="replace")
        if marker == 3:
            return data.decode("utf-8", errors="replace")
        return data.decode(fallback, errors="replace")
    except Exception:
        return data.decode("latin-1", errors="replace")


def popm_stars(payload):
    cut = payload.find(b"\x00")
    if cut < 0 or cut + 1 >= len(payload):
        return 0
    value = payload[cut + 1]
    if value <= 5:
        return value
    for edge, stars in ((224, 5), (160, 4), (96, 3), (32, 2)):
        if value >= edge:
            return stars
    return 1


def tidy_genre(value):
    value = clean(value)
    match = GENRE_TAG.match(value)
    if match:
        rest = value[match.end():].strip()
        if rest:
            return rest
        value = match.group(1)
    if value.isdigit():
        index = int(value)
        return GENRES[index] if index < len(GENRES) else ""
    return value


def walk_frames(handle):
    head = handle.read(10)
    if len(head) < 10 or head[:3] != b"ID3":
        return

    major = head[3]
    size = 0
    for byte in head[6:10]:
        size = (size << 7) | (byte & 0x7F)

    body = handle.read(size)
    if head[5] & 0x40 and major >= 3 and len(body) >= 4:
        body = body[int.from_bytes(body[:4], "big"):]

    step = 6 if major == 2 else 10
    cursor = 0

    while cursor + step <= len(body):
        if major == 2:
            name = body[cursor:cursor + 3].decode("latin-1", errors="replace")
            length = int.from_bytes(body[cursor + 3:cursor + 6], "big")
        else:
            name = body[cursor:cursor + 4].decode("latin-1", errors="replace")
            chunk = body[cursor + 4:cursor + 8]
            if major >= 4:
                length = 0
                for byte in chunk:
                    length = (length << 7) | (byte & 0x7F)
            else:
                length = int.from_bytes(chunk, "big")

        cursor += step
        if length <= 0 or cursor + length > len(body):
            break

        yield name, body[cursor:cursor + length]
        cursor += length


def header_size(handle):
    handle.seek(0)
    head = handle.read(10)
    if len(head) < 10 or head[:3] != b"ID3":
        return 0
    size = 0
    for byte in head[6:10]:
        size = (size << 7) | (byte & 0x7F)
    return size + 10


def read_id3v2(handle, fallback):
    found = {}
    for name, payload in walk_frames(handle):
        slot = FRAME_MAP.get(name)
        if not slot or not payload or slot in found:
            continue

        if name == "POPM":
            value = str(popm_stars(payload))
        elif name in ("COMM", "USLT", "ULT") and len(payload) > 4:
            value = decode_text(payload[4:], payload[0], fallback).split("\x00")[-1]
        else:
            value = decode_text(payload[1:], payload[0], fallback)

        value = clean(value)
        if value:
            found[slot] = value

    return found


def read_id3v1(handle, fallback):
    try:
        handle.seek(-128, os.SEEK_END)
    except OSError:
        return {}

    block = handle.read(128)
    if len(block) < 128 or block[:3] != b"TAG":
        return {}

    def piece(start, end):
        return clean(block[start:end].decode(fallback, errors="replace"))

    found = {
        "songname": piece(3, 33),
        "artist": piece(33, 63),
        "album": piece(63, 93),
        "year": piece(93, 97),
        "genre": str(block[127]) if block[127] < 255 else "",
    }
    return {key: value for key, value in found.items() if value}


def read_mpeg(handle, offset):
    handle.seek(offset)
    window = handle.read(8192)

    for index in range(len(window) - 4):
        if window[index] != 0xFF or (window[index + 1] & 0xE0) != 0xE0:
            continue

        version = (window[index + 1] >> 3) & 0x03
        rate_index = (window[index + 2] >> 2) & 0x03
        channel_mode = (window[index + 3] >> 6) & 0x03

        if version == 1 or rate_index == 3 or version not in MPEG_RATES:
            continue

        return {
            "samplerate": MPEG_RATES[version][rate_index],
            "channels": 1 if channel_mode == 3 else 2,
        }

    return {}


def usable(path):
    return bool(path) and "\x00" not in path


def like(mask, name):
    return len(mask) == len(name) and all(
        piece == "?" or piece == letter for piece, letter in zip(mask, name)
    )


def resolve(path):
    if not usable(path) or "?" not in path:
        return path

    sep = "\\" if "\\" in path else "/"
    if sep not in path:
        return path

    head, base = path.rsplit(sep, 1)
    if "?" in head:
        head = resolve(head)

    if "?" not in base:
        return head + sep + base

    try:
        names = os.listdir(head)
    except OSError:
        return path

    hits = [name for name in names if like(base, name)]
    return head + sep + hits[0] if len(hits) == 1 else (
        head + sep + hits[0] if hits else path
    )


VORBIS_MAP = {
    "TITLE": "songname", "ARTIST": "artist", "ALBUM": "album",
    "DATE": "year", "YEAR": "year", "GENRE": "genre",
    "TRACKNUMBER": "number", "COMMENT": "comment",
}

MP4_MAP = {
    "\xa9nam": "songname", "\xa9ART": "artist", "\xa9alb": "album",
    "\xa9day": "year", "\xa9gen": "genre", "\xa9cmt": "comment",
}


def vorbis_comments(block):
    found = {}
    try:
        at = 4 + int.from_bytes(block[:4], "little")
        count = int.from_bytes(block[at:at + 4], "little")
        at += 4
        for _ in range(min(count, 200)):
            size = int.from_bytes(block[at:at + 4], "little")
            at += 4
            line = block[at:at + size].decode("utf-8", errors="replace")
            at += size
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            slot = VORBIS_MAP.get(key.strip().upper())
            if slot and value.strip() and slot not in found:
                found[slot] = value.strip()
    except Exception:
        pass
    return found


def flac_blocks(handle):
    if handle.read(4) != b"fLaC":
        return
    while True:
        head = handle.read(4)
        if len(head) < 4:
            return
        last = head[0] & 0x80
        kind = head[0] & 0x7F
        size = int.from_bytes(head[1:4], "big")
        yield kind, handle.read(size)
        if last:
            return


def read_flac(handle):
    found = {}
    for kind, block in flac_blocks(handle):
        if kind == 0 and len(block) >= 18:
            bits = int.from_bytes(block[10:14], "big")
            found["samplerate"] = bits >> 12
            found["channels"] = ((bits >> 9) & 0x07) + 1
        elif kind == 4:
            found.update(vorbis_comments(block))
    return found


def read_ogg(handle):
    window = handle.read(262144)

    for magic, skip in ((b"\x03vorbis", 7), (b"OpusTags", 8)):
        at = window.find(magic)
        if at >= 0:
            return vorbis_comments(window[at + skip:])

    return {}


def mp4_atoms(data, at, stop):
    while at + 8 <= stop:
        size = int.from_bytes(data[at:at + 4], "big")
        name = data[at + 4:at + 8].decode("latin-1", errors="replace")
        if size < 8:
            return
        yield name, at + 8, min(at + size, stop)
        at += size


def read_mp4(handle):
    data = handle.read(4194304)
    found = {}

    def dive(start, stop, depth):
        if depth > 6:
            return
        for name, body, end in mp4_atoms(data, start, stop):
            if name in ("moov", "udta", "trak", "mdia", "minf", "stbl"):
                dive(body, end, depth + 1)
            elif name == "meta":
                dive(body + 4, end, depth + 1)
            elif name == "ilst":
                for tag, inner, tail in mp4_atoms(data, body, end):
                    slot = MP4_MAP.get(tag)
                    if not slot:
                        continue
                    for kind, spot, edge in mp4_atoms(data, inner, tail):
                        if kind == "data" and edge - spot > 8:
                            value = data[spot + 8:edge].decode("utf-8", errors="replace").strip()
                            if value and slot not in found:
                                found[slot] = value
            elif name == "stsd" and end - body > 40:
                found.setdefault("channels", int.from_bytes(data[body + 32:body + 34], "big"))
                found.setdefault("samplerate", int.from_bytes(data[body + 36:body + 38], "big"))

    dive(0, len(data), 0)
    return {key: value for key, value in found.items() if value}


def sniff_format(handle):
    handle.seek(0)
    head = handle.read(12)
    offset = 0

    if head[:3] == b"ID3":
        offset = header_size(handle)
        handle.seek(offset)
        head = handle.read(12)

    if head[:4] == b"fLaC":
        return "flac", offset
    if head[:4] == b"OggS":
        return "ogg", offset
    if head[4:8] == b"ftyp":
        return "mp4", offset
    return "mpeg", offset


def read(path, seconds=0, fallback="cp1251"):
    if not usable(path):
        return {}

    try:
        stamp = os.path.getmtime(path)
        size = os.path.getsize(path)
    except (OSError, ValueError):
        return {}

    key = (path, stamp)
    if key in _tags:
        found = dict(_tags[key])
    else:
        found = {}

        try:
            with open(path, "rb") as handle:
                kind, offset = sniff_format(handle)

                if kind == "flac":
                    handle.seek(offset)
                    found.update(read_flac(handle))
                elif kind == "ogg":
                    handle.seek(offset)
                    found.update(read_ogg(handle))
                elif kind == "mp4":
                    handle.seek(0)
                    found.update(read_mp4(handle))
                else:
                    handle.seek(0)
                    found.update(read_id3v2(handle, fallback))
                    if not found:
                        handle.seek(0)
                        found.update(read_id3v1(handle, fallback))
                    found.update(read_mpeg(handle, offset))

                if not any(found.get(slot) for slot in ("songname", "artist", "album")):
                    handle.seek(0)
                    for key, value in read_id3v2(handle, fallback).items():
                        found.setdefault(key, value)
                    if not any(found.get(slot) for slot in ("songname", "artist")):
                        handle.seek(0)
                        for key, value in read_id3v1(handle, fallback).items():
                            found.setdefault(key, value)
        except (OSError, ValueError):
            return {}

        if "genre" in found:
            found["genre"] = tidy_genre(found["genre"])
        if "number" in found:
            found["number"] = found["number"].split("/")[0].strip()

        _tags[key] = dict(found)
        if len(_tags) > 300:
            _tags.clear()

    if seconds and seconds > 0:
        found["bitrate"] = int(round(size * 8 / seconds / 1000))

    return found


def flac_art(handle):
    for kind, block in flac_blocks(handle):
        if kind != 6 or len(block) < 32:
            continue
        try:
            at = 4
            mime_len = int.from_bytes(block[at:at + 4], "big")
            at += 4
            mime = block[at:at + mime_len].decode("latin-1", errors="replace")
            at += mime_len
            desc_len = int.from_bytes(block[at:at + 4], "big")
            at += 4 + desc_len + 16
            data_len = int.from_bytes(block[at:at + 4], "big")
            at += 4
            data = block[at:at + data_len]
            if data:
                return mime or sniff_mime(data), data
        except Exception:
            continue
    return None


def mp4_art(handle):
    data = handle.read(8388608)
    hit = data.find(b"covr")
    if hit < 0:
        return None
    for kind, spot, edge in mp4_atoms(data, hit + 4, min(hit + 4194304, len(data))):
        if kind == "data" and edge - spot > 8:
            blob = data[spot + 8:edge]
            if blob:
                return sniff_mime(blob), blob
        break
    return None


def extract_art(path):
    try:
        with open(path, "rb") as handle:
            kind, offset = sniff_format(handle)

            if kind == "flac":
                handle.seek(offset)
                found = flac_art(handle)
                if found:
                    return found
            elif kind == "mp4":
                handle.seek(0)
                found = mp4_art(handle)
                if found:
                    return found
    except (OSError, ValueError):
        pass

    try:
        with open(path, "rb") as handle:
            best = None
            for name, payload in walk_frames(handle):
                if name not in ART_FRAMES or len(payload) < 6:
                    continue

                marker = payload[0]
                if name == "PIC":
                    kind = payload[4]
                    rest = payload[5:]
                else:
                    cut = payload.find(b"\x00", 1)
                    if cut < 0:
                        continue
                    kind = payload[cut + 1] if cut + 1 < len(payload) else 0
                    rest = payload[cut + 2:]

                if marker in (1, 2):
                    end = rest.find(b"\x00\x00")
                    rest = rest[end + 2:] if end >= 0 else rest
                else:
                    end = rest.find(b"\x00")
                    rest = rest[end + 1:] if end >= 0 else rest

                if not rest:
                    continue
                if kind == 3:
                    return sniff_mime(rest), rest
                if best is None:
                    best = (sniff_mime(rest), rest)

            if best:
                return best
    except (OSError, ValueError):
        return None

    folder = os.path.dirname(path)
    for name in ART_NAMES:
        candidate = os.path.join(folder, name)
        if os.path.isfile(candidate):
            try:
                with open(candidate, "rb") as handle:
                    data = handle.read()
                return sniff_mime(data), data
            except (OSError, ValueError):
                pass

    return None


def cover(path):
    if not usable(path):
        return None

    try:
        key = (path, os.path.getmtime(path))
    except (OSError, ValueError):
        return None

    if key not in _art:
        _art.clear()
        _art[key] = extract_art(path)

    return _art[key]


def frame_list(path):
    if not usable(path):
        return []
    try:
        with open(path, "rb") as handle:
            return [(name, len(payload)) for name, payload in walk_frames(handle)]
    except (OSError, ValueError):
        return []
