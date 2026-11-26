#!/bin/sh
# Brings what the extension carries of Jumpstarter Web up to date.
#
#   scripts/sync-jumpstarter-web.sh [plugin ...]             from the revision of its main that is pinned here
#   scripts/sync-jumpstarter-web.sh --update [plugin ...]    moves the pin to the head of its main first
#   scripts/sync-jumpstarter-web.sh <checkout> [plugin ...]  from a checkout as it is, for work that is not on main
#
# The pin is scripts/jumpstarter-web.pin: the repository and the commit of its main branch the extension is
# built with. It is committed, so that everyone packages the same Jumpstarter Web; a pin that is not on main is
# refused. The repository is kept in a cache (${XDG_CACHE_HOME:-~/.cache}/vscode-jumpstarter) and its UI is built
# there (its scripts/build-ui.sh: Node.js, and a while the first time).
#
# * src/vendor/jumpstarter-api: the bridge of @jumpstarter/api (frames, the hub, a port), as source. That
#   package is not published; these two files have no dependency but each other.
# * python/: Jumpstarter Web and the named plugins (default: hmi, appium-inspector, serial, ssh, power), as
#   `pip install --target` leaves them. The extension puts the directory on PYTHONPATH of the lease's own
#   interpreter, so any environment that has Jumpstarter can be used, with nothing installed into it. A
#   checkout's UI has to be built first (its scripts/build-ui.sh). Not committed: `vsce package` takes it.
#
# Needs `uv`, and `git` for the pinned revision.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
pin="$here/scripts/jumpstarter-web.pin"

update=
if [ "${1:-}" = "--update" ]; then
  update=1
  shift
fi

if [ "$#" -gt 0 ] && [ -d "$1" ]; then
  [ -z "$update" ] || { echo "--update moves the pin: it takes no checkout" >&2; exit 2; }
  source=$(cd "$1" && pwd)
  shift
  revision="$(git -C "$source" rev-parse HEAD 2>/dev/null || echo unknown) (a checkout: $source)"
  [ -f "$source/python/src/jumpstarter_web/static/index.html" ] || {
    echo "the UI of $source is not built: run its scripts/build-ui.sh first" >&2
    exit 1
  }
else
  repository=$(sed -n 's/^repository=//p' "$pin")
  pinned=$(sed -n 's/^revision=//p' "$pin")
  source="${XDG_CACHE_HOME:-$HOME/.cache}/vscode-jumpstarter/jumpstarter-web"
  [ -d "$source/.git" ] || git clone --quiet --no-checkout "$repository" "$source"
  git -C "$source" fetch --quiet origin main
  if [ -n "$update" ]; then
    pinned=$(git -C "$source" rev-parse origin/main)
    printf 'repository=%s\nrevision=%s\n' "$repository" "$pinned" > "$pin"
    echo "the pin is now $pinned"
  fi
  git -C "$source" merge-base --is-ancestor "$pinned" origin/main || {
    echo "the pinned revision $pinned is not on the main branch of $repository" >&2
    exit 1
  }
  git -C "$source" checkout --quiet --detach "$pinned"
  revision=$pinned
  built="$source/.built-revision"
  if [ "$(cat "$built" 2>/dev/null)" != "$pinned" ]; then
    echo "building the UI of jumpstarter-web $pinned"
    "$source/scripts/build-ui.sh" > "$source/.build-ui.log" 2>&1 || {
      echo "the UI did not build: see $source/.build-ui.log" >&2
      exit 1
    }
    echo "$pinned" > "$built"
  fi
fi
[ "$#" -gt 0 ] || set -- hmi appium-inspector serial ssh power

for file in bridge.ts http.ts; do
  {
    echo "// Copied from jumpstarter-web (web/packages/api/src/$file) by scripts/sync-jumpstarter-web.sh: change it there."
    echo "/* eslint-disable */"
    cat "$source/web/packages/api/src/$file"
  } > "$here/src/vendor/jumpstarter-api/$file"
done

rm -rf "$here/python"
packages="$source/python"
for plugin in "$@"; do packages="$packages $source/plugins/$plugin"; done
# shellcheck disable=SC2086
uv pip install --quiet --target "$here/python" --no-deps $packages
rm -rf "$here/python/bin"
find "$here/python" -name __pycache__ -type d -prune -exec rm -rf {} +
# (what the packaged extension was built with, beside what it carries)
echo "$revision" > "$here/python/jumpstarter-web.revision"
echo "python/: $(ls "$here/python" | grep -v dist-info | tr '\n' ' ')"
echo "from jumpstarter-web $revision"
