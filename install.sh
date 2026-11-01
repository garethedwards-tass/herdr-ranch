#!/bin/sh
# Symlinks every mod in this repo into the Herdr app's mods folder, so edits here hot-reload.
# Never overwrites a real folder: a name already taken by something else is skipped.
#   --layout          also install the mod-buttons layout
#   --update          pull the latest version, then install as before
#   --recommended     also install the recommended mods by others (see README, Recommended)
#   --no-recommended  don't ask about them (the default when not run from a terminal)
set -eu

repo=$(cd "$(dirname "$0")" && pwd)
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
dest="$home/mods"
# Automations, pinned: a newer upstream release is taken in on purpose, by bumping this.
AUTOMATIONS_TAG=v0.11.3
automations_src="${XDG_DATA_HOME:-$HOME/.local/share}/herdr-ranch/herdr-automations"

if [ ! -d "$repo/shared" ] || [ ! -f "$repo/install.sh" ]; then
  echo "Run install.sh from a clone of github.com/jslowack/herdr-ranch: ./install.sh" >&2
  exit 1
fi

layout=no update=no recommended=ask
for arg in "$@"; do
  case "$arg" in
    --layout) layout=yes ;;
    --update) update=yes ;;
    --recommended) recommended=yes ;;
    --no-recommended) recommended=no ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done
[ -t 0 ] || [ "$recommended" != ask ] || recommended=no
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) recommended=no ;; esac
have_app() { command -v herdr-app >/dev/null 2>&1; }

ask() { # ask "question": yes for --recommended, else a y/N prompt
  [ "$recommended" = yes ] && return 0
  printf '%s [y/N] ' "$1"; read -r a || a=; case "$a" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}

# Fetches Automations at AUTOMATIONS_TAG and builds its binary; the panel is copied last, so
# a failed step leaves nothing that looks installed. Returns non-zero on any failure.
automations() {
  src=$automations_src
  if [ -d "$src/.git" ]; then
    git -C "$src" fetch -q --tags origin || return 1
  else
    mkdir -p "$(dirname "$src")" || return 1
    git clone -q https://github.com/DnzzL/herdr-automations "$src" || return 1
  fi
  git -C "$src" -c advice.detachedHead=false checkout -q "$AUTOMATIONS_TAG" || return 1
  (cd "$src" && sh scripts/install.sh) || return 1
  bin="$src/bin/herdr-automations"
  "$bin" version >/dev/null 2>&1 || return 1
  mkdir -p "$HOME/.local/bin" && ln -sf "$bin" "$HOME/.local/bin/herdr-automations" || return 1
  # The desktop app runs agents in herdr-core: a first config says so, where the binary reads it.
  conf=$("$bin" --help 2>&1 | sed -n 's/^Config: *//p' | head -1)
  [ -n "$conf" ] || conf="$HOME/.config/herdr/plugins/config/dnzzl.automations/automations.yaml"
  if [ ! -f "$conf" ]; then mkdir -p "$(dirname "$conf")" && printf 'backend: hc\nautomations: []\n' > "$conf" || return 1; fi
  rm -rf "$dest/automations.new" && cp -R "$src/app/mods/automations" "$dest/automations.new" || return 1
  rm -rf "$dest/automations" && mv "$dest/automations.new" "$dest/automations" || return 1
}

# --update: pull the latest version, then install as before (the layout too when it's
# installed, Automations too when this script installed it) and reload the panels, which
# load new code on a layout switch.
if [ "$update" = yes ]; then
  # To the latest release, not whatever is on the branch: what the update check announced.
  git -C "$repo" fetch -q --tags origin || exit 1
  tag=$(git -C "$repo" tag -l 'v*' --sort=-v:refname | grep -v -- '-' | head -1)
  if [ -n "$tag" ]; then git -C "$repo" merge -q --ff-only "$tag" || { echo "Can't fast-forward to $tag: your clone has its own commits." >&2; exit 1; }
  else git -C "$repo" pull --ff-only || exit 1; fi
  flags=""
  if [ "$layout" = yes ] || [ -d "$dest/mod-buttons-bar" ]; then flags="--layout"; fi
  [ "$recommended" = yes ] && flags="$flags --recommended" || flags="$flags --no-recommended"
  # shellcheck disable=SC2086 # the flags are words
  sh "$repo/install.sh" $flags
  if [ -d "$automations_src/.git" ] && [ -d "$dest/automations" ]; then
    if automations; then echo "updated Automations ($AUTOMATIONS_TAG)"; else echo "Automations didn't update; see github.com/DnzzL/herdr-automations"; fi
  fi
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
  for mod in herdr-ranch-prs herdr-ranch-issues herdr-ranch-inbox; do
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

# The lists were called space-issues and space-prs before: drop their old links.
for old in space-issues space-prs; do
  if [ -L "$dest/$old" ]; then rm "$dest/$old" && echo "removed the old link $old"; fi
done

# Recommended mods by others, installed the way their own README says, unchanged.
if [ "$recommended" != no ]; then
  if [ -d "$dest/automations" ]; then echo "Automations is already installed"
  elif ask "Also install Automations (github.com/DnzzL/herdr-automations): agent prompts on a schedule, with a panel?"; then
    if automations; then
      echo "installed Automations $AUTOMATIONS_TAG (panel, and the herdr-automations command in ~/.local/bin)"
      [ -d "$dest/mod-buttons-bar" ] || echo "  its button comes with the mod-buttons layout: ./install.sh --layout"
      # The scheduler runs as a login service: always its own question, even with --recommended.
      if [ -t 0 ]; then
        printf 'Run the Automations scheduler at login (herdr-automations service install)? [y/N] '
        read -r a || a=
        case "$a" in y|Y|yes) "$HOME/.local/bin/herdr-automations" service install ;; *) echo "  later: herdr-automations service install" ;; esac
      else
        echo "  to run on schedule: herdr-automations service install"
      fi
    else
      echo "Automations didn't install; nothing of it is in the mods folder. See github.com/DnzzL/herdr-automations"
    fi
  fi
fi

if have_app; then herdr-app "do" mod-buttons-bar.rescan >/dev/null 2>&1 || true; fi
echo "Now merge each */keys.json into $dest/../keys.json"
