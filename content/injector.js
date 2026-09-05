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
 * Content script. Three jobs:
 *
 * 1. Live CSS updates - when a boost is saved or toggled, patch the <style>
 *    element in every open tab instead of forcing a reload.
 * 2. Fallback CSS injection - if the user has not allowed user scripts yet the
 *    service worker cannot register anything, so CSS is applied from here.
 * 3. Live preview - the popup opens a port and streams CSS while the user
 *    types. Closing the popup drops the port, which reverts the preview.
 *
 * JS injection never happens here: MV3 forbids evaluating strings inside an
 * extension context, so that path always goes through chrome.userScripts.
 */
(function () {
  'use strict';

  var isTopFrame = window.top === window;
  var applied = new Set();

  function styleFor(id) {
    var elementId = 'boost-' + id;
    var style = document.getElementById(elementId);
    if (!style) {
      style = document.createElement('style');
      style.id = elementId;
      style.type = 'text/css';
      (document.head || document.documentElement).appendChild(style);
    }
    return style;
  }

  /**
   * Emptied rather than removed: the document_start bootstrap watches its own
   * element and would immediately put a removed node back.
   */
  function clearStyle(id) {
    var style = document.getElementById('boost-' + id);
    if (style) style.textContent = '';
  }

  function shouldApply(boost) {
    if (!boost.enabled) return false;
    if (!boost.allFrames && !isTopFrame) return false;
    if (!boost.css.trim()) return false;
    return BoostPatterns.boostMatchesUrl(boost, location.href);
  }

  function apply(boosts, alsoConsider) {
    var seen = new Set();

    boosts.forEach(function (boost) {
      if (!shouldApply(boost)) return;
      seen.add(boost.id);
      var style = styleFor(boost.id);
      if (style.textContent !== boost.css) style.textContent = boost.css;
    });

    // Anything applied earlier that no longer matches, was disabled or deleted,
    // plus ids the caller knows about (a preview for a boost never saved).
    var stale = new Set(applied);
    if (alsoConsider) alsoConsider.forEach(function (id) { stale.add(id); });
    stale.forEach(function (id) {
      if (!seen.has(id)) clearStyle(id);
    });

    applied = seen;
  }

  /**
   * alsoConsider lets a caller hand in ids it may have styled itself, so they
   * are dropped in the same pass that re-applies storage. Clearing them first
   * and refreshing afterwards would flash the page unstyled.
   */
  function refresh(alsoConsider) {
    try {
      chrome.storage.local.get(['boosts', 'settings'], function (data) {
        if (chrome.runtime.lastError) return;
        var paused = !!(data.settings && data.settings.paused);
        var boosts = paused || !Array.isArray(data.boosts) ? [] : data.boosts;
        apply(boosts.map(function (b) {
          return {
            id: b.id,
            enabled: b.enabled !== false,
            allFrames: !!b.allFrames,
            patterns: b.patterns || [],
            css: String(b.css || '')
          };
        }), alsoConsider);
      });
    } catch (e) {
      /* Extension context invalidated (reload or update). Nothing to do. */
    }
  }

  refresh();

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && (changes.boosts || changes.settings)) refresh();
    });

    chrome.runtime.onConnect.addListener(function (port) {
      if (port.name !== 'boost-preview') return;
      var previewed = new Set();

      port.onMessage.addListener(function (message) {
        if (!message || message.type !== 'preview' || !message.id) return;
        previewed.add(message.id);
        styleFor(message.id).textContent = String(message.css || '');
      });

      // Popup closed. With autosave the preview is normally already in storage
      // and simply stays; anything that never made it is dropped.
      port.onDisconnect.addListener(function () {
        refresh(previewed);
      });
    });
  } catch (e) {
    /* Without listeners the boost is still applied, just not live-updated. */
  }

  // Single-page apps change the URL without a new document, which can change
  // which boosts match. Only the top frame is worth polling.
  // Single-page apps change the URL without a new document, which can change which
  // boosts match. The Navigation API reports that directly; polling is only the
  // fallback for engines that do not have it, and runs far less often now that it
  // is not the primary mechanism.
  if (isTopFrame) {
    var lastHref = location.href;
    var recheck = function () {
      if (location.href === lastHref) return;
      lastHref = location.href;
      refresh();
    };
    window.addEventListener('popstate', recheck);
    window.addEventListener('hashchange', recheck);
    if (typeof navigation !== 'undefined' && navigation.addEventListener) {
      navigation.addEventListener('navigatesuccess', recheck);
      navigation.addEventListener('currententrychange', recheck);
    } else {
      setInterval(recheck, 1000);
    }
  }
})();
