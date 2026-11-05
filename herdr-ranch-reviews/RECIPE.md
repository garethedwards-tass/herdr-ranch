# Reviews · Herdr Ranch

Comment on a Markdown file, or on an agent's last message, in Herdr, and send the comments back to the agent.

An agent runs `ranch-review annotate <file>` (or `ranch-review last`); in Claude Code you start it with `/herdr-ranch-review <file>` or `/herdr-ranch-review-last`. The agent shows under Needs you until you answer; going to it (or, by setting, the moment it's asked) opens the review as a tab of its own (or, by setting, as a dialog over Herdr); the command waits until you send, approve or discard, then prints the outcome for the agent.

## What you see

### The review (a tab, or a dialog)

- **Header:** the file name (or "Last message"), the agent and its state ("agent waiting", "waiting", "sent", "not delivered") and the path, a search box (**⌘F**), a **Rendered | Source** toggle (an eye and `</>` icon, named on hover; Lucide icons written to `data/herdr-ranch/icons` at start, since `svg()` cannot read a linked mod folder), **Discard** (the agent gets nothing back), then **Approve as is** (no comments) or **Send N comments**, and **×**. Each button explains itself on hover. **⌘⇧↵** does what the main button shows. **×** only closes the tab or dialog: the review keeps waiting, with its unsent comments, in the list.
- **The document, left:** rendered Markdown, one row per block (heading, paragraph, list item, code, quote, table). Each list item is its own block. Its source lines and the numbers of its comments (or 👍) show on the right. A click on a block opens a comment on it; a block with a comment opens that comment. Dragging over rendered text selects it (⌘C copies it); a drag or a double-click does not open a comment (decided on release: pressed and released on the same block, within 4 px, single click). The mod doesn't handle a right-click: select the text and copy it instead. Source shows the plain lines.
- **Search:** typing in the header's box (**⌘F** focuses it) highlights the matches in every block, case-insensitive, with "N matches" beside the box (`countMatches`). No jump to a match: see Watch out. Rendered matches the text you see (no link targets or `*_#>` markers) and highlights each match by wrapping it in `<mark>` (`markHits`: not inside code spans, code blocks, link targets or tags; a match across Markdown markers isn't highlighted); Source matches the Markdown and highlights each match in its line. **Esc** (outside a comment box) or **×** clears it. `matchBlocks` and `hitsIn` in `reviews.js`.
- **The comments, right:** one card per comment, block comments by line and then by when they were added, general comments last. A click on a card edits it and outlines its block. **+ General comment** for the whole document.
- **The comment box:** a text area (⌘↵ saves, ⌘⇧↵ saves and sends), **👍** (block comments: a quick "Ok" note instead of a text, named on hover), **Cancel**, **Save**. ⌘V with an image on the clipboard adds a screenshot as a thumbnail (× removes it); the agent gets its path.
- **After sending:** the tab or dialog closes. When the agent didn't take the feedback, the review shows "not delivered" with **Copy feedback**.

### The list (the Reviews button)

- **Header:** "Reviews", the shown space's name (or "every space"), **This space | All** (remembered), a cog, ↻, and × when open as a window. A review is in a space when its agent runs there, its folder is the space's folder or inside it, or it ran in another worktree of the space's repository (the same `git rev-parse --git-common-dir`, recorded by the CLI as `repo`; for older reviews, a folder under `~/.herdr/worktrees/<repo>/`).
- **Waiting on you:** open reviews, newest first, with what, the agent, and "asked 5m ago". A click opens the review.
- **Sent:** the newest sent reviews (as many as the cog says), with "done 1h ago" and their comment count. Approved and discarded reviews are not listed.
- **×** on a row turns into a red confirm (**Discard** for an open review, **Remove** for a sent one) with **Cancel**.
- **Button count** (mod-buttons): open reviews, through `shared("mod-badges")["herdr-ranch-reviews"]`.

### The cog

**Opens:** On agent focus (the default: the agent shows under Needs you, and going to it opens the review) | Immediately (the review opens right away). **Shows in:** Tab (the default: a tab of its own in the shown space, named "Review: <title>") | Modal (a dialog over the window). **Sent shown:** None | 10 | 25 | 50. Stored in `shared("mod-settings")["herdr-ranch-reviews"]` (`open`, `view`, `sent`, `scope`).

**Keys:** Cmd+Shift+I opens Reviews (`keys.json`).

**Needs:** Node.js 18+ for the CLI, and macOS for screenshots (AppleScript reads the clipboard). Optional: the [mod-buttons](../mod-buttons/RECIPE.md) layout for the **Reviews** button.

## How it behaves

- **`ranch-review annotate <file> [--json]`** and **`ranch-review last [--stdin] [--json]`** (`bin/ranch-review.mjs`, linked to `~/.local/bin` by `install.sh`). The skills `/herdr-ranch-review` and `/herdr-ranch-review-last` (`skills/`, linked to `~/.claude/skills`) run them and tell the agent how to handle each outcome.
- **The agent:** `HC_TERMINAL_ID` names its terminal; `herdr-app ls` gives its pane, app, space and tab. When `ls` answers nothing (seen with herdr-app 0.1.11), `hc ls --json` gives the app, the review opens beside the focused pane, and the mod fills in the space and tab from Herdr's `agents()`.
- **A review** is a JSON file in `~/.config/herdr-app/data/herdr-ranch-reviews/<id>.json`: the text, the agent, `status` (open, sent, approved, dismissed), the unsent comments (`draft`), the result, and the waiting CLI's process id. Screenshots go to `img/` next to it.
- **Needs you:** the CLI finds the agent's terminal device (the first process up from it with a tty, `ps -o ppid=,tty=`) and writes the agent's status there as OSC 7501, the way Claude Code reports its own: `ESC ] 7501 ; state=blocked:app=<app>:kind=question:msg=<base64 "Review <title> in Herdr"> BEL`, and `state=working` once the answer is in. A record with its own `id` would not show in the Agents panel, so it is the agent's main status; the agent's next report replaces it.
- **Going to the agent opens it:** the watcher checks the focused agent every 400 ms (`agents()`); moving to another agent that a review waits for (a click under Needs you, `agent.next`, a click on its pane) opens that review, once per review: a review that opened already (on arrival, or right away) doesn't open again when you come back to its agent; reopen it from the Reviews list. A new review whose agent is the focused one opens right away. Moving into a dialog (no agent focused) doesn't count as leaving.
- **Opening:** `"background": true` in `mod.json` gives the mod an invisible copy in the mod-buttons layout (a 0 px block with `props.background`). That watcher writes a heartbeat (`.watcher` in the reviews folder, every 20 s), sees a new review file with `watchFolder`, fills in the agent's space and tab from `agents()`, updates the count, and opens the review (a tab, or a dialog 1240 px wide and 90% high) when its agent is focused or with **Immediately**, once across copies (compare-and-swap on an `announced` flag in the file). Without a fresh heartbeat (another layout), the CLI splits a launcher pane beside the agent that does the same and closes itself.
- **A review's tab:** `tab.new { name, mod, props: { review, tabbed: true } }`. `run` returns no id, so the page records its own tab on open (the shown tab with a Reviews pane that no other review owns) in `shared("herdr-ranch-reviews-tabs")` as `{ [doc key]: tab id }`. Opening a review whose document has a live tab selects it (and its space); closing the review closes the tab with `tab.close { confirmed: true }`. The launcher only closes Reviews panes in tabs that existed before it opened the review and aren't a review's.
- **One review per document:** `docKey` in `reviews.js`: a file by its absolute path, a last message by its agent's terminal. A new `ranch-review` takes over the unsent comments of an open review of the same document (`carryDraft`: a block comment follows the first block that still starts with its quote, else it becomes a general comment that names its old lines), then marks the older one `dismissed` with `supersededBy: { id, terminal }`. The older CLI prints "A newer review of the same document replaced this one." (`--json`: `{ "decision": "superseded", "by" }`) and leaves the agent's status alone when it's the same agent. The watcher does the same for older duplicates. The list shows the newest review per document. A tab or dialog is per document (`shared("herdr-ranch-reviews-tabs")` and `-dialogs`, keyed by `docKey`): opening a review of a document that has one selects it, and its page switches to the newest review (`ReviewPage.follow`) with a toast.
- **⌘⇧↵:** a key binding (`cx.bind_keys`, context `RanchReview`) to the action `ranch_review_send`, so it works inside the comment box too. **⌘F** is bound the same way to `ranch_review_find`.
- **Nobody waiting:** a `ranch-review` that is stopped (SIGTERM, SIGINT, SIGHUP: the agent's call stopped or timed out, Ctrl+C, the session ended) closes its review as abandoned (`status: "dismissed"`, `result.decision: "abandoned"`, `abandon` in `reviews.js`) and exits 130; the handlers are set before the review file is written. One killed without a signal leaves its review open with a dead `waiting.pid`: the list marks it (`orphaned`, checked with `kill -0` on every list load) under **Nobody waiting**, greyed, with **Dismiss**; it doesn't count on the Reviews button, isn't opened on agent focus, and its page header says "nobody is waiting". The CLI's `prune` closes such reviews as abandoned on its next run. An open review shows its age in the list ("open for 3 h 47 min", `openFor`).
- **Reviewed again:** `ranch-review annotate` on a file you already sent feedback on stores the text of that newest `sent` review as `base: { id, text, sentAt }` (left out when it would make the file too big). The page then marks new or changed blocks (a green bar and "new"; `changedBlocks` compares kind and trimmed text, each earlier block matching once) and folds runs of two or more unchanged blocks into one row ("⋯ 12 unchanged blocks, lines 30-88"; a click opens it, `foldRuns`). Blocks with comments, the block being commented and search hits always show. A banner says how many blocks changed, with **Show all** / **Fold unchanged**.
- **Delivery:** the review saves the answer (compare-and-swap) and closes. A waiting CLI checks the file every 400 ms, marks it `delivery: cli` (or removes an approved or discarded review), and prints the outcome: the feedback, "The user approved.", or nothing (discarded); `--json` prints `{ decision, feedback, annotationCount }`. When no CLI waits any more, the watcher delivers it: it claims the review (`delivery: pasting`), pastes "I reviewed … in Herdr." plus the feedback into the agent's terminal once it is idle (`hc send --if idle`, retried for 2 minutes), and records `pasted` or `kept`. A kept one shows as "not delivered" in the list, with **Copy feedback**. The CLI writes the file only when it still holds what it read, so it never undoes the mod's last write. Without a watcher (another layout), the dialog delivers it before closing.
- **Feedback text:** `# File Feedback` (or `# Message Feedback`), "I've reviewed this file and have N pieces of feedback:", then per comment `## 1. (lines 3-4) Feedback on: "…"` or `## 2. General feedback about the file`, the comment as `> ` lines, `> Screenshot: <path>` per screenshot, and `---`. It is the format [Plannotator](https://plannotator.ai) uses, so agents that know it keep working.
- **The last message:** Claude Code: the session's transcript (`CLAUDE_CODE_SESSION_ID`, else `~/.claude/sessions/<pid>.json`, else the folder's newest transcript), the last assistant message with text. Codex: the newest rollout log under `~/.codex/sessions` for this folder. Anything else: `--stdin`.
- **Clean-up:** each CLI run removes finished reviews and screenshots older than 7 days (`KEEP_DAYS`).
- **Refresh:** `watchFolder` on the reviews folder, and every 30 seconds.

## Built from

- `bin/ranch-review.mjs` (the CLI), `mods/herdr-ranch-reviews/main.js` (the list and the dialog), `mods/herdr-ranch-reviews/reviews.js` (blocks, feedback text, transcripts; shared by both, tested in `tests/reviews.test.mjs`).
- `skills/herdr-ranch-review/SKILL.md`, `skills/herdr-ranch-review-last/SKILL.md`.
- The repository's `shared/` copied in, like every Herdr Ranch mod; Reviews uses `update.js`, for the cog's footer (the Herdr Ranch version, and **Update** or **Check**), as in Issues and Pull requests.
- `mod.json`: `place: none`, a window overlay (70% × 85%), `button: { label: "Reviews", icon: "reviews.svg", opens: "panel", order: 35 }`.
- herdr: `openOverlay`, `closeOverlay`, `run` (`pane.close`, `tab.new`, `tab.select`, `tab.close`, `space.select`), `spaces`, `panes`, `props`, `exec`, `hc`, `readTextFile`, `writeTextFile`, `watchFolder`, `appHome`, `notify`, `shared`, `setShared`, `theme`.
- gpui-base: `TextView.markdown`, `TextareaState` / `Textarea`, `InputState` / `Input`.

## Watch out

- **Selection is copy only:** a mod can't read what's selected in a `TextView`, so a comment is still on a whole block, not on the selected words. Herdr's `TextView` paints its selection over the text, so an opaque theme `selection` hides it: a translucent one in `settings.json` fixes that (`"colors": { "selection": "#3b82f640" }`; Herdr accepts `#rrggbbaa` there). Source view shows plain lines, which can't be selected.
- **No scroll to a block:** search can't jump to a match, and clicking a comment outlines its block without scrolling to it. A mod can scroll from code only a `v_virtual_list` or `uniform_list` (fixed row heights); Herdr ignores `track_scroll` on the lazy `list` (rows of any height), and a plain scroll area has no handle (checked in herdr-app's `list.rs`, 2026-11-05).
- **Local spaces only:** remote spaces are [#2](https://github.com/jslowack/herdr-ranch/issues/2).
- **No code review:** Reviews is for documents and answers, not diffs.

## Done when

- `herdr-app check mods/herdr-ranch-reviews` passes and `cd tests && npm test` passes.
- `/herdr-ranch-review README.md` in Claude Code opens the dialog beside the agent; a comment and **Send** return `# File Feedback` to the agent.
- `/herdr-ranch-review-last` opens the agent's last answer; **Approve as is** returns "The user approved.".
- Stopping the agent's command, then sending, pastes the feedback into its prompt.
