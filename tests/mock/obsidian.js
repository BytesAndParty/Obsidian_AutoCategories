// Minimal in-memory mock of the Obsidian API (only what AutoCategories uses).
// Loaded instead of the real "obsidian" module by tests/setup.js. YAML is handled by Bun.YAML.

export const state = { notices: [], modals: [], trashed: [], deleted: [], writes: [], events: 0 };
export const settingsLog = [];
export const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizePath(p) {
  p = p.replace(/[  ]/g, " ").replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "");
  p = p.normalize("NFC");
  return p === "" ? "/" : p;
}
function parentPath(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "/" : p.slice(0, i);
}

export class TAbstractFile {
  constructor(vault, path) { this.vault = vault; this.path = path; }
  get name() { return this.path === "/" ? "" : this.path.split("/").pop(); }
  get parent() { return this.path === "/" ? null : this.vault.getAbstractFileByPath(parentPath(this.path)); }
}
export class TFile extends TAbstractFile {
  get basename() { const n = this.name; const i = n.lastIndexOf("."); return i <= 0 ? n : n.slice(0, i); }
  get extension() { const n = this.name; const i = n.lastIndexOf("."); return i <= 0 ? "" : n.slice(i + 1); }
}
export class TFolder extends TAbstractFile {
  get children() { return this.vault._children(this.path); }
  isRoot() { return this.path === "/"; }
}

function splitFrontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return null;
  const after = content.indexOf("\n", end + 4);
  return { yaml: content.slice(4, end + 1), rest: after < 0 ? "" : content.slice(after + 1) };
}
function parseYaml(yaml) {
  try { return Bun.YAML.parse(yaml) ?? undefined; } catch { return undefined; }
}
function parseFrontmatter(content) {
  const s = splitFrontmatter(content);
  return s ? parseYaml(s.yaml) : undefined;
}

export class Vault {
  constructor() {
    this.entries = new Map();
    this.entries.set("/", { obj: new TFolder(this, "/") });
    this.failCreate = null; // optional predicate(path) -> simulated failure
  }
  _children(path) {
    return [...this.entries.values()].map((e) => e.obj).filter((o) => o.path !== "/" && parentPath(o.path) === path);
  }
  getAbstractFileByPath(p) { const e = this.entries.get(p); return e ? e.obj : null; }
  getRoot() { return this.entries.get("/").obj; }
  getFiles() { return [...this.entries.values()].map((e) => e.obj).filter((o) => o instanceof TFile); }
  getMarkdownFiles() { return this.getFiles().filter((o) => o.extension === "md"); }
  seed(path, content) {
    let cur = "";
    for (const part of path.split("/").slice(0, -1)) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.entries.has(cur)) this.entries.set(cur, { obj: new TFolder(this, cur) });
    }
    const obj = new TFile(this, path);
    this.entries.set(path, { obj, content });
    this.app.metadataCache._update(obj);
    return obj;
  }
  content(path) { const e = this.entries.get(path); return e ? e.content : undefined; }
  _write(file, data) {
    const e = this.entries.get(file.path);
    if (!e) throw new Error(`File not found: ${file.path}`);
    e.content = data;
    state.writes.push(file.path);
    this.app.metadataCache._changedLater(file);
  }
  async create(path, data) {
    await tick();
    if (this.failCreate && this.failCreate(path)) throw new Error(`Simulated failure for ${path}`);
    if (this.entries.has(path)) throw new Error("File already exists.");
    if (!this.entries.has(parentPath(path))) throw new Error(`Parent folder missing for ${path}`);
    const obj = new TFile(this, path);
    this.entries.set(path, { obj, content: data });
    state.writes.push(path);
    this.app.metadataCache._changedLater(obj);
    return obj;
  }
  async createFolder(path) {
    await tick();
    if (this.entries.has(path)) throw new Error("Folder already exists.");
    const obj = new TFolder(this, path);
    this.entries.set(path, { obj });
    return obj;
  }
  async read(file) { await tick(); return this.entries.get(file.path).content; }
  async cachedRead(file) { return this.read(file); }
  async modify(file, data) { await tick(); this._write(file, data); }
  async process(file, fn) {
    await tick();
    const out = fn(this.entries.get(file.path).content);
    this._write(file, out);
    return out;
  }
  async rename(file, newPath) {
    await tick();
    if (this.entries.has(newPath) && newPath !== file.path) throw new Error("Destination file already exists!");
    const e = this.entries.get(file.path);
    this.entries.delete(file.path);
    file.path = newPath;
    this.entries.set(newPath, e);
    this.app.metadataCache._update(file);
  }
  async delete(file) { await tick(); state.deleted.push(file.path); this.entries.delete(file.path); }
}

export class MetadataCache {
  constructor(app) { this.app = app; this.cache = new Map(); this.handlers = []; this.delay = 2; }
  on(name, cb) { if (name === "changed") this.handlers.push(cb); return { name, cb }; }
  offref(ref) { this.handlers = this.handlers.filter((h) => h !== ref.cb); }
  _update(file) {
    const content = this.app.vault.content(file.path);
    this.cache.set(file.path, content === undefined ? undefined : { frontmatter: parseFrontmatter(content) });
  }
  // Re-index the file shortly after a write and fire 'changed' (like Obsidian)
  _changedLater(file) {
    setTimeout(() => {
      if (!this.app.vault.getAbstractFileByPath(file.path)) return;
      this._update(file);
      state.events++;
      for (const h of [...this.handlers]) h(file, this.app.vault.content(file.path), this.cache.get(file.path));
    }, this.delay);
  }
  getFileCache(file) {
    const c = this.cache.get(file.path);
    return c ? JSON.parse(JSON.stringify(c)) : null;
  }
  // Exact path first, then a path suffix ("Sub/Foo" -> "Categories/Sub/Foo.md"), case-insensitive
  getFirstLinkpathDest(linkpath) {
    const files = this.app.vault.getFiles();
    const candidates = [linkpath.toLowerCase() + ".md", linkpath.toLowerCase()];
    for (const c of candidates) { const f = files.find((x) => x.path.toLowerCase() === c); if (f) return f; }
    for (const c of candidates) { const f = files.find((x) => x.path.toLowerCase().endsWith("/" + c)); if (f) return f; }
    return null;
  }
}

export class FileManager {
  constructor(app) { this.app = app; this.autoUpdateLinks = true; }
  async processFrontMatter(file, fn) {
    const vault = this.app.vault;
    await tick();
    const content = vault.content(file.path);
    if (content === undefined) throw new Error(`File not found: ${file.path}`);
    const s = splitFrontmatter(content);
    const fm = (s ? parseYaml(s.yaml) : undefined) ?? {};
    fn(fm);
    const yaml = Object.keys(fm).length ? Bun.YAML.stringify(fm, null, 2).replace(/\n?$/, "\n") : "";
    const body = s ? s.rest : content;
    vault._write(file, yaml ? `---\n${yaml}---\n${body}` : body);
  }
  // Renames and (like "Automatically update internal links") rewrites [[Old]] / [[Old|alias]] links
  async renameFile(file, newPath) {
    const oldName = file.extension === "md" ? file.basename : file.name;
    await this.app.vault.rename(file, newPath);
    const newName = file.extension === "md" ? file.basename : file.name;
    if (!this.autoUpdateLinks) return;
    const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\[\\[${esc}(\\|[^\\]]*)?\\]\\]`, "g");
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (re.test(this.app.vault.content(f.path))) {
        re.lastIndex = 0;
        await this.app.vault.process(f, (d) => d.replace(re, (_m, a) => `[[${newName}${a || ""}]]`));
      }
    }
  }
  async trashFile(file) { await tick(); state.trashed.push(file.path); this.app.vault.entries.delete(file.path); }
}

export class Workspace {
  constructor() { this.handlers = {}; this.activeFile = null; this.openFiles = new Set(); }
  on(name, cb) { (this.handlers[name] ||= []).push(cb); return { name, cb }; }
  trigger(name, ...args) { for (const cb of this.handlers[name] || []) cb(...args); }
  getActiveFile() { return this.activeFile; }
  getActiveViewOfType() {
    return this.activeFile ? { file: this.activeFile, getState: () => ({}), setState: async () => {} } : null;
  }
  getLeavesOfType(type) {
    return type === "markdown" ? [...this.openFiles].map((file) => ({ view: Object.assign(new MarkdownView(), { file }) })) : [];
  }
  // Open a note in the active editor (null = an empty tab), firing the events Obsidian fires
  setActiveFile(file) {
    if (file) this.openFiles.add(file);
    this.activeFile = file;
    this.trigger("active-leaf-change", null);
    this.trigger("file-open", file);
  }
  // Close a note's tab. Like Obsidian, getActiveFile() keeps returning the most recently active note.
  closeFile(file) {
    this.openFiles.delete(file);
    this.trigger("active-leaf-change", null);
    this.trigger("layout-change");
  }
  onLayoutReady(cb) { cb(); }
}

export class App {
  constructor() {
    this.vault = new Vault();
    this.vault.app = this;
    this.metadataCache = new MetadataCache(this);
    this.fileManager = new FileManager(this);
    this.workspace = new Workspace();
  }
}

export class Notice { constructor(msg) { state.notices.push(String(msg)); } }

export class FakeEl {
  constructor(tag, opts = {}) {
    this.tag = tag; this.children = []; this.text = opts.text || ""; this.cls = opts.cls || "";
    this.disabled = false; this.onclick = null; this.removed = false; this.listeners = {}; this.style = {};
    this.value = opts.value || "";
  }
  createEl(tag, opts) { const el = new FakeEl(tag, opts); this.children.push(el); el.parentEl = this; return el; }
  createDiv(opts) { return this.createEl("div", opts); }
  appendText(t) { this.text += t; }
  addEventListener(n, cb) { this.listeners[n] = cb; }
  remove() { this.removed = true; if (this.parentEl) this.parentEl.children = this.parentEl.children.filter((c) => c !== this); }
  empty() { this.children = []; }
  focus() {}
  select() {}
  findAll(pred, acc = []) { if (pred(this)) acc.push(this); for (const c of this.children) c.findAll(pred, acc); return acc; }
}

export class Modal {
  constructor(app) { this.app = app; this.contentEl = new FakeEl("div"); this.isOpen = false; this.titleText = ""; }
  setTitle(t) { this.titleText = t; return this; }
  open() { this.isOpen = true; state.modals.push(this); this.onOpen && this.onOpen(); }
  close() { this.isOpen = false; this.onClose && this.onClose(); }
}

export class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; this.commands = []; this._data = null; }
  addSettingTab(tab) { this.settingTab = tab; }
  addRibbonIcon() {}
  addCommand(c) { this.commands.push(c); }
  registerEvent() {}
  async loadData() { return this._data; }
  async saveData(d) { this._data = d; }
}

export class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new FakeEl("div"); }
}

class FakeComponent {
  constructor(kind) { this.kind = kind; this.inputEl = {}; }
  setPlaceholder(p) { this.placeholder = p; return this; }
  setValue(v) { this.value = v; return this; }
  onChange(cb) { this.changeHandler = cb; return this; }
}
// Every Setting is logged, so tests can inspect it and call its onChange handlers
export class Setting {
  constructor(containerEl) { this.containerEl = containerEl; this.components = []; settingsLog.push(this); }
  setName(n) { this.name = n; return this; }
  setDesc(d) { this.desc = d; return this; }
  setHeading() { this.heading = true; return this; }
  _add(kind, cb) { const c = new FakeComponent(kind); this.components.push(c); if (cb) cb(c); return this; }
  addText(cb) { return this._add("text", cb); }
  addToggle(cb) { return this._add("toggle", cb); }
  addTextArea(cb) { return this._add("textarea", cb); }
}

export class Menu {
  addItem() { return this; }
  showAtMouseEvent() { return this; }
}
export class MarkdownView {}
