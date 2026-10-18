// Snapshot of the complete resulting state (vault, notices, trash, modal DOM, settings tab) for a set of
// scenarios. Guards refactorings against unintended behaviour changes; after an intended change update
// the snapshots with `bun test --update-snapshots` and review the diff.
import { describe, test, expect } from "bun:test";
import { loadPlugin, reset, note, obsidian as obs, state, App, tick } from "./helpers.js";

const Plugin = await loadPlugin();

const dom = (el) => ({ t: el.tag, x: el.text, c: el.cls, k: el.children.map(dom) });
async function settle() { for (let i = 0; i < 40; i++) await tick(10); }

async function run(files, settings, action) {
  reset();
  const app = new App();
  for (const [p, c] of Object.entries(files)) app.vault.seed(p, c);
  const plugin = new Plugin(app, { id: "auto-categories" });
  await plugin.onload();
  Object.assign(plugin.settings, { debounceDelay: 5 }, settings);
  let ret;
  const { error, warn } = console;
  console.error = console.warn = () => {};
  try {
    ret = await action(plugin, app);
  } catch (e) {
    ret = "THROW " + e.message;
  }
  await settle();
  Object.assign(console, { error, warn });
  const vault = {};
  for (const [p, e] of [...app.vault.entries.entries()].sort()) {
    const name = p.split("/").pop().replace(/\.base$/, "");
    const isDefaultBase = p.endsWith(".base") && e.content === (await plugin.generateBaseContent(name));
    vault[p] = e.content === undefined ? "<folder>" : isDefaultBase ? "<default base>" : e.content;
  }
  // Notices are sorted: their order between debounced events and other async work depends on timing
  return { ret, vault, notices: [...state.notices].sort(), trashed: [...state.trashed], modals: state.modals.map((m) => ({ title: m.titleText, dom: dom(m.contentEl) })) };
}

const vault1 = {
  "Categories/Used.md": "x", "Categories/Sub/Orphan.md": "x", "Categories/orphan2.md": "x",
  "Templates/Bases/Used.base": 'link("Used")', "Projects/Bar.md": "p", "Projects/Unrelated.md": "u",
  "Templates/t.md": note(`categories:\n  - Ignored\n`),
  "a.md": note(`categories:\n  - Books\n  - "[[Fiction|F]]"\n  - "[[A]], [[B]]"\n  - "Foo]"\n  - "[[Foo#Sec]]"\n  - Travel/Europe\n  - books\n  - "[[Categories/Used]]"\n  - "[[projects/Bar]]"\n  - "[[Unfinished"\n  -\n`),
  "b.md": note(`categories: Single\n`),
  "c.md": note(`categories:\n  - "[[Used]]"\n  - "[[Missing]]"\n`),
  "d.md": note(`x: 1\n`),
};
const checks = { categoryCheckFolders: ["Projects"] };

const scenarios = [
  ["processFile a", vault1, checks, (p, app) => p.processFile(app.vault.getAbstractFileByPath("a.md"))],
  ["processFile a (case-insensitive)", vault1, { ...checks, caseSensitive: false }, (p, app) => p.processFile(app.vault.getAbstractFileByPath("a.md"))],
  ["sync", vault1, checks, (p) => p.syncAllCategories()],
  ["used categories", vault1, checks, (p) => [...p.getAllUsedCategories()]],
  ["existing categories", vault1, checks, (p) => [p.getAllExistingCategories(), p.getAllExistingCategories(true)]],
  ["overview modal", vault1, checks, (p) => p.showCategoriesOverview()],
  ["overview modal (case-insensitive)", vault1, { ...checks, caseSensitive: false }, (p) => p.showCategoriesOverview()],
  ["orphan modal + delete all", vault1, checks, async (p) => {
    p.findOrphanCategories();
    const m = state.modals[state.modals.length - 1];
    const b = m && m.contentEl.findAll((e) => e.tag === "button" && /delete all/i.test(e.text))[0];
    if (b) await b.onclick();
  }],
  ["delete check-folder + missing + used", vault1, checks, async (p) => [await p.deleteCategory("Bar"), await p.deleteCategory("Nope"), await p.deleteCategory("Used")]],
  ["rename Used -> New$&", vault1, {}, (p) => p.renameCategory("Used", "New$&")],
  ["rename check-folder Bar", vault1, checks, (p) => p.renameCategory("Bar", "Baz")],
  ["rename invalid / same / collision", vault1, {}, async (p) => [await p.renameCategory("Used", "  "), await p.renameCategory("Used", "Used"), await p.renameCategory("Used", "orphan2")]],
  ["rename case-only (case-insensitive)", vault1, { caseSensitive: false }, (p) => p.renameCategory("used", "USED")],
  ["changed events", vault1, checks, async (p, app) => {
    for (const f of ["a.md", "b.md", "c.md", "d.md"]) app.metadataCache._changedLater(app.vault.getAbstractFileByPath(f));
    await tick(600);
  }],
  ["base template + $", {}, {}, (p) => p.generateBaseContent("A$&B")],
  ["create failure", { "a.md": note(`categories:\n  - Boom\n  - Ok\n`) }, {}, async (p, app) => {
    app.vault.failCreate = (x) => x.includes("Boom");
    return p.processFile(app.vault.getAbstractFileByPath("a.md"));
  }],
  ["settings tab display + onChange", vault1, {}, async (p) => {
    obs.settingsLog.length = 0;
    p.settingTab.display();
    const log = [...obs.settingsLog];
    const shape = log.map((s) => ({ n: s.name, d: s.desc, h: !!s.heading, c: s.components.map((c) => [c.kind, c.placeholder, c.value, c.inputEl.rows, c.inputEl.cols]) }));
    const inputs = {
      "Categories folder": [" /My//Cats/ ", "   ", "/"], "Bases folder": ["B//x/", "", "\\"], "Exclude folders": [" A/ , ,B//c ", ""],
      "Additional category check folders": ["P/, Q, /", ""], "Nested category separator": [" > ", ""], "Debounce delay (ms)": ["250", "-3", "abc"],
      "Base template file path": [" T//x.base ", "  "], "Base file template (fallback)": ["custom {{categoryName}}", ""],
      "Sync on startup": [true, false], "Case sensitive": [false, true], "Show notifications": [false],
    };
    const after = [];
    for (const s of log) for (const c of s.components) for (const value of inputs[s.name] || []) {
      await c.changeHandler(value);
      const { baseTemplate, ...others } = p.settings;
      after.push([s.name, value, JSON.stringify(others), s.name.startsWith("Base file template") ? baseTemplate : undefined]);
    }
    const resetButton = p.settingTab.containerEl.findAll((e) => e.tag === "button")[0];
    p.settings.baseTemplate = "changed";
    await resetButton.onclick();
    return { shape, after, reset: p.settings.baseTemplate.slice(0, 20), dom: dom(p.settingTab.containerEl) };
  }],
];

describe("snapshot", () => {
  for (const [name, files, settings, action] of scenarios) {
    test(name, async () => {
      expect(await run(files, settings, action)).toMatchSnapshot();
    });
  }
});
