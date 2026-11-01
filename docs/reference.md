# Reference

Facts and paths for the Herdr Ranch mods. How to use them is in the [guide](guide.md).

- [What they run and store](#what-they-run-and-store)
- [install.sh flags](#installsh-flags)
- [Keys](#keys)
- [Automations](#automations)

## What they run and store

- **Read only.** Nothing is written to Jira, Linear or GitHub. **Start agent** creates a local git worktree and branch; nothing is pushed.
- **Works on macOS, Linux and Windows.** Remote spaces run `gh` and `git` on their own machine.
- **Programs:**
  - `gh` and `git`;
  - `plannotator` (Inbox, Review in Plannotator), on the space's machine for remote spaces;
  - for the Jira and Linear sign-in: `security` (macOS), `secret-tool` (Linux) or PowerShell (Windows);
  - for Inbox: `ps` (that a process is Plannotator's before it is stopped), `lsof` (which port listens and a session's folder on macOS) and `readlink` (a session's folder on Linux, through `/proc`);
  - `open`, `xdg-open` or `rundll32` for the browser buttons;
  - `sh` in the mod-buttons layout, to list the installed mods.
- **Network:**
  - Jira: `https://<your-site>/rest/api/3` with your token;
  - Linear: `https://api.linear.app/graphql` with your API key;
  - GitHub only through `gh`;
  - the update check, once a day: `gh api repos/jslowack/herdr-ranch/releases/latest`, else `git ls-remote --tags https://github.com/jslowack/herdr-ranch`.
- **Stored:**
  - in the system's credential store, only after you press Connect: the Jira sign-in (item `herdr-jira:<site>`) and the Linear key (item `herdr-linear:linear.app`);
  - in Herdr's shared state: the space links, the lists' settings, your prompts and the last update check;
  - in the mod's local storage: the last list per space;
  - the icons in `~/.config/herdr-app/data/herdr-ranch/icons`.
- **Files outside Herdr's folder:** Inbox watches `~/.plannotator/sessions` and removes a record file there only for a session that isn't running anymore. Start agent writes worktrees under `~/.herdr/worktrees`.
- **Optional, only when you say yes to Automations:** `install.sh` clones [DnzzL/herdr-automations](https://github.com/DnzzL/herdr-automations) and its install script downloads a prebuilt binary. See [Automations](#automations).

## install.sh flags

`install.sh` runs only from a clone of this repository. Piped into `sh` (`curl … | sh`), it stops with a message.

| Flag | What it does |
|---|---|
| none | Links the three mods into `~/.config/herdr-app/mods` (or `$HERDR_APP_HOME/mods`). A name already taken by a real folder is skipped. |
| `--layout` | Also copies the mod-buttons layout. A layout file you changed is kept as `<name>.json.bak`. |
| `--update` | Moves the clone to the latest release, then installs as before (the layout too when it's installed, Automations too when `install.sh` installed it) and reloads the panels. |
| `--recommended` | Also installs the recommended mods by others, without asking. |
| `--no-recommended` | Doesn't ask about them. The default when not run from a terminal, and on Windows. |

## Keys

From the three `keys.json` files, to merge into `~/.config/herdr-app/keys.json`:

| Key | Where | Does |
|---|---|---|
| Cmd+Shift+J | anywhere | opens Issues |
| Cmd+Shift+G | anywhere | opens Pull requests |
| Cmd+Shift+I | anywhere | opens Inbox |
| Cmd+R | in a list | refreshes it |
| Cmd+O | in Issues or Pull requests | opens the item in the browser |

Inside a list: Up and Down move, Enter opens, Esc goes back or closes. On a page: ⌘↵ starts an agent (or goes to it), O opens it in the browser, C copies the key (Issues), B copies the branch and 1 2 3 switch tabs (Pull requests). `ctrl-shift-l` switches layouts. Each mod's `RECIPE.md` lists its commands.

## Automations

[DnzzL/herdr-automations](https://github.com/DnzzL/herdr-automations) (MIT), a recommended mod by others. `install.sh` asks (or installs it with `--recommended`), then:

1. clones it to `${XDG_DATA_HOME:-~/.local/share}/herdr-ranch/herdr-automations` and checks out the tag `install.sh` pins (`AUTOMATIONS_TAG`, now `v0.11.3`; a newer release is taken in on purpose, by bumping it), then runs its own install script, which fetches its prebuilt binary (checked against the release checksums);
2. links the `herdr-automations` command into `~/.local/bin` and copies its panel to `~/.config/herdr-app/mods/automations`;
3. writes a first config with `backend: hc` (the desktop app runs agents in herdr-core) when there is none;
4. asks separately whether to run the scheduler at login (`herdr-automations service install`, a launchd agent or systemd user unit). Without it, the panel's ▶ still runs an automation now.

Its **Automations** button comes with the mod-buttons layout (`./install.sh --layout`); its own `mod.json` declares none. `./install.sh --update` updates it to the pinned tag too.

**Remove it:**

1. `herdr-automations service uninstall`
2. `rm ~/.local/bin/herdr-automations`
3. `rm -rf ~/.config/herdr-app/mods/automations`
4. `rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/herdr-ranch/herdr-automations"`

Its configuration and history stay in `~/.config/herdr/plugins/config/dnzzl.automations`; remove that folder too to drop them. Configuration, history and its own updates are documented in its README.
