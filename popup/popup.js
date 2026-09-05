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
 * Popup: quick edit of the boost that applies to the current tab.
 *
 * Everything autosaves. A popup is dismissed by clicking anywhere outside it,
 * with no chance to press a button, so an explicit save would lose work. Edits
 * are written after a short debounce, flushed on blur, and as a last resort
 * handed to the service worker on pagehide, which outlives this document.
 */
(function () {
  'use strict';

  var SAVE_DELAY = 300;

  var el = {
    host: document.getElementById('host'),
    banner: document.getElementById('banner'),
    main: document.getElementById('main'),
    blocked: document.getElementById('blocked'),
    select: document.getElementById('select'),
    newBtn: document.getElementById('new'),
    enabled: document.getElementById('enabled'),
    patterns: document.getElementById('patterns'),
    tabCss: document.getElementById('tab-css'),
    tabJs: document.getElementById('tab-js'),
    pane: document.getElementById('pane'),
    jshint: document.getElementById('jshint'),
    status: document.getElementById('status'),
    reload: document.getElementById('reload'),
    manage: document.getElementById('manage')
  };

  var state = {
    tab: null,
    boosts: [],
    matching: [],
    current: null,
    isDraft: false,
    field: 'css',
    runningJs: '',
    revision: 0,
    savedRevision: 0
  };

  var editor = new CodeArea(el.pane, {
    label: 'Boost code',
    language: 'css',
    onChange: onEdit,
    onSave: function () { commit(true); }
  });

  /* ------------------------------------------------------------- rendering */

  function announce(message) {
    var region = document.getElementById('a11y-status');
    if (region) region.textContent = message;
  }

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status ' + (kind || 'muted');
    if (kind === 'ok' || kind === 'error') announce(text);
  }

  function placeholderFor(field) {
    return field === 'css'
      ? '/* CSS for this site */\nbody { }'
      : '// Runs in the page. console.log(location.href)';
  }

  function renderSelect() {
    el.select.textContent = '';
    state.matching.forEach(function (boost) {
      var option = document.createElement('option');
      option.value = boost.id;
      option.textContent = (boost.enabled ? '' : '○ ') + boost.name;
      el.select.append(option);
    });
    if (state.isDraft) {
      var draft = document.createElement('option');
      draft.value = state.current.id;
      draft.textContent = state.current.name + ' (new)';
      el.select.append(draft);
    }
    el.select.value = state.current.id;
    el.select.disabled = el.select.options.length < 2;
  }

  /** Everything except the editor, so it is safe to call while typing. */
  function renderMeta() {
    el.enabled.checked = !!state.current.enabled;
    el.patterns.textContent = state.current.patterns.join('  ') || 'no site pattern yet';
    el.patterns.title = state.current.patterns.join('\n') + '\n\nEdit patterns in the manager';
    el.jshint.hidden = state.current.js === state.runningJs;
  }

  /** Resets the textarea, so never call this mid-edit: it moves the caret. */
  function renderEditor() {
    var isCss = state.field === 'css';
    el.tabCss.setAttribute('aria-selected', String(isCss));
    el.tabJs.setAttribute('aria-selected', String(!isCss));
    el.tabCss.tabIndex = isCss ? 0 : -1;
    el.tabJs.tabIndex = isCss ? -1 : 0;
    el.pane.setAttribute('aria-labelledby', isCss ? 'tab-css' : 'tab-js');
    editor.textarea.placeholder = placeholderFor(state.field);
    editor.setLanguage(isCss ? 'css' : 'js');
    editor.set(isCss ? state.current.css : state.current.js);
  }

  function render() {
    renderSelect();
    renderMeta();
    renderEditor();
  }

  /* ---------------------------------------------------------------- editing */

  var saveTimer = null;

  function dirty() {
    return state.revision !== state.savedRevision;
  }

  function markEdited(delay) {
    state.revision++;
    setStatus('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { commit(false); }, delay == null ? SAVE_DELAY : delay);
  }

  function onEdit(value) {
    if (state.field === 'css') {
      state.current.css = value;
      previewCss(value);
    } else {
      state.current.js = value;
      el.jshint.hidden = value === state.runningJs;
    }
    markEdited();
  }

  /**
   * Writes the current boost. Guarded by a revision counter: an edit that lands
   * while the write is in flight leaves the state dirty so the next tick saves it.
   */
  async function commit(force) {
    clearTimeout(saveTimer);
    if (!force && !dirty()) return;

    if (!state.current.patterns.length) {
      setStatus('No site pattern, open the manager', 'error');
      return;
    }

    var at = state.revision;
    var wasDraft = state.isDraft;
    var record;
    try {
      record = await BoostStore.saveBoost(state.current);
    } catch (e) {
      setStatus('Could not save: ' + (e && e.message ? e.message : e), 'error');
      return;
    }

    state.current.id = record.id;
    state.isDraft = false;

    if (wasDraft) {
      state.boosts = await BoostStore.getBoosts();
      state.matching = state.boosts.filter(function (b) {
        return BoostPatterns.boostMatchesUrl(b, state.tab.url);
      });
      renderSelect();
    }

    if (state.revision !== at) return; // Superseded; the pending timer handles it.

    state.savedRevision = at;
    renderMeta();
    setStatus(state.current.js === state.runningJs ? 'Saved' : 'Saved, reload to run the JS', 'ok');
  }

  /** Last resort: the popup is being torn down, so let the worker do the write. */
  function flushOnTeardown() {
    if (!dirty() || !state.current.patterns.length) return;
    clearTimeout(saveTimer);
    try {
      chrome.runtime.sendMessage({ type: 'save', boost: state.current });
    } catch (e) {
      /* Nothing left to try. */
    }
  }

  var previewTimer = null;
  var previewPort = null;

  /**
   * Streams CSS to the content script so edits are visible before the save
   * lands, which is what makes typing feel immediate.
   */
  function previewCss(css) {
    if (!state.tab) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      try {
        if (!previewPort) {
          previewPort = chrome.tabs.connect(state.tab.id, {
            name: 'boost-preview',
            frameId: 0
          });
          previewPort.onDisconnect.addListener(function () { previewPort = null; });
        }
        previewPort.postMessage({ type: 'preview', id: state.current.id, css: css });
      } catch (e) {
        previewPort = null;
      }
    }, 100);
  }

  /* --------------------------------------------------------- boost switching */

  async function selectBoost(id) {
    await commit(false);
    var found = state.matching.find(function (b) { return b.id === id; });
    if (!found) return;
    state.current = Object.assign({}, found);
    state.runningJs = found.js;
    state.isDraft = false;
    state.revision = state.savedRevision = 0;
    render();
    setStatus('');
  }

  async function newDraft() {
    await commit(false);
    var host = '';
    try { host = new URL(state.tab.url).hostname; } catch (e) { host = 'this site'; }
    state.current = BoostStore.createBoost({
      name: host.replace(/^www\./, ''),
      patterns: [BoostPatterns.suggestPatternForUrl(state.tab.url)].filter(Boolean)
    });
    state.runningJs = '';
    state.isDraft = true;
    // Left clean on purpose: an untouched draft is never written to storage.
    state.revision = state.savedRevision = 0;
    render();
    editor.focus();
    setStatus('New boost, saves as you type');
  }

  /* ----------------------------------------------------------------- banner */

  function showBanner(message, kind, actionLabel, action) {
    el.banner.hidden = false;
    el.banner.textContent = '';
    var box = document.createElement('div');
    box.className = 'notice ' + kind;
    box.append(document.createTextNode(message));
    if (actionLabel) {
      var button = document.createElement('button');
      button.textContent = actionLabel;
      button.addEventListener('click', action);
      box.append(document.createElement('br'), button);
    }
    el.banner.append(box);
  }

  async function checkUserScripts() {
    var settings = await BoostStore.getSettings();
    if (settings.paused) {
      showBanner('All boosts are paused, so nothing is running on any site.', 'warn',
        'Resume boosts', async function () {
          await BoostStore.setSettings({ paused: false });
          el.banner.hidden = true;
          setStatus('Resumed, reload the page to run JS', 'ok');
        });
      return;
    }

    var status = await chrome.runtime.sendMessage({ type: 'status' }).catch(function () { return null; });
    if (!status) return;

    if (!status.userScripts) {
      showBanner(
        'JavaScript injection is off. Allow user scripts for this extension to turn it on. CSS works either way.',
        'warn',
        'Show me how',
        function () { chrome.runtime.openOptionsPage(); }
      );
      return;
    }

    var errors = status.runtime && status.runtime.errors ? status.runtime.errors : {};
    var mine = state.current && errors[state.current.id];
    if (mine) showBanner('This boost failed to register: ' + mine, 'error');
  }

  /* ------------------------------------------------------------------- init */

  async function init() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tabs[0] || null;

    if (!state.tab || !BoostPatterns.isInjectableUrl(state.tab.url)) {
      el.blocked.hidden = false;
      el.blocked.textContent = 'Boosts can only run on http(s) and file pages. '
        + 'Open a website, or use the manager to edit your boosts.';
      el.host.textContent = state.tab ? (state.tab.url || '') : '';
      return;
    }

    el.host.textContent = state.tab.url;
    el.main.hidden = false;

    state.boosts = await BoostStore.getBoosts();
    state.matching = state.boosts.filter(function (b) {
      return BoostPatterns.boostMatchesUrl(b, state.tab.url);
    });

    if (state.matching.length) await selectBoost(state.matching[0].id);
    else await newDraft();

    checkUserScripts();
  }

  /* ---------------------------------------------------------------- events */

  el.select.addEventListener('change', function () { selectBoost(el.select.value); });
  el.newBtn.addEventListener('click', newDraft);

  el.enabled.addEventListener('change', function () {
    state.current.enabled = el.enabled.checked;
    markEdited(0);
  });

  function showField(field, focusTab) {
    state.field = field;
    renderEditor();
    if (focusTab) (field === 'css' ? el.tabCss : el.tabJs).focus();
  }

  el.tabCss.addEventListener('click', function () { showField('css'); });
  el.tabJs.addEventListener('click', function () { showField('js'); });
  [el.tabCss, el.tabJs].forEach(function (tab) {
    tab.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        showField(state.field === 'css' ? 'js' : 'css', true);
      }
    });
  });

  el.reload.addEventListener('click', async function () {
    await commit(false);
    if (state.tab) chrome.tabs.reload(state.tab.id);
    window.close();
  });
  el.manage.addEventListener('click', async function () {
    await commit(false);
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // Clicking outside the popup blurs it first, which is the earliest reliable
  // signal that it is about to be dismissed.
  window.addEventListener('blur', function () { commit(false); });
  window.addEventListener('pagehide', flushOnTeardown);

  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      commit(true);
    }
  });

  init();
})();
