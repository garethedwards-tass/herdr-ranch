# Files

Herdr's Files panel with syntax colors: a file `ranch-highlight` knows (CFML with cfscript and `<cfquery>` SQL, JavaScript, TypeScript, SQL, Python, Go and the rest of its languages) opens colored by tree-sitter, the way the diff views color code. Behind the tab bar's **Files** button in the mod-buttons layout, in place of Herdr's own.

`main.js` is a copy of Herdr's `files` mod (Herdr 0.1.15) with a few marked changes, so its browsing stays as Herdr has it: the focused pane's folder, folders opened lazily, git status colors, read-only previews.

## What you see

- **The tree:** as in Herdr's Files (Herdr's own chevron, folder and file icons).
- **A file the helper knows:** a read-only view with line numbers in the terminal font, plain at once and colored when the helper answers. Colors as in the diff views: keywords `ansi5`, strings `ansi2`, comments `dim`, functions and properties `ansi4`, types and attributes `ansi3`, numbers and constants `ansi6`, tags `ansi1`.
- **Editor | Colors** in the file's header (only for a colored file): **Editor** switches to Herdr's own editor on the same text, for selecting and copying; the choice is remembered.
- **Other files**, files over 50,000 lines, and every file when the helper isn't installed: Herdr's editor as before.

## How it behaves

- **The helper:** `~/.local/bin/ranch-highlight`, else `ranch-highlight` on the PATH, asked once per session for its languages (`--languages`). A file is colored when its extension is one of them, or it is `.bashrc`, `.zshrc`, `.profile` or `.bash_profile`.
- **Colors:** the text (at most 400,000 characters, as Herdr's preview) goes to the helper in a request file under `data/herdr-ranch/highlight/` (`--requests`, since Herdr's `exec` has no stdin), which is removed after. Tabs count as 4 spaces. The file may be on another machine: its text is read there and colored here.
- **The view** is a `list` (one row per line), so long files scroll without building every line.

## Built from

- `mods/herdr-ranch-files/main.js`: a copy of Herdr's `mods/files/main.js` (0.1.15). Its changes, each marked `ranch:`: the import of `code-view.js`; `COLOR_LINES` and the remembered view mode; loading a file keeps its text and, for a language the helper knows, its lines and then its spans; `editor()` makes Herdr's editor only when shown; `setMode()`; the **Editor | Colors** button; the body shows the colored view or the editor. After a Herdr update: copy its `files/main.js` again and re-apply these.
- `code-view.js`: `supports`, `expand`, `highlight` (tested in `tests/files.test.mjs`), and `codeView`.
- `mod.json`: `place: none`, `cloned_from` Herdr's `files` 0.1.15; the mod-buttons layout's `files` block shows it.
- herdr: the copy's own, plus `appHome`, `home`, `writeTextFile`, `settings`. Programs: `ranch-highlight` when installed, `mkdir`, `rm`.

## Watch out

- Icons are Herdr's (`mods/files/*.svg`): `svg()` can't read a linked mod folder, and Herdr's Files folder is a real one.
- Herdr's own Files panel and this one are both installed; the layout shows one.

## Done when

- `herdr-app check mods/herdr-ranch-files` passes, and the mod-buttons layout's **Files** button shows it.
- A `.cfc` or `.js` file opens colored; **Editor** switches to Herdr's editor and back; a `.txt` file opens in Herdr's editor.
