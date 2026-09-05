/*
 * Boosts - per-site CSS and JavaScript for Chromium browsers.
 * Copyright (C) 2026 Oliver Bartsch
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 as published
 * by the Free Software Foundation. This program is distributed WITHOUT ANY
 * WARRANTY; see the LICENSE file for details.
 */

var files = arguments;
var bad = 0;
for (var i = 0; i < files.length; i++) {
  var src = readFile(files[i]);
  try {
    // Parse without executing.
    new Function(src);
    print('ok   ' + files[i]);
  } catch (e) {
    bad++;
    print('FAIL ' + files[i] + ': ' + e);
  }
}
if (bad) { throw new Error(bad + ' file(s) failed to parse'); }
