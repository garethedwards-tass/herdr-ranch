# History

The git commit history of the repository you're working in, in a side panel next to Files and Changes: newest first under a heading per day, searchable across the whole history, and each commit's changes as diffs, unified or split.

## What you see

- **Header** (as in Pull requests): **History** (semibold), the repository folder's name and branch (`dim`, "· Refreshing…" while it reloads, "· detached" off a branch); the search box (220px, inline from 720px wide, else its own line), and ↻ (Herdr's spinner while loading or searching). Under it the filters **All | Mine | Merges | Recent** and, on the right, **This branch | All branches**.
- **List:** a heading per day ("Today", "Yesterday", "Fri, 7 Nov 2026") with its count, then a row per commit (body text size + 17px high, rounded, hover `hover`, the keyboard's highlight `selected`): ○ (⑂ in `ansi5` for a merge), the 7-character sha in the code font (`dim`), the title (merges `muted`), up to 2 ref pills (branches `ansi2`, remote branches `ansi4`, tags `ansi3`), the author from 520px wide, and the age.
- While a search is on, a line under the header says what's happening: "Searching the whole history…", "n in the whole history", or the error (`ansi1`).
- **Footer:** ↑ ↓ move, ↵ open, Esc clear (while searching).
- **A commit:** a `surface` card with **← History** (Esc), ↑ ↓ for the newer and older commit, **Copy sha**, the title, the message body (code font, cut at 1500 characters), "author committed 2d ago", the sha and its refs; under it the commit's files as the Pull requests Files tab shows them (`files-tab.js`): Unified | Split (`S`), Expand all (`E`), a card per file with its diff. No Viewed and no GitHub link.
- **Linked** (in the commit card, when there is any): a button per pull request that contains the commit (`PR #12 · title`), per issue it closes (`Issue #4`) and per ticket key in its message (`TASS-123`); a click opens it in Pull requests or Issues.

## How it behaves

- **Which repository:** the focused terminal's live folder (`focused().cwd`), on its space's machine, through `git rev-parse --show-toplevel --abbrev-ref HEAD`. When the panel itself has the keyboard (no focused folder), it stays on the last repository. Outside a repository: "The focused terminal isn't in a git repository."
- **Loading:** `git log --max-count=300 --date=iso-strict --format=<fields split by \x1f, records by \x1e>` (with `--all` for All branches). Every 4 s a cheap check (`git rev-parse HEAD`, or `git for-each-ref` of heads and remotes) reloads the log only when it moved.
- **Search:** typing filters the loaded commits at once (every word must match the sha, title, author or refs; a word with a capital is case-sensitive). After a 450 ms pause git searches the whole history and its answer replaces the list (up to 300): plain words run `--grep` and `--author` as two searches merged newest first (git ANDs the two), `-i -F`. Prefixes: `author:`, `message:` (or `msg:`), `path:` (a file or folder at any depth, `:(icase,glob)`), `code:` (`-S`, reads every diff, up to 60 s), `since:`/`after:`, `until:`/`before:`; quotes keep a phrase; 4 to 40 hex digits find that commit first. Changing the branch scope runs the search again.
- **Filters** (on top of the search): Mine (author is `git config user.name`), Merges, Recent (the last 7 days).
- **A commit:** `git show -s --format=%B` for the message, and `git show --format= --patch --no-color --no-ext-diff -M --first-parent --diff-merges=first-parent` for its files (a merge against its first parent, as GitHub shows it), parsed into the Files tab's shape (`parseShow`, then `prepareFile` from `diff.js`). The last 30 commits are kept. Files open by themselves up to 800 lines; Expand all opens up to 2500.
- **Keys:** list: ↑ ↓ move the highlight, ↵ opens, Esc clears the search. A commit: ↑ ↓ or `[` `]` newer and older, `S` unified or split, `E` expand or collapse all, Esc or ⌫ back.
- **Linked** (`xref.js`, shared with Pull requests and Issues): the pull requests from `gh api repos/<github>/commits/<sha>/pulls` (the GitHub repository is Link space's, else the `origin` remote's) and from the title (`Merge pull request #n`, `(#n)` at the end); closing refs (`fixes|closes|resolves #n`); ticket keys, only the linked Jira or Linear prefix when Link space names one (any case), else any `KEY-123` except words like UTF, SHA, ISO, RFC. A click writes shared `ranch-open` and shows that mod (its side panel, its tab, else a new tab).
- **Opened from elsewhere:** Pull requests and Issues ask for `{ sha }` or `{ search }` with `{ cwd, on }`. History shows that repository (until the focus moves to another folder), opens the commit (`git log -1 <sha>`; a toast says to fetch when the checkout lacks it) or runs the search.
- Read only: nothing but `git rev-parse`, `git for-each-ref`, `git log`, `git show`, `git remote get-url origin`, `git config user.name`, and `gh api` for the pull requests of a commit.

## Built from

- `mods/herdr-ranch-history/main.js` (the panel), `git.js` (git calls, `parseLog`, `parseShow`, `searchArgs`, `search`), `ui.js` (text sizes, button, pill, arrow, segmented control), and copies of the Pull requests mod's `diff.js` and `files-tab.js` (the diff view).
- `mod.json`: `place: none`, `focusable`, `button: { label: "History", icon: "history.svg", opens: "panel", order: 5 }` for mod-buttons; `history.svg` is Lucide's `history` (ISC).
- herdr: `focused`, `spaces`, `theme`, `settings`, `exec`. Programs: `git`.

## Watch out

- `--grep` and `--author` together mean both, not either: plain words need two searches.
- `--max-count` after `-1` wins: put `-1` last when looking up one sha.
- `code:` is slow on a large history (about 14 s on tassweb's); say so while it runs.
- Minified files put a whole file on one line: `diff.js` cuts lines at 500 characters.
- `svg()` can't read a linked mod folder, so the History button's icon comes through mod-buttons' own copy.

## Done when

- `herdr-app check mods/herdr-ranch-history` passes, and the mod-buttons tab bar shows **History**.
- With a terminal in a repository focused, History lists its commits by day; ↵ on one shows its message and diffs; `S` switches to split.
- `author:<you>` lists your commits from the whole history; a 7-character sha finds that commit; `path:<file>` lists the commits that touched it.
- **Mine** and **Merges** narrow the list; **All branches** shows other branches' commits with their ref pills.

- **Jira ↗** follows each ticket key in Linked when a Jira site is known (Link space's, else the one most spaces link to; not for a Linear team's keys) and opens `https://<site>/browse/<KEY>`.
