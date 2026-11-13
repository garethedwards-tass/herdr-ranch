#!/bin/sh
# Symlinks every mod in this repo into the Herdr app's mods folder, so edits here hot-reload.
# Never overwrites a real folder: a name already taken by something else is skipped.
#   --layout   also install the mod-buttons layout
#   --update   update to the latest release, then install as before
set -eu

repo=$(cd "$(dirname "$0")" && pwd)
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
dest="$home/mods"

if [ ! -d "$repo/shared" ] || [ ! -f "$repo/install.sh" ]; then
  echo "Run install.sh from a clone of github.com/jslowack/herdr-ranch: ./install.sh" >&2
  exit 1
fi

layout=no update=no
for arg in "$@"; do
  case "$arg" in
    --layout) layout=yes ;;
    --update) update=yes ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done
have_app() { command -v herdr-app >/dev/null 2>&1; }

# --update: pull the latest version, then install as before (the layout too when it's
# installed) and reload the panels, which load new code on a layout switch.
if [ "$update" = yes ]; then
  # To the latest release, not whatever is on the branch: what the update check announced.
  git -C "$repo" fetch -q --tags origin || exit 1
  tag=$(git -C "$repo" tag -l 'v*' --sort=-v:refname | grep -v -- '-' | head -1)
  if [ -n "$tag" ]; then git -C "$repo" merge -q --ff-only "$tag" || { echo "Can't fast-forward to $tag: your clone has its own commits." >&2; exit 1; }
  else git -C "$repo" pull --ff-only || exit 1; fi
  if [ "$layout" = yes ] || [ -d "$dest/mod-buttons-bar" ]; then sh "$repo/install.sh" --layout; else sh "$repo/install.sh"; fi
  if have_app && [ -d "$dest/mod-buttons-bar" ]; then
    cur=$(herdr-app status 2>/dev/null | sed -n 's/.*"layout": *"\([^"]*\)".*/\1/p' | head -1)
    if [ -n "$cur" ]; then
      away="main"; [ "$cur" = main ] && away="mod-buttons"
      herdr-app "do" layout.switch "{\"name\":\"$away\"}" >/dev/null 2>&1 || true
      sleep 1.5
      herdr-app "do" layout.switch "{\"name\":\"$cur\"}" >/dev/null 2>&1 || true
    fi
  fi
  echo "Updated to $(grep -o 'VERSION = "[^"]*"' "$repo/shared/update.js" | cut -d'"' -f2)"
  exit 0
fi
mkdir -p "$dest"

for mod in "$repo"/*/mods/*/; do
  [ -d "$mod" ] || continue
  mod=${mod%/}
  # Layouts (a folder with layouts/) are copied, not linked: see their RECIPE.md.
  if [ -d "${mod%/mods/*}/layouts" ]; then
    [ "$layout" = yes ] && continue
    echo "skip $(basename "$mod"): part of a layout, install it with --layout"
    [ -L "$dest/$(basename "$mod")" ] && echo "  warning: $dest/$(basename "$mod") is a link; its icons need a real folder"
    continue
  fi
  name=$(basename "$mod")
  # A folder left from a removed mod (only files Herdr wrote, no main.js) isn't a mod.
  [ -f "$mod/main.js" ] || continue
  target="$dest/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "skip $name: $target exists and is not a link"
    continue
  fi
  ln -sfn "$mod" "$target"
  echo "linked $name"
  if have_app; then herdr-app check "$target" || true; fi
done

# shared/ holds the files both lists need (a mod cannot import outside its folder, so
# each keeps a copy): warn about a copy that differs from its source.
for src in "$repo"/shared/*.js; do
  file=$(basename "$src")
  for mod in herdr-ranch-prs herdr-ranch-issues herdr-ranch-reviews; do
    cmp -s "$src" "$repo/$mod/mods/$mod/$file" || echo "stale $mod/mods/$mod/$file: copy shared/$file over it"
  done
done

# --layout: also install the mod-buttons layout (a tab-bar button for every mod that declares
# one). Copied, not linked: its tab bar copies mod icons into its own folder. A layout file
# you changed is kept as <name>.json.bak.
if [ "$layout" = yes ]; then
  mkdir -p "$home/layouts"
  for f in "$repo"/mod-buttons/layouts/*; do
    t="$home/layouts/$(basename "$f")"
    if [ -f "$t" ] && ! cmp -s "$f" "$t"; then cp "$t" "$t.bak" && echo "kept your previous $(basename "$t") as $(basename "$t").bak"; fi
    cp "$f" "$t"
  done
  rm -rf "$dest/mod-buttons-bar.new" && cp -R "$repo/mod-buttons/mods/mod-buttons-bar" "$dest/mod-buttons-bar.new"
  rm -rf "$dest/mod-buttons-bar" && mv "$dest/mod-buttons-bar.new" "$dest/mod-buttons-bar"
  if have_app; then herdr-app check "$dest/mod-buttons-bar" || true; fi
  echo "installed the mod-buttons layout: herdr-app do layout.switch '{\"name\":\"mod-buttons\"}'"
fi

# Reviews: the ranch-review CLI goes on the PATH, its skills into Claude Code. Links only, and
# never over a real file.
link_one() {
  if [ -e "$2" ] && [ ! -L "$2" ]; then echo "skip $(basename "$2"): $2 exists and is not a link"; return; fi
  mkdir -p "$(dirname "$2")" && ln -sfn "$1" "$2" && echo "linked $(basename "$2")"
}
link_one "$repo/herdr-ranch-reviews/bin/ranch-review.mjs" "$HOME/.local/bin/ranch-review"
for skill in "$repo"/herdr-ranch-reviews/skills/*/; do
  skill=${skill%/}
  link_one "$skill" "$HOME/.claude/skills/$(basename "$skill")"
done
command -v ranch-review >/dev/null 2>&1 || echo "  add ~/.local/bin to your PATH for ranch-review"

# The diff views' highlighter: built with cargo when Rust is installed (the grammars compile in,
# a minute or two the first time), linked into ~/.local/bin. Without it the diffs stay plain.
if command -v cargo >/dev/null 2>&1; then
  if cargo build --release --quiet --manifest-path "$repo/ranch-highlight/Cargo.toml"; then
    link_one "$repo/ranch-highlight/target/release/ranch-highlight" "$HOME/.local/bin/ranch-highlight"
  else
    echo "ranch-highlight didn't build: the diffs stay plain"
  fi
else
  echo "skip ranch-highlight: install Rust (https://rustup.rs) for highlighted diffs"
fi
# The skills had other names before: drop their old links.
for old in ranch-annotate ranch-last herdr-ranch-annotate herdr-ranch-last; do
  if [ -L "$HOME/.claude/skills/$old" ]; then rm "$HOME/.claude/skills/$old" && echo "removed the old link $old"; fi
done

# The lists were called space-issues and space-prs before, and Inbox (Plannotator's sessions)
# gave way to Reviews: drop their old links.
for old in space-issues space-prs herdr-ranch-inbox; do
  if [ -L "$dest/$old" ]; then rm "$dest/$old" && echo "removed the old link $old"; fi
done


if have_app; then herdr-app "do" mod-buttons-bar.rescan >/dev/null 2>&1 || true; fi
echo "Now merge each */keys.json into $dest/../keys.json"
