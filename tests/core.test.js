// Core behaviour: parsing, links, loop safety, races, check folders, delete, rename, sync
import { loadPlugin, runChecks, setup, quiet, note, fmOf, exists, keys, errors, state, tick } from "./helpers.js";

const Plugin = await loadPlugin();
const J = JSON.stringify;

await runChecks("core", async (check) => {
  // ---------- parser & links ----------
  {
    const { app, plugin, v } = await setup(Plugin, {
      "a.md": note(`title: Hallo\ntags:\n  - x\ncategories:\n  - Books\n  - "[[Fiction]]"\ncreated: 2024-01-01\n`, "# Heading\n\ncategories: not frontmatter\n"),
    });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    const fm = fmOf(app, "a.md");
    check("plain + link -> both links", J(fm?.categories) === J(["[[Books]]", "[[Fiction]]"]), fm?.categories);
    check("other frontmatter keys preserved", fm?.title === "Hallo" && fm?.tags?.[0] === "x" && fm?.created !== undefined, fm);
    check("body preserved", v.content("a.md").endsWith("# Heading\n\ncategories: not frontmatter\n"), v.content("a.md"));
    check("category files created", exists(v, "Categories/Books.md") && exists(v, "Categories/Fiction.md") && exists(v, "Templates/Bases/Books.base"));
  }
  {
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - "[[Foo|Alias]]"\n`) });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("alias link kept as-is", J(fmOf(app, "a.md")?.categories) === J(["[[Foo|Alias]]"]), fmOf(app, "a.md")?.categories);
    check("alias link -> category Foo (not Foo-Alias)", exists(v, "Categories/Foo.md") && !exists(v, "Categories/Foo-Alias.md"), keys(v));
  }
  {
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - "[[Categories/Foo]]"\n`) });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("folder-prefixed link -> category Foo", exists(v, "Categories/Foo.md") && !exists(v, "Categories/Categories - Foo.md"), keys(v));
    check("folder-prefixed link not rewritten", J(fmOf(app, "a.md")?.categories) === J(["[[Categories/Foo]]"]), fmOf(app, "a.md")?.categories);
    check("getAllUsedCategories has Foo", plugin.getAllUsedCategories().has("Foo"), [...plugin.getAllUsedCategories()]);
  }
  {
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - "[[Travel/Europe|EU]]"\n`) });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("nested link with alias -> [[Travel - Europe|EU]]", J(fmOf(app, "a.md")?.categories) === J(["[[Travel - Europe|EU]]"]), fmOf(app, "a.md")?.categories);
  }
  {
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - Books\n  -\n  - {a: 1}\n`) });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("null/object entries: no 'null'/'[object Object]' category", !exists(v, "Categories/null.md") && !exists(v, "Categories/[object Object].md"), keys(v));
    check("null/object entries: result", J(fmOf(app, "a.md")?.categories) === J(["[[Books]]"]), fmOf(app, "a.md")?.categories);
  }
  {
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - [[Foo]]\n`) }); // unquoted -> nested array
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("unquoted [[Foo]] (nested array) -> [[Foo]]", J(fmOf(app, "a.md")?.categories) === J(["[[Foo]]"]) && exists(v, "Categories/Foo.md"), fmOf(app, "a.md")?.categories);
  }
  {
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`categories: Travel//Europe/\n`) });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("empty segments filtered", J(fmOf(app, "a.md")?.categories) === J(["[[Travel - Europe]]"]), fmOf(app, "a.md")?.categories);
  }
  {
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - Foo\n  - foo\n  - "[[FOO]]"\n`) }, { caseSensitive: false });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("case-insensitive dedupe", J(fmOf(app, "a.md")?.categories) === J(["[[Foo]]"]), fmOf(app, "a.md")?.categories);
  }
  // ---------- $ patterns ----------
  {
    const { plugin } = await setup(Plugin, {});
    const c = await plugin.generateBaseContent("A$&B$1");
    check("$-pattern in base template", c.includes('link("A$&B$1")'), c.split("\n")[2]);
  }
  // ---------- loop detection (processFrontMatter -> changed -> processFile) ----------
  {
    const { plugin, v } = await setup(Plugin, {
      "a.md": note(`categories:\n  - Books\n  - "[[Foo|Alias]]"\n  - "[[Categories/Bar]]"\n  - "Bad:Name"\n  - Travel/Europe\n  - books\n`),
      "b.md": note(`categories: Single\n`),
    });
    plugin.app.metadataCache._changedLater(v.getAbstractFileByPath("a.md"));
    plugin.app.metadataCache._changedLater(v.getAbstractFileByPath("b.md"));
    const settled = await quiet(2000);
    const writesA = state.writes.filter((p) => p === "a.md").length;
    const writesB = state.writes.filter((p) => p === "b.md").length;
    check("no endless loop (settles)", settled, state.writes.length);
    check("each note rewritten at most once", writesA <= 1 && writesB <= 1, { writesA, writesB });
    check("no error notices in loop test", errors().length === 0, errors());
  }
  // ---------- race ----------
  {
    const files = {};
    for (let i = 0; i < 6; i++) files[`n${i}.md`] = note(`categories:\n  - "[[Shared]]"\n  - "[[Other]]"\n`);
    const { plugin, v } = await setup(Plugin, files);
    await Promise.all([
      ...Object.keys(files).map((p) => plugin.processFile(v.getAbstractFileByPath(p))),
      plugin.syncAllCategories(),
    ]);
    await quiet();
    check("race: no 'already exists' errors", errors().length === 0, errors());
    check("race: files exist", exists(v, "Categories/Shared.md") && exists(v, "Templates/Bases/Shared.base"));
  }
  // ---------- queue keeps working after a failure ----------
  {
    const { plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - "[[Boom]]"\n  - "[[Fine]]"\n`) });
    v.failCreate = (p) => p === "Categories/Boom.md";
    const ok = await plugin.processFile(v.getAbstractFileByPath("a.md"));
    v.failCreate = null;
    const r = await Promise.race([plugin.ensureCategoryExists("After").then(() => "done"), tick(500).then(() => "timeout")]);
    check("queue: continues after a failing create", exists(v, "Categories/Fine.md") && r === "done" && exists(v, "Categories/After.md"), { r });
    check("queue: processFile returns false when a category could not be created", ok === false, ok);
  }
  // ---------- findCategoryFile ----------
  {
    const { plugin, v } = await setup(Plugin, {
      "Categories/Sub/Foo.md": "---\ntags:\n  - categories\n---\n",
      "Notes/Cats/Bar.md": "x",
      "Categories/baz.md": "x",
      "a.md": note(`categories:\n  - "[[Foo]]"\n  - "[[Bar]]"\n  - "[[Baz]]"\n`),
    }, { categoryCheckFolders: ["Notes/Cats"], caseSensitive: false });
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("subfolder category not duplicated", !exists(v, "Categories/Foo.md"), keys(v));
    check("check-folder category not duplicated", !exists(v, "Categories/Bar.md"));
    check("case-insensitive existing file not duplicated", !exists(v, "Categories/Baz.md"));
    check("base files created by existing basename", exists(v, "Templates/Bases/Foo.base") && exists(v, "Templates/Bases/Bar.base") && exists(v, "Templates/Bases/baz.base"), keys(v).filter((k) => k.endsWith(".base")));
  }
  // ---------- delete ----------
  {
    const { plugin } = await setup(Plugin, {
      "Categories/Unused.md": "x", "Templates/Bases/Unused.base": "y",
      "Categories/Used.md": "x",
      "a.md": note(`categories:\n  - "[[Used]]"\n`),
    });
    const r1 = await plugin.deleteCategory("Unused");
    check("delete existing -> true + trashFile", r1 === true && state.trashed.includes("Categories/Unused.md") && state.trashed.includes("Templates/Bases/Unused.base") && state.deleted.length === 0, { r1, t: state.trashed, d: state.deleted });
    const r2 = await plugin.deleteCategory("Nope");
    check("delete missing -> false", r2 === false, r2);
  }
  {
    // orphan modal: failing delete re-enables button and keeps item
    const { plugin, v } = await setup(Plugin, { "Categories/O1.md": "x", "Categories/O2.md": "x" });
    plugin.findOrphanCategories();
    const modal = state.modals[state.modals.length - 1];
    const del = modal.contentEl.findAll((e) => e.tag === "button").find((b) => b.text === "Delete");
    v.entries.delete("Categories/O1.md"); // file vanished meanwhile
    await del.onclick();
    const lis = modal.contentEl.findAll((e) => e.tag === "li");
    check("orphan modal: failed delete keeps item & re-enables button", lis.length === 2 && del.disabled === false && modal.isOpen, { lis: lis.length, dis: del.disabled });
  }
  {
    // check folders contain ordinary notes -> "Delete all orphans" must not touch them
    const { plugin } = await setup(Plugin, {
      "Categories/Used.md": "x",
      "Projects/Project A.md": "my project notes",
      "Projects/Project B.md": "more notes",
      "a.md": note(`categories:\n  - "[[Used]]"\n`),
    }, { categoryCheckFolders: ["Projects"] });
    plugin.findOrphanCategories();
    const modal = state.modals[state.modals.length - 1];
    const all = modal && modal.contentEl.findAll((e) => e.tag === "button" && /delete all/i.test(e.text))[0];
    if (all) await all.onclick();
    check("check-folder notes are NOT trashed by 'Delete all orphans'", !state.trashed.some((p) => p.startsWith("Projects/")) && !state.deleted.some((p) => p.startsWith("Projects/")), { trashed: state.trashed, deleted: state.deleted });
  }
  // ---------- rename ----------
  for (const autoLinks of [true, false]) {
    const { app, plugin, v } = await setup(Plugin, {
      "Categories/Old.md": "---\ntags:\n  - categories\n---\n\n![[Old.base]]\n",
      "Templates/Bases/Old.base": 'filters:\n  and:\n    - categories.contains(link("Old"))\n',
      "n1.md": note(`categories:\n  - "[[Old]]"\n  - "[[Other]]"\n`, "See [[Old]] in body\n"),
      "n2.md": note(`categories:\n  - "[[Old|Alias]]"\n`),
      "n3.md": note(`categories: Old\n`),
      "n4.md": note(`categories:\n  - "[[Categories/Old]]"\n`),
      "n5.md": note(`categories:\n  - "[[Other]]"\n`),
    });
    app.fileManager.autoUpdateLinks = autoLinks;
    const ok = await plugin.renameCategory("Old", "New$&");
    await quiet();
    const tag = `rename(autoLinks=${autoLinks})`;
    check(`${tag}: returns true`, ok === true, state.notices);
    check(`${tag}: category file renamed`, exists(v, "Categories/New$&.md") && !exists(v, "Categories/Old.md"), keys(v));
    check(`${tag}: base renamed`, exists(v, "Templates/Bases/New$&.base") && !exists(v, "Templates/Bases/Old.base"));
    check(`${tag}: embed updated`, (v.content("Categories/New$&.md") || "").includes("![[New$&.base]]"), v.content("Categories/New$&.md"));
    check(`${tag}: base filter updated`, (v.content("Templates/Bases/New$&.base") || "").includes('link("New$&")'), v.content("Templates/Bases/New$&.base"));
    check(`${tag}: n1 updated`, J(fmOf(app, "n1.md")?.categories) === J(["[[New$&]]", "[[Other]]"]), fmOf(app, "n1.md")?.categories);
    check(`${tag}: n2 alias kept`, J(fmOf(app, "n2.md")?.categories) === J(["[[New$&|Alias]]"]), fmOf(app, "n2.md")?.categories);
    const n3 = fmOf(app, "n3.md")?.categories;
    check(`${tag}: n3 plain single value`, ["[[New$&]]", J(["[[New$&]]"])].includes(typeof n3 === "string" ? n3 : J(n3)), n3);
    check(`${tag}: n4 folder-prefixed link updated`, !J(fmOf(app, "n4.md")?.categories).includes("Old"), fmOf(app, "n4.md")?.categories);
    check(`${tag}: n5 untouched`, !state.writes.includes("n5.md"));
    check(`${tag}: no Old category recreated`, !exists(v, "Categories/Old.md") && !exists(v, "Templates/Bases/Old.base"));
    check(`${tag}: no error notices`, errors().length === 0, errors());
  }
  {
    const { plugin, v } = await setup(Plugin, { "Categories/Old.md": "x", "Categories/Taken.md": "x", "Templates/Bases/Old.base": "x" });
    const ok = await plugin.renameCategory("Old", "Taken");
    check("rename collision (md) -> false, nothing moved", ok === false && exists(v, "Categories/Old.md") && exists(v, "Templates/Bases/Old.base"));
  }
  {
    const { plugin, v } = await setup(Plugin, { "Categories/Old.md": "x", "Templates/Bases/Old.base": "x", "Templates/Bases/Taken.base": "x" });
    const ok = await plugin.renameCategory("Old", "Taken");
    check("rename collision (base only) -> false, nothing moved", ok === false && exists(v, "Categories/Old.md") && exists(v, "Templates/Bases/Old.base"), keys(v));
  }
  {
    const { app, plugin, v } = await setup(Plugin, {
      "Categories/Sub/Old.md": "![[Old.base]]\n", "Templates/Bases/Old.base": 'link("Old")',
      "n.md": note(`categories:\n  - "[[old]]"\n`),
    }, { caseSensitive: false });
    const ok = await plugin.renameCategory("old", "Neu");
    await quiet();
    check("rename in subfolder + case-insensitive", ok && exists(v, "Categories/Sub/Neu.md") && v.content("Categories/Sub/Neu.md").includes("![[Neu.base]]") && J(fmOf(app, "n.md").categories) === J(["[[Neu]]"]), { k: keys(v), fm: fmOf(app, "n.md"), n: state.notices });
  }
  {
    const { app, plugin, v } = await setup(Plugin, {
      "Categories/foo.md": "![[foo.base]]\n", "Templates/Bases/foo.base": 'link("foo")',
      "n.md": note(`categories:\n  - "[[foo]]"\n`),
    }, { caseSensitive: false });
    const ok = await plugin.renameCategory("foo", "Foo");
    await quiet();
    check("rename case-only (case-insensitive mode)", ok && exists(v, "Categories/Foo.md") && exists(v, "Templates/Bases/Foo.base") && J(fmOf(app, "n.md").categories) === J(["[[Foo]]"]), { ok, k: keys(v), n: state.notices });
  }
  // ---------- sync counts ----------
  {
    const { plugin } = await setup(Plugin, { "a.md": note(`categories: A\n`), "b.md": note(`categories:\n  - B\n  - A\n`), "c.md": note(`x: 1\n`) });
    await plugin.syncAllCategories();
    const msg = state.notices[state.notices.length - 1];
    check("sync notice counts", msg === "Synced 2 categories from 2 files", msg);
  }
  {
    // stale metadata cache: the file on disk already contains a newer edit (M1)
    const { plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - Books\n`, "body\n") }, { debounceDelay: 5000 });
    v.entries.get("a.md").content = note(`categories:\n  - Books\n  - Fiction\n`, "body\n");
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    check("stale cache: newer frontmatter on disk is kept", /\[\[Books\]\][\s\S]*\[\[Fiction\]\]/.test(v.content("a.md")) && v.content("a.md").endsWith("body\n"), v.content("a.md"));
  }
});
