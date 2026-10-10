// editor.js — a small dependency-free code editor: a <textarea> for input, a
// highlighted <pre> underneath it for color, and a line-number gutter.

const KEYWORDS = new Set([
  'and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'export', 'false', 'for', 'function', 'if',
  'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'type', 'typeof', 'until', 'while',
]);

const GLOBALS = new Set([
  'game', 'workspace', 'script', 'Instance', 'task', 'print', 'warn', 'error', 'assert', 'pcall', 'xpcall',
  'select', 'pairs', 'ipairs', 'next', 'tostring', 'tonumber', 'setmetatable', 'getmetatable', 'rawget',
  'rawset', 'unpack', 'require', 'math', 'string', 'table', 'os', 'utf8', 'bit32', 'coroutine', 'debug',
  'buffer', 'Vector3', 'Vector2', 'CFrame', 'Color3', 'BrickColor', 'UDim', 'UDim2', 'Rect', 'Ray',
  'Region3', 'NumberRange', 'NumberSequence', 'NumberSequenceKeypoint', 'ColorSequence',
  'ColorSequenceKeypoint', 'PhysicalProperties', 'Content', 'DateTime', 'Enum', 'Random', 'gcinfo',
]);

const RE_NUMBER = /0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?/y;
const RE_IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const RE_LONG_OPEN = /\[(=*)\[/y;
const RE_FOLLOWED_BY_CALL = /[ \t]*[("'`{]/y;

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const span = (cls, text) => `<span class="tok-${cls}">${escapeHtml(text)}</span>`;

/** Luau source -> highlighted HTML (every character of `src` is preserved). */
export function highlightLuau(src) {
  const n = src.length;
  let out = '';
  let i = 0;

  const sticky = (re, at) => { re.lastIndex = at; return re.exec(src); };
  const longEnd = (level, from) => {
    const close = ']' + '='.repeat(level) + ']';
    const at = src.indexOf(close, from);
    return at < 0 ? n : at + close.length;
  };

  while (i < n) {
    const c = src[i];

    if (c === '-' && src[i + 1] === '-') { // comment
      let end;
      const open = sticky(RE_LONG_OPEN, i + 2);
      if (open) {
        end = longEnd(open[1].length, i + 2 + open[0].length);
      } else {
        end = src.indexOf('\n', i);
        if (end < 0) end = n;
      }
      out += span('com', src.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'" || c === '`') { // string (ends at the closing quote or the line)
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (j < n && src[j] === c) j++;
      out += span('str', src.slice(i, Math.min(j, n)));
      i = Math.min(j, n);
    } else if (c === '[' && sticky(RE_LONG_OPEN, i)) { // long string
      const open = sticky(RE_LONG_OPEN, i);
      const end = longEnd(open[1].length, i + open[0].length);
      out += span('str', src.slice(i, end));
      i = end;
    } else if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const m = sticky(RE_NUMBER, i);
      out += span('num', m[0]);
      i += m[0].length;
    } else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      const m = sticky(RE_IDENT, i);
      const word = m[0];
      const after = i + word.length;
      if (KEYWORDS.has(word)) out += span('kw', word);
      else if (GLOBALS.has(word)) out += span('glob', word);
      else if (sticky(RE_FOLLOWED_BY_CALL, after)) out += span('fn', word);
      else out += escapeHtml(word);
      i = after;
    } else {
      // plain run up to the next interesting character
      let j = i + 1;
      while (j < n && !/[-"'`\[\w.]/.test(src[j])) j++;
      out += escapeHtml(src.slice(i, j));
      i = j;
    }
  }
  return out;
}

export class Editor {
  /**
   * @param {{ textarea: HTMLTextAreaElement, pre: HTMLElement, gutter: HTMLElement,
   *           onRun?: () => void, onChange?: (value: string) => void }} els
   */
  constructor({ textarea, pre, gutter, onRun, onChange }) {
    this.ta = textarea;
    this.pre = pre;
    this.gutter = gutter;
    this.onRun = onRun ?? (() => {});
    this.onChange = onChange ?? (() => {});
    this.errorLine = null;
    this._lines = 0;
    this._raf = 0;

    textarea.addEventListener('input', () => { this.refresh(); this.onChange(this.value); });
    textarea.addEventListener('scroll', () => this._syncScroll());
    textarea.addEventListener('keydown', (e) => this._onKey(e));
    this.refresh();
  }

  get value() { return this.ta.value; }
  set value(v) {
    this.ta.value = v;
    this.errorLine = null;
    this.refresh();
  }

  /** Mark (or clear, with null) the line an error points at. */
  markError(line) {
    this.errorLine = line;
    this._renderGutter(true);
  }

  /** Select a 1-based line and scroll it into view. */
  goToLine(line) {
    const text = this.ta.value;
    let start = 0;
    for (let l = 1; l < line; l++) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) break;
      start = nl + 1;
    }
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    this.ta.focus();
    this.ta.setSelectionRange(start, end);
    const lineHeight = 20;
    const top = (line - 1) * lineHeight;
    if (top < this.ta.scrollTop || top > this.ta.scrollTop + this.ta.clientHeight - 3 * lineHeight) {
      this.ta.scrollTop = Math.max(0, top - this.ta.clientHeight / 3);
    }
    this._syncScroll();
  }

  refresh() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      const text = this.ta.value;
      this.pre.innerHTML = highlightLuau(text) + (text.endsWith('\n') ? ' ' : '');
      this._renderGutter(false);
      this._syncScroll();
    });
  }

  // ---- internals -----------------------------------------------------------

  _renderGutter(force) {
    const count = this.ta.value.split('\n').length;
    if (!force && count === this._lines) return;
    this._lines = count;
    const frag = document.createDocumentFragment();
    for (let l = 1; l <= count; l++) {
      const d = document.createElement('div');
      d.textContent = String(l);
      if (l === this.errorLine) d.className = 'err';
      frag.append(d);
    }
    this.gutter.replaceChildren(frag);
    this._syncScroll();
  }

  _syncScroll() {
    this.pre.scrollTop = this.ta.scrollTop;
    this.pre.scrollLeft = this.ta.scrollLeft;
    this.gutter.scrollTop = this.ta.scrollTop;
  }

  // Edit through execCommand so the browser's undo stack keeps working; fall
  // back to setRangeText where it is unavailable.
  _insert(text) {
    this.ta.focus();
    let done = false;
    try { done = document.execCommand('insertText', false, text); } catch { /* fall through */ }
    if (!done) {
      this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
      this.ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  _lineBounds() {
    const { value, selectionStart, selectionEnd } = this.ta;
    const start = value.lastIndexOf('\n', selectionStart - 1) + 1;
    // a selection that ends right after a newline does not include the next line
    const probe = selectionEnd > selectionStart && value[selectionEnd - 1] === '\n' ? selectionEnd - 1 : selectionEnd;
    let end = value.indexOf('\n', probe);
    if (end < 0) end = value.length;
    return { start, end };
  }

  _replaceBlock(start, end, text, selStart, selEnd) {
    this.ta.setSelectionRange(start, end);
    this._insert(text);
    this.ta.setSelectionRange(selStart, selEnd);
  }

  _onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      this.onRun();
      return;
    }
    if (mod && e.key === '/') {
      e.preventDefault();
      this._toggleComment();
      return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = this.ta;
      const multiline = value.slice(s, en).includes('\n');
      if (e.shiftKey || multiline) this._shiftIndent(e.shiftKey ? -1 : 1);
      else this._insert('    ');
      return;
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      const { value, selectionStart } = this.ta;
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
      const before = value.slice(lineStart, selectionStart);
      const indent = /^[ \t]*/.exec(before)[0];
      const opens = /(\bthen|\bdo|\belse|\brepeat|\bfunction\b.*\)|[({])\s*$/.test(before) && !/\bend\s*$/.test(before);
      e.preventDefault();
      this._insert('\n' + indent + (opens ? '    ' : ''));
    }
  }

  _shiftIndent(dir) {
    const { start, end } = this._lineBounds();
    const block = this.ta.value.slice(start, end);
    const lines = block.split('\n');
    const changed = lines.map((l) => (dir > 0 ? '    ' + l : l.replace(/^( {1,4}|\t)/, '')));
    const text = changed.join('\n');
    this._replaceBlock(start, end, text, start, start + text.length);
  }

  _toggleComment() {
    const { start, end } = this._lineBounds();
    const lines = this.ta.value.slice(start, end).split('\n');
    const allCommented = lines.every((l) => /^\s*--/.test(l) || l.trim() === '');
    const changed = lines.map((l) => {
      if (l.trim() === '') return l;
      return allCommented ? l.replace(/^(\s*)-- ?/, '$1') : l.replace(/^(\s*)/, '$1-- ');
    });
    const text = changed.join('\n');
    this._replaceBlock(start, end, text, start, start + text.length);
  }
}
