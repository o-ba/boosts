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
 * Tokenisers for CSS and JavaScript, rendered to spans for the editor overlay.
 *
 * Hand written on purpose: MV3 blocks scripts from a CDN, and pulling in a real
 * editor would mean vendoring a few hundred kilobytes and a build step. This is
 * good enough to read code by, and it is the only thing the editor needs.
 */
(function (root) {
  'use strict';

  // Above this size the spans cost more than the colour is worth.
  var MAX_LENGTH = 100000;

  var JS_KEYWORDS = ('break case catch class const continue debugger default delete do else '
    + 'export extends finally for function if import in instanceof let new of return static '
    + 'super switch this throw try typeof var void while with yield async await get set').split(' ');

  var JS_LITERALS = 'true false null undefined NaN Infinity arguments'.split(' ');

  var JS_GLOBALS = ('window document console location navigator history screen localStorage '
    + 'sessionStorage setTimeout setInterval clearTimeout clearInterval requestAnimationFrame '
    + 'cancelAnimationFrame queueMicrotask fetch alert getComputedStyle matchMedia Math JSON '
    + 'Object Array String Number Boolean Symbol BigInt Promise Set Map WeakMap WeakSet Date '
    + 'RegExp Error TypeError Proxy Reflect URL URLSearchParams Blob FormData Headers Request '
    + 'Response MutationObserver IntersectionObserver ResizeObserver CustomEvent Event Element '
    + 'HTMLElement Node NodeList customElements CSS globalThis').split(' ');

  function toSet(list) {
    var set = Object.create(null);
    list.forEach(function (word) { set[word] = true; });
    return set;
  }

  var KEYWORD_SET = toSet(JS_KEYWORDS);
  var LITERAL_SET = toSet(JS_LITERALS);
  var GLOBAL_SET = toSet(JS_GLOBALS);

  function isSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'; }
  function isDigit(c) { return c >= '0' && c <= '9'; }
  function isIdentStart(c) { return /[A-Za-z_$]/.test(c); }
  function isIdentPart(c) { return /[\w$]/.test(c); }

  /* --------------------------------------------------------------------- CSS */

  /**
   * At-rules that wrap other rules rather than declarations. Inside one of these the
   * tokeniser is still looking at selectors, which a single brace counter cannot know.
   */
  var NESTING_AT_RULES = ('media supports layer container scope document when else '
    + 'starting-style keyframes -webkit-keyframes -moz-keyframes').split(' ');

  function tokenizeCss(src) {
    var tokens = [];
    var i = 0;
    var n = src.length;
    // Stack of open braces: 'decl' for a declaration block, 'rules' for an at-rule
    // block that contains further rules. Empty means top level.
    var blocks = [];
    var parens = 0;     // inside ( ), which makes ":" a separator, not a pseudo
    var inValue = false;
    var pendingAt = ''; // the most recent at-keyword, until its block opens

    function push(type, value) { if (value) tokens.push({ type: type, value: value }); }
    function inDeclarations() { return blocks[blocks.length - 1] === 'decl'; }
    function nextNonSpace(from) {
      while (from < n && isSpace(src[from])) from++;
      return src[from] || '';
    }
    function readWhile(test) {
      var start = i;
      while (i < n && test(src[i])) i++;
      return src.slice(start, i);
    }

    while (i < n) {
      var c = src[i];

      if (isSpace(c)) { push('text', readWhile(isSpace)); continue; }

      if (c === '/' && src[i + 1] === '*') {
        var start = i;
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(n, i + 2);
        push('com', src.slice(start, i));
        continue;
      }

      if (c === '"' || c === "'") {
        push('str', readString(src, i, (i = skipString(src, i))));
        continue;
      }

      if (c === '@') {
        i++;
        var atName = readWhile(function (ch) { return /[\w-]/.test(ch); });
        pendingAt = atName.toLowerCase();
        push('key', '@' + atName);
        continue;
      }

      if (c === '{') {
        // An at-rule from the nesting list opens a block of rules; anything else
        // (a selector, or @font-face / @keyframes) opens declarations.
        blocks.push(pendingAt && NESTING_AT_RULES.indexOf(pendingAt) !== -1 ? 'rules' : 'decl');
        pendingAt = '';
        inValue = false;
        i++;
        push('pun', '{');
        continue;
      }
      if (c === '}') { blocks.pop(); inValue = false; i++; push('pun', '}'); continue; }
      if (c === ';') { inValue = false; pendingAt = ''; i++; push('pun', ';'); continue; }
      if (c === '(') { parens++; i++; push('pun', '('); continue; }
      if (c === ')') { parens = Math.max(0, parens - 1); i++; push('pun', ')'); continue; }

      if (c === ':') {
        // A pseudo class wherever selectors are legal and we are outside parentheses,
        // so "@media (min-width: 600px)" is not mistaken for one but ".a:hover"
        // inside that media block still is.
        if (!inDeclarations() && parens === 0) {
          var mark = i;
          i++;
          if (src[i] === ':') i++;
          readWhile(function (ch) { return /[\w-]/.test(ch); });
          push('sel', src.slice(mark, i));
        } else {
          inValue = true;
          i++;
          push('pun', ':');
        }
        continue;
      }

      if (isDigit(c) || ((c === '.' || c === '-' || c === '+') && isDigit(src[i + 1] || ''))) {
        var numStart = i;
        if (c === '-' || c === '+') i++;
        readWhile(function (ch) { return isDigit(ch) || ch === '.'; });
        readWhile(function (ch) { return /[a-z%]/i.test(ch); });
        push('num', src.slice(numStart, i));
        continue;
      }

      if (c === '#') {
        var hashStart = i;
        i++;
        readWhile(function (ch) { return /[\w-]/.test(ch); });
        // An id selector wherever selectors are legal; a hex colour in a value.
        push(inDeclarations() ? 'num' : 'sel', src.slice(hashStart, i));
        continue;
      }

      if (c === '!') {
        var bangStart = i;
        i++;
        readWhile(function (ch) { return /[a-z]/i.test(ch); });
        push('key', src.slice(bangStart, i));
        continue;
      }

      if (c === '.' && /[A-Za-z_-]/.test(src[i + 1] || '')) {
        var classStart = i;
        i++;
        readWhile(function (ch) { return /[\w-]/.test(ch); });
        push('sel', src.slice(classStart, i));
        continue;
      }

      // Native nesting: "&" begins a nested selector, and it appears *inside* a
      // declaration block, which is exactly where a brace counter says it cannot.
      if (c === '&' && !inValue) {
        var ampStart = i;
        i++;
        if (src[i] === ':') {
          i++;
          if (src[i] === ':') i++;
          readWhile(function (ch) { return /[\w-]/.test(ch); });
        } else {
          readWhile(function (ch) { return /[\w-]/.test(ch); });
        }
        push('sel', src.slice(ampStart, i));
        continue;
      }

      if (/[A-Za-z_-]/.test(c)) {
        var word = readWhile(function (ch) { return /[\w-]/.test(ch); });
        // Inside parentheses at rule level we are in a feature query such as
        // "(min-width: 600px)", where the word before ":" is a property.
        if (!inDeclarations()) push(parens > 0 ? 'pro' : 'sel', word);
        else if (!inValue) push('pro', word);
        else push(nextNonSpace(i) === '(' ? 'fun' : 'val', word);
        continue;
      }

      i++;
      push('pun', c);
    }

    return tokens;
  }

  /* -------------------------------------------------------------- JavaScript */

  function skipString(src, i) {
    var quote = src[i];
    var n = src.length;
    i++;
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === quote) return i + 1;
      if (src[i] === '\n' && quote !== '`') return i; // Unterminated line string.
      i++;
    }
    return n;
  }

  function readString(src, from, to) {
    return src.slice(from, to);
  }

  /** Templates can nest arbitrary code in ${...}, including more backticks. */
  function skipTemplate(src, i) {
    var n = src.length;
    i++;
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') return i + 1;
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        var depth = 1;
        while (i < n && depth > 0) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          else if (src[i] === '`') { i = skipTemplate(src, i); continue; }
          else if (src[i] === '"' || src[i] === "'") { i = skipString(src, i); continue; }
          i++;
        }
        continue;
      }
      i++;
    }
    return n;
  }

  function skipRegex(src, i) {
    var n = src.length;
    i++;
    var inClass = false;
    while (i < n) {
      var c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') return -1;
      if (inClass) { if (c === ']') inClass = false; }
      else if (c === '[') inClass = true;
      else if (c === '/') { i++; break; }
      i++;
    }
    while (i < n && /[a-z]/.test(src[i])) i++;
    return i;
  }

  /**
   * "/" is division after a value and a regex otherwise, which cannot be decided
   * without looking back at the last token that was not whitespace or a comment.
   */
  function regexCanStart(previous) {
    if (!previous) return true;
    // After ")" this guesses division, which is right for "(a + b) / 2" and
    // wrong for "if (x) /re/.test(y)". Telling those apart needs a real parser,
    // and division is by far the commoner of the two.
    if (previous.type === 'pun') return ')]'.indexOf(previous.value) === -1;
    if (previous.type === 'key') return previous.value !== 'this' && previous.value !== 'super';
    return false;
  }

  function tokenizeJs(src) {
    var tokens = [];
    var i = 0;
    var n = src.length;
    var previous = null;

    function push(type, value) {
      if (!value) return;
      tokens.push({ type: type, value: value });
      if (type !== 'text' && type !== 'com') previous = tokens[tokens.length - 1];
    }
    function readWhile(test) {
      var start = i;
      while (i < n && test(src[i])) i++;
      return src.slice(start, i);
    }
    function nextNonSpace(from) {
      while (from < n && isSpace(src[from])) from++;
      return src[from] || '';
    }

    while (i < n) {
      var c = src[i];

      if (isSpace(c)) { push('text', readWhile(isSpace)); continue; }

      if (c === '/' && src[i + 1] === '/') {
        push('com', readWhile(function (ch) { return ch !== '\n'; }));
        continue;
      }

      if (c === '/' && src[i + 1] === '*') {
        var blockStart = i;
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(n, i + 2);
        push('com', src.slice(blockStart, i));
        continue;
      }

      if (c === '/' && regexCanStart(previous)) {
        var end = skipRegex(src, i);
        if (end !== -1) {
          push('str', src.slice(i, end));
          i = end;
          continue;
        }
      }

      if (c === '"' || c === "'") {
        var strStart = i;
        i = skipString(src, i);
        push('str', src.slice(strStart, i));
        continue;
      }

      if (c === '`') {
        var tplStart = i;
        i = skipTemplate(src, i);
        push('str', src.slice(tplStart, i));
        continue;
      }

      if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
        var numStart = i;
        if (c === '0' && /[xXbBoO]/.test(src[i + 1] || '')) {
          i += 2;
          readWhile(function (ch) { return /[\w]/.test(ch); });
        } else {
          readWhile(function (ch) { return isDigit(ch) || ch === '.' || ch === '_'; });
          if (/[eE]/.test(src[i] || '')) {
            i++;
            if (src[i] === '+' || src[i] === '-') i++;
            readWhile(isDigit);
          }
          if (src[i] === 'n') i++;
        }
        push('num', src.slice(numStart, i));
        continue;
      }

      if (isIdentStart(c)) {
        var word = readWhile(isIdentPart);
        var afterDot = previous && previous.type === 'pun' && previous.value === '.';
        if (afterDot) push(nextNonSpace(i) === '(' ? 'fun' : 'pro', word);
        else if (KEYWORD_SET[word]) push('key', word);
        else if (LITERAL_SET[word]) push('lit', word);
        else if (nextNonSpace(i) === '(') push('fun', word);
        else if (GLOBAL_SET[word] || /^[A-Z]/.test(word)) push('glo', word);
        else push('name', word);
        continue;
      }

      i++;
      push('pun', c);
    }

    return tokens;
  }

  /* ------------------------------------------------------------------ output */

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function tokenize(code, language) {
    if (typeof code !== 'string' || !code) return [];
    if (code.length > MAX_LENGTH) return [{ type: 'text', value: code }];
    return language === 'js' ? tokenizeJs(code) : tokenizeCss(code);
  }

  function render(code, language) {
    return tokenize(code, language).map(function (token) {
      var text = escapeHtml(token.value);
      if (token.type === 'text' || token.type === 'name') return text;
      return '<span class="t-' + token.type + '">' + text + '</span>';
    }).join('');
  }

  root.BoostHighlight = {
    MAX_LENGTH: MAX_LENGTH,
    tokenize: tokenize,
    render: render
  };
})(typeof self !== 'undefined' ? self : this);
