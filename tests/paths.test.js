// Folder settings (vault root never allowed), path-link resolution, commands and documented edge cases
import { loadPlugin, runChecks, setup, quiet, note, fmOf, exists, keys, catFiles, lastModal, obsidian as obs, state, tick } from "./helpers.js";

const Plugin = await loadPlugin();
const J = JSON.stringify;

async function deleteAllOrphans(plugin) {
  plugin.findOrphanCategories();
  const modal = lastModal();
  const orphans = modal ? modal.orphans.slice() : [];
  const buttons = modal ? modal.contentEl.findAll((e) => e.tag === "button") : [];
  // "Delete all orphans" only exists for more than one orphan
  const all = buttons.find((b) => /delete all/i.test(b.text));
  for (const button of all ? [all] : buttons.filter((b) => b.text === "Delete")) await button.onclick();
  return orphans;
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

  // ---------------- deleteCategory and check folders ----------------
  {
    const { plugin, v } = await setup(Plugin, { "Projects/Bar.md": "x", "Templates/Bases/Bar.base": "b" }, { categoryCheckFolders: ["Projects"] });
    const r = await plugin.deleteCategory("Bar");
    check("delete: category whose page lives in a check folder is refused, nothing trashed", r === false && state.trashed.length === 0 && exists(v, "Projects/Bar.md") && exists(v, "Templates/Bases/Bar.base") && state.notices.some((n) => n.includes("Projects/Bar.md") && /not deleted/.test(n)), { r, trashed: state.trashed, n: state.notices });
  }
  {
    // Only a base file left (page already gone): the base file is still cleaned up
    const { plugin } = await setup(Plugin, { "Templates/Bases/Gone.base": "b" }, { categoryCheckFolders: ["Projects"] });
    const r = await plugin.deleteCategory("Gone");
    check("delete: base file without any page is trashed", r === true && J(state.trashed) === J(["Templates/Bases/Gone.base"]), { r, trashed: state.trashed });
  }

  // ---------------- Folder settings are compared case-insensitively ----------------
  {
    const { plugin, v } = await setup(Plugin, {
      "Templates/t.md": note(`categories:\n  - InTemplate\n`),
      "ÄRCHIV/old.md": note(`categories:\n  - InArchive\n`),
      "a.md": note(`categories:\n  - Visible\n`),
    }, { excludeFolders: ["templates", "ärchiv"] });
    check("case: exclude 'templates' matches 'Templates/'", plugin.shouldExcludeFile(v.getAbstractFileByPath("Templates/t.md")) === true);
    check("case: exclude 'ärchiv' matches 'ÄRCHIV/' (Unicode)", plugin.shouldExcludeFile(v.getAbstractFileByPath("ÄRCHIV/old.md")) === true);
    check("case: 'Templates2/' is not inside 'templates'", plugin.shouldExcludeFile({ path: "Templates2/x.md" }) === false);
    await plugin.syncAllCategories();
    await quiet();
    check("case: excluded notes are not processed", exists(v, "Categories/Visible.md") && !exists(v, "Categories/InTemplate.md") && !exists(v, "Categories/InArchive.md"), catFiles(v));
  }
  {
    // Check folder written in another case: existing page found, never an orphan, never deleted
    const { plugin, v } = await setup(Plugin, {
      "Projects/Bar.md": "x", "Categories/Used.md": "x",
      "a.md": note(`categories:\n  - "[[Bar]]"\n  - "[[PROJECTS/Bar]]"\n  - "[[Used]]"\n`),
    }, { categoryCheckFolders: ["projects"] });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("case: check folder 'projects' finds 'Projects/Bar.md' (no duplicate)", !exists(v, "Categories/Bar.md") && !exists(v, "Categories/PROJECTS - Bar.md"), catFiles(v));
    const orphans = await deleteAllOrphans(plugin);
    const r = await plugin.deleteCategory("Bar");
    check("case: check-folder page in other case is never an orphan or deleted", orphans.length === 0 && r === false && state.trashed.length === 0 && exists(v, "Projects/Bar.md"), { orphans, r, trashed: state.trashed });
  }
  {
    // Categories folder written in another case: pages go into the existing folder, no error, orphans work
    const { plugin, v } = await setup(Plugin, {
      "Categories/Old.md": "x",
      "a.md": note(`categories:\n  - New\n`),
    }, { categoriesFolder: "categories", basesFolder: "templates/bases" }, null);
    v.seed("Templates/Bases/Old.base", "b");
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("case: categories folder 'categories' uses the existing 'Categories/' folder", exists(v, "Categories/New.md") && exists(v, "Templates/Bases/New.base") && !keys(v).some((k) => k.startsWith("categories") || k.startsWith("templates")), keys(v));
    check("case: no error notices", !state.notices.some((n) => /error/i.test(n)), state.notices);
    const orphans = await deleteAllOrphans(plugin);
    check("case: orphan in 'Categories/' found and deleted with its base", J(orphans) === J(["Old"]) && J(state.trashed.sort()) === J(["Categories/Old.md", "Templates/Bases/Old.base"]), { orphans, trashed: state.trashed });
  }
  {
    const { plugin } = await setup(Plugin, {}, {}, { categoryCheckFolders: ["Projects", "projects", "PROJECTS/", "Notes"], excludeFolders: ["Archive", "archive"] });
    check("case: folder lists are deduplicated case-insensitively (first spelling kept)", J(plugin.settings.categoryCheckFolders) === J(["Projects", "Notes"]) && J(plugin.settings.excludeFolders) === J(["Archive"]), plugin.settings);
  }
  {
    // Path link with a folder prefix in another case falls back to the folder-insensitive prefix strip
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - "[[CATEGORIES/Fresh]]"\n`) }, { categoriesFolder: "Categories" });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("case: '[[CATEGORIES/Fresh]]' creates 'Fresh', link kept as written", exists(v, "Categories/Fresh.md") && J(fmOf(app, "a.md").categories) === J(["[[CATEGORIES/Fresh]]"]), { k: catFiles(v), fm: fmOf(app, "a.md").categories });
  }
});
