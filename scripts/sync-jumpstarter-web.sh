#!/bin/sh
# Brings what the extension carries of Jumpstarter Web up to date, from a checkout of it:
#
#   scripts/sync-jumpstarter-web.sh <jumpstarter-web checkout> [plugin ...]
#
# * src/vendor/jumpstarter-api: the bridge of @jumpstarter/api (frames, the hub, a port), as source. That
#   package is not published; these two files have no dependency but each other.
# * python/: Jumpstarter Web and the named plugins (default: hmi, appium-inspector, serial, ssh, power), as
#   `pip install --target` leaves them. The extension puts the directory on PYTHONPATH of the lease's own
#   interpreter, so any environment that has Jumpstarter can be used, with nothing installed into it. The
#   checkout's UI has to be built first (its scripts/build-ui.sh). Not committed: `vsce package` takes it.
#
# Needs `uv`.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
source=$(cd "$1" && pwd)
shift
[ "$#" -gt 0 ] || set -- hmi appium-inspector serial ssh power

for file in bridge.ts http.ts; do
  {
    echo "// Copied from jumpstarter-web (web/packages/api/src/$file) by scripts/sync-jumpstarter-web.sh: change it there."
    echo "/* eslint-disable */"
    cat "$source/web/packages/api/src/$file"
  } > "$here/src/vendor/jumpstarter-api/$file"
done

[ -f "$source/python/src/jumpstarter_web/static/index.html" ] || {
  echo "the UI of $source is not built: run its scripts/build-ui.sh first" >&2
  exit 1
}
rm -rf "$here/python"
packages="$source/python"
for plugin in "$@"; do packages="$packages $source/plugins/$plugin"; done
# shellcheck disable=SC2086
uv pip install --quiet --target "$here/python" --no-deps $packages
rm -rf "$here/python/bin"
find "$here/python" -name __pycache__ -type d -prune -exec rm -rf {} +
echo "python/: $(ls "$here/python" | grep -v dist-info | tr '\n' ' ')"
