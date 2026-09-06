#!/bin/sh
# Builds the Chrome Web Store upload zip from the current source.
# Run from the repository root: sh store/package.sh
set -e
VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' manifest.json | head -1)
OUT="store/boosts-$VERSION.zip"
TMP=$(mktemp -d)
for p in manifest.json background.js LICENSE content lib popup manager; do
  cp -R "$p" "$TMP/"
done
mkdir -p "$TMP/icons"
for s in 16 32 48 128; do cp "icons/icon-$s.png" "$TMP/icons/"; done
rm -f "$OUT"
(cd "$TMP" && zip -qr - . -x ".*") > "$OUT"
rm -rf "$TMP"
echo "$OUT  ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | tail -1
