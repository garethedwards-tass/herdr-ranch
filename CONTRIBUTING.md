# Contributing

Thanks for looking. Issues and pull requests are welcome at [jslowack/herdr-ranch](https://github.com/jslowack/herdr-ranch).

## How the repository is laid out

- **One folder per mod** (`herdr-ranch-issues`, `herdr-ranch-prs`, `herdr-ranch-reviews`, `herdr-ranch-files`, `herdr-ranch-spaces`, `herdr-ranch-agents`, `mod-buttons`), each with:
  - `RECIPE.md`: the brief another agent builds the mod from (what you see, how it behaves, what it's built from, when it's done). Keep it in step with the code.
  - `mods/<name>/`: the mod itself, as Herdr loads it.
  - `keys.json`: its keys, for users to merge into their own.
- **`shared/`:** code the mods share. A mod can't import outside its own folder, so each mod keeps a copy. Edit the file in `shared/`, then copy it over the copies in `*/mods/*/`. `install.sh` and CI fail or warn on a stale copy.
- **`install.sh`:** links the mods into Herdr's mods folder (flags in [docs/reference.md](docs/reference.md#installsh-flags)).
- **`docs/`:** the [guide](docs/guide.md), the [reference](docs/reference.md), [Connect Jira](docs/connect-jira.md) and the images.
- **`tests/`:** logic tests under `node --test`, with stubs for Herdr's built-in modules (`herdr`, `gpui-kit`, `gpui-base`) in `tests/stubs/`.
- **[NOTES.md](NOTES.md):** what we learned about Herdr's render limits along the way.

## Working on a mod

1. Clone, then `./install.sh --layout`: the mods are linked, so an edit here hot-reloads in Herdr. The layout is copied: rerun `./install.sh --layout` after changing `mod-buttons`.
2. `herdr-app check ~/.config/herdr-app/mods/<name>` checks a mod.
3. Change `shared/` first, then copy it into each mod.

## Tests

```sh
cd tests && npm test
```

CI runs the tests, checks that every mod file parses (`node --check`), that the copies of `shared/` match, and runs `shellcheck` and a smoke test of `install.sh` on Linux and macOS.

Test the pure logic (grouping, parsing, prompts, sites); the UI isn't tested. Import the module from its mod folder; the stubs answer `exec`, `fetch` and files through `state` in `tests/stubs/herdr.mjs`.

## Releasing

1. `scripts/release.sh 0.2.0` on a branch: sets the version in `shared/update.js` and every mod's copy, and in each `mod.json`; turns `## Unreleased` in the CHANGELOG into `## v0.2.0`; runs the tests. Commit it, open a pull request, merge it.
2. `scripts/release.sh --publish 0.2.0` on `main` once merged: tags `v0.2.0`, pushes the tag, and creates the GitHub release with that CHANGELOG section as its notes.

Every installed suite then sees the release within a day (the cog's **Check** at once) and offers **Update**.

## Style

- Plain, short sentences in docs and comments.
- No em dashes or en dashes in prose, comments or strings: use a colon, a comma, parentheses or two sentences.
- Read only toward Jira, Linear and GitHub: the mods don't write to them.
- Tokens only in the system's credential store or environment variables, never in Herdr's settings or on a command line.
- Add a line to [CHANGELOG.md](CHANGELOG.md) for a change users notice.
