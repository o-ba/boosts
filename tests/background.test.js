/*
 * Boosts - per-site CSS and JavaScript for Chromium browsers.
 * Copyright (C) 2026 Oliver Bartsch
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 as published
 * by the Free Software Foundation. This program is distributed WITHOUT ANY
 * WARRANTY; see the LICENSE file for details.
 */

// Harness: stub just enough of the extension platform to load background.js.
function URL(href) {
  var m = /^([a-z][a-z0-9+.-]*):\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?/i.exec(href);
  if (!m) throw new Error('bad url ' + href);
  this.protocol = m[1].toLowerCase() + ':';
  this.hostname = m[2].toLowerCase().replace(/:\d+$/, '');
  this.pathname = m[3] || '/';
  this.search = m[4] || '';
}
var self = this;
// jsc has no timers; the worker only uses them to coalesce sync bursts.
var timerSeq = 0;
function setTimeout(fn) { return ++timerSeq; }
function clearTimeout() {}
function importScripts() { for (var i = 0; i < arguments.length; i++) load(arguments[i]); }

var store = {};
var listener = { addListener: function () {} };
var chrome = {
  runtime: { id: 'test', onInstalled: listener, onStartup: listener, onMessage: listener,
             openOptionsPage: function () {} },
  storage: {
    local: {
      get: async function (keys) {
        var out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { if (k in store) out[k] = store[k]; });
        return out;
      },
      set: async function (obj) { for (var k in obj) store[k] = obj[k]; }
    },
    onChanged: listener
  },
  tabs: { onUpdated: listener, onActivated: listener, query: async function () { return []; },
          get: async function () { throw new Error('no tab'); } },
  action: { setBadgeText: async function () {}, setBadgeBackgroundColor: async function () {} }
};

/**
 * Mimics chrome.userScripts closely enough to be worth testing against: it
 * validates match patterns the way Chrome does (ports and junk hosts are
 * rejected), and register() is atomic per call.
 */
var registry = new Map();
var syncLog = [];
var minCoverage = Infinity;
function validateMatches(script) {
  (script.matches || []).forEach(function (pattern) {
    if (pattern === '<all_urls>') return;
    var host = /^[^:]+:\/\/([^/]*)/.exec(pattern);
    host = host ? host[1] : '';
    if (/:\d+$/.test(host)) {
      throw new Error("Script with ID '" + script.id + "' has invalid value for matches[0]: Invalid port.");
    }
    if (!/^(\*|(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i.test(host)) {
      throw new Error("Script with ID '" + script.id + "' has invalid value for matches[0]: Invalid host.");
    }
  });
}
chrome.userScripts = {
  register: async function (scripts) {
    scripts.forEach(validateMatches);            // atomic: validate all first
    scripts.forEach(function (s) {
      if (registry.has(s.id)) throw new Error('duplicate id ' + s.id);
    });
    scripts.forEach(function (s) { registry.set(s.id, s); });
    syncLog.push('register:' + scripts.map(function (s) { return s.id; }).join(','));
    minCoverage = Math.min(minCoverage, registry.size);
  },
  update: async function (scripts) {
    scripts.forEach(function (s) {
      if (!registry.has(s.id)) throw new Error('no such script ' + s.id);
    });
    scripts.forEach(validateMatches);
    scripts.forEach(function (s) { registry.set(s.id, s); });
    syncLog.push('update:' + scripts.map(function (s) { return s.id; }).join(','));
    minCoverage = Math.min(minCoverage, registry.size);
  },
  unregister: async function (filter) {
    (filter.ids || []).forEach(function (id) { registry.delete(id); });
    syncLog.push('unregister:' + (filter.ids || []).join(','));
    minCoverage = Math.min(minCoverage, registry.size);
  },
  getScripts: async function () {
    return Array.from(registry.values());
  },
  configureWorld: async function () {}
};

importScripts('background.js');

var fails = 0;
function check(cond, label) {
  if (cond) print('ok   ' + label);
  else { fails++; print('FAIL ' + label); }
}

var boost = BoostStore.sanitizeBoost({
  id: 'b1', name: 'My "quoted" boost', patterns: ['github.com', 'bad**host'],
  css: 'body { color: red; }\n/* </style> */', js: 'console.log("hi");',
  runAt: 'document_end', world: 'MAIN'
});

var regs = registrationsFor(boost);
check(regs.length === 2, 'css + js produce two registrations');
check(regs[0].id === 'css:b1' && regs[0].runAt === 'document_start', 'css registered at document_start');
check(regs[1].id === 'js:b1' && regs[1].runAt === 'document_end', 'js keeps its runAt');
check(regs[0].matches.length === 1 && regs[0].matches[0] === '*://*.github.com/*',
      'invalid pattern filtered out, valid one normalized');

// Generated sources must parse, including hostile CSS and quoted names.
[regs[0].js[0].code, regs[1].js[0].code].forEach(function (code, i) {
  try { new Function(code); print('ok   generated source ' + i + ' parses'); }
  catch (e) { fails++; print('FAIL generated source ' + i + ': ' + e); }
});
check(/var css = "/.test(regs[0].js[0].code), 'css is embedded as a quoted JS string literal');
check(JSON.parse(/var css = (".*?");/.exec(regs[0].js[0].code.replace(/\n/g, '\\n'))[1]).indexOf('color: red') !== -1,
      'css round-trips through the string literal');

// A boost with only CSS, only JS, disabled, or no patterns.
check(registrationsFor(BoostStore.sanitizeBoost({ id: 'b2', patterns: ['a.com'], css: 'a{}' })).length === 1, 'css only -> one registration');
check(registrationsFor(BoostStore.sanitizeBoost({ id: 'b3', patterns: ['a.com'], js: 'x' })).length === 1, 'js only -> one registration');
check(registrationsFor(BoostStore.sanitizeBoost({ id: 'b4', patterns: ['a.com'], css: 'a{}', enabled: false })).length === 0, 'disabled -> none');
check(registrationsFor(BoostStore.sanitizeBoost({ id: 'b5', patterns: [], css: 'a{}' })).length === 0, 'no patterns -> none');
check(registrationsFor(BoostStore.sanitizeBoost({ id: 'b6', patterns: ['a.com'], css: '   ', js: '  ' })).length === 0, 'whitespace only -> none');

// A syntax error in user JS must not take the CSS registration down with it.
var broken = BoostStore.sanitizeBoost({ id: 'b7', patterns: ['a.com'], css: 'a{}', js: 'function( {' });
var brokenRegs = registrationsFor(broken);
check(brokenRegs.length === 2, 'broken js still yields both registrations');
try { new Function(brokenRegs[0].js[0].code); print('ok   css source still parses next to broken js'); }
catch (e) { fails++; print('FAIL css source broken by bad js: ' + e); }

// The CSS bootstrap only touches the DOM, so it does not need the page's world.
check(regs[0].world === 'USER_SCRIPT', 'css bootstrap runs in the isolated world');

// Snippets copied out of the DevTools console are usually written with top-level
// await. The wrapper has to be async or they fail to parse.
function wrapperFor(js) {
  return registrationsFor(BoostStore.sanitizeBoost({ id: 'w', patterns: ['a.com'], js: js }))[0].js[0].code;
}
function parses(js) { try { new Function(wrapperFor(js)); return true; } catch (e) { return false; } }
check(parses('await fetch("/x");'), 'top-level await parses inside the wrapper');
check(parses('const x = 1; console.log(x);'), 'ordinary code still parses');
check(/sourceURL=boost-w\.js/.test(wrapperFor('x')), 'wrapper names itself for the console');
check(wrapperFor('LINE1').split('\n')[1] === 'LINE1',
      'user code starts on line 2, so console line numbers stay close to the gutter');

check(userScriptsAvailable() === true, 'userScripts probe finds the mocked API');

/* ------------------------------------------------ the real registration path */

var results = [];

// syncRegistrations() coalesces: a call made while one is in flight queues another
// rather than starting it, so a test has to let the queue drain.
async function flushSync() {
  await syncRegistrations();
  await syncRegistrations();
  await syncRegistrations();
}

(async function () {
  // "localhost:3000" is now rescued (the port is dropped), "###" is not.
  await chrome.storage.local.set({ boosts: [
    BoostStore.sanitizeBoost({ id: 'dev', name: 'Dev server', patterns: ['localhost:3000'],
                               css: 'body{}', js: 'void 0;' }),
    BoostStore.sanitizeBoost({ id: 'junk', name: 'Typo', patterns: ['###'],
                               css: 'body{}', js: 'void 0;' }),
    BoostStore.sanitizeBoost({ id: 'ok', name: 'Fine', patterns: ['example.com'],
                               css: 'body{}', js: 'void 0;' })
  ] });

  await flushSync();
  var ids = (await chrome.userScripts.getScripts()).map(function (s) { return s.id; }).sort();
  check(ids.join(',') === 'css:dev,css:ok,js:dev,js:ok',
        'a dev-server port is rescued, junk is dropped (got ' + ids + ')');

  var runtime = await BoostStore.getRuntime();
  check(!!runtime.errors.junk, 'a boost left with no usable pattern is reported, not silent');
  check(!runtime.errors.dev, 'the rescued boost reports no error');
  check(runtime.userScripts === true,
        'the userScripts flag survives the errors write (setRuntime is serialised)');

  // A resync must never leave a matching page with nothing registered.
  minCoverage = Infinity;
  syncLog = [];
  await flushSync();
  check(minCoverage >= 4, 'resync never drops below full coverage (low water mark ' + minCoverage + ')');
  check(syncLog.length && syncLog[0].indexOf('unregister') !== 0,
        'the new set is registered before stale ids are removed');

  // Deleting a boost still removes its registrations.
  await chrome.storage.local.set({ boosts: [] });
  await flushSync();
  check((await chrome.userScripts.getScripts()).length === 0, 'removing a boost unregisters it');

  results.push(true);
})().catch(function (err) {
  fails++;
  print('FAIL registration suite threw: ' + err);
  results.push(true);
});

drainMicrotasks();
if (!results.length) { fails++; print('FAIL registration suite did not finish'); }

print(fails ? '\n' + fails + ' FAILURES' : '\nall passed');
if (fails) throw new Error('tests failed');
