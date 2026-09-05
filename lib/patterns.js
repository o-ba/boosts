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
 * Pattern helpers shared by the service worker, the content script and the UI.
 *
 * Users type friendly patterns ("github.com", "localhost:3000", "*.example.com/docs*")
 * which get normalised into Chrome match patterns so the same string can be handed to
 * chrome.userScripts.register() and matched locally by the content script.
 *
 * normalizePattern only ever returns something Chrome will accept, or ''. Anything it
 * cannot rescue is reported by explainPattern() with a reason the user can act on,
 * rather than being waved through and failing later at registration time.
 */
(function (root) {
  'use strict';

  var SCHEMES = ['http', 'https', 'file', 'ftp', 'urn'];

  /** Looks like a fully qualified match pattern already? */
  function isMatchPattern(input) {
    return /^(\*|https?|file|ftp|urn):\/\//.test(input) || input === '<all_urls>';
  }

  function isIpv4(host) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  }

  function isIpv6(host) {
    return host.charAt(0) === '[';
  }

  /**
   * Chrome match patterns have no port syntax, and a pattern without one already
   * matches every port. Stripping it is what the user meant.
   */
  function splitPort(host) {
    if (isIpv6(host)) {
      var close = host.indexOf(']');
      return { host: host.slice(0, close + 1), port: host.slice(close + 2) };
    }
    var m = /^(.*):(\d+)$/.exec(host);
    return m ? { host: m[1], port: m[2] } : { host: host, port: '' };
  }

  /** A hostname Chrome will accept: labels of alphanumerics and hyphens. */
  function isValidHostname(host) {
    if (!host) return false;
    if (isIpv4(host) || isIpv6(host)) return true;
    if (host.length > 253) return false;
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host);
  }

  /**
   * "github.com"          -> "*://*.github.com/*"
   * "github.com/oli*"     -> "*://*.github.com/oli*"
   * "localhost:3000"      -> "*://localhost/*"        (ports are matched anyway)
   * "*.example.com"       -> "*://*.example.com/*"
   * "https://a.com/x"     -> unchanged
   * anything unusable     -> ""
   */
  function normalizePattern(input) {
    return explainPattern(input).pattern;
  }

  /**
   * The same work as normalizePattern, but keeping the reasoning so the manager can
   * explain itself. Returns { pattern, valid, note, error }.
   */
  function explainPattern(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return { pattern: '', valid: false, note: '', error: '' };

    if (raw === '<all_urls>' || raw === '*') {
      return { pattern: '<all_urls>', valid: true, note: 'every site you visit', error: '' };
    }

    // Already a full match pattern: validate it rather than mangling it.
    if (isMatchPattern(raw)) {
      return isValidPattern(raw)
        ? { pattern: raw, valid: true, note: '', error: '' }
        : { pattern: '', valid: false, note: '', error: describeInvalid(raw) };
    }

    // A scheme we will never be able to inject into.
    var scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
    if (scheme && !/^\d+$/.test(raw.slice(scheme[0].length))) {
      var name = scheme[1].toLowerCase();
      if (SCHEMES.indexOf(name) === -1 && name !== '*') {
        return {
          pattern: '', valid: false, note: '',
          error: '"' + name + ':" pages cannot be modified by any extension'
        };
      }
    }

    var pattern = raw.replace(/^\/\//, '');

    var slash = pattern.indexOf('/');
    var hostPart = slash === -1 ? pattern : pattern.slice(0, slash);
    var path = slash === -1 ? '/*' : pattern.slice(slash);
    if (path === '/') path = '/*';

    var split = splitPort(hostPart);
    var host = split.host;
    var note = '';
    if (split.port) note = 'port ignored, this matches every port';

    if (!host) {
      return { pattern: '', valid: false, note: '', error: 'no site name here' };
    }

    // A bare host also covers its subdomains, which is what people expect when they
    // type "github.com". "*.github.com" matches "github.com" as well. IP literals
    // have no subdomains, so leave those alone.
    var wildcarded = host;
    if (host.indexOf('*') === -1 && !isIpv4(host) && !isIpv6(host)) {
      wildcarded = '*.' + host;
      if (!note) note = 'includes subdomains';
    }

    var checkHost = wildcarded.indexOf('*.') === 0 ? wildcarded.slice(2) : wildcarded;
    if (checkHost !== '*' && !isValidHostname(checkHost)) {
      return {
        pattern: '', valid: false, note: '',
        error: /\s/.test(host) ? 'site names cannot contain spaces' : 'not a valid site name'
      };
    }

    var out = '*://' + wildcarded + path;
    return isValidPattern(out)
      ? { pattern: out, valid: true, note: note, error: '' }
      : { pattern: '', valid: false, note: '', error: describeInvalid(out) };
  }

  function parsePattern(pattern) {
    if (pattern === '<all_urls>') {
      return { scheme: '*', host: '*', path: '/*' };
    }
    var m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
    if (!m) return null;
    return { scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), path: m[3] || '/*' };
  }

  /** Explains why isValidPattern said no, in the user's terms. */
  function describeInvalid(pattern) {
    var parts = parsePattern(pattern);
    if (!parts) return 'not a site pattern';
    if (parts.scheme !== '*' && SCHEMES.indexOf(parts.scheme) === -1) {
      return '"' + parts.scheme + ':" pages cannot be modified by any extension';
    }
    if (parts.host === '' && parts.scheme !== 'file') return 'no site name here';
    if (splitPort(parts.host).port) return 'remove the port, patterns match every port';
    if (parts.host.indexOf('*') !== -1 && !/^\*($|\.)/.test(parts.host)) {
      return 'a "*" is only allowed at the very start of the site name';
    }
    return 'not a valid site name';
  }

  /**
   * Rejects patterns Chrome would throw on, so a typo cannot kill registration.
   * Everything that reaches chrome.userScripts.register() passes through here first.
   */
  function isValidPattern(pattern) {
    if (typeof pattern !== 'string' || !pattern) return false;
    if (pattern === '<all_urls>') return true;

    var parts = parsePattern(pattern);
    if (!parts) return false;
    if (parts.scheme !== '*' && SCHEMES.indexOf(parts.scheme) === -1) return false;

    var host = parts.host;
    if (host === '') return parts.scheme === 'file';
    if (host === '*') return true;

    // "*" is only ever allowed as the whole host or as a leading "*." label.
    if (host.indexOf('*') !== -1) {
      if (host.indexOf('*.') !== 0) return false;
      host = host.slice(2);
      if (host.indexOf('*') !== -1) return false;
    }

    // Chrome rejects ports outright, which is the single commonest way a boost
    // silently fails to register.
    if (splitPort(host).port) return false;

    return isValidHostname(host);
  }

  function globToRegExp(glob) {
    var escaped = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$');
  }

  function hostMatches(hostPattern, host) {
    if (hostPattern === '*') return true;
    if (hostPattern.indexOf('*.') === 0) {
      var base = hostPattern.slice(2);
      return host === base || host.endsWith('.' + base);
    }
    return host === hostPattern;
  }

  /** Chrome-compatible match-pattern test, used for local matching. */
  function matchesPattern(pattern, url) {
    var parts = parsePattern(pattern);
    if (!parts) return false;

    var parsed;
    try { parsed = new URL(url); } catch (e) { return false; }

    var scheme = parsed.protocol.replace(/:$/, '');
    if (parts.scheme === '*') {
      if (scheme !== 'http' && scheme !== 'https') return false;
    } else if (parts.scheme !== scheme) {
      return false;
    }

    // parsed.hostname never carries the port, which is what makes a port-free
    // pattern match http://localhost:3000 the way Chrome does.
    if (!hostMatches(parts.host, parsed.hostname)) return false;

    return globToRegExp(parts.path).test(parsed.pathname + parsed.search);
  }

  /**
   * Normalises on the way in: patterns can reach storage un-normalised via an
   * imported file, and a boost the user can see must be a boost that matches.
   */
  function boostMatchesUrl(boost, url) {
    return (boost.patterns || []).some(function (pattern) {
      var normalized = normalizePattern(pattern);
      return !!normalized && matchesPattern(normalized, url);
    });
  }

  /** URLs no extension may touch, so the UI can explain itself instead of failing. */
  function isInjectableUrl(url) {
    return /^(https?|file):/i.test(String(url || ''));
  }

  /** Default pattern offered when creating a boost for the current tab. */
  function suggestPatternForUrl(url) {
    try {
      var host = new URL(url).hostname;
      if (!host) return '';
      if (isIpv4(host) || host.charAt(0) === '[') return '*://' + host + '/*';
      return '*://*.' + host.replace(/^www\./, '') + '/*';
    } catch (e) {
      return '';
    }
  }

  root.BoostPatterns = {
    normalizePattern: normalizePattern,
    explainPattern: explainPattern,
    isValidPattern: isValidPattern,
    matchesPattern: matchesPattern,
    boostMatchesUrl: boostMatchesUrl,
    isInjectableUrl: isInjectableUrl,
    suggestPatternForUrl: suggestPatternForUrl
  };
})(typeof self !== 'undefined' ? self : this);
