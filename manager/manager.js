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
 * Manager page: full CRUD over boosts, plus the user-scripts setup guide.
 *
 * Autosaves like the popup. state.current is the source of truth; the inputs
 * push into it on the event that suits each field, so a half-typed site pattern
 * is never written to storage (patterns commit on blur, not on every keystroke).
 */
(function () {
  'use strict';

  var SAVE_DELAY = 400;
  var NAME_DELAY = 600;

  var el = {};
  ['setup', 'list', 'empty', 'search', 'new', 'detail', 'placeholder', 'name', 'enabled',
    'duplicate', 'delete', 'error', 'patterns', 'normalized', 'runAt', 'world', 'allFrames',
    'tab-css', 'tab-js', 'status', 'save', 'pane', 'import', 'export', 'file',
    'a11y-status', 'import-dialog', 'import-summary', 'import-list', 'import-warning',
    'import-confirm', 'paused', 'paused-banner'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  /** Autosave state is the only feedback this UI gives; make sure it is announced. */
  function announce(message) {
    if (el['a11y-status']) el['a11y-status'].textContent = message;
  }

  var state = {
    boosts: [],
    current: null,
    field: 'css',
    filter: '',
    errors: {},
    revision: 0,
    savedRevision: 0
  };

  var editor = new CodeArea(el.pane, {
    label: 'Boost code',
    language: 'css',
    onChange: onEdit,
    onSave: function () { commit(true); }
  });

  /* -------------------------------------------------------------- utilities */

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status ' + (kind || 'muted');
    // "Saving..." fires constantly while typing; only announce settled states.
    if (kind === 'ok' || kind === 'error') announce(text);
  }

  function patternLines() {
    return el.patterns.value
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(Boolean);
  }

  function renderNormalized() {
    var lines = patternLines();
    if (!lines.length) {
      el.normalized.textContent = 'No pattern set, so this boost will not run.';
      return;
    }
    el.normalized.textContent = lines.map(function (line) {
      var result = BoostPatterns.explainPattern(line);
      if (!result.valid) return '✕ ' + line + ': ' + (result.error || 'not a valid pattern');
      return '→ ' + result.pattern + (result.note ? '   (' + result.note + ')' : '');
    }).join('\n');
  }

  /* ------------------------------------------------------------------- list */

  /**
   * Rebuilds the sidebar. Focus is restored afterwards: this runs on every autosave
   * tick, and it used to drop the user's focus to <body> every time - which made the
   * row toggles unusable from the keyboard.
   */
  function renderList() {
    var filter = state.filter.toLowerCase();
    var visible = state.boosts.filter(function (boost) {
      if (!filter) return true;
      return (boost.name + ' ' + boost.patterns.join(' ')).toLowerCase().indexOf(filter) !== -1;
    });

    var focusKey = focusKeyOf(document.activeElement);

    el.list.textContent = '';
    if (!state.boosts.length) {
      el.empty.hidden = false;
      el.empty.textContent = 'No boosts yet. Create one, or open the popup on a site.';
    } else if (!visible.length) {
      el.empty.hidden = false;
      el.empty.textContent = 'Nothing matches “' + state.filter + '”.';
    } else {
      el.empty.hidden = true;
    }

    visible.forEach(function (boost) {
      var index = state.boosts.indexOf(boost);
      var isCurrent = !!state.current && state.current.id === boost.id;

      var item = document.createElement('li');
      item.className = boost.enabled ? '' : 'off';
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.dataset.id = boost.id;
      item.setAttribute('aria-current', String(isCurrent));
      item.setAttribute('aria-label',
        boost.name + ', ' + (boost.enabled ? 'enabled' : 'disabled')
        + ', ' + (boost.patterns.join(' ') || 'no site pattern'));

      var toggle = document.createElement('label');
      toggle.className = 'switch';
      toggle.title = boost.enabled ? 'Disable' : 'Enable';
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = boost.enabled;
      checkbox.dataset.focus = 'toggle:' + boost.id;
      checkbox.setAttribute('aria-label', (boost.enabled ? 'Disable ' : 'Enable ') + boost.name);
      checkbox.addEventListener('click', function (event) { event.stopPropagation(); });
      checkbox.addEventListener('keydown', function (event) { event.stopPropagation(); });
      checkbox.addEventListener('change', async function () {
        announce(boost.name + (checkbox.checked ? ' enabled' : ' disabled'));
        if (state.current && state.current.id === boost.id) {
          state.current.enabled = checkbox.checked;
          el.enabled.checked = checkbox.checked;
          markEdited(0);
          return;
        }
        await BoostStore.saveBoost(Object.assign({}, boost, { enabled: checkbox.checked }));
        await reload();
      });
      toggle.append(checkbox, document.createElement('span'));

      var info = document.createElement('div');
      info.className = 'info';
      var title = document.createElement('div');
      title.className = 'title';
      title.textContent = boost.name;
      var sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = boost.patterns.join(' ') || 'no pattern';
      info.append(title, sub);

      var flags = document.createElement('div');
      flags.className = 'flags';
      flags.textContent = [boost.css.trim() && 'CSS', boost.js.trim() && 'JS']
        .filter(Boolean).join(' ');

      if (state.errors[boost.id]) {
        flags.textContent = '!';
        flags.title = state.errors[boost.id];
      }

      // Order decides which boost wins when two style the same element, so it has
      // to be something the user can actually change.
      var order = document.createElement('div');
      order.className = 'order';
      order.append(
        orderButton('▲', 'Move ' + boost.name + ' up', index === 0, boost.id, -1),
        orderButton('▼', 'Move ' + boost.name + ' down', index === state.boosts.length - 1, boost.id, 1)
      );

      item.append(toggle, info, flags, order);
      item.addEventListener('click', function () { select(boost.id); });
      item.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(boost.id);
        }
      });
      el.list.append(item);
    });

    restoreFocus(focusKey);
  }

  function orderButton(glyph, label, disabled, id, delta) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyph;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.dataset.focus = 'order:' + delta + ':' + id;
    button.addEventListener('click', async function (event) {
      event.stopPropagation();
      await commit(false);
      await BoostStore.moveBoost(id, delta);
      await reload();
      announce('Moved ' + (delta < 0 ? 'up' : 'down'));
    });
    button.addEventListener('keydown', function (event) { event.stopPropagation(); });
    return button;
  }

  /** Identifies the focused control so it can be found again after a rebuild. */
  function focusKeyOf(node) {
    if (!node || !el.list.contains(node)) return '';
    if (node.dataset && node.dataset.focus) return node.dataset.focus;
    if (node.tagName === 'LI' && node.dataset.id) return 'row:' + node.dataset.id;
    return '';
  }

  function restoreFocus(key) {
    if (!key) return;
    var next = key.indexOf('row:') === 0
      ? el.list.querySelector('li[data-id="' + key.slice(4) + '"]')
      : el.list.querySelector('[data-focus="' + key + '"]');
    if (next && !next.disabled) next.focus();
  }

  /* ----------------------------------------------------------------- detail */

  /**
   * Swaps the editor between CSS and JS. Deliberately touches nothing else, and
   * never runs mid-edit on the field it is showing: editor.set moves the caret.
   */
  function renderEditor() {
    if (!state.current) return;
    var isCss = state.field === 'css';
    el['tab-css'].setAttribute('aria-selected', String(isCss));
    el['tab-js'].setAttribute('aria-selected', String(!isCss));
    el['tab-css'].tabIndex = isCss ? 0 : -1;
    el['tab-js'].tabIndex = isCss ? -1 : 0;
    el.pane.setAttribute('aria-labelledby', isCss ? 'tab-css' : 'tab-js');
    editor.textarea.placeholder = isCss
      ? '/* CSS applied to the matching sites */'
      : '// JavaScript run on the matching sites';
    editor.setLanguage(isCss ? 'css' : 'js');
    editor.set(isCss ? state.current.css : state.current.js);
  }

  function renderError() {
    var message = state.current ? state.errors[state.current.id] : '';
    el.error.hidden = !message;
    el.error.textContent = message ? 'Could not register this boost: ' + message : '';
  }

  function renderDetail() {
    var boost = state.current;
    el.detail.hidden = !boost;
    el.placeholder.hidden = !!boost;
    if (!boost) return;

    el.name.value = boost.name;
    el.enabled.checked = boost.enabled;
    el.patterns.value = boost.patterns.join('\n');
    el.runAt.value = boost.runAt;
    el.world.value = boost.world;
    el.allFrames.checked = boost.allFrames;
    renderNormalized();
    renderError();
    renderEditor();
  }

  /* ----------------------------------------------------------------- saving */

  var saveTimer = null;

  function dirty() {
    return state.revision !== state.savedRevision;
  }

  function markEdited(delay) {
    if (!state.current) return;
    state.revision++;
    setStatus('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { commit(false); }, delay == null ? SAVE_DELAY : delay);
  }

  function onEdit(value) {
    if (!state.current) return;
    if (state.field === 'css') state.current.css = value; else state.current.js = value;
    markEdited();
  }

  function listFieldsChanged(a, b) {
    return a.name !== b.name
      || a.enabled !== b.enabled
      || a.patterns.join('\n') !== b.patterns.join('\n')
      || !a.css.trim() !== !b.css.trim()
      || !a.js.trim() !== !b.js.trim();
  }

  /** Pulls patterns out of the textarea. Only for teardown and explicit saves. */
  function pullPatterns() {
    if (!state.current) return;
    state.current.patterns = patternLines()
      .map(BoostPatterns.normalizePattern)
      .filter(Boolean);
  }

  async function commit(force) {
    clearTimeout(saveTimer);
    if (!state.current) return;
    if (force) pullPatterns();
    if (!force && !dirty()) return;

    var at = state.revision;
    var record;
    try {
      record = await BoostStore.saveBoost(state.current);
    } catch (e) {
      setStatus('Could not save: ' + (e && e.message ? e.message : e), 'error');
      return;
    }

    state.current.id = record.id;

    // The sidebar only shows name, patterns, enabled state and which of CSS/JS is
    // present. Rebuilding it on every keystroke pause is wasted work.
    var stored = state.boosts.find(function (b) { return b.id === record.id; });
    if (!stored || listFieldsChanged(stored, record)) await reload();
    else state.boosts = state.boosts.map(function (b) { return b.id === record.id ? record : b; });

    if (state.revision !== at) return; // Superseded; the pending timer handles it.
    state.savedRevision = at;
    setStatus('Saved', 'ok');
  }

  /** The tab is closing, so grab whatever the inputs hold and hand it over. */
  function flushOnTeardown() {
    if (!state.current) return;
    // Patterns commit on blur, which never fires when a tab is closed outright.
    // Comparing before and after is what makes an unblurred edit survive; the old
    // code pulled them and then returned early because the revision hadn't moved.
    var before = state.current.patterns.join('\n');
    pullPatterns();
    if (state.current.patterns.join('\n') !== before) state.revision++;
    if (!dirty()) return;
    clearTimeout(saveTimer);
    try {
      chrome.runtime.sendMessage({ type: 'save', boost: state.current });
    } catch (e) {
      /* Nothing left to try. */
    }
  }

  /* ------------------------------------------------------------- navigation */

  async function select(id) {
    await commit(false);
    var found = state.boosts.find(function (b) { return b.id === id; });
    state.current = found ? Object.assign({}, found) : null;
    state.revision = state.savedRevision = 0;
    setStatus('');
    renderList();
    renderDetail();
  }

  async function createNew() {
    await commit(false);
    var record = await BoostStore.saveBoost(BoostStore.createBoost({
      name: 'Untitled boost',
      enabled: false
    }));
    await reload();
    await select(record.id);
    el.name.focus();
    el.name.select();
    setStatus('Add a site pattern, then enable it');
  }

  async function duplicate() {
    if (!state.current) return;
    await commit(true);
    var source = state.current;
    var record = await BoostStore.saveBoost(BoostStore.createBoost({
      name: source.name + ' copy',
      patterns: source.patterns.slice(),
      css: source.css,
      js: source.js,
      enabled: false,
      runAt: source.runAt,
      world: source.world,
      allFrames: source.allFrames
    }));
    await reload();
    await select(record.id);
  }

  async function remove() {
    if (!state.current) return;
    if (!confirm('Delete "' + state.current.name + '"? Pages using it need a reload.')) return;
    clearTimeout(saveTimer);
    var id = state.current.id;
    state.current = null;
    state.revision = state.savedRevision = 0;
    await BoostStore.deleteBoost(id);
    await reload();
    renderDetail();
    setStatus('Deleted');
  }

  /* --------------------------------------------------------- import/export */

  async function exportAll() {
    await commit(false);
    var boosts = await BoostStore.getBoosts();
    var payload = JSON.stringify({ format: 'boosts@1', exportedAt: new Date().toISOString(), boosts: boosts }, null, 2);
    var url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    var link = document.createElement('a');
    link.href = url;
    link.download = 'boosts-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking in the same tick can cancel the download on a slow disk.
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    setStatus('Exported ' + boosts.length + ' boost' + (boosts.length === 1 ? '' : 's'), 'ok');
  }

  /**
   * Imports are the one path that ingests a file someone else wrote. Everything
   * arrives switched off and is shown before it is written, because a file that
   * merely omitted "enabled" used to install itself against every site at once.
   */
  async function importFile(file) {
    var text;
    try {
      text = await file.text();
    } catch (e) {
      setStatus('Could not read that file', 'error');
      return;
    }

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setStatus('That file is not valid JSON', 'error');
      return;
    }

    var format = parsed && parsed.format;
    if (format && !/^boosts@1$/.test(String(format))) {
      setStatus('Unsupported export format "' + format + '"', 'error');
      return;
    }

    var incoming = Array.isArray(parsed) ? parsed : parsed && parsed.boosts;
    if (!Array.isArray(incoming) || !incoming.length) {
      setStatus('No boosts found in that file', 'error');
      return;
    }

    var boosts = incoming.map(BoostStore.sanitizeImportedBoost);
    var accepted = await reviewImport(boosts);
    if (!accepted) {
      setStatus('Import cancelled');
      return;
    }

    var added = await BoostStore.appendBoosts(boosts);
    await reload();
    setStatus('Imported ' + added.length + ' boost' + (added.length === 1 ? '' : 's') + ', all disabled', 'ok');
  }

  /** Shows what a file is asking to install. Resolves true if the user accepts. */
  function reviewImport(boosts) {
    var dialog = el['import-dialog'];
    var summaries = boosts.map(BoostStore.describeBoost);

    el['import-summary'].textContent =
      'This file contains ' + boosts.length + ' boost' + (boosts.length === 1 ? '' : 's') + '.';

    el['import-list'].textContent = '';
    summaries.forEach(function (info) {
      var li = document.createElement('li');
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = info.name;
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = info.contains + ' · ' + info.sites;
      if (info.allSites || info.runsJs) meta.classList.add('risk');
      li.append(name, meta);
      el['import-list'].append(li);
    });

    var risky = summaries.filter(function (i) { return i.runsJs; });
    var everywhere = summaries.filter(function (i) { return i.allSites; });
    var warnings = [];
    if (risky.length) {
      warnings.push(risky.length + ' of these run JavaScript, which can read and change '
        + 'anything on the pages they match, including what you type.');
    }
    if (everywhere.length) {
      warnings.push(everywhere.length + ' ask to run on every site you visit.');
    }
    el['import-warning'].hidden = !warnings.length;
    el['import-warning'].textContent = warnings.join(' ');

    if (typeof dialog.showModal !== 'function') {
      // No <dialog> support: fall back to a plain confirm rather than silently importing.
      return Promise.resolve(window.confirm(
        'Import ' + boosts.length + ' boost(s)? They will be added switched off.'));
    }

    return new Promise(function (resolve) {
      function done() {
        dialog.removeEventListener('close', done);
        resolve(dialog.returnValue === 'import');
      }
      dialog.addEventListener('close', done);
      dialog.returnValue = 'cancel';
      dialog.showModal();
      el['import-confirm'].focus();
    });
  }

  /* ------------------------------------------------------------ setup guide */

  function renderSetup(status) {
    if (status && status.userScripts) {
      el.setup.hidden = true;
      return;
    }

    el.setup.hidden = false;
    el.setup.textContent = '';

    var box = document.createElement('div');
    box.className = 'notice warn';

    var heading = document.createElement('strong');
    heading.textContent = 'JavaScript injection is not enabled yet';
    var intro = document.createElement('div');
    intro.textContent = 'CSS boosts already work. Chromium requires an explicit '
      + 'opt-in before an extension may run user JavaScript:';

    var steps = document.createElement('ol');
    [
      'Open the extensions page and find "Boosts".',
      'Open its Details.',
      'Turn on "Allow User Scripts". On older builds, switch on "Developer mode" (top right) first.',
      'Come back here and press Re-check.'
    ].forEach(function (text) {
      var li = document.createElement('li');
      li.textContent = text;
      steps.append(li);
    });

    var actions = document.createElement('div');
    actions.className = 'actions';

    var open = document.createElement('button');
    open.textContent = 'Open extensions page';
    open.addEventListener('click', function () {
      chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
    });

    var recheck = document.createElement('button');
    recheck.className = 'primary';
    recheck.textContent = 'Re-check';
    recheck.addEventListener('click', function () { refreshStatus(true); });

    actions.append(open, recheck);
    box.append(heading, intro, steps, actions);
    el.setup.append(box);
  }

  async function refreshStatus(resync) {
    var status = await chrome.runtime
      .sendMessage({ type: resync ? 'sync' : 'status' })
      .catch(function () { return null; });

    if (status && status.runtime) state.errors = status.runtime.errors || {};
    renderSetup(status);
    renderList();
    renderError();
  }

  /* ------------------------------------------------------------------- init */

  /** Refreshes the sidebar from storage without disturbing the open editor. */
  async function reload() {
    state.boosts = await BoostStore.getBoosts();
    if (state.current && !state.boosts.some(function (b) { return b.id === state.current.id; })) {
      state.current = null;
    }
    renderList();
    renderError();
  }

  el['new'].addEventListener('click', createNew);
  el.save.addEventListener('click', function () { commit(true); });
  el.duplicate.addEventListener('click', duplicate);
  el['delete'].addEventListener('click', remove);
  el.search.addEventListener('input', function () {
    state.filter = el.search.value;
    renderList();
  });

  function showField(field, focusTab) {
    state.field = field;
    renderEditor();
    if (focusTab) el[field === 'css' ? 'tab-css' : 'tab-js'].focus();
  }

  el['tab-css'].addEventListener('click', function () { showField('css'); });
  el['tab-js'].addEventListener('click', function () { showField('js'); });

  // Arrow keys move between tabs, which is what the tablist role promises.
  [el['tab-css'], el['tab-js']].forEach(function (tab) {
    tab.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        showField(state.field === 'css' ? 'js' : 'css', true);
      }
    });
  });

  el.name.addEventListener('input', function () {
    if (!state.current) return;
    state.current.name = el.name.value;
    markEdited(NAME_DELAY);
  });

  // Patterns are parsed, so they are only committed once the field is left.
  // Typing "github.com" would otherwise store "*://*.g/*" and friends on the way.
  el.patterns.addEventListener('input', renderNormalized);
  el.patterns.addEventListener('change', function () {
    if (!state.current) return;
    pullPatterns();
    markEdited(0);
  });

  ['runAt', 'world'].forEach(function (id) {
    el[id].addEventListener('change', function () {
      if (!state.current) return;
      state.current[id] = el[id].value;
      markEdited(0);
    });
  });
  ['enabled', 'allFrames'].forEach(function (id) {
    el[id].addEventListener('change', function () {
      if (!state.current) return;
      state.current[id] = el[id].checked;
      markEdited(0);
    });
  });

  el.paused.addEventListener('change', async function () {
    var settings = await BoostStore.setSettings({ paused: el.paused.checked });
    renderPaused(settings.paused);
    announce(settings.paused ? 'All boosts paused' : 'Boosts resumed');
    setStatus(settings.paused ? 'Paused' : 'Resumed', 'ok');
  });

  el['export'].addEventListener('click', exportAll);
  el['import'].addEventListener('click', function () { el.file.click(); });
  el.file.addEventListener('change', function () {
    if (el.file.files[0]) importFile(el.file.files[0]);
    el.file.value = '';
  });

  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      commit(true);
    }
  });

  window.addEventListener('pagehide', flushOnTeardown);
  window.addEventListener('blur', function () {
    if (!state.current) return;
    var before = state.current.patterns.join('\n');
    pullPatterns();
    if (state.current.patterns.join('\n') !== before) state.revision++;
    commit(false);
  });

  function renderPaused(paused) {
    el.paused.checked = !!paused;
    el['paused-banner'].hidden = !paused;
    document.body.classList.toggle('is-paused', !!paused);
  }

  (async function () {
    renderPaused((await BoostStore.getSettings()).paused);
    await reload();
    await refreshStatus(false);
    renderDetail();
  })();
})();
