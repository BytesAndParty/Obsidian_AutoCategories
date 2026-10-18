// Folder settings (vault root never allowed), path-link resolution, commands and documented edge cases
import { loadPlugin, runChecks, setup, quiet, note, fmOf, exists, keys, catFiles, lastModal, obsidian as obs, state, tick } from "./helpers.js";

const Plugin = await loadPlugin();
const J = JSON.stringify;

async function deleteAllOrphans(plugin) {
  plugin.findOrphanCategories();
  const modal = lastModal();
  const button = modal && modal.contentEl.findAll((e) => e.tag === "button" && /delete all/i.test(e.text))[0];
  if (button) await button.onclick();
  return modal ? modal.orphans.slice() : [];
}

await runChecks("paths", async (check) => {
  // ---------------- N1: the vault root is never a categories/bases folder ----------------
  const vault = {
    "Journal/2024-01-01.md": "diary", "Projects/Thesis.md": "important", "Books.md": "x",
    "a.md": note(`categories:\n  - "[[Books]]"\n`),
  };
  for (const input of ["/", " / ", "\\", ".", "//"]) {
    // stored setting (loadSettings)
    const { plugin } = await setup(Plugin, vault, {}, { categoriesFolder: input, basesFolder: input });
    check(`N1 stored folders ${J(input)} fall back to the defaults`, plugin.settings.categoriesFolder === "Categories" && plugin.settings.basesFolder === "Templates/Bases", plugin.settings);
    // settings tab
    obs.settingsLog.length = 0;
    plugin.settingTab.display();
    const byName = (n) => obs.settingsLog.find((s) => s.name === n).components[0];
    plugin.settings.categoriesFolder = "Somewhere";
    await byName("Categories folder").changeHandler(input);
    await byName("Bases folder").changeHandler(input);
    check(`N1 settings tab ${J(input)} -> defaults`, plugin.settings.categoriesFolder === "Categories" && plugin.settings.basesFolder === "Templates/Bases", plugin.settings);
    const orphans = await deleteAllOrphans(plugin);
    check(`N1 ${J(input)}: orphan search / delete all trashes nothing (adv2root)`, orphans.length === 0 && state.trashed.length === 0, { orphans, trashed: state.trashed });
  }
  {
    // Settings set directly to the root (bypassing normalization): still never scan the whole vault
    const { plugin, v } = await setup(Plugin, vault, { categoriesFolder: "/", categoryCheckFolders: ["/"] });
    const orphans = await deleteAllOrphans(plugin);
    const r = await plugin.deleteCategory("Thesis");
    check("N1 root set directly: no orphans, deleteCategory trashes nothing", orphans.length === 0 && r === false && state.trashed.length === 0 && exists(v, "Projects/Thesis.md"), { orphans, r, trashed: state.trashed });
    check("N1 root set directly: existing categories are not taken from the whole vault", J(plugin.getAllExistingCategories(true)) === "[]", plugin.getAllExistingCategories(true));
  }
  {
    const { plugin } = await setup(Plugin, {}, {}, { categoryCheckFolders: ["/", "Notes", "."], excludeFolders: ["\\", "Archive"] });
    check("N1 root dropped from check/exclude folder lists", J(plugin.settings.categoryCheckFolders) === J(["Notes"]) && J(plugin.settings.excludeFolders) === J(["Archive"]), plugin.settings);
  }

  // ---------------- Path links resolved via getFirstLinkpathDest ----------------
  {
    const { app, plugin, v } = await setup(Plugin, {
      "Categories/Sub/Foo.md": "x",
      "a.md": note(`categories:\n  - "[[Categories/Sub/Foo]]"\n`),
    });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("links: [[Categories/Sub/Foo]] -> existing Foo, no 'Sub - Foo' duplicate", !exists(v, "Categories/Sub - Foo.md") && exists(v, "Templates/Bases/Foo.base"), keys(v));
    check("links: [[Categories/Sub/Foo]] kept as written (no write)", J(fmOf(app, "a.md").categories) === J(["[[Categories/Sub/Foo]]"]) && state.writes.filter((p) => p === "a.md").length === 0, fmOf(app, "a.md").categories);
    check("links: used categories / no orphan for the resolved file", plugin.getAllUsedCategories().has("Foo") && J(plugin.getAllExistingCategories()) === J(["Foo"]), [...plugin.getAllUsedCategories()]);
    plugin.findOrphanCategories();
    check("links: resolved category is not an orphan", state.notices.includes("No orphan categories found!"), state.notices);
  }
  {
    // Partial path ("Sub/Foo") and check folder are resolved as well
    const { app, plugin, v } = await setup(Plugin, {
      "Categories/Sub/Foo.md": "x", "Notes/Cats/Deep/Bar.md": "x",
      "a.md": note(`categories:\n  - "[[Sub/Foo|F]]"\n  - "[[Notes/Cats/Deep/Bar]]"\n  - Plain\n`),
    }, { categoryCheckFolders: ["Notes/Cats"] });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("links: partial path and check-folder path resolved, links kept while 'Plain' is rewritten", J(fmOf(app, "a.md").categories) === J(["[[Sub/Foo|F]]", "[[Notes/Cats/Deep/Bar]]", "[[Plain]]"]) && !exists(v, "Categories/Sub - Foo.md") && !exists(v, "Categories/Deep - Bar.md"), { fm: fmOf(app, "a.md").categories, k: catFiles(v) });
  }
  {
    // Not resolvable -> previous logic (prefix removed, rest flattened)
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - "[[Categories/Sub/Foo]]"\n`) });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("links: unresolvable path link falls back to 'Sub - Foo'", J(fmOf(app, "a.md").categories) === J(["[[Sub - Foo]]"]) && exists(v, "Categories/Sub - Foo.md"), { fm: fmOf(app, "a.md").categories, k: catFiles(v) });
  }
  {
    // A path link to a note outside the categories/check folders is not a category page
    const { app, plugin, v } = await setup(Plugin, { "Travel/Europe.md": "trip", "a.md": note(`categories:\n  - "[[Travel/Europe]]"\n`) });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("links: link to an ordinary note keeps the nested-category behaviour", J(fmOf(app, "a.md").categories) === J(["[[Travel - Europe]]"]) && exists(v, "Categories/Travel - Europe.md"), { fm: fmOf(app, "a.md").categories, k: catFiles(v) });
  }
  {
    // Case differs from the file on disk (case-sensitive mode): resolved to the real file name
    const { app, plugin, v } = await setup(Plugin, { "Categories/Foo.md": "x", "a.md": note(`categories:\n  - "[[Categories/foo]]"\n`) });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("links: [[Categories/foo]] resolves to Foo.md, no duplicate foo.md", !exists(v, "Categories/foo.md") && J(fmOf(app, "a.md").categories) === J(["[[Categories/foo]]"]), keys(v));
  }
  {
    // Alias from a duplicate is merged into the kept path link
    const { app, plugin, v } = await setup(Plugin, {
      "Categories/Foo.md": "x", "a.md": note(`categories:\n  - "[[Categories/Foo]]"\n  - "[[Foo|Alias]]"\n`),
    });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("links: alias of a duplicate merged into the path link", J(fmOf(app, "a.md").categories) === J(["[[Categories/Foo|Alias]]"]), fmOf(app, "a.md").categories);
  }

  // ---------------- Commands (adv2cmd) ----------------
  {
    const { plugin } = await setup(Plugin, { "a.md": note(`categories: Foo\n`), "Categories/Orph.md": "x" });
    const results = [];
    for (const c of plugin.commands) {
      await c.callback();
      await tick(30);
      results.push([c.id, state.notices[state.notices.length - 1], state.modals.length]);
    }
    check("commands: ids registered", J(plugin.commands.map((c) => c.id)) === J(["sync-all-categories", "process-current-file", "show-categories-overview", "find-orphan-categories"]), plugin.commands.map((c) => c.id));
    check("commands: callbacks work", J(results) === J([
      ["sync-all-categories", "Synced 1 categories from 1 files", 0],
      ["process-current-file", "No active file", 0],
      ["show-categories-overview", "No active file", 1],
      ["find-orphan-categories", "No active file", 2],
    ]), results);
  }

  // ---------------- Documented edge cases (edge.cjs) ----------------
  {
    // Open point: a base file is trashed although the category page lives in a check folder
    const { plugin } = await setup(Plugin, { "Projects/Bar.md": "x", "Templates/Bases/Bar.base": "b" }, { categoryCheckFolders: ["Projects"] });
    const r = await plugin.deleteCategory("Bar");
    check("edge: deleteCategory with page in check folder only trashes the base file, never the note", r === true && J(state.trashed) === J(["Templates/Bases/Bar.base"]), { r, trashed: state.trashed });
  }
  {
    // Open point: folder settings are compared case-sensitively
    const { plugin } = await setup(Plugin, {}, { excludeFolders: ["templates"] });
    check("edge: exclude folder 'templates' does not match 'Templates/' (case-sensitive)", plugin.shouldExcludeFile({ path: "Templates/x.md" }) === false);
  }
});
