#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
khinsider_dl.py - download an album from downloads.khinsider.com

Given a link to an album page, it:
  1) Creates a folder named after the album (next to the script).
  2) Downloads the cover -> cover.jpg and generates cover.ico.
  3) Visits every track and downloads mp3 and flac (when available),
     keeping the file name exactly as the site provides it.
  4) Writes the in-album number into each file's metadata: for multi-disc
     albums as disc*1000 + track (e.g. disc 2 track 73 -> 2073), otherwise
     the plain track number. Album and title are also filled in from the site
     when the file has no value for them yet (existing tags are kept).

Usage:
  python khinsider_dl.py "https://downloads.khinsider.com/game-soundtracks/album/<slug>"
  python khinsider_dl.py <URL> --formats mp3           # mp3 only
  python khinsider_dl.py <URL> --formats mp3,flac      # both (default)
  python khinsider_dl.py <URL> --out "D:\\Music"       # custom base folder
  python khinsider_dl.py <URL> --delay 1.0             # pause between tracks, sec

Dependencies:  pip install requests beautifulsoup4 pillow mutagen
"""

import argparse
import os
import re
import sys
import time
from urllib.parse import urljoin, urlparse, unquote

try:
    import requests
    from bs4 import BeautifulSoup
    from PIL import Image
    from mutagen.mp3 import MP3
    from mutagen.id3 import ID3, TRCK, TPOS, TALB, TIT2
    from mutagen.flac import FLAC
except ImportError as e:
    missing = str(e).split("'")[-2] if "'" in str(e) else str(e)
    sys.stderr.write(
        f"Missing module: {missing}\n"
        "Install the dependencies:\n"
        "    pip install requests beautifulsoup4 pillow mutagen\n"
    )
    sys.exit(1)


HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

BASE = "https://downloads.khinsider.com"


def sanitize(name: str, is_dir: bool = False) -> str:
    name = unquote(name)
    name = name.replace("\u200b", "").strip()
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = name.rstrip(" .")
    if not name:
        name = "untitled"
    reserved = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
    stem = name.split(".")[0].upper()
    if stem in reserved:
        name = "_" + name
    return name[:180] if not is_dir else name[:150]


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    return s


def get(session: requests.Session, url: str, referer: str = None,
        stream: bool = False, retries: int = 3, timeout: int = 60):
    headers = {}
    if referer:
        headers["Referer"] = referer
    last = None
    for attempt in range(1, retries + 1):
        try:
            r = session.get(url, headers=headers, stream=stream, timeout=timeout)
            r.raise_for_status()
            return r
        except Exception as e:
            last = e
            if attempt < retries:
                wait = 2 * attempt
                print(f"    ! attempt {attempt} failed ({e}); retrying in {wait}s")
                time.sleep(wait)
    raise last


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def download_file(session, url, dest, referer=None):
    tmp = dest + ".part"
    r = get(session, url, referer=referer, stream=True)
    total = int(r.headers.get("Content-Length", 0))

    if os.path.exists(dest) and total and os.path.getsize(dest) == total:
        print(f"    = already downloaded ({human(total)}), skipping")
        r.close()
        return False

    done = 0
    with open(tmp, "wb") as f:
        for chunk in r.iter_content(chunk_size=64 * 1024):
            if chunk:
                f.write(chunk)
                done += len(chunk)
                if total:
                    pct = done * 100 // total
                    print(f"\r    {pct:3d}%  {human(done)}/{human(total)}", end="", flush=True)
    print()
    os.replace(tmp, dest)
    return True


def parse_album(session, album_url):
    r = get(session, album_url)
    soup = BeautifulSoup(r.text, "html.parser")

    title = soup.title.get_text(strip=True) if soup.title else ""
    album_name = re.split(r"\s*MP3 - Download Soundtracks for FREE!", title)[0].strip()
    if not album_name:
        album_name = "khinsider_album"

    cover_url = None
    div = soup.find("div", class_="albumImage")
    if div:
        a = div.find("a", href=True)
        img = div.find("img", src=True)
        if a:
            cover_url = a["href"]
        elif img:
            cover_url = img["src"]
    if cover_url:
        cover_url = urljoin(album_url, cover_url)

    # tracks from the songlist table. Cell layout differs for 1 vs N discs:
    #   1 disc : [play] [ "N." track ] [link] ...
    #   N discs: [play] [ "D" disc ] [ "N." track ] [link] ...
    # Distinguish them: a track number always has a dot ("12."), a disc number
    # does not ("2").
    tracks = []
    table = soup.find("table", id="songlist")
    seen = set()
    if table:
        for row in table.find_all("tr"):
            if row.get("id") == "songlist_header":
                continue
            link = row.select_one("td.clickable-row a[href]")
            if not link:
                continue
            href = unquote(urljoin(album_url, link["href"]))
            if href in seen:
                continue
            seen.add(href)

            disc, track = 1, None
            for td in row.find_all("td", recursive=False):
                cls = td.get("class") or []
                if "clickable-row" in cls or "playlistDownloadSong" in cls:
                    break
                txt = td.get_text(strip=True)
                if re.fullmatch(r"\d+\.", txt):
                    track = int(txt[:-1])
                elif re.fullmatch(r"\d+", txt):
                    disc = int(txt)
            if track is None:
                track = sum(1 for t in tracks if t["disc"] == disc) + 1
            title = link.get_text(strip=True)
            tracks.append({"page": href, "disc": disc, "track": track, "title": title})

    multi_disc = len({t["disc"] for t in tracks}) > 1
    return album_name, cover_url, tracks, multi_disc


def album_number(disc, track, multi_disc):
    return disc * 1000 + track if multi_disc else track


def tag_track(path, number, disc=None, album=None, title=None):
    """Write metadata into an mp3/flac file.

    The track number (and disc number for multi-disc albums) is always set.
    Album and title are only filled in when the file has no value for them yet
    existing tags are never overwritten.
    """
    ext = path.rsplit(".", 1)[-1].lower()
    if ext == "mp3":
        try:
            audio = MP3(path, ID3=ID3)
        except Exception:
            audio = MP3(path)
        if audio.tags is None:
            audio.add_tags()
        tags = audio.tags
        tags.setall("TRCK", [TRCK(encoding=3, text=[str(number)])])
        if disc is not None:
            tags.setall("TPOS", [TPOS(encoding=3, text=[str(disc)])])

        def has(frame):
            fr = tags.get(frame)
            return bool(fr and any(str(t).strip() for t in fr.text))

        if album and not has("TALB"):
            tags.setall("TALB", [TALB(encoding=3, text=[album])])
        if title and not has("TIT2"):
            tags.setall("TIT2", [TIT2(encoding=3, text=[title])])
        audio.save()
    elif ext == "flac":
        audio = FLAC(path)
        audio["tracknumber"] = str(number)
        if disc is not None:
            audio["discnumber"] = str(disc)

        def has(key):
            vals = audio.get(key)
            return bool(vals and any(str(v).strip() for v in vals))

        if album and not has("album"):
            audio["album"] = album
        if title and not has("title"):
            audio["title"] = title
        audio.save()


def parse_song_page(session, song_url):
    r = get(session, song_url, referer=BASE)
    soup = BeautifulSoup(r.text, "html.parser")
    out = []
    seen = set()
    for span in soup.select("span.songDownloadLink"):
        a = span.find_parent("a", href=True)
        if not a:
            continue
        txt = span.get_text(" ", strip=True).lower()
        if "flac" in txt:
            fmt = "flac"
        elif "mp3" in txt:
            fmt = "mp3"
        else:
            ext = os.path.splitext(urlparse(a["href"]).path)[1].lower().lstrip(".")
            fmt = ext or "?"
        url = urljoin(song_url, a["href"])
        filename = sanitize(os.path.basename(urlparse(url).path))
        key = (fmt, url)
        if key in seen:
            continue
        seen.add(key)
        out.append((fmt, filename, url))
    return out


def save_cover(session, cover_url, folder, referer):
    if not cover_url:
        print("  ! no cover found on the album page")
        return
    print(f"  cover: {cover_url}")
    r = get(session, cover_url, referer=referer)
    raw = r.content
    try:
        from io import BytesIO
        im = Image.open(BytesIO(raw))
        im.load()
    except Exception as e:
        print(f"  ! could not open the cover image: {e}")
        return

    rgba = im.convert("RGBA")
    bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    flat = Image.alpha_composite(bg, rgba).convert("RGB")
    jpg_path = os.path.join(folder, "cover.jpg")
    flat.save(jpg_path, "JPEG", quality=92)
    print(f"    -> cover.jpg  ({im.size[0]}x{im.size[1]}, {human(os.path.getsize(jpg_path))})")

    w, h = flat.size
    s = min(w, h)
    sq = flat.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    all_sizes = [16, 32, 48, 64, 128, 256]
    sizes = [(x, x) for x in all_sizes if x <= s] or [(s, s)]
    ico_path = os.path.join(folder, "cover.ico")
    sq.save(ico_path, format="ICO", sizes=sizes)
    print(f"    -> cover.ico  ({', '.join(str(x[0]) for x in sizes)})")


def main():
    ap = argparse.ArgumentParser(description="Album downloader for downloads.khinsider.com")
    ap.add_argument("url", help="link to the album page")
    ap.add_argument("--formats", default="mp3,flac",
                    help="comma-separated formats to download (default: mp3,flac)")
    ap.add_argument("--out", default=None,
                    help="base folder (default: the script's own folder)")
    ap.add_argument("--delay", type=float, default=0.5,
                    help="pause between tracks in seconds (default: 0.5)")
    args = ap.parse_args()

    want = {f.strip().lower() for f in args.formats.split(",") if f.strip()}
    base_dir = args.out or os.path.dirname(os.path.abspath(__file__))

    session = make_session()

    print(f"Reading the album page...\n  {args.url}")
    album_name, cover_url, tracks, multi_disc = parse_album(session, args.url)
    print(f"Album: {album_name}")
    if multi_disc:
        ndiscs = len({t['disc'] for t in tracks})
        print(f"Tracks: {len(tracks)}  (discs: {ndiscs}; numbering as disc*1000+track)")
    else:
        print(f"Tracks: {len(tracks)}")
    if not tracks:
        print("No tracks found - check the link (it must be an album page).")
        sys.exit(1)

    folder = os.path.join(base_dir, sanitize(album_name, is_dir=True))
    os.makedirs(folder, exist_ok=True)
    print(f"Folder: {folder}\n")

    save_cover(session, cover_url, folder, referer=args.url)
    print()

    ok, skipped, failed = 0, 0, 0
    for i, t in enumerate(tracks, 1):
        page, disc, track = t["page"], t["disc"], t["track"]
        number = album_number(disc, track, multi_disc)
        tag_disc = disc if multi_disc else None
        title_guess = unquote(os.path.basename(urlparse(page).path))
        prefix = f"[{i}/{len(tracks)}] #{number}"
        print(f"{prefix} {title_guess}")
        try:
            links = parse_song_page(session, page)
        except Exception as e:
            print(f"  ! could not open the track page: {e}")
            failed += 1
            continue

        available = {fmt for fmt, _, _ in links}
        targets = [(fmt, fn, url) for fmt, fn, url in links if fmt in want]
        if not targets:
            print(f"  ! none of the requested formats (page has: {', '.join(sorted(available)) or 'nothing'})")
            failed += 1
            continue

        for fmt, filename, url in targets:
            dest = os.path.join(folder, filename)
            print(f"  [{fmt}] {filename}")
            try:
                changed = download_file(session, url, dest, referer=page)
                ok += 1 if changed else 0
                skipped += 0 if changed else 1
            except Exception as e:
                print(f"    ! download error: {e}")
                failed += 1
                continue
            try:
                tag_track(dest, number, disc=tag_disc,
                          album=album_name, title=t["title"])
            except Exception as e:
                print(f"    ! could not write tag: {e}")

        time.sleep(args.delay)

    print(f"\nDone. Downloaded: {ok}, skipped (already present): {skipped}, errors: {failed}")
    print(f"Everything is in: {folder}")


if __name__ == "__main__":
    main()
