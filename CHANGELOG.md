# Changelog

Versions of the Herdr Ranch suite: the Issues, Pull requests and Reviews mods and the mod-buttons layout share one version. The cog in Issues and Pull requests shows the installed version and offers **Update** when a newer release exists.

## Unreleased

- **Reviews:** comment on a Markdown file or an agent's last answer in Herdr, and send the comments back to the agent ([#1](https://github.com/jslowack/herdr-ranch/issues/1)). Comment per block or on the whole document, paste screenshots, give a 👍, right-click to copy a block. The waiting agent shows under Needs you, going to it opens the review, and the button counts it; This space or All. Cmd+Shift+I opens it.
- **Installed with it:** the `ranch-review` command (in `~/.local/bin`) and the Claude Code skills `/herdr-ranch-review` and `/herdr-ranch-review-last` (in `~/.claude/skills`), linked by `install.sh`. The feedback uses Plannotator's text format, so agents that know it keep working.
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
