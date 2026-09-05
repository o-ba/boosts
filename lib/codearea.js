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
 * Minimal code editor: a textarea with a line-number gutter, tab indentation,
 * auto-indent, bracket completion and syntax highlighting. Deliberately
 * dependency free so the extension stays a handful of local files.
 *
 * Highlighting is the usual overlay trick: a <pre> of coloured spans sits behind
 * a textarea whose own text is transparent. The two must agree on font, padding
 * and line height to the pixel, which is why ui.css sets them together.
 */
(function (root) {
  'use strict';

  var INDENT = '  ';

  function CodeArea(container, options) {
    options = options || {};

    var gutter = document.createElement('div');
    gutter.className = 'gutter';
    gutter.setAttribute('aria-hidden', 'true');

    var surface = document.createElement('div');
    surface.className = 'surface';

    var highlight = document.createElement('pre');
    highlight.className = 'highlight';
    highlight.setAttribute('aria-hidden', 'true');

    var textarea = document.createElement('textarea');
    textarea.spellcheck = false;
    textarea.autocapitalize = 'off';
    textarea.setAttribute('autocomplete', 'off');
    if (options.placeholder) textarea.placeholder = options.placeholder;
    if (options.label) textarea.setAttribute('aria-label', options.label);

    surface.append(highlight, textarea);
    container.classList.add('codearea');
    container.append(gutter, surface);

    this.el = container;
    this.textarea = textarea;
    this.gutter = gutter;
    this.highlight = highlight;
    this.language = options.language || 'css';
    this.onChange = options.onChange || function () {};
    this.onSave = options.onSave || null;
    this.label = options.label || 'Code';
    this.tabExits = false;
    this.applyLabel();

    var self = this;
    textarea.addEventListener('input', function () {
      self.sync();
      self.onChange(textarea.value);
    });
    textarea.addEventListener('scroll', function () { self.syncScroll(); });
    textarea.addEventListener('keydown', function (event) { self.handleKey(event); });

    this.sync();
  }

  /** Keeps the gutter and the highlight layer aligned with the textarea. */
  CodeArea.prototype.syncScroll = function () {
    this.gutter.scrollTop = this.textarea.scrollTop;
    this.highlight.scrollTop = this.textarea.scrollTop;
    this.highlight.scrollLeft = this.textarea.scrollLeft;
  };

  CodeArea.prototype.renderGutter = function () {
    var lines = this.textarea.value.split('\n').length;
    var numbers = new Array(lines);
    for (var i = 0; i < lines; i++) numbers[i] = i + 1;
    this.gutter.textContent = numbers.join('\n');
  };

  CodeArea.prototype.renderHighlight = function () {
    var value = this.textarea.value;
    // The trailing newline of a textarea has no height in a <pre>, so the two
    // layers drift apart on the last line without this.
    this.highlight.innerHTML = BoostHighlight.render(value, this.language) + '\n';
  };

  CodeArea.prototype.sync = function () {
    this.renderGutter();
    this.renderHighlight();
    this.syncScroll();
  };

  /** Names the field by the language it is showing, so a screen reader can tell. */
  CodeArea.prototype.applyLabel = function () {
    this.textarea.setAttribute('aria-label',
      this.label + ', ' + (this.language === 'js' ? 'JavaScript' : 'CSS')
      + '. Press Escape then Tab to leave the editor.');
  };

  CodeArea.prototype.setLanguage = function (language) {
    this.language = language;
    this.applyLabel();
    this.renderHighlight();
  };

  CodeArea.prototype.get = function () {
    return this.textarea.value;
  };

  CodeArea.prototype.set = function (value) {
    this.textarea.value = value == null ? '' : String(value);
    this.textarea.scrollTop = 0;
    this.textarea.scrollLeft = 0;
    this.sync();
  };

  CodeArea.prototype.focus = function () {
    this.textarea.focus();
  };

  /**
   * Writes through execCommand so the browser records an undo transaction. Assigning
   * textarea.value directly is simpler but wipes the undo stack, which made Ctrl+Z a
   * no-op after any auto-indent or bracket completion.
   */
  CodeArea.prototype.insertText = function (text) {
    var el = this.textarea;
    var ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      // No undo on this path, but correctness beats history if execCommand is gone.
      var start = el.selectionStart;
      var end = el.selectionEnd;
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + text.length;
    }
    return ok;
  };

  /** Replaces the selection and keeps the caret where the user expects it. */
  CodeArea.prototype.replaceSelection = function (text, caretOffset) {
    var el = this.textarea;
    var start = el.selectionStart;
    this.insertText(text);
    if (caretOffset != null) {
      var caret = start + caretOffset;
      el.selectionStart = el.selectionEnd = caret;
    }
    this.sync();
    this.onChange(el.value);
  };

  CodeArea.prototype.indentSelection = function (outdent) {
    var el = this.textarea;
    var value = el.value;
    var lineStart = value.lastIndexOf('\n', el.selectionStart - 1) + 1;
    var lineEnd = value.indexOf('\n', el.selectionEnd);
    if (lineEnd === -1) lineEnd = value.length;

    var block = value.slice(lineStart, lineEnd);
    var updated = block.split('\n').map(function (line) {
      if (outdent) return line.replace(/^(\t| {1,2})/, '');
      return line ? INDENT + line : line;
    }).join('\n');
    if (updated === block) return;

    // Select the whole affected block so execCommand replaces it as one undoable edit.
    el.selectionStart = lineStart;
    el.selectionEnd = lineEnd;
    this.insertText(updated);
    el.selectionStart = lineStart;
    el.selectionEnd = lineStart + updated.length;
    this.sync();
    this.onChange(el.value);
  };

  CodeArea.prototype.handleKey = function (event) {
    var el = this.textarea;
    var collapsed = el.selectionStart === el.selectionEnd;

    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      // The page also listens for Ctrl+S; one save is enough.
      event.stopPropagation();
      if (this.onSave) this.onSave();
      return;
    }

    // Escape releases the Tab key so the editor is not a keyboard trap. The next
    // Tab moves focus normally; typing anything puts Tab back to indenting.
    if (event.key === 'Escape' && !this.tabExits) {
      this.tabExits = true;
      this.announce('Tab now moves to the next control. Press any key to resume indenting.');
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === 'Tab') {
      if (this.tabExits) {
        this.tabExits = false;
        this.announce('');
        return; // Let the browser move focus.
      }
      event.preventDefault();
      if (collapsed && !event.shiftKey) this.replaceSelection(INDENT);
      else this.indentSelection(event.shiftKey);
      return;
    }

    if (this.tabExits && event.key.length === 1) {
      this.tabExits = false;
      this.announce('');
    }

    if (event.key === 'Enter' && collapsed) {
      var before = el.value.slice(0, el.selectionStart);
      var line = before.slice(before.lastIndexOf('\n') + 1);
      var indent = (line.match(/^[\t ]*/) || [''])[0];
      var opensBlock = /[{([]\s*$/.test(line);
      var after = el.value.slice(el.selectionEnd);

      event.preventDefault();
      if (opensBlock && /^\s*[})\]]/.test(after)) {
        var body = '\n' + indent + INDENT + '\n' + indent;
        this.replaceSelection(body, 1 + indent.length + INDENT.length);
      } else {
        this.replaceSelection('\n' + indent + (opensBlock ? INDENT : ''));
      }
      return;
    }

    var pairs = { '{': '}', '(': ')', '[': ']', '"': '"', "'": "'", '`': '`' };
    var quotes = { '"': true, "'": true, '`': true };
    if (collapsed && pairs[event.key]) {
      var next = el.value.charAt(el.selectionStart);
      var prev = el.value.charAt(el.selectionStart - 1);

      // Typing the closing half of a pair that is already there just steps over it.
      if (quotes[event.key] && next === event.key) {
        event.preventDefault();
        el.selectionStart = el.selectionEnd = el.selectionStart + 1;
        return;
      }

      // Don't auto-close a quote that is really an apostrophe: prose in a comment
      // ("don't") used to leave a stray quote behind on every contraction.
      var afterWord = /[\w]/.test(prev);
      if (quotes[event.key] && afterWord) return;

      // Only auto-close when it cannot get in the way of typing over text.
      if (next === '' || /[\s)\]};,]/.test(next)) {
        event.preventDefault();
        this.replaceSelection(event.key + pairs[event.key], 1);
      }
      return;
    }

    if (collapsed && /^[)\]}]$/.test(event.key) && el.value.charAt(el.selectionStart) === event.key) {
      event.preventDefault();
      el.selectionStart = el.selectionEnd = el.selectionStart + 1;
    }
  };

  /** Pushes a message into the shared live region, if the page provided one. */
  CodeArea.prototype.announce = function (message) {
    var region = document.getElementById('a11y-status');
    if (region) region.textContent = message;
  };

  root.CodeArea = CodeArea;
})(typeof self !== 'undefined' ? self : this);
