#!/usr/bin/env bash
# Packs the plugins for a release:
#   scripts/pack.sh  ->  dist/smbact@giglabo.com.shell-extension.zip  (the GNOME Shell extension, for `gnome-extensions install`)
#                        dist/smbact-kwin.js                          (the KWin script; SMBAct loads it into KWin itself)
set -euo pipefail
cd "$(dirname "$0")/.."
UUID=smbact@giglabo.com
OUT="dist/$UUID.shell-extension.zip"
mkdir -p dist
rm -f "$OUT"
(cd "gnome-shell/$UUID" && zip -q -X -r "../../$OUT" .)
zip -q -X -j "$OUT" LICENSE
cp kwin/smbact-kwin.js dist/smbact-kwin.js
echo "$OUT"
echo dist/smbact-kwin.js
