// A fast drop-in for makefun-site 1.0.0: run(input) returns the same output
// tree makefun-site's build returns, byte for byte, for every case.
//
// The dialect is makefun-site's own (front matter, permalinks, Markdown
// subset, collections, tags, template language, build report), implemented
// here from its documented rules with the hot paths restructured for speed:
// a per-case memoised slug rule with an ASCII fast path, a front-matter
// scanner that never splits the body, a fused block renderer, and an inline
// renderer that works on index ranges of the original string instead of
// slicing a fresh substring at every construct. All state lives inside one
// run() call: nothing is carried from one case to the next.

// ---------------------------------------------------------------- text rules

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const HAS_ESCAPE_RE = /[&<>"']/;

/**
 * `text` with & < > " and ' replaced by their HTML escapes, nothing else.
 * Most texts hold no special character and are returned as they stand
 * after one engine scan; the rest take one regex pass in which only a
 * character that is actually replaced reaches the callback.
 */
function escapeHtml(text) {
  return HAS_ESCAPE_RE.test(text) ? text.replace(ESCAPE_RE, (c) => ESCAPES[c]) : text;
}

const SLUG_MAX = 64;

/**
 * The slug of `text`, computed once: NFKD, combining marks dropped, A-Z
 * lowered, each run of characters other than a-z and 0-9 a single "-", none
 * at either end, cut to 64 characters with a "-" left at the cut dropped,
 * "untitled" when nothing is left. Pure-ASCII text skips normalisation
 * entirely (NFKD is the identity there and no ASCII character is a mark),
 * and the scan stops once 64 characters are kept, which is all the cut can
 * ever keep.
 */
function slugCompute(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
      if (out.length >= SLUG_MAX) break;
    }
    out += keep;
    if (out.length >= SLUG_MAX) break;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether code unit `c` is whitespace to JavaScript's \s. */
function isSpaceCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279;
}

// Whitespace by code unit: exactly the set isSpaceCode names, as a table
// (a Uint8Array read beats the chain of comparisons in the hot loop).
const WS_TABLE = new Uint8Array(65536);
for (let c = 9; c <= 13; c++) WS_TABLE[c] = 1;
WS_TABLE[32] = 1;
WS_TABLE[160] = 1;
WS_TABLE[5760] = 1;
for (let c = 8192; c <= 8202; c++) WS_TABLE[c] = 1;
WS_TABLE[8232] = 1;
WS_TABLE[8233] = 1;
WS_TABLE[8239] = 1;
WS_TABLE[8287] = 1;
WS_TABLE[12288] = 1;
WS_TABLE[65279] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `line` is blank: spaces and tabs only. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `s` with trailing spaces and tabs dropped. */
function stripTrail(s) {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return s.slice(0, e);
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** Whether `s` matches a slug: a-z and 0-9, single "-" between groups. */
function isSlugText(s) {
  if (s.length === 0) return false;
  let seg = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) { // '-'
      if (seg === 0) return false;
      seg = 0;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) seg++;
    else return false;
  }
  return seg > 0;
}

/** One front-matter key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug':
      return raw.length <= 64 && isSlugText(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. The text is scanned line by line from the top
 * (the closing "---" is found before any line is judged, as the dialect has
 * it), and the body is the untouched remainder of the text.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  const fmLines = [];
  let pos = firstNl + 1;
  let bodyStart = -1;
  for (;;) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') {
      bodyStart = e === -1 ? text.length : e + 1;
      break;
    }
    fmLines.push(line);
    if (e === -1) return { error: 'the front matter is not closed' };
    pos = e + 1;
  }
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    if (isBlankLine(line) || line.startsWith('#')) continue;
    let c = 0;
    const n = line.length;
    while (c < n) {
      const cc = line.charCodeAt(c);
      if ((cc >= 97 && cc <= 122) || cc === 95) c++;
      else break;
    }
    if (c === 0 || c >= n || line[c] !== ':') return { error: `line ${k + 2} is not "key: value"` };
    let raw;
    if (c + 1 === n) raw = '';
    else if (line[c + 1] === ' ') raw = stripTrail(line.slice(c + 2));
    else return { error: `line ${k + 2} is not "key: value"` };
    const key = line.slice(0, c);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** A line's spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return line.slice(a, b);
}

/**
 * A fence opening line's language, or null: three backticks, a language of
 * A-Z a-z 0-9 _ + -, then spaces or tabs only.
 */
function fenceLang(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return null;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 35) i++; // '#'
  if (i === 0 || i > 6 || i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  let j = i;
  while (j < line.length) {
    const cc = line.charCodeAt(j);
    if (cc === 32 || cc === 9) j++;
    else break;
  }
  let e = line.length;
  while (e > j) {
    const cc = line.charCodeAt(e - 1);
    if (cc === 32 || cc === 9) e--;
    else break;
  }
  if (e <= j) return null;
  return { depth: i, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break: "---" or "***", then spaces or tabs only. */
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item line's content ("- " or "* "), or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item line's number and content ("12. "), or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
    return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
  }
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isSpaceCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  // Every one of the four can only start with one of these code units
  // (an empty line, a space or tab, ` # - or *); anything else is a plain
  // continuation and skips all four scans.
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9 && c !== 96 && c !== 35 && c !== 45 && c !== 42 && line.length !== 0) return false;
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

/** The first index in s[from, hi) where `what` sits outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in s[from, hi) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < hi && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * s[lo, hi) rendered inline, appended to `out` as chunks. Plain runs are
 * escaped in bulk between constructs; constructs recurse on ranges of the
 * same string, so nothing is copied but the output itself. `link(target)`
 * is a link's href.
 */
function inlineInto(s, lo, hi, link, out) {
  let i = lo;
  let plain = lo;
  while (i < hi) {
    // Only \ ` * and [ can open a construct; the search for the next one
    // runs in the string engine, so the plain text between constructs is
    // never walked a character at a time.
    let j = s.indexOf('\\', i);
    const jTick = s.indexOf('`', i);
    if (jTick !== -1 && (j === -1 || jTick < j)) j = jTick;
    const jStar = s.indexOf('*', i);
    if (jStar !== -1 && (j === -1 || jStar < j)) j = jStar;
    const jBrack = s.indexOf('[', i);
    if (jBrack !== -1 && (j === -1 || jBrack < j)) j = jBrack;
    if (j === -1 || j >= hi) break;
    i = j;
    const c = s.charCodeAt(i);
    if (c === 92) { // '\'
      if (i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
        if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
        out.push(escapeHtml(s[i + 1]));
        i += 2;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 96) { // '`'
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < hi && k > i + 1) {
        if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 42) { // '*'
      if (i + 1 < hi && s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2, hi);
        if (k > i + 2) {
          if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
          out.push('<strong>');
          inlineInto(s, i + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const k = findSingleStar(s, i + 1, hi);
      if (k > i + 1) {
        if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
        out.push('<em>');
        inlineInto(s, i + 1, k, link, out);
        out.push('</em>');
        i = k + 1;
        plain = i;
      } else i++;
      continue;
    }
    // c === 91, '['
    const k = findUnescaped(s, ']', i + 1, hi);
    let m = -1;
    if (k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40) { // '('
      m = s.indexOf(')', k + 2);
      if (m >= hi) m = -1;
    }
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
      out.push('<a href="', escapeHtml(link(target)), '">');
      inlineInto(s, i + 1, k, link, out);
      out.push('</a>');
      i = m + 1;
      plain = i;
    } else i++;
  }
  if (hi > plain) out.push(escapeHtml(s.slice(plain, hi)));
}

/** `s` rendered inline. */
function inlineStr(s, link) {
  const out = [];
  inlineInto(s, 0, s.length, link, out);
  return out.join('');
}

/**
 * A body's rendering in one pass over its lines: the HTML (each block
 * followed by "\n"), the table of contents (every level 2 and 3 heading:
 * level, id and its inline HTML) and the excerpt (the first paragraph's
 * inline HTML, or "").
 */
function renderBody(src, link, slugify) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    // A construct can only open on ` # - * > or a digit; a line opening
    // on anything else is paragraph text and skips every probe below.
    const c0 = line.charCodeAt(0);
    const plain = c0 !== 96 && c0 !== 35 && c0 !== 45 && c0 !== 42 && c0 !== 62 && !(c0 >= 48 && c0 <= 57);
    const lang = plain ? null : fenceLang(line);
    if (lang !== null) {
      i++;
      const parts = ['<pre><code'];
      if (lang !== '') parts.push(' class="language-', lang, '"');
      parts.push('>');
      while (i < n && !isFenceClose(lines[i])) {
        parts.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      i++;
      parts.push('</code></pre>');
      blocks.push(parts.join(''));
      continue;
    }
    const h = plain ? null : headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text), ids);
      const html = inlineStr(h.text, link);
      blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (!plain && isHR(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) { // '>'
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const t = lines[i];
        const stripped = t.length > 1 && t.charCodeAt(1) === 32 ? t.slice(2) : t.slice(1);
        const trimmed = trimLine(stripped);
        if (trimmed !== '') kept.push(trimmed);
        i++;
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const b0 = plain ? null : bulletOf(line);
    const o0 = b0 === null && !plain ? orderedOf(line) : null;
    if (b0 !== null || o0 !== null) {
      const isOrd = o0 !== null;
      const items = [];
      let cur = null;
      while (i < n) {
        const l = lines[i];
        let content = null;
        if (isOrd) {
          const m = orderedOf(l);
          if (m !== null) content = m.text;
        } else {
          const m = bulletOf(l);
          if (m !== null) content = m;
        }
        if (content !== null) {
          cur = [trimLine(content)];
          items.push(cur);
          i++;
        } else if (cur !== null && isContinued(l)) {
          cur.push(trimLine(l));
          i++;
        } else break;
      }
      const parts = [isOrd && o0.num !== 1 ? `<ol start="${o0.num}">` : `<${isOrd ? 'ol' : 'ul'}>`, '\n'];
      for (const item of items) parts.push('<li>', inlineStr(item.join('\n'), link), '</li>\n');
      parts.push(`</${isOrd ? 'ol' : 'ul'}>`);
      blocks.push(parts.join(''));
      continue;
    }
    const plines = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      plines.push(trimLine(lines[i]));
      i++;
    }
    const html = inlineStr(plines.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why, in its message. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether s[a, b) is spaces and tabs only. */
function isBlankRange(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
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
      if (text !== '') {
        tokens.push({ t: 'text', text });
        text = '';
      }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = isBlankRange(src, lineStart, open) && isBlankRange(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') {
      tokens.push({ t: 'text', text });
      text = '';
    }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
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
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
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
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope`, appended to `out`; `ctx` holds the parsed templates. */
function renderInto(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    switch (nd.kind) {
      case 'text':
        out.push(nd.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, nd.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, nd.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) renderInto(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, nd.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        // One scope for the whole loop, its fields rewritten per item:
        // rendering is synchronous and nothing keeps the item or the
        // loop record past its own iteration, so reuse is unobservable.
        // (vars.loop is assigned after the item, as in a fresh literal,
        // so an item itself named "loop" still loses to the record.)
        const loop = { index: 0, first: false, last: false, length: len };
        const vars = {};
        const inner = { vars, parent: scope };
        for (let k = 0; k < len; k++) {
          vars[nd.name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          renderInto(nd.body, inner, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(nd.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A source's date in words, computed once and kept on the source. */
function dateLongOf(s) {
  if (s.dateLong === undefined) s.dateLong = s.data.date === undefined ? '' : longDate(s.data.date);
  return s.dateLong;
}

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: dateLongOf(s),
  };
}

/** A source's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: dateLongOf(s),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    // A tag's card record never changes once the tag exists, and one tag
    // sits in many cards: build it once, on the tag itself.
    tags: s.tagRefs.map((t) => t.cardTag ?? (t.cardTag = { name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it, over its (shared) card. */
function pageOf(s, card) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's. */
export function run(input) {
  // The slug rule, memoised for this case alone: titles, tag names and
  // headings repeat across a site's hundreds of sources, and each repeat
  // would otherwise pay the normalisation again.
  const slugMemo = new Map();
  const slugify = (text) => {
    let r = slugMemo.get(text);
    if (r === undefined) {
      r = slugCompute(text);
      slugMemo.set(text, r);
    }
    return r;
  };

  // Every template parsed, in code-unit order of its name; one that does
  // not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // The sources in code-unit order of path, line ends made "\n"; a file
  // that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the refusal checks, in their order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
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

  // Each body's Markdown, its links resolved.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  // A target's resolution depends only on its directory: the same link
  // written in twenty posts of one section resolves once per case.
  const linkMemo = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    let dirMemo = linkMemo.get(dir);
    if (dirMemo === undefined) {
      dirMemo = new Map();
      linkMemo.set(dir, dirMemo);
    }
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      let r = dirMemo.get(target);
      if (r === undefined) {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        r = null;
        if (path !== null) {
          const pg = bySource.get(path);
          if (pg !== undefined) r = `${pg.url}${frag}`;
          else if (staticPaths.has(path)) r = `${base}/${path}${frag}`;
        }
        dirMemo.set(target, r);
      }
      if (r === null) {
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      return r;
    };
    const md = renderBody(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest date first, and equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // The tags: grouped by slug, named as first met in the posts' order,
  // ordered by count of posts, then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slugify(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slugify(name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Every page through its layout, then the index and tag pages, then the
  // static files.
  // A source's card is computed once and shared by the cards map, the tag
  // pages, recent and the page's own layout: templates only ever read a
  // card, and the word count of a body is the dearest part of one.
  const card = (s) => s.card ?? (s.card = cardOf(s));
  const cards = new Map();
  for (const p of posts) cards.set(p, card(p));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderInto(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, card(s)) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
