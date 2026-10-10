// explorer.js — the Explorer tree and the Properties panel. Like the console,
// everything is built with textContent: instance names are script-controlled.

const MAX_ROWS = 3000;
const INDENT_PX = 14;

const PART_CLASSES = new Set([
  'Part', 'WedgePart', 'CornerWedgePart', 'SpawnLocation', 'Seat', 'VehicleSeat', 'TrussPart', 'MeshPart',
  'UnionOperation', 'Terrain',
]);
const FX_CLASS = /Emitter|Light$|Sound|Beam|Trail|Smoke|Fire|Sparkles|Attachment/;
const GUI_CLASS = /Gui$|Frame$|Label$|Button$|TextBox$|Layout$|Constraint$|Padding$/;

function iconFor(cls, isRoot) {
  if (isRoot) return 'service';
  if (PART_CLASSES.has(cls)) return 'part';
  if (cls === 'Model' || cls === 'Actor') return 'model';
  if (cls === 'Folder') return 'folder';
  if (cls === 'Humanoid') return 'humanoid';
  if (GUI_CLASS.test(cls)) return 'gui';
  if (FX_CLASS.test(cls)) return 'fx';
  return '';
}

export class Explorer {
  /**
   * @param {HTMLElement} el
   * @param {{ onSelect?: (id: number | null, node: object | null) => void }} [options]
   */
  constructor(el, { onSelect } = {}) {
    this.el = el;
    this.onSelect = onSelect ?? (() => {});
    this.tree = null;
    this.expanded = new Set();
    this.selected = null;
    this.nodes = new Map();   // id -> node
    this.parents = new Map(); // id -> parent id
    this._key = '';
    this._visible = [];       // ids in row order

    el.tabIndex = 0;
    el.addEventListener('click', (e) => {
      const row = e.target.closest?.('.row[data-id]');
      if (!row) return;
      const id = Number(row.dataset.id);
      if (e.target.classList.contains('caret')) this._toggle(id);
      else this.select(id);
    });
    el.addEventListener('keydown', (e) => this._onKey(e));
    this._renderEmpty();
  }

  /**
   * Replace the tree. Cheap when nothing changed: pass the raw JSON text as
   * `key` (the engine's own output) to skip re-serializing a large tree.
   */
  setTree(tree, key = JSON.stringify(tree)) {
    if (key === this._key) return;
    this._key = key;
    this.tree = tree;
    this.nodes.clear();
    this.parents.clear();
    if (tree?.root) {
      const stack = [tree.root];
      while (stack.length) {
        const n = stack.pop();
        this.nodes.set(n.id, n);
        for (const c of n.ch) { this.parents.set(c.id, n.id); stack.push(c); }
      }
      if (this.expanded.size === 0) this.expanded.add(tree.root.id);
    }
    if (this.selected !== null && !this.nodes.has(this.selected)) {
      this.selected = null;
      this.onSelect(null, null);
    }
    this._render();
  }

  /** Select programmatically (e.g. from a click in the viewport). */
  select(id, { reveal = false, notify = true } = {}) {
    if (id !== null && !this.nodes.has(id)) return;
    this.selected = id;
    if (reveal && id !== null) {
      for (let p = this.parents.get(id); p !== undefined; p = this.parents.get(p)) this.expanded.add(p);
    }
    this._render();
    if (reveal) this.el.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
    if (notify) this.onSelect(id, id === null ? null : this.nodes.get(id));
  }

  // ---- internals ---------------------------------------------------------------

  _toggle(id) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this._render();
  }

  _renderEmpty() {
    const d = document.createElement('div');
    d.className = 'more';
    d.textContent = 'Workspace is empty. Run a script that creates instances.';
    this.el.replaceChildren(d);
    this._visible = [];
  }

  _render() {
    const root = this.tree?.root;
    if (!root) { this._renderEmpty(); return; }
    const frag = document.createDocumentFragment();
    this._visible = [];
    let rows = 0;
    let hidden = 0;
    // iterative preorder over the expanded part of the tree
    const stack = [[root, 0]];
    while (stack.length) {
      const [n, depth] = stack.pop();
      if (rows >= MAX_ROWS) { hidden++; continue; }
      rows++;
      this._visible.push(n.id);
      const open = this.expanded.has(n.id);
      const row = document.createElement('div');
      row.className = 'row' + (n.id === this.selected ? ' selected' : '');
      row.dataset.id = String(n.id);
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(depth + 1));
      row.setAttribute('aria-selected', String(n.id === this.selected));
      row.style.paddingLeft = 4 + depth * INDENT_PX + 'px';
      const caret = document.createElement('span');
      caret.className = 'caret';
      if (n.ch.length) {
        row.setAttribute('aria-expanded', String(open));
        caret.textContent = open ? '▾' : '▸';
      }
      const ico = document.createElement('span');
      ico.className = 'ico ' + iconFor(n.c, depth === 0);
      const name = document.createElement('span');
      name.textContent = n.n;
      const cls = document.createElement('span');
      cls.className = 'cls';
      cls.textContent = n.c;
      row.append(caret, ico, name, cls);
      frag.append(row);
      if (open) for (let i = n.ch.length; i-- > 0;) stack.push([n.ch[i], depth + 1]);
    }
    if (hidden) {
      const more = document.createElement('div');
      more.className = 'more';
      more.textContent = `… more rows not shown (collapse some branches)`;
      frag.append(more);
    }
    const keepScroll = this.el.scrollTop;
    this.el.replaceChildren(frag);
    this.el.scrollTop = keepScroll;
  }

  _onKey(e) {
    const i = this._visible.indexOf(this.selected);
    const go = (idx) => {
      const id = this._visible[Math.max(0, Math.min(this._visible.length - 1, idx))];
      if (id !== undefined) this.select(id, { reveal: true });
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i < 0 ? 0 : i - 1); }
    else if (e.key === 'ArrowRight' && this.selected !== null) {
      e.preventDefault();
      if (this.nodes.get(this.selected)?.ch.length && !this.expanded.has(this.selected)) this._toggle(this.selected);
      else go(i + 1);
    } else if (e.key === 'ArrowLeft' && this.selected !== null) {
      e.preventDefault();
      if (this.expanded.has(this.selected) && this.nodes.get(this.selected)?.ch.length) this._toggle(this.selected);
      else if (this.parents.has(this.selected)) this.select(this.parents.get(this.selected), { reveal: true });
    }
  }
}

export class PropertiesPanel {
  /** @param {HTMLElement} el @param {HTMLInputElement} filterInput */
  constructor(el, filterInput) {
    this.el = el;
    this.filterInput = filterInput;
    this._last = '';
    this._node = null;
    this._props = null;
    filterInput.addEventListener('input', () => this._render(true));
    this.clear();
  }

  clear(message = 'Select an instance in the Explorer or click a part in the viewport.') {
    this._node = null;
    this._props = null;
    this._last = '';
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = message;
    this.el.replaceChildren(d);
  }

  /** @param {{id: number, c: string, n: string}} node @param {{n,t,v,ro}[] | null} props */
  show(node, props) {
    if (!props) { this.clear('That instance no longer exists.'); return; }
    this._node = node;
    this._props = props;
    this._render(false);
  }

  _render(force) {
    if (!this._node || !this._props) return;
    const filter = this.filterInput.value.trim().toLowerCase();
    const key = JSON.stringify([this._node.id, this._node.n, filter, this._props]);
    if (!force && key === this._last) return;
    this._last = key;

    const rows = this._props
      .filter((p) => !filter || p.n.toLowerCase().includes(filter))
      .sort((a, b) => (a.n === 'Name' ? -1 : b.n === 'Name' ? 1 : a.n.toLowerCase() < b.n.toLowerCase() ? -1 : 1));

    const frag = document.createDocumentFragment();
    const title = document.createElement('div');
    title.className = 'title';
    title.append(this._node.n);
    const small = document.createElement('small');
    small.textContent = this._node.c;
    title.append(small);
    frag.append(title);
    for (const p of rows) {
      const row = document.createElement('div');
      row.className = 'row' + (p.ro ? ' ro' : '');
      const n = document.createElement('div');
      n.className = 'n';
      n.textContent = p.n;
      n.title = `${p.n} : ${p.t}${p.ro ? ' (read-only)' : ''}`;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = p.t;
      n.append(t);
      const v = document.createElement('div');
      v.className = 'v';
      v.textContent = p.v;
      v.title = p.v;
      row.append(n, v);
      frag.append(row);
    }
    if (!rows.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No properties match the filter.';
      frag.append(e);
    }
    const keep = this.el.scrollTop;
    this.el.replaceChildren(frag);
    this.el.scrollTop = keep;
  }
}
