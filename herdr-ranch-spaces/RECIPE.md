# Spaces

Herdr's spaces list with git and links, in the sidebar of the mod-buttons layout (its `spaces` block), in place of Herdr's own `spaces` mod. `main.js` is a copy of that mod (Herdr 0.1.15) with a few marked changes, so everything it does stays: machines with their headers, reconnect and login hints, loading rows, folding, the rail, drag to reorder.

## What you see

- **Header:** "Spaces" (`dim`) and **+** (a new space).
- **A space:** its avatar (the colors Herdr's own list stores in `shared("space.colors")`), its name, then only what the name doesn't say: the repository and the branch ("herdr · spike"; "detached" off a branch; main and master left out, as Herdr does), then its work.
- **Git:** a click on a space's repository and branch text opens its **Git** dialog; a click on `↓n` pulls (`git pull --ff-only`) with a toast (on failure: git's answer, and Git's Pull with rebase).
- **Work** (on spaces and worktrees alike): `●n` uncommitted files (`ansi3`), `↑n` commits ahead of the upstream or on no remote, whichever is more (`ansi2`), `↓n` behind (`ansi1`); the tooltip says it in words. Nothing when there's none.
- **Link:** a linked space shows a chip (`accent`, link icon) with its Jira or Linear key, else its GitHub repository's name; the tooltip has the whole link and a click opens **Link space**. Worktree spaces follow their repository's link (`linkOf`).
- **The shown space** also has buttons: **Link space** (when it has no link) and **New worktree** (in a repository).
- **Worktrees:** a worktree space sits under its repository's space, indented, with a branch icon. After them, "n worktrees without a space" (▸, folded by default, remembered per repository; "· n with work" in `ansi3`) lists the repository's other checkouts from `git worktree list`: branch, folder when it isn't named after the branch, "locked", its work (one with work in `foreground`, the others `muted`). A click opens its **Git** dialog (no space is made); right-click for Git, Switch branch, **Create space here**, **Delete worktree…** and **Copy path**.
- **Machines, rail, loading:** as in Herdr's list (machine headers with state, Connect for a rebuilt machine, the login hint with Copy, folding, "New space there", the narrow rail). Worktree rows don't show on the rail.

## How it behaves

- **Where a space is:** its first terminal's live folder, else its folder. Git is read per place, refs only (`rev-parse --show-toplevel`, `--git-common-dir`, `symbolic-ref`, `rev-list --left-right --count HEAD...@{upstream}`), so nothing is written under `.git`.
- **When it reads again:** a new place, a terminal's command or an agent's turn ending, a machine coming back, a change under a local repository's git folder (`watchFolder`), and every 60 s while the window is in front. Each read also refreshes that repository's `git worktree list --porcelain` and every checkout's work: `git --no-optional-locks -c core.fsmonitor=false status --porcelain=v1 -z --no-renames` (counted) and `git rev-list --count HEAD --not --remotes` (skipped, as 0, in a repository without a remote).
- **Order:** worktree spaces move under their repository's space with `space.move`, as Herdr's own list does. Drag a space onto another (same machine) to move it; a click selects it.
- **Link space:** the shared Link space dialog (`link-dialog.js`): the list opens itself as a dialog with `props { dialog: "link", space }`, for any space, shown or not.
- **New worktree** (`new.js`, the list opened as a dialog with `props { dialog: "new", space, mode }`): **Branch | Issue** (Tab), a filter, ↑/↓, Enter.
  - **Branch:** `git for-each-ref --sort=-committerdate refs/heads refs/remotes`: local branches, then remote ones without a local branch (tagged with the remote), each with its age, "checked out" or "open" when a worktree has it. A typed name that isn't a branch gives "Create branch <name> from <the space's branch>" (checked with `git check-ref-format --branch`).
  - **Issue:** your open issues from the space's link (`issues.js`): Jira (`project = KEY AND assignee = currentUser() AND statusCategory != Done`, `/rest/api/3/search/jql`), Linear (the team's issues assigned to you, not completed or canceled) or GitHub (`gh issue list --assignee @me`). A typed key (`ABC-12`, `#12`) that isn't listed is looked up. Each issue shows the branch it goes on: an existing one named after its key or starting with `KEY-`, else a new `KEY-short-title` (`issue-12-short-title` on GitHub). Read only.
  - **Enter:** a branch already checked out selects its space, or opens one there. Otherwise `git worktree add` into `<home>/.herdr/worktrees/<repo>/<branch, slashes as dashes>` (as Herdr's worktree dialog puts it): an existing branch is checked out, a remote one gets a tracking branch (`--track -b`), a new one starts from the space's HEAD. Then `space.new { folder }`, unnamed, so it nests under the repository. git's error shows in the dialog.
- **Delete worktree** (`remove.js`, `props { dialog: "remove", path, main, on, branch }`): reads the checkout's work and says what goes: uncommitted files are lost (`blocked`), unpushed commits stay on the branch (`ansi3`; `blocked` when detached, since nothing would point at them), or "No uncommitted files, nothing unpushed." (`ansi2`). Enter runs `git worktree remove` (with `--force` only when it said files would be lost); the branch stays. It refuses when a space opened in it meanwhile: that space's Remove worktree closes the space too.
- **Git dialog** (`git-dialog.js`, `props { dialog: "git", space, tab }`, or `{ folder, on }` for a worktree without a space):
  - **Header:** the repository, the branch (`accent`), `→ upstream` (or "no upstream", "upstream gone"), `↑ahead ↓behind`, "n changed"; **Fetch** (`git fetch --prune`) and **Pull** (`git pull --ff-only`; `primary` and "Pull ↓n" when behind, off without an upstream). When git can't fast-forward, **Pull with rebase** (`git pull --rebase`) shows under its error.
  - **Status:** `git --no-optional-locks -c core.fsmonitor=false status --porcelain=v1 -z --branch --no-renames`, files grouped as Conflicts, Staged, Staged and changed, Changes, Untracked, each with git's two letters (a space as `·`). At most 300 files.
  - **Branches:** the filter and branch list of New worktree; Enter runs `git switch <branch>` (a remote one: `--track -c`; a typed new name: `-c`). A branch in another worktree selects that worktree's space, or shows that worktree in the dialog when no space has it.
  - **Uncommitted changes:** the status is read again right before a switch. Conflicts block it ("Resolve the n conflicted files before switching branches."). Tracked changes (staged or not) open a confirmation in place of the list (`ansi3` border): the files with their letters and three choices, only by click or key:
    - **Stash them, then switch** (`S`; primary for an existing branch): `git stash push -m "herdr-ranch: <from> before switching to <to>"`, then the switch. A failed switch runs `git stash pop --index`, so staged and unstaged changes come back as they were; a toast after a good one names the stash and `git stash pop`.
    - **Bring them to <branch>** (`B`; primary for a new branch): a plain `git switch`; git refuses, and nothing changes, when that branch has other versions of those files.
    - **Cancel** (`Esc`). Untracked files stay in the folder either way; Enter never switches from here.
  - Every command runs one at a time, toasts git's last line on success and shows its error in the dialog; the dialog reads everything again after. Tab switches Status and Branches, Esc closes.
- **Accounts** (`accounts.js`, `account-dialog.js`): right-click **Account…** opens the dialog (`props { dialog: "account", space }`): Default or one of your accounts (●), **remove** on each (only the entry; logins and folders stay), and New account: a label, a Claude Code config folder (empty: `~/.claude-<label>`), a GitHub login picked from `gh auth status`, **Add and use**. Stored in shared state `ranch-accounts` as `{ accounts: [{ id, label, claudeDir?, ghUser? }], spaces: { <space id>: { account, main, on } } }`; a space without its own uses its repository's, so worktree spaces follow it.
  - A space with an account shows `@Label` (`ansi5`; tooltip with its folder and login; a click opens the dialog), and its menu adds **New tab as <Label>** and **New Claude Code as <Label>** (`tab.new` with `argv`).
  - Herdr can't give a space environment variables, so those terminals start with `sh -c '<exports>; exec "$SHELL" -l'` (or `claude; exec "$SHELL" -l`): `export CLAUDE_CONFIG_DIR=<folder>` and `GH_TOKEN=$(gh auth token --user <login>) && export GH_TOKEN` (a warning when gh has no token for it). The token is fetched inside that shell: it is never on a command line or in Herdr's settings.
  - New worktree and Create space here start the new space's first terminal the same way when the repository has an account. Terminals opened with Herdr's own + are not affected.
  - First use: New Claude Code as the account, then `/login` there.
- **Plain New worktree** (right-click **New worktree…**): Herdr's own dialog, a branch name and Enter.
- **Agents** reads sessions from every account's Claude Code folder too (see its recipe).
- **Commands** (for keys.json, on a focused copy): `herdr-ranch-spaces.git`, `.branches`, `.new-worktree` for the shown space.
- **Open and Remove worktree on a space:** Herdr's `worktree` dialog (`{ space, action: "open" | "remove" }`).
- **Right-click menu:** the list opens itself as a popup at the pointer with `props { menu, git }` (`menu.js`): Link space…, Git: status, pull…, Switch branch…, New worktree…, New worktree from a branch…, New worktree from an issue…, Open worktree…, Remove worktree… (worktrees only), Rename, Close. A worktree without a space: Git: status, pull…, Switch branch…, Create space here, Delete worktree…, Copy path. ↑/↓, Enter, Esc.

## Built from

- `mods/herdr-ranch-spaces/main.js`: a copy of Herdr's `mods/spaces/main.js` (0.1.15). Its changes, each marked `ranch:`: the imports; `init` (a dialog or popup copy renders only that, else `start()` and `writeIcons()`); `refreshTrees()` after each git refresh; `check()` uses `probe()`; `ordered()` uses `arrange()` and moves only space rows; `grouped()` draws worktree rows and finds a row's machine; `row()` takes `at`, right-click opens our menu, and `spaceTail()` replaces `gitTail()`; `render()` returns the dialog, and the root tracks focus. After a Herdr update: copy its `spaces/main.js` again and re-apply these.
- `extras.js`: what main.js calls (`dialogFor`, `start`, `spaceMenu`, `spaceTail`, `moreRow`, `looseRow`, the pull on `↓n`).
- The rest: `git.js` (`place`, `where`, `probe`, `parseWorktrees`, `worktrees`, `workIn`, `worktreesWithWork`, `arrange`, `tail`, `linkLabel`, `parseRefs`, `branches`, `issueBranch`, `addArgs`, `worktreePath`, `homeOn`; tested in `tests/spaces.test.mjs`), `issues.js` (`source`, `mine`, `lookup`), `new.js`, `remove.js`, `git-dialog.js` and `account-dialog.js` (the dialogs; `accounts.js` for accounts; `parseStatus`, `status`, `switchArgs`, `diverged` in `git.js`), `menu.js` (the popups), `actions.js` (what opens them, its icons).
- The shared files from `shared/` (`links.js`, `link-dialog.js` and what they import), copies that `install.sh` and CI keep equal to the source.
- `mod.json`: `place: none`, `focusable`, no button.
- herdr: `spaces`, `panes`, `machines`, `layout`, `window`, `home`, `shared`, `setShared`, `exec`, `fetch` (Jira, through `jira-client.js`), `watchFolder`, `openOverlay`, `closeOverlay`, `run` (`space.new`, `space.select`, `space.move`, `space.rename`, `space.close`), `nextCommand`. Programs: `git`, `gh` (GitHub issues).

## Watch out

- Its icons are written to `data/herdr-ranch-spaces/icons` at start: `svg()` can't read the linked mod folder.
- Herdr's own `spaces` mod moves spaces too: show only one of the two, or they reorder against each other.
- Keep the copy's changes few and marked: new behavior goes in `extras.js` or its own file, so the copy can be refreshed from Herdr.

## Done when

- `herdr-app check mods/herdr-ranch-spaces` passes, and the mod-buttons layout's sidebar shows it.
- In a repository with two worktrees, one opened as a space: that space sits under the repository's space, and "1 worktree without a space" opens the other.
- **Link space** on a space saves a link; its chip shows, and the repository's worktree spaces show it too.
- An edited file in a worktree without a space shows `●1` on its row and "1 with work" on the fold; Delete worktree on it warns that the file will be lost.
- A click on a space's branch shows its changed files; Branches → Enter switches it, and `↓n` pulls.
- With an edited and a staged file, a switch asks first; Stash leaves the new branch clean and `git stash pop` on the old one brings back both, staged and unstaged; switching to a missing branch after Stash puts the changes back.
- New worktree → Issue lists your issues; Enter on one makes `KEY-short-title` and a space opens under the repository's space.
