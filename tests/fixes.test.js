// Second fix round: orphans/delete only in the categories folder (A1), sanitizing/splitting/no loops (A2),
// fresh frontmatter in processFrontMatter (A3), smaller fixes (A4)
import { loadPlugin, runChecks, setup, quiet, note, fmOf, exists, keys, lastModal, state } from "./helpers.js";

const Plugin = await loadPlugin();
const J = JSON.stringify;
const texts = (el, tag) => el.findAll((e) => e.tag === tag).map((e) => e.text + e.children.map((c) => c.text).join(""));

// Process a note once via the 'changed' event path and report the resulting categories + write count
async function viaEvent(fm, settings = {}) {
  const ctx = await setup(Plugin, { "a.md": note(fm) }, settings);
  ctx.app.metadataCache._changedLater(ctx.v.getAbstractFileByPath("a.md"));
  const settled = await quiet(2000);
  return { ...ctx, settled, writes: state.writes.filter((p) => p === "a.md").length, cats: fmOf(ctx.app, "a.md")?.categories };
}

await runChecks("fixes", async (check) => {
  // ---------------- A1: orphans / delete only in categoriesFolder ----------------
  {
    const { plugin, v } = await setup(Plugin, {
      "Categories/Used.md": "x",
      "Categories/Sub/OldSub.md": "x",
      "Projects/Project A.md": "my project notes",
      "a.md": note(`categories:\n  - "[[Used]]"\n`),
    }, { categoryCheckFolders: ["Projects"] });
    plugin.findOrphanCategories();
    const modal = lastModal();
    const items = modal ? texts(modal.contentEl, "li") : [];
    check("A1 orphan list contains subfolder category of categoriesFolder", items.some((t) => t.includes("OldSub")), items);
    check("A1 orphan list does not contain check-folder notes", !items.some((t) => t.includes("Project A")), items);
    const r = await plugin.deleteCategory("Project A");
    check("A1 deleteCategory never trashes a check-folder note", r === false && exists(v, "Projects/Project A.md") && state.trashed.length === 0, { r, trashed: state.trashed });
    const r2 = await plugin.deleteCategory("OldSub");
    check("A1 deleteCategory trashes category page in subfolder of categoriesFolder", r2 === true && state.trashed.includes("Categories/Sub/OldSub.md"), state.trashed);
  }
  {
    const { plugin } = await setup(Plugin, {
      "Projects/Project A.md": "x",
      "a.md": note(`categories:\n  - "[[Used]]"\n`),
    }, { categoryCheckFolders: ["Projects"] });
    plugin.findOrphanCategories();
    check("A1 only check-folder notes unused -> 'No orphan categories found!'", state.modals.length === 0 && state.notices.includes("No orphan categories found!"), state.notices);
  }
  {
    // Overview: category in check folder counts as existing (no "missing file"), but is no orphan
    const { plugin } = await setup(Plugin, {
      "Projects/Bar.md": "x",
      "Projects/Unrelated.md": "x",
      "Categories/Foo.md": "x",
      "a.md": note(`categories:\n  - "[[Bar]]"\n  - "[[Foo]]"\n  - "[[Missing]]"\n`),
    }, { categoryCheckFolders: ["Projects"] });
    plugin.showCategoriesOverview();
    const modal = lastModal();
    const items = texts(modal.contentEl, "li");
    const ps = texts(modal.contentEl, "p");
    check("A1 overview: check-folder category not marked missing", items.some((t) => t === "Bar") && !items.some((t) => /^Bar.*missing/.test(t)), items);
    check("A1 overview: really missing category marked", items.some((t) => /^Missing.*missing file/.test(t)), items);
    check("A1 overview: unrelated check-folder note not listed as orphan", !items.some((t) => t.includes("Unrelated")), items);
    check("A1 overview: 'Category files' counts categoriesFolder only", ps.includes("Category files: 1"), ps);
    check("A4 overview: Modal.setTitle used", modal.titleText === "Categories overview", modal.titleText);
  }

  // ---------------- A2: sanitizing, splitting, no loops ----------------
  {
    const r = await viaEvent(`categories: "[[A]], [[B]]"\n`);
    check("A2 '[[A]], [[B]]' (text property) -> two categories", J(r.cats) === J(["[[A]]", "[[B]]"]) && exists(r.v, "Categories/A.md") && exists(r.v, "Categories/B.md"), { cats: r.cats, k: keys(r.v) });
    check("A2 '[[A]], [[B]]' settles with one write", r.settled && r.writes === 1, r.writes);
  }
  {
    const r = await viaEvent(`categories:\n  - "[[A]], [[B]]"\n  - C\n`);
    check("A2 list entry '[[A]], [[B]]' split, order kept", J(r.cats) === J(["[[A]]", "[[B]]", "[[C]]"]), r.cats);
  }
  for (const [label, fm, expected, file] of [
    ["plain 'Foo]'", `categories:\n  - "Foo]"\n`, ["[[Foo-]]"], "Categories/Foo-.md"],
    ["plain 'C#'", `categories:\n  - "C#"\n`, ["[[C-]]"], "Categories/C-.md"],
    ["plain 'x^y'", `categories:\n  - "x^y"\n`, ["[[x-y]]"], "Categories/x-y.md"],
    ["plain 'a[b'", `categories:\n  - "a[b"\n`, ["[[a-b]]"], "Categories/a-b.md"],
    ["'[[Foo#Sec]]' -> anchor removed", `categories:\n  - "[[Foo#Sec]]"\n`, ["[[Foo]]"], "Categories/Foo.md"],
    ["'[[Foo#^block|Alias]]'", `categories:\n  - "[[Foo#^block|Alias]]"\n`, ["[[Foo|Alias]]"], "Categories/Foo.md"],
    ["'[[Foo|a]b]]' alias with bracket", `categories:\n  - "[[Foo|a]b]]"\n`, ["[[Foo|a]b]]"], "Categories/Foo.md"],
    ["nested garbage '[[[[A]]]]'", `categories:\n  - "[[[[A]]]]"\n`, ["[[A]]"], "Categories/A.md"],
    ["'[[A]] B' text next to link", `categories:\n  - "[[A]] B"\n`, ["[[A]]", "[[B]]"], "Categories/B.md"],
  ]) {
    const r = await viaEvent(fm);
    check(`A2 ${label} -> ${J(expected)}`, J(r.cats) === J(expected) && exists(r.v, file), { cats: r.cats, k: keys(r.v).filter((k) => k.startsWith("Categories/")) });
    check(`A2 ${label}: settles, <= 1 write, no bracket/#/^ file`, r.settled && r.writes <= 1 && !keys(r.v).some((k) => k.startsWith("Categories/") && /[[\]#^]/.test(k)), { settled: r.settled, writes: r.writes });
  }
  for (const [label, fm] of [
    ["unfinished link '[[Foo'", `categories:\n  - "[[Foo"\n`],
    ["empty link '[[]]'", `categories:\n  - "[[]]"\n`],
    ["heading-only link '[[#Sec]]'", `categories:\n  - "[[#Sec]]"\n`],
  ]) {
    const r = await viaEvent(fm);
    check(`A2 ${label}: ignored (no write, no category)`, r.writes === 0 && !keys(r.v).some((k) => k.startsWith("Categories/")), { writes: r.writes, k: keys(r.v) });
  }
  {
    // Rewrite triggered by "Bar": unfinished links and correctly written path links stay as written
    const r = await viaEvent(`categories:\n  - Bar\n  - "[[Baz"\n  - "[[]]"\n  - "[[Categories/Foo]]"\n`);
    check("A2 unfinished links and correct entries are kept as written when another entry triggers a rewrite", J(r.cats) === J(["[[Bar]]", "[[Baz", "[[]]", "[[Categories/Foo]]"]) && r.settled && r.writes === 1, { cats: r.cats, writes: r.writes });
  }
  {
    // Idempotency: processing a normalized note again must not write
    const { plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - "Bad:Name"\n  - "[[X|Y]]"\n  - Travel/Europe\n  - "Foo]"\n`) });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    const before = state.writes.length;
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("A2 second processFile on normalized note writes nothing", state.writes.length === before, state.writes.slice(before));
  }

  // ---------------- A3: frontmatter recomputed from fresh data ----------------
  {
    const { plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - Books\n`) }, { debounceDelay: 5000 });
    v.entries.get("a.md").content = note(`categories:\n  - Books\n  - Fiction\n`); // newer edit, cache not updated yet
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    check("A3 categories added after the cache snapshot are kept", /\[\[Books\]\][\s\S]*\[\[Fiction\]\]/.test(v.content("a.md")), v.content("a.md"));
    check("A3 category file for the fresh value is created", exists(v, "Categories/Fiction.md"), keys(v));
  }
  {
    const { plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - Books\n  - Old\n`) }, { debounceDelay: 5000 });
    v.entries.get("a.md").content = note(`categories:\n  - Books\n`);
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    check("A3 category removed after the cache snapshot is not written back / created", !/Old/.test(v.content("a.md")) && !exists(v, "Categories/Old.md"), { c: v.content("a.md"), k: keys(v) });
  }

  // ---------------- A4: smaller fixes ----------------
  {
    const { plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - "[[Boom]]"\n`), "b.md": note(`categories:\n  - Fine\n`) });
    v.failCreate = (p) => p === "Categories/Boom.md";
    await plugin.syncAllCategories();
    const msg = state.notices[state.notices.length - 1];
    check("A4 fix 12: sync counts a failed category creation as error", msg === "Synced 2 categories from 1 files (1 errors)", msg);
  }
  {
    const { plugin, v } = await setup(Plugin, {
      "Notes/Cats/Bar.md": "x",
      "a.md": note(`categories:\n  - "[[Notes/Cats/Bar]]"\n  - "[[categories/Foo]]"\n  - "[[CATEGORIES/Sub/Baz]]"\n`),
    }, { categoryCheckFolders: ["Notes/Cats"] });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("A4 check-folder prefix stripped -> existing Bar, no duplicate", !exists(v, "Categories/Bar.md") && !exists(v, "Categories/Notes - Cats - Bar.md"), keys(v));
    check("A4 case-insensitive categories prefix stripped -> Foo", exists(v, "Categories/Foo.md") && !exists(v, "Categories/categories - Foo.md"), keys(v));
  }
  {
    const { app, plugin, v } = await setup(Plugin, {
      "Notes/Cats/Bar.md": "x",
      "a.md": note(`categories:\n  - "[[Notes/Cats/Bar]]"\n  - "[[categories/Foo]]"\n`),
    }, { categoryCheckFolders: ["Notes/Cats"] });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("A4 prefixed links are not rewritten on their own", state.writes.filter((p) => p === "a.md").length === 0 && J(fmOf(app, "a.md").categories) === J(["[[Notes/Cats/Bar]]", "[[categories/Foo]]"]), fmOf(app, "a.md").categories);
  }
  {
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - Foo\n  - "[[foo|Alias]]"\n`) }, { caseSensitive: false });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("A4 alias of case-insensitive duplicate kept", J(fmOf(app, "a.md").categories) === J(["[[Foo|Alias]]"]), fmOf(app, "a.md").categories);
  }
  {
    const { plugin } = await setup(Plugin, {}, {}, {
      categoriesFolder: "/Cats/", basesFolder: "Bases//X/", excludeFolders: [" Archive/ ", "", "/"], categoryCheckFolders: ["Notes//Cats/"], baseTemplatePath: " T/a.base ",
    });
    const s = plugin.settings;
    check("A4 stored paths normalized on load (vault root dropped)", s.categoriesFolder === "Cats" && s.basesFolder === "Bases/X" && J(s.excludeFolders) === J(["Archive"]) && J(s.categoryCheckFolders) === J(["Notes/Cats"]) && s.baseTemplatePath === "T/a.base", s);
    const { plugin: p2 } = await setup(Plugin, {}, {}, { categoriesFolder: "  " });
    check("A4 empty stored categories folder falls back to default", p2.settings.categoriesFolder === "Categories", p2.settings.categoriesFolder);
  }
  {
    const { plugin, v } = await setup(Plugin, {
      "Projects/Bar.md": "x", "Templates/Bases/Bar.base": 'link("Bar")',
      "a.md": note(`categories:\n  - "[[Bar]]"\n`),
    }, { categoryCheckFolders: ["Projects"] });
    const ok = await plugin.renameCategory("Bar", "Baz");
    check("A4 rename of a check-folder category is refused, nothing changed", ok === false && exists(v, "Projects/Bar.md") && exists(v, "Templates/Bases/Bar.base") && state.writes.length === 0, { ok, k: keys(v), n: state.notices });
  }
  {
    const { app, plugin } = await setup(Plugin, {
      "Categories/Old.md": "![[Old.base]]\n", "Templates/Bases/Old.base": 'link("Old")',
      "a.md": note(`categories: "[[Old]], [[B]]"\n`),
      "Templates/t.md": note(`categories:\n  - "[[Old]]"\n`),
    });
    app.fileManager.autoUpdateLinks = false; // otherwise Obsidian itself updates the link in t.md
    const ok = await plugin.renameCategory("Old", "New");
    await quiet();
    check("A4 rename splits a multi-link entry", ok && J(fmOf(app, "a.md").categories) === J(["[[New]]", "[[B]]"]), fmOf(app, "a.md").categories);
    check("A4 rename leaves notes in excluded folders untouched (documented)", J(fmOf(app, "Templates/t.md").categories) === J(["[[Old]]"]), fmOf(app, "Templates/t.md").categories);
  }
  {
    const { plugin } = await setup(Plugin, { "Categories/O1.md": "x", "Categories/O2.md": "x" });
    plugin.findOrphanCategories();
    check("A4 orphan modal uses setTitle", lastModal().titleText === "Orphan categories" && !lastModal().contentEl.findAll((e) => e.tag === "h2").length, lastModal().titleText);
  }
});
