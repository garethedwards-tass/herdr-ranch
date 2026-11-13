# Agents

Herdr's agents list with what Claude Code knows about each of its sessions, in the sidebar of the mod-buttons layout (its `agents` block), in place of Herdr's own `agents` mod. `main.js` is a copy of that mod (Herdr 0.1.15) with a few marked changes, so everything it does stays: priority and grouped sorting, pins, time since the last change, Herdr's sub-agent trees and folding, the narrow rail.

## What you see

- **Context chip** on each Claude Code agent on this computer, before its time: the context in use as a percentage (`dim`, `ansi3` from 60%, `ansi1` from 85%); its tooltip gives the tokens. A click opens the stats popup.
- **Stats popup** (at the pointer, 320 wide): the session's title; Model (`Opus 5.5 · medium effort`); Mode when not normal; Context (`364k of ~1.0M (36%)`) with a bar; This conversation: Replies, Output tokens, Input (new and from cache), Cost and Lines when Claude Code saved them (`cost-state`), Running for; Tasks (`☑ ◐ ☐`, n/m done); Subagents (`●` running, `✓` done; type and description). A note says where it comes from and that the window size is an estimate. Esc closes.
- **Under the agent's row** (unfolded, not on the rail): its task list as one row (`3/7` and the task in progress, or "All tasks done"; a click unfolds every task with its glyph), then each running subagent (spinner, type, description).

## How it behaves

- **Which session:** every 4 s, for each agent whose `app` is `claude-code` on this computer: Claude Code's live sessions (`sessions/*.json` in `~/.claude` and in every account's Claude Code folder from Spaces' shared `ranch-accounts`, read every 15 s) in the terminal's folder; with several there, the one whose title (`ai-title` or `custom-title` in its conversation) or name is the agent's title.
- **First read** of a conversation (`<that session's config folder>/projects/<folder, non-alphanumerics as ->/<session>.jsonl`, often tens of MB): one `sh` call with `grep` for the lines that matter (titles, mode, cost-state, TaskCreate/TaskUpdate/Agent calls and "Task #n created" results), the newest reply from the last 2 MB, and every reply's id and usage (`grep -o`), then the file's size.
- **After that:** only what was added (`tail -c +offset`, whole lines), every tick while the agent works, every 20 s otherwise. Subagents from `<session>/subagents/*.meta.json` (newest 8) and whether their call returned.
- **Counting:** a reply split over several records counts once (by its message id); subagents' own usage isn't included. Context is the newest reply's input, cache reads and cache writes. The window is 1M when the model was asked for with `[1m]` or the context is already past 200k, else 200k (Claude Code doesn't record it).
- **Tasks:** a TaskCreate gets its number from its result; TaskUpdate sets the status (or removes it when deleted).
- **Subagents:** done when `meta.json` says `finished`; without that, a foreground one is done when its call returned, a background one stays running.
- Read only. Nothing leaves the computer; only titles, statuses, task subjects, subagent descriptions and counts are kept.

## Built from

- `mods/herdr-ranch-agents/main.js`: a copy of Herdr's `mods/agents/main.js` (0.1.15). Its changes, each marked `ranch:`: the imports; `init` (the stats popup is a copy of its own; else `start()`); `withKids` adds `claudeRows()` after Herdr's sub-agents; `row` adds `statsChip()`; `render` returns `statsView()` for the popup. After a Herdr update: copy its `agents/main.js` again and re-apply these.
- `extras.js`: `start` (the watcher), `snapshot`, `statsChip`, `claudeRows`, `statsView`, `modelName`.
- `claude.js`: `liveSessions`, `configDirs`, `pickSession`, `projectDir`, `firstRead`/`parseFirstRead`, `readSince`, `apply`, `totals`, `windowOf`, `tokens`, `subagents`/`subagentOf`, `taskList` (tested in `tests/agents.test.mjs`).
- `mod.json`: `place: none`, no button: the mod-buttons layout's `agents` block shows it.
- herdr: `agents`, `terminals`, `home`, `exec`, `openOverlay`, `closeOverlay`, and the copy's own. Programs: `sh`, `grep`, `tail`, `head`, `wc`, `ls`, `tr`, `sort`.

## Watch out

- Claude Code's files are internals, not an API: a new version can rename a record. Everything reads what fits and leaves the rest out; check the popup after a Claude Code update.
- Only this computer: agents on other machines get no chip.
- Herdr's own `agents` mod writes the same pins and order: show only one of the two.

## Done when

- `herdr-app check mods/herdr-ranch-agents` passes, and the mod-buttons layout's sidebar shows it.
- Each Claude Code agent shows a percentage; its popup names the model and effort, and the numbers grow as it works.
- An agent that makes a task list shows `n/m` under its row, and a running subagent shows with a spinner until it returns.
