/*
 * Boosts - per-site CSS and JavaScript for Chromium browsers.
 * Copyright (C) 2026 Oliver Bartsch
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 as published
 * by the Free Software Foundation. This program is distributed WITHOUT ANY
 * WARRANTY; see the LICENSE file for details.
 */

// Autosave issues writes back to back. Each one is a read-modify-write of the
// whole boost list, so without serialisation two overlapping saves lose one of
// the two boosts. This pins that down.
function URL(href) {
  var m = /^([a-z][a-z0-9+.-]*):\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?/i.exec(href);
  if (!m) throw new Error('bad url ' + href);
  this.protocol = m[1].toLowerCase() + ':';
  this.hostname = m[2].toLowerCase().replace(/:\d+$/, '');
  this.pathname = m[3] || '/';
  this.search = m[4] || '';
}
var self = this;

var backing = {};
var reads = 0;

/** Resolves a few microtasks late, so a read can overlap a foreign write. */
function slow(value) {
  return Promise.resolve().then(function () {}).then(function () {}).then(function () { return value; });
}

var chrome = {
  storage: {
    local: {
      get: function (keys) {
        reads++;
        var out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
          if (k in backing) out[k] = backing[k];
        });
        return slow(out);
      },
      set: function (obj) {
        return slow(null).then(function () {
          for (var k in obj) backing[k] = obj[k];
        });
      }
    }
  }
};

load('lib/patterns.js');
load('lib/store.js');

var fails = 0;
function check(cond, label) {
  if (cond) print('ok   ' + label);
  else { fails++; print('FAIL ' + label); }
}

var results = [];

// Two overlapping saves of different boosts.
Promise.all([
  BoostStore.saveBoost(BoostStore.createBoost({ id: 'a', name: 'A', patterns: ['a.com'], css: 'a{}' })),
  BoostStore.saveBoost(BoostStore.createBoost({ id: 'b', name: 'B', patterns: ['b.com'], css: 'b{}' }))
]).then(function () {
  return BoostStore.getBoosts();
}).then(function (list) {
  var names = list.map(function (b) { return b.name; }).sort().join(',');
  check(names === 'A,B', 'overlapping saves keep both boosts (got ' + (names || 'nothing') + ')');

  // A burst of edits to one boost: the last value must win.
  var writes = [];
  for (var i = 1; i <= 8; i++) {
    writes.push(BoostStore.saveBoost({ id: 'a', name: 'A', patterns: ['a.com'], css: 'a{--v:' + i + '}' }));
  }
  return Promise.all(writes).then(function () { return BoostStore.getBoosts(); });
}).then(function (list) {
  var a = list.find(function (b) { return b.id === 'a'; });
  check(!!a, 'burst of edits does not drop the boost');
  check(a && a.css === 'a{--v:8}', 'last write wins (got ' + (a && a.css) + ')');
  check(list.length === 2, 'no duplicates created (got ' + list.length + ')');

  // Delete overlapping with a save of a different boost.
  return Promise.all([
    BoostStore.deleteBoost('a'),
    BoostStore.saveBoost({ id: 'c', name: 'C', patterns: ['c.com'], css: 'c{}' })
  ]).then(function () { return BoostStore.getBoosts(); });
}).then(function (list) {
  var ids = list.map(function (b) { return b.id; }).sort().join(',');
  check(ids === 'b,c', 'delete and save do not clobber each other (got ' + ids + ')');

  // Patterns are normalised on the way into storage.
  return BoostStore.saveBoost({ id: 'd', name: 'D', patterns: ['github.com'] })
    .then(function (record) {
      check(record.patterns[0] === '*://*.github.com/*', 'stored patterns are normalised');
    });
  // Imports must never arrive switched on: a file that merely omits "enabled"
  // used to default to true and register itself against every site it asked for.
}).then(function () {
  var hostile = BoostStore.sanitizeImportedBoost({
    id: 'pack', name: 'Theme pack', patterns: ['*'], js: 'alert(1)'
  });
  check(hostile.enabled === false, 'an imported boost is always disabled');
  check(hostile.patterns[0] === '<all_urls>', 'its scope is still recorded honestly');

  var described = BoostStore.describeBoost(hostile);
  check(described.allSites === true, 'the review prompt knows it wants every site');
  check(described.runsJs === true, 'the review prompt knows it runs JavaScript');
  check(described.sites === 'EVERY site you visit', 'and says so in words');

  // Appending is serialised, so a concurrent autosave cannot be lost.
  return Promise.all([
    BoostStore.appendBoosts([hostile]),
    BoostStore.saveBoost({ id: 'live', name: 'Live edit', patterns: ['x.com'], css: 'x{}' })
  ]).then(function () { return BoostStore.getBoosts(); });
}).then(function (list) {
  var ids = list.map(function (b) { return b.id; }).sort().join(',');
  check(ids.indexOf('live') !== -1 && ids.indexOf('pack') !== -1,
        'an import running next to an autosave keeps both (got ' + ids + ')');

  // Ordering decides which CSS wins, so it has to be movable and stable.
  return BoostStore.getBoosts().then(function (before) {
    var firstId = before[0].id;
    return BoostStore.moveBoost(firstId, 1).then(function () {
      return BoostStore.getBoosts().then(function (after) {
        check(after[1].id === firstId, 'moveBoost moves a boost down one place');
        check(after.length === before.length, 'and does not lose any');
        return BoostStore.moveBoost(firstId, -5);
      });
    }).then(function () {
      return BoostStore.getBoosts();
    }).then(function (after) {
      check(after[0].id === firstId, 'moving past the start clamps to the start');
    });
  });
}).then(function () {
  results.push(fails);
}, function (err) {
  fails++;
  print('FAIL threw: ' + err);
  results.push(fails);
});

drainMicrotasks();

if (!results.length) { print('FAIL suite did not finish'); fails++; }
print(fails ? '\n' + fails + ' FAILURES' : '\nall passed');
if (fails) throw new Error('tests failed');
