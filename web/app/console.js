// console.js — the output pane. Everything is inserted as text nodes: script
// output is untrusted, so nothing here ever goes through innerHTML.

const MAX_LINES = 2000;
// "main:12:" / "lib.luau:3:" — Luau's error location prefix
const LOCATION = /\b([A-Za-z_][\w.-]*):(\d+):/g;

export class ConsoleView {
  /**
   * @param {HTMLElement} el scroll container
   * @param {{ onLocation?: (chunk: string, line: number) => void }} [options]
   */
  constructor(el, { onLocation } = {}) {
    this.el = el;
    this.onLocation = onLocation ?? (() => {});
    this.lineCount = 0;
    el.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[data-line]');
      if (!a) return;
      e.preventDefault();
      this.onLocation(a.dataset.chunk, Number(a.dataset.line));
    });
    this.clear();
  }

  clear() {
    this.el.replaceChildren();
    this.lineCount = 0;
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Output from print(), warn() and script errors appears here.';
    this.el.append(empty);
    this._hasEmpty = true;
  }

  set showTime(on) { this.el.classList.toggle('show-time', on); }

  /**
   * @param {{ level: 'print' | 'warn' | 'error' | 'info', text: string }[]} lines
   * @param {number} [now] virtual time to stamp the lines with
   */
  append(lines, now = 0) {
    if (!lines.length) return;
    if (this._hasEmpty) { this.el.replaceChildren(); this._hasEmpty = false; }
    const stick = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const { level, text } of lines) {
      const row = document.createElement('div');
      row.className = 'line ' + (level === 'print' ? '' : level);
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = now.toFixed(3);
      const msg = document.createElement('span');
      msg.className = 'msg';
      this._fill(msg, text, level === 'error');
      row.append(t, msg);
      frag.append(row);
    }
    this.el.append(frag);
    this.lineCount += lines.length;
    while (this.lineCount > MAX_LINES) {
      this.el.firstChild.remove();
      this.lineCount--;
    }
    if (stick) this.el.scrollTop = this.el.scrollHeight;
  }

  _fill(parent, text, linkify) {
    if (!linkify) { parent.textContent = text; return; }
    let last = 0;
    for (const m of text.matchAll(LOCATION)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = '#';
      a.dataset.chunk = m[1];
      a.dataset.line = m[2];
      a.title = `Go to line ${m[2]}`;
      a.textContent = `${m[1]}:${m[2]}`;
      parent.append(a, ':');
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }
}
