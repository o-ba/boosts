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
 * Storage layer. Everything lives in chrome.storage.local under three keys:
 *   boosts   - ordered array of boost records; order decides which CSS wins
 *   runtime  - state the UI needs from the worker (see background.js)
 *   settings - user-level switches, currently just the global pause
 */
(function (root) {
  'use strict';

  var KEY_BOOSTS = 'boosts';
  var KEY_RUNTIME = 'runtime';
  var KEY_SETTINGS = 'settings';

  var DEFAULTS = {
    name: 'New boost',
    patterns: [],
    css: '',
    js: '',
    enabled: true,
    runAt: 'document_idle',
    world: 'MAIN',
    allFrames: false
  };

  function newId() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function createBoost(overrides) {
    return Object.assign({}, DEFAULTS, { id: newId(), updatedAt: Date.now() }, overrides || {});
  }

  /** Drops unknown keys and coerces types, so imported files cannot corrupt state. */
  function sanitizeBoost(raw) {
    var patterns = Array.isArray(raw && raw.patterns) ? raw.patterns : [];
    return {
      id: (raw && raw.id) || newId(),
      name: String((raw && raw.name) || DEFAULTS.name).slice(0, 200),
      patterns: patterns
        .map(function (p) { return BoostPatterns.normalizePattern(p); })
        .filter(Boolean),
      css: String((raw && raw.css) || ''),
      js: String((raw && raw.js) || ''),
      enabled: (raw && raw.enabled) !== false,
      runAt: ['document_start', 'document_end', 'document_idle'].indexOf(raw && raw.runAt) === -1
        ? DEFAULTS.runAt : raw.runAt,
      world: (raw && raw.world) === 'USER_SCRIPT' ? 'USER_SCRIPT' : 'MAIN',
      allFrames: !!(raw && raw.allFrames),
      updatedAt: Number((raw && raw.updatedAt) || Date.now())
    };
  }

  /**
   * A boost that arrived from a file rather than from the user. Same shape, but it
   * can never switch itself on: an imported file that merely omits "enabled" used to
   * default to true and register itself against every site it asked for.
   */
  function sanitizeImportedBoost(raw) {
    var boost = sanitizeBoost(raw);
    boost.enabled = false;
    return boost;
  }

  /** A one-line summary of what a file is asking to install, for the import prompt. */
  function describeBoost(boost) {
    var parts = [];
    if (boost.css.trim()) parts.push('CSS');
    if (boost.js.trim()) parts.push('JavaScript');
    var sites = boost.patterns.length ? boost.patterns.join(', ') : 'no sites';
    if (boost.patterns.indexOf('<all_urls>') !== -1) sites = 'EVERY site you visit';
    return {
      name: boost.name,
      sites: sites,
      contains: parts.length ? parts.join(' + ') : 'nothing',
      runsJs: !!boost.js.trim(),
      allSites: boost.patterns.indexOf('<all_urls>') !== -1
    };
  }

  // Autosave fires writes in quick succession, and every write is a
  // read-modify-write of the whole list. Serialising them stops two in-flight
  // saves from clobbering each other.
  var writeQueue = Promise.resolve();

  function serialize(task) {
    var run = writeQueue.then(task, task);
    writeQueue = run.catch(function () {});
    return run;
  }

  async function getBoosts() {
    var data = await chrome.storage.local.get(KEY_BOOSTS);
    var list = Array.isArray(data[KEY_BOOSTS]) ? data[KEY_BOOSTS] : [];
    return list.map(sanitizeBoost);
  }

  async function setBoosts(list) {
    return serialize(function () {
      return chrome.storage.local.set({ boosts: list.map(sanitizeBoost) });
    });
  }

  async function writeBoosts(list) {
    await chrome.storage.local.set({ boosts: list.map(sanitizeBoost) });
  }

  async function getBoost(id) {
    var list = await getBoosts();
    return list.find(function (b) { return b.id === id; }) || null;
  }

  /** Inserts or replaces by id and returns the stored record. */
  async function saveBoost(boost) {
    return serialize(async function () {
      var list = await getBoosts();
      var record = sanitizeBoost(Object.assign({}, boost, { updatedAt: Date.now() }));
      var index = list.findIndex(function (b) { return b.id === record.id; });
      if (index === -1) list.push(record); else list[index] = record;
      await writeBoosts(list);
      return record;
    });
  }

  async function deleteBoost(id) {
    return serialize(async function () {
      var list = await getBoosts();
      await writeBoosts(list.filter(function (b) { return b.id !== id; }));
    });
  }

  async function getRuntime() {
    var data = await chrome.storage.local.get(KEY_RUNTIME);
    return Object.assign({ userScripts: false, lastError: '', errors: {} }, data[KEY_RUNTIME] || {});
  }

  /**
   * Serialised like the boost writes: this is a read-modify-write too, and the
   * service worker patches it from two places during one sync. Unserialised, the
   * "user scripts are on" flag could be clobbered by the errors write that follows
   * it, which showed the first-run setup wizard on a working install.
   */
  async function setRuntime(patch) {
    return serialize(async function () {
      var current = await getRuntime();
      await chrome.storage.local.set({ runtime: Object.assign(current, patch) });
    });
  }

  /**
   * Appends boosts to the stored list inside the write queue, so a concurrent
   * autosave cannot be lost between the read and the write.
   */
  async function appendBoosts(incoming) {
    return serialize(async function () {
      var list = await getBoosts();
      var taken = new Set(list.map(function (b) { return b.id; }));
      var added = incoming.map(function (boost) {
        var record = Object.assign({}, boost);
        // Keep both copies rather than silently overwriting an existing boost.
        if (taken.has(record.id)) record.id = newId();
        taken.add(record.id);
        return record;
      });
      await writeBoosts(list.concat(added));
      return added;
    });
  }

  /** Moves a boost within the ordered list; order decides which CSS wins. */
  async function moveBoost(id, delta) {
    return serialize(async function () {
      var list = await getBoosts();
      var from = list.findIndex(function (b) { return b.id === id; });
      if (from === -1) return list;
      var to = Math.max(0, Math.min(list.length - 1, from + delta));
      if (to === from) return list;
      list.splice(to, 0, list.splice(from, 1)[0]);
      await writeBoosts(list);
      return list;
    });
  }

  /**
   * Global switch. A single boost with a "*" pattern and a bad rule can make every
   * page in the browser unusable, and the popup is the wrong place to fix it because
   * the popup is on the broken page. This is the way out.
   */
  async function getSettings() {
    var data = await chrome.storage.local.get(KEY_SETTINGS);
    return Object.assign({ paused: false }, data[KEY_SETTINGS] || {});
  }

  async function setSettings(patch) {
    return serialize(async function () {
      var current = await getSettings();
      var next = Object.assign(current, patch);
      await chrome.storage.local.set({ settings: next });
      return next;
    });
  }

  root.BoostStore = {
    DEFAULTS: DEFAULTS,
    newId: newId,
    createBoost: createBoost,
    sanitizeBoost: sanitizeBoost,
    sanitizeImportedBoost: sanitizeImportedBoost,
    describeBoost: describeBoost,
    getBoosts: getBoosts,
    setBoosts: setBoosts,
    appendBoosts: appendBoosts,
    moveBoost: moveBoost,
    getBoost: getBoost,
    saveBoost: saveBoost,
    deleteBoost: deleteBoost,
    getRuntime: getRuntime,
    setRuntime: setRuntime,
    getSettings: getSettings,
    setSettings: setSettings
  };
})(typeof self !== 'undefined' ? self : this);
