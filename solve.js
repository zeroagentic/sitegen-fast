// solve.js — a faster drop-in for make.fun's makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build() returns for the same input: every path it
// writes and that file's text, byte for byte. Same rules, same report, same template dialect — the work is done with
// run-based escaping, a single-pass Markdown renderer and templates compiled to JavaScript closures.
//
// No dependencies, no I/O, no clock, no randomness: the answer is a function of the input alone.

// ---------------------------------------------------------------- constants

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const INCLUDE_DEPTH = 8;
const SLUG_MAX = 64;

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const NEEDS_ESC = /[&<>"']/;
const ESC_G = /[&<>"']/g;
const escCb = (c) => ESCAPES[c];

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_G, escCb);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const ASCII_ONLY = /^[\x00-\x7f]*$/;
const MARKS_G = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most 64 characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 */
function slugify(text) {
  const plain = ASCII_ONLY.test(text) ? text : text.normalize('NFKD').replace(MARKS_G, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = null;
    if (c >= 97 && c <= 122) keep = plain[i];
    else if (c >= 48 && c <= 57) keep = plain[i];
    else if (c >= 65 && c <= 90) keep = String.fromCharCode(c + 32);
    if (keep === null) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += keep;
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  while (out.length > 0 && out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const a = date.indexOf('-');
  const b = date.indexOf('-', a + 1);
  const m = Number(date.slice(a + 1, b));
  const d = Number(date.slice(b + 1));
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, a)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let space = c === 32 || (c >= 9 && c <= 13);
    if (!space && c > 127) space = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** The words of one line: its runs of characters other than whitespace (a line holds no newline, so this sums to a body's count). */
function wordsInLine(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let space = c === 32 || (c >= 9 && c <= 13);
    if (!space && c > 127) space = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** JavaScript's \s, by code unit. */
function isSpaceCode(c) {
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 128) return false;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

const QUOTE_NOT_CLOSED = { error: 'a quoted string is not closed' };
const QUOTE_BAD_ESCAPE = { error: 'a quoted string holds an escape other than \\" or \\\\' };
const QUOTE_STRAY = { error: 'a quoted string holds a stray quote' };
const BARE_OPEN_BRACKET = { error: 'a bare string opens on [' };

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return QUOTE_NOT_CLOSED;
    let out = '';
    const last = raw.length - 1;
    for (let i = 1; i < last; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === last) return QUOTE_BAD_ESCAPE;
        out += n;
        i++;
      } else if (c === 34) return QUOTE_STRAY;
      else out += raw[i];
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return BARE_OPEN_BRACKET;
  return { value: raw };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (m === null || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= SLUG_MAX ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

const KEY_RE = /^[a-z_]+$/;

const FM_OPEN = '---\n';
const FM_CLOSE_AT_START = '---';

/** A source's front matter and body: { data, body }, or { error } with the first reason it is refused. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // Find the closing "---" line without splitting the whole file: a "\n---" that ends a line.
  let closeAt = -1;
  let search = firstNl;
  for (;;) {
    const at = text.indexOf('\n---', search);
    if (at === -1) break;
    const after = at + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeAt = at;
      break;
    }
    search = at + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineStart = firstNl + 1;
  let lineNo = 2;
  while (lineStart <= closeAt) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1 || lineEnd > closeAt) lineEnd = closeAt;
    const line = text.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    const at = lineNo++;
    if (line === '' || isBlank(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon === -1) return { error: `line ${at} is not "key: value"` };
    const key = line.slice(0, colon);
    if (!KEY_RE.test(key)) return { error: `line ${at} is not "key: value"` };
    let raw;
    if (colon === line.length - 1) raw = '';
    else {
      if (line.charCodeAt(colon + 1) !== 32) return { error: `line ${at} is not "key: value"` };
      raw = line.slice(colon + 2);
      let endRaw = raw.length;
      while (endRaw > 0) {
        const c = raw.charCodeAt(endRaw - 1);
        if (c === 32 || c === 9) endRaw--;
        else break;
      }
      if (endRaw !== raw.length) raw = raw.slice(0, endRaw);
    }
    if (KEYS.indexOf(key) === -1) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeAt + 4 >= text.length ? '' : text.slice(closeAt + 5) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes, by code unit. */
const ESCAPABLE = new Uint8Array(128);
const ESCAPED_CHAR = new Array(128);
for (const ch of '\\`*_[]()#+-.!>') {
  ESCAPABLE[ch.charCodeAt(0)] = 1;
  ESCAPED_CHAR[ch.charCodeAt(0)] = ESCAPES[ch] ?? ch;
}

const isTabOrSpace = (c) => c === 32 || c === 9;

/** A line of spaces and tabs only. */
function isBlank(s) {
  for (let i = 0; i < s.length; i++) if (!isTabOrSpace(s.charCodeAt(i))) return false;
  return true;
}

const isLangChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 43 || c === 45;

/** The fence's language when `s` opens a fence, else null. */
function fenceOpen(s) {
  if (s.length < 3 || s.charCodeAt(0) !== 96 || s.charCodeAt(1) !== 96 || s.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < s.length && isLangChar(s.charCodeAt(i))) i++;
  const lang = s.slice(3, i);
  for (; i < s.length; i++) if (!isTabOrSpace(s.charCodeAt(i))) return null;
  return lang;
}

/** Whether `s` closes a fence. */
function fenceClose(s) {
  if (s.length < 3 || s.charCodeAt(0) !== 96 || s.charCodeAt(1) !== 96 || s.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < s.length; i++) if (!isTabOrSpace(s.charCodeAt(i))) return false;
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(s) {
  let level = 0;
  while (level < s.length && s.charCodeAt(level) === 35) level++;
  if (level === 0 || level > 6 || level >= s.length) return null;
  if (!isTabOrSpace(s.charCodeAt(level))) return null;
  let i = level;
  while (i < s.length && isTabOrSpace(s.charCodeAt(i))) i++;
  let end = s.length;
  while (end > i && isTabOrSpace(s.charCodeAt(end - 1))) end--;
  if (end === i) return null;
  return { depth: level, text: s.slice(i, end) };
}

/** Whether `s` is a thematic break. */
function isHr(s) {
  if (s.length < 3) return false;
  const c = s.charCodeAt(0);
  if (!((c === 45 && s.charCodeAt(1) === 45 && s.charCodeAt(2) === 45) || (c === 42 && s.charCodeAt(1) === 42 && s.charCodeAt(2) === 42))) return false;
  for (let i = 3; i < s.length; i++) if (!isTabOrSpace(s.charCodeAt(i))) return false;
  return true;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(s) {
  let a = 0;
  let b = s.length;
  while (a < b && isTabOrSpace(s.charCodeAt(a))) a++;
  while (b > a && isTabOrSpace(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** A bullet item's text, or null. */
function bulletOf(s) {
  if (s.length < 2) return null;
  const c = s.charCodeAt(0);
  if ((c !== 45 && c !== 42) || s.charCodeAt(1) !== 32) return null;
  return s.slice(2);
}

/** An ordered item's number and text, or null. */
function orderedOf(s) {
  let i = 0;
  while (i < s.length && i < 10) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0 || i > 9) return null;
  if (i >= s.length || s.charCodeAt(i) !== 46) return null;
  if (i + 1 >= s.length || s.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(s.slice(0, i)), text: s.slice(i + 2) };
}

/** Whether `s` continues the item above it: two or more spaces then a non-space. */
function isContinued(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  return i >= 2 && i < s.length && !isSpaceCode(s.charCodeAt(i));
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescapedChar(s, code, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c === code) return j;
  }
  return -1;
}

/** The first "**" from `from` outside an escape, or -1. */
function findDoubleStar(s, from) {
  for (let j = from; j + 1 < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` from `a` to `b`, escaped in one pass. */
function escapedSpan(s, a, b) {
  return (a === 0 && b === s.length ? s : s.slice(a, b)).replace(ESC_G, escCb);
}

/** The next index at or after `from` of a character inline() handles itself (\ ` * [), or -1. */
const SPECIAL_SCAN = /[\\`*\[]/g;
function nextSpecial(s, from) {
  SPECIAL_SCAN.lastIndex = from;
  const m = SPECIAL_SCAN.exec(s);
  return m === null ? -1 : m.index;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let start = 0;
  let i = nextSpecial(s, 0);
  const n = s.length;
  while (i !== -1) {
    if (i > start) out += escapedSpan(s, start, i);
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && ESCAPABLE[s.charCodeAt(i + 1)] === 1) {
        out += ESCAPED_CHAR[s.charCodeAt(i + 1)];
        i += 2;
      } else {
        out += '\\';
        i += 1;
      }
      start = i;
      i = nextSpecial(s, start);
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += '<code>' + escapedSpan(s, i + 1, j) + '</code>';
        i = j + 1;
      } else {
        out += '`';
        i += 1;
      }
      start = i;
      i = nextSpecial(s, start);
      continue;
    }
    if (c === 42) {
      if (i + 1 < n && s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2);
        if (j > i + 2) {
          out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        start = i;
        i = nextSpecial(s, start);
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        i = j + 1;
      } else {
        out += '*';
        i += 1;
      }
      start = i;
      i = nextSpecial(s, start);
      continue;
    }
    // '['
    const k = findUnescapedChar(s, 93, i + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
      i = m + 1;
    } else {
      out += '[';
      i += 1;
    }
    start = i;
    i = nextSpecial(s, start);
  }
  if (start < n) out += escapedSpan(s, start, n);
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  let i = 0;
  const len = lines.length;
  let words = 0;
  for (let k = 0; k < len; k++) words += wordsInLine(lines[k]);
  while (i < len) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < len && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      const text = body.length === 0 ? '' : escapeHtml(body.join('\n')) + '\n';
      html += `<pre><code${cls}>${text}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const d = heading.depth;
      const id = uniqueSlug(slugify(heading.text), ids);
      const inner = inline(heading.text, env);
      html += `<h${d} id="${id}">${inner}</h${d}>\n`;
      if (d === 2 || d === 3) toc.push({ level: d, id, html: inner });
      i++;
      continue;
    }
    if (isHr(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < len && lines[i].charCodeAt(0) === 62) {
        const rest = lines[i][1] === ' ' ? lines[i].slice(2) : lines[i].slice(1);
        const t = trimLine(rest);
        if (t !== '') body.push(t);
        i++;
      }
      html += body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < len) {
        const cur = lines[i];
        const mBullet = isOrdered ? null : bulletOf(cur);
        const mOrdered = isOrdered ? orderedOf(cur) : null;
        if (mBullet !== null || mOrdered !== null) {
          items.push([trimLine(mBullet !== null ? mBullet : mOrdered.text)]);
          i++;
        } else if (isContinued(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? ordered.start : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      html += `${open}\n`;
      for (let k = 0; k < items.length; k++) html += `<li>${items[k].length === 1 ? inline(items[k][0], env) : inline(items[k].join('\n'), env)}</li>\n`;
      html += `</${tag}>\n`;
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < len && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const inner = inline(body.length === 1 ? body[0] : body.join('\n'), env);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number') return String(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A value as text with HTML escaping: a string escaped straight, anything else as textOf would write it. */
function escText(v) {
  if (typeof v === 'string') return v.replace(ESC_G, escCb);
  const t = textOf(v);
  return t === '' ? '' : t.replace(ESC_G, escCb);
}

/** A value's own property, as a path's step reads it (undefined off a null, or a name the value does not own). */
function gv(o, k) {
  return o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined;
}

const ROOT_NAMES = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);
const EXPAND_LIMIT = 40000;

/** `nodes` with every include expanded in place (to INCLUDE_DEPTH deep). */
function expandIncludes(nodes, templates, depth, budget) {
  const out = [];
  for (const n of nodes) {
    if (--budget.left < 0) throw new RangeError('template expansion too large');
    if (n.kind === 'include') {
      const t = templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) {
        const inner = expandIncludes(t, templates, depth + 1, budget);
        for (const x of inner) out.push(x);
      }
      continue;
    }
    if (n.kind === 'for') out.push({ kind: 'for', name: n.name, path: n.path, body: expandIncludes(n.body, templates, depth, budget) });
    else if (n.kind === 'if') {
      out.push({
        kind: 'if',
        not: n.not,
        path: n.path,
        then: expandIncludes(n.then, templates, depth, budget),
        else: n.else === null ? null : expandIncludes(n.else, templates, depth, budget),
      });
    } else out.push(n);
  }
  return out;
}

/** Whether a body reads `loop`, the innermost loop's own record (a nested for binds its own). */
function usesLoop(nodes) {
  for (const n of nodes) {
    if (n.kind === 'for') {
      if (n.path[0] === 'loop') return true;
      continue;
    }
    if (n.kind === 'var' || n.kind === 'raw') {
      if (n.path[0] === 'loop') return true;
      continue;
    }
    if (n.kind === 'if') {
      if (n.path[0] === 'loop') return true;
      if (usesLoop(n.then)) return true;
      if (n.else !== null && usesLoop(n.else)) return true;
    }
  }
  return false;
}

/** The JavaScript expression a path reads, in a compiled template's scope. */
function pathExpr(path, state) {
  const first = path[0];
  let expr = null;
  for (let k = state.bindings.length - 1; k >= 0; k--) {
    if (state.bindings[k].name === first) {
      expr = state.bindings[k].expr;
      break;
    }
  }
  if (expr === null) {
    if (!ROOT_NAMES.has(first)) return 'void 0';
    expr = state.rootExpr(first);
  }
  for (let k = 1; k < path.length; k++) expr = `gv(${expr},"${path[k]}")`;
  return expr;
}

/** JavaScript statements that append `nodes` rendered in `state`'s scope to `o`. */
function genNodes(nodes, state) {
  let code = '';
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (n.kind === 'text') {
      let text = n.text;
      while (k + 1 < nodes.length && nodes[k + 1].kind === 'text') text += nodes[++k].text;
      code += `o+=${JSON.stringify(text)};`;
      continue;
    }
    if (n.kind === 'var') {
      code += `o+=esct(${pathExpr(n.path, state)});`;
      continue;
    }
    if (n.kind === 'raw') {
      code += `o+=tOf(${pathExpr(n.path, state)});`;
      continue;
    }
    if (n.kind === 'if') {
      const e = pathExpr(n.path, state);
      const then = genNodes(n.then, state);
      code += n.not ? `if(!tr(${e})){${then}}` : `if(tr(${e})){${then}}`;
      if (n.else !== null) code += `else{${genNodes(n.else, state)}}`;
      continue;
    }
    // for
    const id = state.uid++;
    const arrVar = `a${id}`;
    const idxVar = `i${id}`;
    const itemVar = `x${id}`;
    const loopVar = `l${id}`;
    const bound = state.bindings.length;
    state.bindings.push({ name: n.name, expr: itemVar });
    const needsLoop = usesLoop(n.body);
    if (needsLoop) state.bindings.push({ name: 'loop', expr: loopVar });
    const inner = genNodes(n.body, state);
    state.bindings.length = bound;
    const loopObj = needsLoop
      ? `var ${loopVar}={index:${idxVar}+1,first:${idxVar}===0,last:${idxVar}===${arrVar}.length-1,length:${arrVar}.length};`
      : '';
    code += `{var ${arrVar}=${pathExpr(n.path, state)};if(Array.isArray(${arrVar})){for(var ${idxVar}=0;${idxVar}<${arrVar}.length;${idxVar}++){var ${itemVar}=${arrVar}[${idxVar}];${loopObj}${inner}}}}`;
  }
  return code;
}

const FN_CACHE = new WeakMap();

/** A template compiled to a closure `(v) => text`, or null when it does not parse (or is not there). */
function compiled(name, templates) {
  const cache = FN_CACHE.get(templates);
  if (cache !== undefined && cache.has(name)) return cache.get(name);
  const nodes = templates.get(name);
  let fn = null;
  if (nodes !== undefined) {
    try {
      const expanded = expandIncludes(nodes, templates, 0, { left: EXPAND_LIMIT });
      const roots = new Map();
      const state = {
        bindings: [],
        uid: 0,
        rootExpr(first) {
          let local = roots.get(first);
          if (local === undefined) {
            local = `r${roots.size}`;
            roots.set(first, local);
          }
          return local;
        },
      };
      const body = genNodes(expanded, state);
      let prelude = '';
      for (const [name, local] of roots) prelude += `var ${local}=gv(v,"${name}");`;
      const f = new Function('v', 'esct', 'tOf', 'tr', 'gv', `var o="";${prelude}${body}return o;`);
      const run = (vars) => f(vars, escText, textOf, truthy, gv);
      fn = run;
    } catch (err) {
      fn = null;
    }
  }
  if (cache !== undefined) cache.set(name, fn);
  else FN_CACHE.set(templates, new Map([[name, fn]]));
  return fn;
}

// ---------------------------------------------------------------- the build

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function build(input) {
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  let base = input.site.base_url;
  while (base.length > 0 && base.charCodeAt(base.length - 1) === 47) base = base.slice(0, -1);

  const output = {};
  const broken = new Set();
  const lines = report;
  const statics = [];
  const staticsSet = new Set();
  const bySource = new Map();
  const sources = [];

  // 1. the sources, in code-unit order of their paths
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else {
      statics.push(f);
      staticsSet.add(f.path);
    }
  }

  // 2. each source's front matter
  let kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      lines.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (let k = 1; k < RESERVED.length; k++) {
      if (s.path.startsWith(`${RESERVED[k]}/`)) {
        own = RESERVED[k];
        break;
      }
    }
    if (own !== undefined) {
      lines.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      lines.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      lines.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      lines.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources.length = 0;

  // 3. each page's output directory, slug and url
  const taken = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. each body's Markdown, its links resolved
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const path = s.path;
    const env = {
      link(target) {
        const c = target.charCodeAt(0);
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || c === 47 || c === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const resolved = rel === '' ? null : resolvePath(dir, rel);
        if (resolved !== null) {
          const page = bySource.get(resolved);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticsSet.has(resolved)) return `${base}/${resolved}${frag}`;
        }
        broken.add(`broken-link ${path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. the posts, newest first and then by slug
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. the tags
  const bySlug = new Map();
  const slugOfTag = new Map();
  const ownTags = (s) => {
    const tags = s.data.tags ?? [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      let slug = slugOfTag.get(name);
      if (slug === undefined) {
        slug = slugify(name);
        slugOfTag.set(name, slug);
      }
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let k = 0; k < names.length; k++) {
      const name = names[k];
      const slug = slugOfTag.get(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names = ownTags(s);
    const refs = new Array(names.length);
    for (let k = 0; k < names.length; k++) {
      const name = names[k];
      const slug = slugOfTag.get(name);
      refs[k] = bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    }
    s.tagRefs = refs;
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. every page through its layout, the index pages and the tag pages through theirs
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => {
    if (s.card === undefined) {
      s.card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
    }
    return s.card;
  };


  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));

  const vars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };

  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const fn = compiled(s.layout, templates);
    if (fn === null) continue;
    vars.page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = fn(vars);
    vars.page = undefined;
  }

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  const indexFn = compiled('index', templates);
  if (indexFn !== null) {
    const pager = { number: 1, total: pages, url: '', newer_url: '', older_url: '' };
    vars.pager = pager;
    for (let k = 1; k <= pages; k++) {
      vars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
      pager.number = k;
      pager.url = indexUrl(k);
      pager.newer_url = k === 1 ? '' : indexUrl(k - 1);
      pager.older_url = k === pages ? '' : indexUrl(k + 1);
      output[k === 1 ? 'index.html' : `page/${k}/index.html`] = indexFn(vars);
    }
    vars.pager = undefined;
    vars.posts = undefined;
  }

  const tagFn = compiled('tag', templates);
  if (tagFn !== null) {
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      vars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
      output[`tags/${t.slug}/index.html`] = tagFn(vars);
      vars.tag = undefined;
    }
  }

  const tagsFn = compiled('tags', templates);
  if (tagsFn !== null) output['tags/index.html'] = tagsFn(vars);

  // 8. each static file at its own path, unless a built page has it
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) lines.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. the report
  const sorted = [...lines, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  sorted.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${sorted.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
