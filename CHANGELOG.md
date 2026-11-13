# Changelog

Versions of the Herdr Ranch suite: the Issues, Pull requests and Reviews mods and the mod-buttons layout share one version. The cog in Issues and Pull requests shows the installed version and offers **Update** when a newer release exists.

## Unreleased

- **Spaces:** Collapse all / Expand all in the header; icons and text line up level by level in the tree, with a boxed terminal icon for shells; worktrees without a space have their git state read at most once a minute (those with a space on every change), instead of two git runs per worktree on each change.
- **Spaces:** each space folds (▸/▾) with its agents and terminals (each with its program's icon, its folder and branch only when they differ, and a peek eye), its worktree spaces and its worktrees without a space under it. A fixed-width **git chip** shows the branch and state, colored (green ✓ in sync, amber uncommitted, red behind or diverged, blue to push), and opens a git popup; the link chip is the same width, grey **Link** when unlinked. **+** starts a space with a terminal or an installed agent, and a space starts new agents or terminals as its account. Git status and Switch branch are separate dialogs; Status lists uncommitted files and commits on no remote, and a click opens a diff. A worktree without a space opens a dialog with its details, Open in a new space (terminal or agent), Make a branch (when detached) and Delete.
- **Refresh buttons:** the refresh button in Changes, History, Issues, Pull requests and Reviews is an icon (Lucide's refresh-cw, like the cog beside it) at 13px (it looks the size of the 14px cog) and centered with it, instead of a small ↻ text glyph.
- **Files:** the Files panel in the mod-buttons layout colors code the way the diff views do (`ranch-highlight`: CFML, JavaScript, SQL and the rest), with **Editor** to switch to Herdr's own editor for selecting text. Other files open as before.
- **Accounts per space:** pick an account for a space in Spaces (right-click, **Account…**): a Claude Code login (its own config folder) and a GitHub account from `gh`. Worktree spaces follow their repository's. **New tab as** and **New Claude Code as** the account open terminals with `CLAUDE_CONFIG_DIR` and `GH_TOKEN` set (the token fetched inside the shell, never on a command line), and new worktree spaces start that way. Agents shows those sessions too.
- **Agents:** a new agents list in place of Herdr's own in the mod-buttons layout, a copy of it with Claude Code's own records added: each Claude Code agent shows the context in use (`36%`), and a click opens a popup with the model and effort, context, replies, tokens, cost and lines when saved, running time, tasks and subagents. Under the agent: its task list (`3/7` and the task in progress) and its running subagents. Read from `~/.claude`, read only.
- **Spaces:** a new spaces list in place of Herdr's own in the mod-buttons layout: each space's branch and ahead/behind, worktree spaces under their repository's space, and the repository's worktrees that no space shows yet, folded under "n worktrees without a space" (a click opens a space there). **Link space** and **New worktree** on the shown space, a chip with each space's link (Jira or Linear key, else the GitHub repository) that opens Link space, and a right-click menu with Link space, New, Open and Remove worktree, Rename and Close. Every checkout shows its outstanding work (`●` uncommitted files, `↑` commits not pushed). A worktree without a space has a right-click menu too: Create space here, Delete worktree (it says first what would be lost), Copy path. **New worktree** starts from a branch (local or remote, or a new one) or from an issue (your open Jira, Linear or GitHub issues, or a key you type), and opens a space on it; Herdr's own New worktree stays in the menu. A **Git** dialog per space or worktree (click its branch) shows its changed files, switches branches (with uncommitted changes it asks first: stash them, bring them along, or cancel; a failed switch puts a stash back), fetches and pulls (fast-forward, or with rebase); `↓n` on a row pulls at once. A click on a worktree without a space opens its Git dialog; making a space there is in its right-click menu.
- **Changes:** a new Changes panel in place of Herdr's own in the mod-buttons layout: every uncommitted file as a card with its diff, unified or split and syntax highlighted, staged and unstaged together against HEAD, new files as additions, and the same commit box.
- **Highlighting:** diffs in Pull requests (Files, Commits) and History are syntax highlighted by `ranch-highlight`, a small tree-sitter helper in Rust that `install.sh` builds when Rust is installed: CFML (with cfscript, `<cfquery>` SQL and embedded HTML, CSS and JS), JavaScript, TypeScript, TSX, JSON, HTML, CSS, SQL, Python, Java, C#, Go, Rust, PHP, Ruby, YAML, Bash and Markdown. Whole files are highlighted when the commits are in a local checkout, so a hunk inside a comment or a string colors right; otherwise the hunk lines are. Without the helper the diffs stay plain.
- **Pull requests:** the **Files** tab shows each file's diff, as on GitHub's Files changed: **Unified** or **Split** (old left, new right; `S` switches), with line numbers and hunk headers. A click on a file opens or closes it, **Expand all** (`E`) opens them all, and **Viewed** folds a file away until the next push. Large diffs show their first 400 lines with **Show more**. Read through `gh`, nothing is written to GitHub.
- **Pull requests:** a **Commits** tab (`4`) lists the commits by day with their checks. A click opens a commit's diff in the same view; `[` and `]` step to the older and newer commit, a click on a sha copies it.
- **Pull requests:** a **Pushed** filter lists the open pull requests with a commit in the last 7 days, latest push first, each with the age of its last push.
- **History:** a new panel with the git commit history of the repository you're in: by day, filters (Mine, Merges, Recent), this branch or all, a search across the whole history (`author:`, `path:`, `code:`, `since:`, a sha), and each commit's diffs, unified or split.

## v0.5.0

- **Reviews:** Mermaid and draw.io diagrams show as pictures: a ` ```mermaid ` block, a ` ```drawio ` block (or ` ```xml ` holding draw.io XML), and an image line pointing at a `.drawio`, `.drawio.svg` or `.dio` file. They render with the tools you have installed (`mmdc` from mermaid-cli, the draw.io app), once per diagram; without them, or when a diagram has an error, the block shows its code with the reason above it. **Source** still shows the text.

## v0.4.1

- **Reviews:** a review opens by itself only once. Coming back to its agent from another tab or space no longer opens it again; a new `ranch-review` call (a new review) still does, and the Reviews list always does.
- **Reviews:** a stopped `ranch-review` (the agent stopped it or its call timed out, Ctrl+C, the session ended) closes its review as abandoned and exits 130, so it no longer stays in the list as a review to answer. A review whose `ranch-review` is gone without a signal shows greyed under **Nobody waiting**, with **Dismiss**; it doesn't count on the Reviews button, and the next `ranch-review` closes it.
- **Reviews:** a file reviewed again after you sent feedback on it shows what changed since then: new and changed blocks are marked, and runs of unchanged blocks fold into one row (a click opens it; **Show all** in the banner opens them all).
- **Reviews:** open reviews in the list show how long they have been open ("open for 3 h 47 min").

## v0.4.0

- **Reviews:** a review opens as a tab of its own in the shown space instead of a modal dialog; opening it again selects that tab. The cog's **Shows in** setting switches it back to **Modal**.
- **Reviews:** one review per document. Asking again for the same file (or the same agent's last message) replaces the open review: the list shows one row, the tab or dialog already open switches to the newest version, and unsent comments move over (a comment whose block is gone becomes a general one). The replaced `ranch-review` prints "A newer review of the same document replaced this one." Older duplicates are cleaned up the same way.
- **Reviews:** search the document: **⌘F** or the box in the header highlights the matching words in every block, with the number of matches beside the box; Esc or × clears it.
- **Reviews:** select text in a rendered block and copy it with ⌘C. A drag or double-click selects; a single click still opens a comment on the block. Right-click no longer copies the whole block.
- **Reviews:** the header's **Rendered | Source** switch shows icons, and **👍 Looks good** in the comment box is just **👍**: the agent gets "Ok" on the block (shown on hover).

## v0.3.0

- **Pull requests:** a stack of dependent pull requests shows as one row with its layers under it, numbered from the bottom. A search or filter keeps the whole stack and greys the layers that don't match. **Agent review** on the stack row starts one agent on the whole stack: **Review stack**, or **Fix stack to merge** (needs `gh stack`) ([#9](https://github.com/jslowack/herdr-ranch/issues/9)).
- **Pull requests:** every open pull request shows its review state (`draft`, `needs review`, `approved`, `changes`), and **Agent review** opens on fixing your own pull request or stack, and on reviewing someone else's.
- **Pull requests:** a GitHub timeout (502, 503, 504) is retried once, and a second one no longer shows a red error over the list.
- **Pull requests:** the list refreshes about 40% faster: it asks GitHub how many checks pass, fail and run, instead of fetching every check run.

## v0.2.1

- **Reviews:** `/herdr-ranch-review @docs/foo.md` works: `ranch-review annotate` accepts the `@path` that Claude Code's file picker inserts.

## v0.2.0

- **Reviews:** comment on a Markdown file or an agent's last answer in Herdr, and send the comments back to the agent ([#1](https://github.com/jslowack/herdr-ranch/issues/1)). Comment per block or on the whole document, paste screenshots, give a 👍, right-click to copy a block. The waiting agent shows under Needs you, going to it opens the review, and the button counts it; This space or All. Cmd+Shift+I opens it.
- **Installed with it:** the `ranch-review` command (in `~/.local/bin`) and the Claude Code skills `/herdr-ranch-review` and `/herdr-ranch-review-last` (in `~/.claude/skills`), linked by `install.sh`. The feedback uses Plannotator's text format, so agents that know it keep working.
- **Pull requests:** the list and the page show GitHub avatars instead of initials ([#4](https://github.com/jslowack/herdr-ranch/pull/4)).
- **Updates:** the cog in Reviews shows the version and **Update** too ([#5](https://github.com/jslowack/herdr-ranch/pull/5)).
- **Removed: Inbox** (Plannotator's sessions) and **Review in Plannotator** on a pull request. Reviews replaces them; `install.sh` removes the old Inbox link.

## v0.1.0

The first release.

- **Issues:** Jira Cloud, Linear or GitHub issues per space, grouped by priority or in backlog order, with GitHub-style filters. A page per issue like GitHub's (timeline, sub-tasks, relations, linked pull requests) in a dialog, split or full view. Start agent with modes, model and effort, your own prompts, and `.worktreeinclude`.
- **Pull requests:** grouped by what each waits on, with checks, reviews and diff size. A page per pull request with tabs, a merge box and reviewers. Review with agent, and Review in Plannotator.
- **Inbox:** the open Plannotator sessions per space or all, opened in your browser, closed with ×. Refreshes when a session opens or closes, and when Herdr's window comes back to the front.
- **Link space:** connect Jira (classic API token) or Linear (personal API key), stored in the system's credential store; per-space GitHub repository.
- **mod-buttons layout:** a tab-bar button for every mod that declares one, with a count from the mod.
- **Recommended mods:** the README points to [Automations](https://github.com/DnzzL/herdr-automations); the mod-buttons layout gives it a button when it's installed.
- macOS, Linux and Windows (tested on macOS).
