/*
 * Boosts - per-site CSS and JavaScript for Chromium browsers.
 * Copyright (C) 2026 Oliver Bartsch
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 as published
 * by the Free Software Foundation. This program is distributed WITHOUT ANY
 * WARRANTY; see the LICENSE file for details.
 */

// The highlighter is hand written, so the value of these tests is mostly in the
// awkward cases: regex vs division, templates, comments that contain code.
var self = this;
load('lib/highlight.js');
var H = BoostHighlight;

var fails = 0;
function check(cond, label) {
  if (cond) print('ok   ' + label);
  else { fails++; print('FAIL ' + label); }
}

/** The whole point: colouring must never change the text. */
function roundTrips(code, lang) {
  return H.tokenize(code, lang).map(function (t) { return t.value; }).join('') === code;
}

function typeOf(code, lang, needle) {
  var found = H.tokenize(code, lang).filter(function (t) { return t.value === needle; });
  return found.length ? found[0].type : null;
}

function types(code, lang) {
  return H.tokenize(code, lang)
    .filter(function (t) { return t.type !== 'text'; })
    .map(function (t) { return t.type + ':' + t.value; })
    .join(' ');
}

/* ---------------------------------------------------------------- lossless */

var samples = [
  ['body { color: red; }', 'css'],
  ['/* unterminated', 'css'],
  ['a { b: "unterminated', 'css'],
  ['.x{}\n@media (min-width: 600px) { .y { --z: -3.5rem !important } }', 'css'],
  ['#id .cls > p:hover::before, a[href^="http"] { background: url(a.png) }', 'css'],
  ['const a = 1 / 2; const re = /a\\/b[/]/gi;', 'js'],
  ['let t = `a ${ `${x}` + "}" } b`;', 'js'],
  ['// comment with { and " and `\nx++;', 'js'],
  ['/* unterminated block', 'js'],
  ['"unterminated string', 'js'],
  ['`unterminated template ${', 'js'],
  ['x = 0xFF + 1e-3 + 1_000n + .5;', 'js'],
  ['a < b > c && d || !e ?? f?.g;', 'js'],
  ['', 'css'],
  ['', 'js'],
  ['\n\n\t  \n', 'js'],
  ['<script>&"\'</script>', 'js'],
  ['a b c', 'js']
];
samples.forEach(function (pair) {
  check(roundTrips(pair[0], pair[1]), 'lossless (' + pair[1] + '): ' + JSON.stringify(pair[0].slice(0, 42)));
});

/* --------------------------------------------------------------------- CSS */

check(typeOf('body { color: red; }', 'css', 'body') === 'sel', 'css tag is a selector');
check(typeOf('body { color: red; }', 'css', 'color') === 'pro', 'css property inside a block');
check(typeOf('body { color: red; }', 'css', 'red') === 'val', 'css value after the colon');
check(typeOf('.foo { }', 'css', '.foo') === 'sel', 'css class selector');
check(typeOf('#bar { }', 'css', '#bar') === 'sel', 'css id selector, not a colour');
check(typeOf('a { color: #fff }', 'css', '#fff') === 'num', 'hex colour inside a block');
check(typeOf('a:hover { }', 'css', ':hover') === 'sel', 'pseudo class');
check(typeOf('a::before { }', 'css', '::before') === 'sel', 'pseudo element');
check(typeOf('@media screen { }', 'css', '@media') === 'key', 'at-rule');
check(types('@media (min-width: 600px) {}', 'css').indexOf('num:600px') !== -1,
      'media query value is a number, not a pseudo class');
check(typeOf('a { margin: -5px }', 'css', '-5px') === 'num', 'negative length');
check(typeOf('a { --my-var: 1px }', 'css', '--my-var') === 'pro', 'custom property');
check(typeOf('a { color: rgb(0,0,0) }', 'css', 'rgb') === 'fun', 'css function call');
check(typeOf('a { color: red !important }', 'css', '!important') === 'key', 'bang important');
check(typeOf('/* c */ a {}', 'css', '/* c */') === 'com', 'css comment');
// A brace inside a comment or string must not open a block.
check(typeOf('/* { */ body {}', 'css', 'body') === 'sel', 'brace in a comment does not open a block');
check(typeOf('a[title="{"] {}', 'css', 'a') === 'sel', 'brace in a string does not open a block');

/* ---------------------------------------------------------------------- JS */

check(typeOf('const x = 1;', 'js', 'const') === 'key', 'js keyword');
check(typeOf('x = true;', 'js', 'true') === 'lit', 'js literal');
check(typeOf('foo();', 'js', 'foo') === 'fun', 'call target is a function');
check(typeOf('document.title', 'js', 'document') === 'glo', 'known global');
check(typeOf('document.title', 'js', 'title') === 'pro', 'property after a dot');
check(typeOf('el.focus()', 'js', 'focus') === 'fun', 'method call after a dot');
check(typeOf('new MutationObserver(f)', 'js', 'MutationObserver') === 'fun', 'constructor call');
check(typeOf('let x = MyClass;', 'js', 'MyClass') === 'glo', 'capitalised name reads as a class');
check(typeOf('// hi\nx', 'js', '// hi') === 'com', 'line comment');
check(typeOf('/* hi */x', 'js', '/* hi */') === 'com', 'block comment');
check(typeOf('x = "s"', 'js', '"s"') === 'str', 'double quoted string');
check(typeOf("x = 's'", 'js', "'s'") === 'str', 'single quoted string');
check(typeOf('x = `t`', 'js', '`t`') === 'str', 'template literal');
check(typeOf('x = 42', 'js', '42') === 'num', 'number');

// Regex versus division, the classic ambiguity.
check(typeOf('var re = /ab+/g;', 'js', '/ab+/g') === 'str', 'regex after an assignment');
check(types('a / b', 'js').indexOf('pun:/') !== -1, 'slash after an identifier is division');
check(typeOf('a / b', 'js', 'a') === 'name', 'a plain identifier is a name token, not filler');
check(types('(a + b) / 2', 'js').indexOf('pun:/') !== -1, 'slash after a paren is division');
check(types('arr[0] / 2', 'js').indexOf('pun:/') !== -1, 'slash after a bracket is division');
check(typeOf('x.replace(/a/g, "")', 'js', '/a/g') === 'str', 'regex as an argument');
check(types('this / 2', 'js').indexOf('pun:/') !== -1, 'slash after this is division');
// Documented limitation: a slash after ")" is read as division, because
// "(a + b) / 2" is far commoner in real code than a regex in that position.
check(typeOf('if (x) /a/.test(y);', 'js', '/a/') === null, 'regex after ) is read as division (known limitation)');

// A string or comment must not leak into what follows.
check(typeOf('var s = "// not a comment"; ok();', 'js', 'ok') === 'fun',
      'comment marker inside a string does not start a comment');
check(typeOf('/* " */ ok();', 'js', 'ok') === 'fun',
      'quote inside a comment does not start a string');
check(typeOf('var s = "a\\\\" + ok();', 'js', 'ok') === 'fun', 'escaped quote ends the string correctly');

/* ------------------------------------------------------------------ output */

var html = H.render('body { color: red; }', 'css');
check(html.indexOf('<span class="t-sel">body</span>') === 0, 'render emits token spans');
check(H.render('a < b && c > d', 'js').indexOf('&lt;') !== -1, 'render escapes angle brackets');
check(H.render('x = "<img src=x onerror=alert(1)>"', 'js').indexOf('<img') === -1,
      'render escapes markup inside strings');
// Each operator character is its own span, so the entities are not adjacent.
var amps = H.render('a && b', 'js');
check((amps.match(/&amp;/g) || []).length === 2, 'render escapes ampersands');
check(!/&(?!amp;|lt;|gt;)/.test(amps), 'render leaves no bare ampersand');

var huge = new Array(H.MAX_LENGTH + 10).join('a');
var hugeTokens = H.tokenize(huge, 'js');
check(hugeTokens.length === 1 && hugeTokens[0].type === 'text', 'oversized input is left as plain text');

// Token TYPES inside at-rule blocks. The old tokeniser used one brace counter, so
// every selector nested in @media/@supports/@layer was coloured as a property and
// every id selector as a hex colour. The suite had a @media sample, but only in the
// lossless round-trip list and only with an empty body, so it never caught this.
function cssType(css, word) { return typeOf(css, 'css', word); }
function eqType(css, word, expected, label) {
  var got = cssType(css, word);
  check(got === expected, label + ' (got ' + got + ', expected ' + expected + ')');
}
var AT_RULES = ['@media (min-width: 600px)', '@supports (display: grid)', '@layer base',
                '@container (width > 400px)'];
AT_RULES.forEach(function (at) {
  var src = at + ' {\n  body { color: red }\n  a:hover { color: blue }\n  #promo { display: none }\n  .ad { display: none }\n}';
  eqType(src, 'body', 'sel', 'type selector is a selector inside ' + at);
  eqType(src, '#promo', 'sel', 'id selector is a selector inside ' + at);
  eqType(src, '.ad', 'sel', 'class selector is a selector inside ' + at);
  eqType(src, ':hover', 'sel', 'pseudo-class survives inside ' + at);
  eqType(src, 'color', 'pro', 'property is still a property inside ' + at);
});
eqType('@media (min-width: 600px) { a{b:c} }', 'min-width', 'pro', 'feature query name is a property');
eqType('body { color: red }', 'body', 'sel', 'top level still works');
eqType('body { color: #fff }', '#fff', 'num', 'hex colour in a value is still a number');

// Native CSS nesting is baseline in Chrome 120, the extension's own floor.
eqType('.card {\n  &:hover { color: red }\n}', '&:hover', 'sel', 'nested &:hover is a selector');
eqType('.card {\n  & .inner { color: red }\n}', '&', 'sel', 'bare & is a selector');

// @font-face and @keyframes are not nesting at-rules in the same way.
eqType('@font-face { font-family: X }', 'font-family', 'pro', '@font-face holds declarations');
eqType('@keyframes spin { from { opacity: 0 } }', 'from', 'sel', '@keyframes holds selectors');
eqType('@keyframes spin { from { opacity: 0 } }', 'opacity', 'pro', 'and declarations inside those');

print(fails ? '\n' + fails + ' FAILURES' : '\nall passed');
if (fails) throw new Error('tests failed');
