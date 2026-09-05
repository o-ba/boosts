/*
 * Boosts - per-site CSS and JavaScript for Chromium browsers.
 * Copyright (C) 2026 Oliver Bartsch
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 as published
 * by the Free Software Foundation. This program is distributed WITHOUT ANY
 * WARRANTY; see the LICENSE file for details.
 */

/**
 * Service worker: turns stored boosts into live chrome.userScripts registrations.
 *
 * Each boost becomes up to two registrations, registered separately so that a
 * pattern Chrome rejects on one cannot take the other down, and so CSS always runs
 * at document_start:
 *   css:<id>  document_start, USER_SCRIPT world (it only touches the DOM)
 *   js:<id>   the boost's own runAt / world
 *
 * The new set is registered before stale ids are removed, so a page loading during a
 * resync is never left unstyled.
 */
'use strict';

importScripts('lib/patterns.js', 'lib/store.js');

var CSS_PREFIX = 'css:';
var JS_PREFIX = 'js:';

/* ------------------------------------------------------------------ helpers */

/**
 * chrome.userScripts is only exposed once the user allowed user scripts for this
 * extension, and touching it otherwise throws. Probe defensively.
 */
function userScriptsAvailable() {
  try {
    return !!(chrome.userScripts && chrome.userScripts.register);
  } catch (e) {
    return false;
  }
}

function validPatterns(boost) {
  return (boost.patterns || [])
    .map(BoostPatterns.normalizePattern)
    .filter(function (pattern) { return pattern && BoostPatterns.isValidPattern(pattern); });
}

/** Bootstrap that keeps a <style> element alive even if the page tears it down. */
function cssBootstrap(boost) {
  return [
    '(function(){',
    '  var css = ' + JSON.stringify(boost.css) + ';',
    '  var id = ' + JSON.stringify('boost-' + boost.id) + ';',
    '  var style = document.getElementById(id);',
    '  if (!style) {',
    '    style = document.createElement("style");',
    '    style.id = id;',
    '    style.type = "text/css";',
    '  }',
    '  style.textContent = css;',
    // A page that reconciles <style> elements (React 19 hoists them) can remove ours
    // on every render. Re-attach, but give up after a while rather than trading
    // mutations with the page forever.
    '  var attempts = 0;',
    '  var observer = new MutationObserver(function(){',
    '    if (style.isConnected) return;',
    '    if (++attempts > 50) { observer.disconnect(); return; }',
    '    place(); observe();',
    '  });',
    '  function place(){ (document.head || document.documentElement).appendChild(style); }',
    '  function observe(){',
    '    observer.disconnect();',
    '    if (style.parentNode) observer.observe(style.parentNode, { childList: true });',
    '  }',
    '  place();',
    '  observe();',
    '  document.addEventListener("DOMContentLoaded", function(){',
    '    if (document.head && style.parentNode !== document.head) { document.head.appendChild(style); observe(); }',
    '  }, { once: true });',
    '})();'
  ].join('\n');
}

/**
 * User JS, isolated so a throw is reported instead of breaking the page.
 *
 * Async so that top-level await works, which is how most snippets copied out of the
 * DevTools console are written. The wrapper adds exactly one line above the user's
 * code and a sourceURL below it, so console line numbers line up with the editor
 * gutter instead of being off by the height of the wrapper.
 */
function jsBootstrap(boost) {
  var label = JSON.stringify('[Boosts] ' + boost.name);
  return [
    '(async function(){ try {',
    boost.js,
    '} catch (err) { console.error(' + label + ', err); } })()',
    '  .catch(function(err){ console.error(' + label + ', err); });',
    '//# sourceURL=boost-' + boost.id + '.js'
  ].join('\n');
}

function registrationsFor(boost) {
  var matches = validPatterns(boost);
  if (!boost.enabled || !matches.length) return [];

  var out = [];
  if (boost.css.trim()) {
    out.push({
      id: CSS_PREFIX + boost.id,
      matches: matches,
      js: [{ code: cssBootstrap(boost) }],
      runAt: 'document_start',
      // Only touches the DOM, so it gains nothing from the page's world and the
      // page cannot reach in and patch it here.
      world: 'USER_SCRIPT',
      allFrames: boost.allFrames
    });
  }
  if (boost.js.trim()) {
    out.push({
      id: JS_PREFIX + boost.id,
      matches: matches,
      js: [{ code: jsBootstrap(boost) }],
      runAt: boost.runAt,
      world: boost.world,
      allFrames: boost.allFrames
    });
  }
  return out;
}

/* ------------------------------------------------------- registration sync */

var syncing = null;
var resyncQueued = false;
var syncTimer = null;

/**
 * Autosave writes storage often, and each write would otherwise trigger a full
 * unregister/re-register cycle. Coalesce bursts into one sync.
 */
function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(function () { syncRegistrations(); }, delay == null ? 400 : delay);
}

/** Replaces all registrations with the current stored set. */
async function syncRegistrations() {
  clearTimeout(syncTimer);
  // A save that lands mid-sync must not be dropped: queue one more pass.
  if (syncing) {
    resyncQueued = true;
    return syncing;
  }
  syncing = (async function () {
    var available = userScriptsAvailable();
    if (!available) {
      await BoostStore.setRuntime({ userScripts: false, errors: {} });
      await refreshAllBadges();
      return;
    }

    try {
      // Only affects boosts set to the isolated world; allowing eval there keeps
      // pasted snippets from the web working as they would in a page.
      await chrome.userScripts.configureWorld({
        messaging: false,
        csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      });
    } catch (e) {
      /* configureWorld is optional; a failure here must not stop registration. */
    }

    var settings = await BoostStore.getSettings();
    var boosts = settings.paused ? [] : await BoostStore.getBoosts();
    var errors = {};
    var wanted = [];

    // Register each boost's CSS and JS as separate calls, so a pattern Chrome
    // rejects on one cannot take the other down with it, and so one bad boost
    // cannot disable the rest.
    for (var i = 0; i < boosts.length; i++) {
      var boost = boosts[i];

      // An enabled boost with code but no usable site pattern would otherwise sit
      // there doing nothing, with no explanation anywhere in the UI. Invalid
      // patterns are dropped on the way into storage, so this covers a typo that
      // was discarded as well as a boost that never had a pattern.
      if (boost.enabled && (boost.css.trim() || boost.js.trim()) && !validPatterns(boost).length) {
        errors[boost.id] = 'No usable site pattern, so this boost never runs.';
      }

      var scripts = registrationsFor(boost);
      for (var j = 0; j < scripts.length; j++) {
        var script = scripts[j];
        try {
          // update() where it already exists, so an edit never leaves a window
          // with nothing registered; register() only for genuinely new ids.
          await chrome.userScripts.update([script]);
        } catch (e) {
          try {
            await chrome.userScripts.register([script]);
          } catch (err) {
            errors[boost.id] = err && err.message ? err.message : String(err);
            console.error('[Boosts] failed to register "' + boost.name + '"', err);
            continue;
          }
        }
        wanted.push(script.id);
      }
    }

    // Remove what is no longer wanted only once the new set is in place, so there
    // is never a moment where a matching page would load unstyled.
    try {
      var live = await chrome.userScripts.getScripts();
      var stale = live
        .map(function (s) { return s.id; })
        .filter(function (id) { return wanted.indexOf(id) === -1; });
      if (stale.length) await chrome.userScripts.unregister({ ids: stale });
    } catch (e) {
      console.warn('[Boosts] could not clear stale registrations', e);
    }

    await BoostStore.setRuntime({ userScripts: true, errors: errors, paused: settings.paused });
    await refreshAllBadges(boosts);
  })().finally(function () {
    syncing = null;
    if (resyncQueued) {
      resyncQueued = false;
      syncRegistrations();
    }
  });

  return syncing;
}

/* -------------------------------------------------------------- action badge */

function badgeForUrl(boosts, url) {
  if (!BoostPatterns.isInjectableUrl(url)) return 0;
  return boosts.filter(function (b) {
    return b.enabled && BoostPatterns.boostMatchesUrl(b, url);
  }).length;
}

/**
 * Takes the boost list as an argument rather than reading storage. Counting for one
 * tab used to deserialise every boost's CSS and JS out of storage, once per tab, on
 * every save.
 */
async function updateBadge(tabId, url, boosts) {
  var settings = await BoostStore.getSettings();
  var list = boosts || (settings.paused ? [] : await BoostStore.getBoosts());
  var count = settings.paused ? 0 : badgeForUrl(list, url);
  try {
    await chrome.action.setBadgeText({
      tabId: tabId,
      text: settings.paused ? '❚❚' : (count ? String(count) : '')
    });
    await chrome.action.setBadgeBackgroundColor({
      tabId: tabId,
      color: settings.paused ? '#8a5a00' : '#6366f1'
    });
  } catch (e) {
    /* Tab closed while we were counting. */
  }
}

async function refreshAllBadges(boosts) {
  var list = boosts || await BoostStore.getBoosts();
  var tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(function (tab) {
    return tab.id != null ? updateBadge(tab.id, tab.url || '', list) : null;
  }));
}

/* ------------------------------------------------------------------ wiring */

/** One disabled example so a fresh install shows what a boost looks like. */
async function seedExample() {
  var existing = await BoostStore.getBoosts();
  if (existing.length) return;
  await BoostStore.saveBoost(BoostStore.createBoost({
    name: 'Example: Wikipedia reading width',
    patterns: ['wikipedia.org'],
    enabled: false,
    css: [
      '/* Widen the article column and soften the type. */',
      '.mw-parser-output {',
      '  max-width: 46rem;',
      '  font-size: 1.05rem;',
      '  line-height: 1.7;',
      '}'
    ].join('\n'),
    js: [
      '// Runs in the page, so page globals are reachable.',
      'console.log(\'[Boosts] hello from\', location.hostname);'
    ].join('\n')
  }));
}

chrome.runtime.onInstalled.addListener(async function (details) {
  if (details.reason === 'install') {
    await seedExample();
    chrome.runtime.openOptionsPage();
  }
  syncRegistrations();
});

chrome.runtime.onStartup.addListener(function () {
  syncRegistrations();
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.boosts) scheduleSync();
  // Pausing should feel immediate, not debounced behind an autosave window.
  if (changes.settings) scheduleSync(0);
});

chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (info.url || info.status === 'complete') updateBadge(tabId, tab.url || '');
});

chrome.tabs.onActivated.addListener(async function (info) {
  try {
    var tab = await chrome.tabs.get(info.tabId);
    updateBadge(info.tabId, tab.url || '');
  } catch (e) {
    /* Tab vanished. */
  }
});

chrome.runtime.onMessage.addListener(function (message, sender, respond) {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'sync') {
    syncRegistrations()
      .then(BoostStore.getRuntime)
      .then(function (runtime) {
        respond({ ok: true, userScripts: userScriptsAvailable(), runtime: runtime });
      });
    return true;
  }

  // Sent by the popup as it is dismissed, when its own write would not finish.
  if (message.type === 'save' && message.boost) {
    BoostStore.saveBoost(message.boost).then(
      function (record) { respond({ ok: true, boost: record }); },
      function (err) { respond({ ok: false, error: String(err) }); }
    );
    return true;
  }

  if (message.type === 'status') {
    BoostStore.getRuntime().then(function (runtime) {
      respond({ ok: true, userScripts: userScriptsAvailable(), runtime: runtime });
    });
    return true;
  }

  return false;
});

// The worker can be respawned at any time; make sure state is current.
syncRegistrations();
