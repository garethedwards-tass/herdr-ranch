# Reference

Facts and paths for the Herdr Ranch mods. How to use them is in the [guide](guide.md).

- [What they run and store](#what-they-run-and-store)
- [install.sh flags](#installsh-flags)
- [Keys](#keys)

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

## install.sh flags

`install.sh` runs only from a clone of this repository. Piped into `sh` (`curl … | sh`), it stops with a message.

| Flag | What it does |
|---|---|
| none | Links the three mods into `~/.config/herdr-app/mods` (or `$HERDR_APP_HOME/mods`). A name already taken by a real folder is skipped. |
| `--layout` | Also copies the mod-buttons layout. A layout file you changed is kept as `<name>.json.bak`. |
| `--update` | Moves the clone to the latest release, then installs as before (the layout too when it's installed) and reloads the panels. |

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
