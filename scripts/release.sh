#!/bin/sh
# Releases of the Herdr Ranch suite, in two steps:
#
#   scripts/release.sh 0.2.0            prepare: set the version everywhere, copy shared/ into
#                                       every mod, turn "## Unreleased" in CHANGELOG.md into
#                                       "## v0.2.0", run the tests. Commit that and merge it.
#   scripts/release.sh --publish 0.2.0  publish, on main once that is merged: tag v0.2.0, push the
#                                       tag, create the GitHub release with the CHANGELOG notes.
#
# A mod can't import outside its folder, so each keeps a copy of shared/ (and its VERSION):
# that's why the version lives in four places, and why this script sets all of them.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

publish=no
[ "${1:-}" = "--publish" ] && { publish=yes; shift; }
version=${1:-}
case "$version" in
  v*) version=${version#v} ;;
esac
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "usage: scripts/release.sh [--publish] <major.minor.patch>, e.g. 0.2.0" >&2
  exit 2
fi
tag="v$version"
current=$(sed -n 's/^export const VERSION = "\([^"]*\)";$/\1/p' shared/update.js)

if [ "$publish" = yes ]; then
  [ "$(git branch --show-current)" = main ] || { echo "Publish from main." >&2; exit 1; }
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main isn't at origin/main: pull first." >&2; exit 1; }
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Commit or set aside your changes first." >&2; exit 1; }
  [ "$current" = "$version" ] || { echo "main is at $current, not $version: merge the release commit first." >&2; exit 1; }
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "$tag already exists." >&2; exit 1; }
  # The release notes: the CHANGELOG section of this version, without its heading.
  notes=$(awk -v h="## $tag" '$0 == h { on = 1; next } on && /^## / { exit } on { print }' CHANGELOG.md)
  [ -n "$(printf '%s' "$notes" | tr -d '[:space:]')" ] || { echo "CHANGELOG.md has no notes under ## $tag." >&2; exit 1; }
  git tag -a "$tag" -m "Herdr Ranch $tag"
  git push -q origin "$tag"
  printf '%s\n' "$notes" | gh release create "$tag" --title "Herdr Ranch $tag" --notes-file -
  echo "Published $tag. Every cog offers Update within a day (or at once with Check)."
  exit 0
fi

newer=$(node -e 'const p=(v)=>v.split(".").map(Number);const [a,b]=[p(process.argv[1]),p(process.argv[2])];for(let i=0;i<3;i++){if(a[i]!==b[i]){console.log(a[i]>b[i]?"yes":"no");process.exit(0)}}console.log("no")' "$version" "$current")
[ "$newer" = yes ] || { echo "$version isn't newer than the current $current." >&2; exit 1; }
grep -q '^## Unreleased$' CHANGELOG.md || { echo "CHANGELOG.md has no \"## Unreleased\" section to release." >&2; exit 1; }

# 1. The version: shared/update.js, then every mod's copy of shared/.
sed "s/^export const VERSION = \".*\";$/export const VERSION = \"$version\";/" shared/update.js > shared/update.js.new
mv shared/update.js.new shared/update.js
for mod in */mods/*/; do
  mod=${mod%/}
  [ -f "$mod/main.js" ] || continue
  case "$mod" in mod-buttons/*) continue ;; esac # the layout's bar keeps no shared/
  cp shared/*.js "$mod/"
done

# 2. Each mod.json's own version (the first "version", not one nested in it).
for f in */mods/*/mod.json; do
  node -e 'const fs=require("fs");const f=process.argv[1];const s=fs.readFileSync(f,"utf8");fs.writeFileSync(f,s.replace(/"version":\s*"[^"]*"/,`"version": "${process.argv[2]}"`))' "$f" "$version"
done

# 3. The CHANGELOG: Unreleased becomes this version.
sed "s/^## Unreleased$/## $tag/" CHANGELOG.md > CHANGELOG.md.new
mv CHANGELOG.md.new CHANGELOG.md

# 4. The tests check that every place agrees.
(cd tests && npm test >/dev/null 2>&1) || { echo "Tests fail: cd tests && npm test" >&2; exit 1; }

echo "Prepared $tag ($current -> $version). Next:"
echo "  1. Commit and merge: git commit -am \"chore: release $tag\""
echo "  2. On main, once merged: scripts/release.sh --publish $version"
