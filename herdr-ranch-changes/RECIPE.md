# Changes

The uncommitted changes of the repository you're working in, in the side panel behind the tab bar's **Changes** button: every changed file as a card with its diff, unified or split and syntax highlighted, and a commit box, in place of Herdr's own Changes panel.

## What you see

- **Header:** **Changes** (semibold), a pill with the number of files ("300+" when capped), the repository folder's name and branch (`dim`), the total `+add` (`ansi2`) and `−del` (`ansi1`), and ↻ (Herdr's spinner while loading).
- **Files:** the Pull requests Files view (`files-tab.js`): **Unified | Split** (`S`), **Expand all** (`E`), "n files", then a card per file: ▾ or ▸, the path in the code font, an added or deleted pill, `+add −del`, and its diff with line numbers, hunk headers and colors from `ranch-highlight` (plain until they come, and without the helper). No Viewed and no GitHub link.
- "The focused terminal isn't in a git repository." outside one, "No uncommitted changes." when clean.
- **Commit box** (as Herdr's own): a message field (32px, rounded 8) and **Commit** (`solid` when there's a message and changes, else `raised`), "Committing…" while it runs, and git's error in `ansi1` above it.

## How it behaves

- **Which repository:** the focused pane's live folder, on its space's machine, found the way Herdr's own Changes panel finds it; when the panel has the keyboard, the last one stays. A 1.5 s check follows a change of folder.
- **Changes:** `git status --porcelain=v1 -z --no-renames --untracked-files=all` and one `git diff HEAD --no-ext-diff --no-textconv --no-color --no-renames` (against the empty tree before the first commit), parsed by `parseShow` and `prepareFile` (`diff.js`). New files are read from disk and shown as all-added (first 1500 lines); a binary one says it has no diff. At most 300 files. Every read runs with `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`, so it writes nothing under `.git` and doesn't wake its own folder watch.
- **Refresh:** `watchFolder` on the repository (this computer), else every 10 s; a refresh asked for while one runs runs after it.
- **Open files:** the first files open up to 800 lines; Expand all opens up to 2500; a file keeps its open state across refreshes.
- **Colors:** `highlight.js` with the old side from `HEAD` (a git blob) and the new side from the file on disk; a file whose hunks didn't change keeps its colors across refreshes.
- **Commit:** `git add -A`, then `git commit -m <message>`, as Herdr's own panel does; a toast says it's done.
- **Keys:** `S` and `E` (not while typing the message).

## Built from

- `mods/herdr-ranch-changes/main.js` (the panel), `git.js` (`repoOf`, `parseStatus`, `addedPatch`, `changes`, `commitAll`), and the diff view's files, copied from Pull requests (`diff.js`, `files-tab.js`, `highlight.js`) with `ui.js` from History. A test checks the copies stay the same.
- `diff-list.js`: the diff list as a retained child view (`DiffList`), redrawn only when the panel calls `redraw(cx)` after a change to the diff (files, colors, open, more, mode), not on every live change. History keeps an identical copy.
- `mod.json`: `place: none`, `focusable`, no button: the mod-buttons layout's `changes` block shows it.
- herdr: `focused`, `spaces`, `panes`, `theme`, `settings`, `exec`, `readTextFile`, `writeTextFile`, `watchFolder`, `notify`. Programs: `git`, and `ranch-highlight` when installed.

## Watch out

- A plain read refreshes the index and writes under `.git`, which the folder watch sees: keep the read flags.
- `--no-renames` in both status and diff, so their paths agree.
- Herdr's `exec` has no stdin: the highlighter's requests go through a file.

## Done when

- `herdr-app check mods/herdr-ranch-changes` passes, and the **Changes** button of the mod-buttons layout shows it.
- In a repository with an edited file, a staged file and a new file, all three show with their diffs, colored when `ranch-highlight` is installed; `S` switches to split.
- Saving a file shows its change within a moment; Commit with a message commits everything and the list empties.
