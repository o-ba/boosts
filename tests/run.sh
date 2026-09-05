#!/bin/sh
# Boosts - per-site CSS and JavaScript for Chromium browsers.
# Copyright (C) 2026 Oliver Bartsch
#
# This program is free software; you can redistribute it and/or modify it
# under the terms of the GNU General Public License version 2 as published
# by the Free Software Foundation. This program is distributed WITHOUT ANY
# WARRANTY; see the LICENSE file for details.
# Runs the test suite with macOS's built-in JavaScriptCore, so there is no
# toolchain to install. Run from the project root: sh tests/run.sh
set -e

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
if [ ! -x "$JSC" ]; then
  echo "jsc not found at $JSC" >&2
  exit 1
fi

echo "--- parse"
"$JSC" tests/parse.test.js -- \
  lib/patterns.js lib/store.js lib/highlight.js lib/codearea.js \
  background.js content/injector.js popup/popup.js manager/manager.js

echo "--- patterns"
"$JSC" tests/patterns.test.js

echo "--- highlight"
"$JSC" tests/highlight.test.js

echo "--- store"
"$JSC" tests/store.test.js

echo "--- registrations"
"$JSC" tests/background.test.js

echo "--- all suites passed"
