# Smoke Test: Google Drive Import (File-Only)

## Preconditions
- User has access to the target section/document.
- `gdrive-import` function is deployed and active.
- A valid Google Drive **file** URL or file ID is available (not a folder link).

## Quick Checks
1. Open a section and find any document row.
2. Verify new Drive icon button `Import` is visible next to `Pliki`.
3. Click `Import` and paste a Google Drive **file** URL.
4. Choose destination mode:
   - `current` -> file is added to the same document (`Pliki`).
   - `new` -> provide subfolder name; file imports into newly created subfolder flow.
5. Confirm success toast shows `Imported 1/1` (or expected count) with `run_id`.
6. Open `Pliki` and verify imported file is present and downloadable.

## Negative Checks
1. Paste a Google Drive folder URL.
2. Verify warning/error says only file links are supported (no folder import).
3. Confirm no unexpected logout occurs.

## Regression Checks
1. Upload a local file manually via `Pliki` and verify it still works.
2. Download section ZIP and confirm newly imported files are included.
