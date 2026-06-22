# Vampire Survivors - Save Editor

A single self-contained HTML page that edits the local **Vampire Survivors** save (`SaveData.sav`, plain JSON) and fixes its checksum automatically.

## Features

- **Visual editor (schema-driven).** Widgets are inferred from your save's own field types, so it keeps working across game/DLC updates without a hardcoded list.
- **Text (JSON) editor** with live validation.

## Save file location

| OS | Path |
|---|---|
| Windows | `%appdata%\Vampire_Survivors_Data\SaveData.sav` |
| macOS | `$HOME/Library/Application Support/Vampire_Survivors_Data/SaveData.sav` |
| Linux | `$HOME/.config/Vampire_Survivors_Data/SaveData.sav` |

## How to use

1. **Close the game** (it overwrites the file on exit).
2. **Back up** with the *Backup* button (or copy the file).
3. Open `vampire-survivors-save-editor.html` in browser, load your save, edit.
4. *Download save* -> replace `SaveData.sav`.
5. Launch and check.

## Notes

- Tested on version `1.12`.
- Steam Cloud can revert local edits - disable Cloud for the game while editing.
