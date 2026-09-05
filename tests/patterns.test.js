/*
 * Boosts - per-site CSS and JavaScript for Chromium browsers.
 * Copyright (C) 2026 Oliver Bartsch
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 as published
 * by the Free Software Foundation. This program is distributed WITHOUT ANY
 * WARRANTY; see the LICENSE file for details.
 */

// Minimal URL shim: jsc has no WHATWG URL.
function URL(href) {
  var m = /^([a-z][a-z0-9+.-]*):\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?/i.exec(href);
  if (!m) throw new Error('bad url ' + href);
  this.protocol = m[1].toLowerCase() + ':';
  this.hostname = m[2].toLowerCase().replace(/:\d+$/, '');
  this.pathname = m[3] || '/';
  this.search = m[4] || '';
}
var self = this;
load('lib/patterns.js');
var P = BoostPatterns;

var fails = 0;
function eq(actual, expected, label) {
  var ok = String(actual) === String(expected);
  if (!ok) { fails++; print('FAIL ' + label + '\n  got      ' + actual + '\n  expected ' + expected); }
  else print('ok   ' + label);
}

// normalizePattern
eq(P.normalizePattern('github.com'), '*://*.github.com/*', 'bare host');
eq(P.normalizePattern('  github.com  '), '*://*.github.com/*', 'trims');
eq(P.normalizePattern('github.com/oli*'), '*://*.github.com/oli*', 'host + path');
eq(P.normalizePattern('github.com/'), '*://*.github.com/*', 'trailing slash');
eq(P.normalizePattern('*.example.com'), '*://*.example.com/*', 'wildcard host kept');
eq(P.normalizePattern('https://a.com/x'), 'https://a.com/x', 'full pattern untouched');
eq(P.normalizePattern('*'), '<all_urls>', 'star means all');
eq(P.normalizePattern(''), '', 'empty');

// validity
eq(P.isValidPattern('*://*.github.com/*'), true, 'valid wildcard');
eq(P.isValidPattern('<all_urls>'), true, 'valid all_urls');
eq(P.isValidPattern('*://git*hub.com/*'), false, 'mid-host wildcard rejected');
eq(P.isValidPattern('gopher://a.com/*'), false, 'unknown scheme rejected');
eq(P.isValidPattern('nonsense'), false, 'garbage rejected');
eq(P.isValidPattern('*://*.localhost:3000/*'), false, 'port rejected (Chrome: "Invalid port")');
eq(P.isValidPattern('*://*.a b.com/*'), false, 'space in host rejected');
eq(P.isValidPattern('*://*.###/*'), false, 'garbage host rejected (Chrome: "Invalid host")');
eq(P.isValidPattern('*://*..com/*'), false, 'empty label rejected');

// Production never calls isValidPattern on raw input - it normalises first. These
// pin the path that is actually taken, which is where the old validator let
// everything through and Chrome then rejected it at register time.
function round(input) {
  var pattern = P.normalizePattern(input);
  return pattern && P.isValidPattern(pattern) ? pattern : '(rejected)';
}
eq(round('localhost:3000'), '*://*.localhost/*', 'port stripped: patterns match every port');
eq(round('127.0.0.1:5173'), '*://127.0.0.1/*', 'ip keeps its literal host, port dropped');
eq(round('a b.com'), '(rejected)', 'space in host is refused, not stored');
eq(round('###'), '(rejected)', 'garbage is refused, not stored');
eq(round('not a pattern at all'), '(rejected)', 'prose is refused, not stored');
eq(round('about:blank'), '(rejected)', 'about: is refused');
eq(round('data:text/html,x'), '(rejected)', 'data: is refused');
eq(round('javascript:alert(1)'), '(rejected)', 'javascript: is refused');
eq(round('gopher://a.com/*'), '(rejected)', 'unknown scheme refused after normalising too');
eq(round('github.com'), '*://*.github.com/*', 'the ordinary case still works');
eq(P.explainPattern('localhost:3000').note, 'port ignored, this matches every port',
   'the port is explained rather than silently dropped');
eq(P.explainPattern('a b.com').error, 'site names cannot contain spaces', 'errors say why');

// A port-free pattern must still match the port the user typed.
eq(m('*://*.localhost/*', 'http://localhost:3000/'), true, 'localhost pattern matches port 3000');
eq(m('*://127.0.0.1/*', 'http://127.0.0.1:5173/x'), true, 'ip pattern matches its port');

// matching
function m(p, u) { return P.matchesPattern(p, u); }
eq(m('*://*.github.com/*', 'https://github.com/oli'), true, 'apex matches *.host');
eq(m('*://*.github.com/*', 'https://gist.github.com/x'), true, 'subdomain matches');
eq(m('*://*.github.com/*', 'https://notgithub.com/x'), false, 'suffix trap');
eq(m('*://*.github.com/*', 'ftp://github.com/x'), false, '* scheme is http(s) only');
eq(m('https://a.com/*', 'http://a.com/'), false, 'scheme respected');
eq(m('*://*.github.com/oli*', 'https://github.com/oli/repo'), true, 'path glob');
eq(m('*://*.github.com/oli*', 'https://github.com/other'), false, 'path glob misses');
eq(m('*://*.example.com/*', 'https://example.com'), true, 'empty path is /');
eq(m('*://*.example.com/search*', 'https://example.com/search?q=1'), true, 'query included');
eq(m('<all_urls>', 'https://anything.test/x'), true, 'all_urls matches');
eq(m('*://*/*', 'https://a.b.c/d'), true, 'any host');
eq(m('file:///Users/*', 'file:///Users/someone/x.html'), true, 'file url');

// boostMatchesUrl
eq(P.boostMatchesUrl({ patterns: ["a.com", "b.com"] }, "https://b.com/"), true, "raw patterns are normalized");
eq(P.boostMatchesUrl({ patterns: ['*://*.b.com/*'] }, 'https://b.com/'), true, 'normalized pattern matches');

// injectable
eq(P.isInjectableUrl('https://x.com'), true, 'https injectable');
eq(P.isInjectableUrl('chrome://extensions'), false, 'chrome:// not injectable');
eq(P.isInjectableUrl('about:blank'), false, 'about: not injectable');

eq(P.suggestPatternForUrl('https://www.github.com/a'), '*://*.github.com/*', 'suggest strips www');

print(fails ? '\n' + fails + ' FAILURES' : '\nall passed');
if (fails) throw new Error('tests failed');
