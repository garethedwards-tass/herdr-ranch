# Changelog

Versions of the Herdr Ranch suite: the Issues, Pull requests and Reviews mods and the mod-buttons layout share one version. The cog in Issues and Pull requests shows the installed version and offers **Update** when a newer release exists.

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
