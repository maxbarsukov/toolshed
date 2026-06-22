# Cell to Singularity — Save Editor

`patch_save.py` edits the in-game currency amounts in a local **Cell to Singularity** save. The save files are .NET BinaryFormatter (NRBF) serialized; currency amounts are stored as plain strings, and the script rewrites them in place without breaking the file structure.

## Supported currencies

| Name in script  | Internal key | Currency |
|---|---|---|
| `entropy`        | `bank`   | Entropy        |
| `ideas`          | `bank_b` | Ideas          |
| `darwinium`      | `bank_c` | Darwinium      |
| `metabits`       | `bank_d` | Metabits       |
| `mutagen`        | `bank_e` | Mutagen        |
| `fossils`        | `bank_f` | Fossils        |
| `idea_metabits`  | `bank_g` | Idea Metabits  |
| `bank_h`         | `bank_h` | (unconfirmed)  |

> [!NOTE]
> **Logits** are not stored in the `bank*` system and were not located in the save, so they are not editable here yet.

## Where the save files live

Depends on the platform. Typical path (Windows, standalone / Steam):

```
C:\Users\<NAME>\AppData\LocalLow\Computer Lunch\Cell to Singularity
```

Quick way to open it: press `Win+R`, paste
`%LocalAppData%Low\Computer Lunch\Cell to Singularity`, hit Enter.

The folder contains `savedGames.gd`, `savedGames2.gd`, `savedGamesDeepBackup.gd`, `savedGamesBackup_1.gd`, etc. The game loads `savedGames.gd`; the others are backups. The script patches several of them by
default so the change is picked up regardless of which one loads.

## Requirements

- Python 3 (3.6+). Check with `python3 --version` (or `python --version`).

## How to use

1. **Fully close the game.** Otherwise it overwrites the files on exit and your
   edits are lost.
2. Copy `patch_save.py` into the save folder (or open a terminal there).
3. **See current values:**
   ```
   python3 patch_save.py --show
   ```
4. **Set the values you want** — open `patch_save.py` in a text editor and edit
   the `CHANGES` block near the top. For example:
   ```python
   CHANGES = {
       "darwinium":     "10000000000",   # 10^10
       "metabits":      "1000000000",
       "fossils":       "1e12",
       "idea_metabits": "1000000",
   }
   ```
   Each value is a string. Plain (`"50000"`) or scientific (`"1e40"`) both work — the game accepts both.
5. **Apply:**
   ```
   python3 patch_save.py
   ```
   A `*.bak` backup is created next to each edited file.
6. Launch the game and check.

### Targeting specific files
```
python3 patch_save.py savedGames.gd savedGames2.gd
python3 patch_save.py --show savedGames.gd
```

## Steam Cloud note

If you play on Steam with **Steam Cloud** enabled, the cloud may revert local
edits. Either:
- disable Cloud for the game before editing (Steam → right-click the game → Properties → General → uncheck "Steam Cloud"), edit, then launch and let it save; or
- edit while offline and let the cloud sync the new (larger) value afterward.

## Reverting

The script writes a `.bak` for every file. To undo, delete the modified file and
rename `savedGames.gd.bak` back to `savedGames.gd` (and so on).

## ⚠️ Leaderboard warning

Editing currencies can get your account **flagged as a cheater**. Cell to Singularity syncs your save to a server backend (PlayFab — visible in `Player.log`), which validates progress. Sudden, implausible currency jumps (e.g. darwinium going from 10 to 10^10 with no matching playtime/progression) trip the check.

Once flagged, during events you are placed into the dedicated **cheater division #666**, where your position is periodically reset, making good placements and event/logit rewards effectively impossible. Community reports describe this flag as essentially permanent.

If you only care about a single-player/offline experience and don't play ranked events, this likely won't bother you. If you compete in events or care about the leaderboards, **don't do this on your main account.**

## How it works

Each currency value is a `BinaryObjectString` record (`06 <id:int32> <len:varint> <utf8 bytes>`) sitting right after its key string (`bank_c`, etc.). The script finds the key, takes the following value string, and rewrites its length + content.

## Disclaimer

This edits your own local single-player save. Back up the folder before use. Changing currencies may affect achievements/progression balance — use at your own risk.
