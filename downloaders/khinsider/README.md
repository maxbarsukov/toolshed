# KHInsider - Album Downloader

`khinsider_dl.py` downloads a whole album from **[downloads.khinsider.com](https://downloads.khinsider.com)** given just the album-page URL.

For each album it:

1. Creates a folder named after the album (next to the script by default).
2. Downloads the cover art as `cover.jpg` and generates a multi-size `cover.ico`.
3. Visits every track page and downloads `mp3` and `flac` (whichever the site offers), keeping the site's own file names.
4. Writes the **in-album track number** into each file's metadata.

## Track numbering

The number written to the tag is the position within the *album*, not just the track index:

| Album type | Number | Example |
|---|---|---|
| Single disc | plain track number | track 7 -> `7` |
| Multi-disc | `disc * 1000 + track` | disc 1 track 1 -> `1001`, disc 2 track 73 -> `2073` |

Disc/track are read straight from the songlist table (a disc cell is a bare integer, a track cell ends with a dot), so the same logic covers both layouts. For multi-disc albums the real disc number is also written to the standard disc-number tag.

| Format | Track number tag | Disc number tag | Album tag | Title tag |
|---|---|---|---|---|
| mp3 | `TRCK` (ID3) | `TPOS` (multi-disc only) | `TALB` | `TIT2` |
| flac | `tracknumber` | `discnumber` (multi-disc only) | `album` | `title` |

The track/disc number is always (re)written. **Album and title are only filled in when the file has no value for them yet** - if a file already carries an album or title tag, it's left untouched. The title comes from the song name shown on the site; the album from the album-page heading.

## Requirements

- Python 3 (3.7+).
- `pip install requests beautifulsoup4 pillow mutagen`

## How to use

```
python khinsider_dl.py "https://downloads.khinsider.com/game-soundtracks/album/<slug>"
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--formats` | `mp3,flac` | Comma-separated formats to fetch. Use `--formats mp3` for mp3 only. |
| `--out` | script folder | Base folder to create the album folder in, e.g. `--out "D:\Music"`. |
| `--delay` | `0.5` | Seconds to wait between tracks. |

Example - mp3 only, into a chosen folder:

```
python khinsider_dl.py "<album URL>" --formats mp3 --out "D:\Music"
```

## Notes

- **Resumable.** Files already present with a matching size are skipped, and the track-number tag is (re)written even for skipped files, so you can safely re-run to top up a partial download.
- **Cover.** The full-resolution image linked on the album page is used, then flattened over white for the JPEG. The ICO is a centered square with sizes up to the source resolution (16–256 px).
- **File names** come from the site verbatim (e.g. `2-01. The Resurrection.mp3`), sanitized for Windows-illegal characters.
- If an album's cover markup differs (multi-disc front/back art), the **first** `albumImage` is used as the cover.

> [!NOTE]
> Only grab soundtracks you're entitled to. This is a personal convenience tool.
