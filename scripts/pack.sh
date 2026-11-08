#!/usr/bin/env bash
# Packs the GNOME Shell extension into the zip `gnome-extensions install` takes:
#   scripts/pack.sh  ->  dist/smbact@giglabo.com.shell-extension.zip
set -euo pipefail
cd "$(dirname "$0")/.."
UUID=smbact@giglabo.com
OUT="dist/$UUID.shell-extension.zip"
mkdir -p dist
rm -f "$OUT"
(cd "gnome-shell/$UUID" && zip -q -X -r "../../$OUT" .)
zip -q -X -j "$OUT" LICENSE
echo "$OUT"
