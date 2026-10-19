// Adversarial tests from the independent validator (round 2): multi-links, empty values, Unicode,
// Windows paths, rename collisions, check folders, concurrency, misc
import { loadPlugin, runChecks, setup, quiet, note, fmOf, exists, keys, catFiles, errors, writesOf, obsidian as obs, state, tick } from "./helpers.js";

const Plugin = await loadPlugin();
const J = JSON.stringify;

async function viaEvent(files, path, settings = {}, data = null) {
  const ctx = await setup(Plugin, files, settings, data);
  ctx.app.metadataCache._changedLater(ctx.v.getAbstractFileByPath(path));
  const settled = await quiet(2500, 150);
  return { ...ctx, settled, writes: writesOf(path), cats: fmOf(ctx.app, path)?.categories };
}

await runChecks("adversarial", async (check) => {
  const info = () => {}; // informational output of the original script

  // ---------- 1 Mehrfachlinks ----------
  {
    const r = await viaEvent({ "a.md": note(`categories: "[[A]][[B]]"\n`) }, "a.md");
    check("1a '[[A]][[B]]' ohne Trenner -> zwei Links, settles", J(r.cats) === J(["[[A]]", "[[B]]"]) && r.settled && r.writes === 1, { cats: r.cats, w: r.writes });
  }
  {
    const r = await viaEvent({ "a.md": note(`categories: "[[A|x]], [[B]], [[A|y]]"\n`) }, "a.md");
    check("1b Mehrfachlinks mit Dublette + Alias -> erster Alias bleibt", J(r.cats) === J(["[[A|x]]", "[[B]]"]) && r.settled && r.writes === 1, { cats: r.cats, w: r.writes });
  }
  {
    const r = await viaEvent({ "a.md": note(`categories:\n  - "[[Categories/A#h|al]], [[Travel/Europe]]"\n  - "[[A]]"\n`) }, "a.md");
    check("1c Pfad + Heading + Alias + verschachtelt im Mehrfachlink", J(r.cats) === J(["[[A|al]]", "[[Travel - Europe]]"]) && r.settled && r.writes === 1 && exists(r.v, "Categories/Travel - Europe.md"), { cats: r.cats, w: r.writes, k: catFiles(r.v) });
  }
  {
    const r = await viaEvent({ "a.md": note(`categories: "[[A]],,, ,[[B]] , "\n`) }, "a.md");
    check("1d leere Komma-Segmente zwischen Links ignoriert", J(r.cats) === J(["[[A]]", "[[B]]"]) && r.settled && !catFiles(r.v).some((k) => /Categories\/\s*\.md|,/.test(k)), { cats: r.cats, k: catFiles(r.v) });
  }
  // ---------- 2 Leere Werte ----------
  for (const [label, fm] of [
    ["leerer String", `categories: ""\n`], ["leere Liste", `categories: []\n`], ["Liste mit ''", `categories:\n  - ""\n`],
    ["null", `categories:\n`], ["nur Leerzeichen", `categories: "   "\n`], ["[null, '']", `categories:\n  -\n  - ""\n`],
    ["Map", `categories: {a: 1}\n`], ["0", `categories: 0\n`], ["false", `categories: false\n`],
    ["leerer Link mit Alias", `categories:\n  - "[[|alias]]"\n`], ["nur Ordnerpfad", `categories:\n  - "[[Categories/]]"\n`],
  ]) {
    const r = await viaEvent({ "a.md": note(fm) }, "a.md");
    check(`2 leerer Wert (${label}): kein Schreiben, keine Kategorie, kein Fehler`, r.writes === 0 && catFiles(r.v).length === 0 && errors().length === 0 && r.settled, { w: r.writes, k: catFiles(r.v), e: errors() });
  }
  {
    const r = await viaEvent({ "a.md": note(`categories:\n  - "[[/]]"\n  - Real\n`) }, "a.md");
    check("2b '[[/]]' (leer nach Flatten) wird entfernt, Rest bleibt, konvergiert", J(r.cats) === J(["[[Real]]"]) && r.settled && r.writes === 1, { cats: r.cats, w: r.writes });
  }
  // ---------- 3 Unicode ----------
  {
    const r = await viaEvent({ "a.md": note(`categories:\n  - Bücher\n  - "Café ☕"\n  - 日本語\n  - "📚 Lesen"\n  - "Straße/Übersicht"\n`) }, "a.md");
    const exp = ["[[Bücher]]", "[[Café ☕]]", "[[日本語]]", "[[📚 Lesen]]", "[[Straße - Übersicht]]"];
    check("3a Unicode-Namen -> Links + Dateien, konvergiert", J(r.cats) === J(exp) && r.settled && r.writes === 1 && exp.every((l) => exists(r.v, `Categories/${l.slice(2, -2)}.md`)), { cats: r.cats, k: catFiles(r.v) });
  }
  {
    const r = await viaEvent({ "a.md": note(`categories:\n  - ÄRGER\n  - "[[ärger|x]]"\n  - Öl\n`) }, "a.md", { caseSensitive: false });
    check("3b case-insensitive Unicode-Dublette (ÄRGER/ärger), Alias übernommen", J(r.cats) === J(["[[ÄRGER|x]]", "[[Öl]]"]) && r.settled, { cats: r.cats });
  }
  {
    // NFD in frontmatter vs. NFC file on disk
    const nfd = "Cafe\u0301", nfc = "Caf\u00e9";
    const r = await viaEvent({ ["Categories/" + nfc + ".md"]: "x", "a.md": note(`categories:\n  - "[[${nfd}]]"\n`) }, "a.md");
    info("3c NFD-Link vs. NFC-Datei: Kategoriedateien", catFiles(r.v).map((k) => [k, k.normalize("NFC") === k]));
    check("3c NFD vs. NFC: keine Schreibschleife", r.settled && r.writes === 0, { w: r.writes });
  }
  // ---------- 4 Windows-Pfade ----------
  {
    const { plugin, v, app } = await setup(Plugin, {
      "Notes/Cats/Bar.md": "x", "Templates/cat.base": 'custom link("{{categoryName}}")',
      "a.md": note(`categories:\n  - "[[Bar]]"\n  - Foo\n`),
    }, {}, { categoriesFolder: "My\\Cats\\", basesFolder: "B\\\\X", categoryCheckFolders: ["Notes\\Cats"], excludeFolders: ["Archive\\"], baseTemplatePath: "Templates\\cat.base" });
    const s = plugin.settings;
    check("4a Backslash-Pfade beim Laden normalisiert", s.categoriesFolder === "My/Cats" && s.basesFolder === "B/X" && J(s.categoryCheckFolders) === J(["Notes/Cats"]) && J(s.excludeFolders) === J(["Archive"]) && s.baseTemplatePath === "Templates/cat.base", s);
    await plugin.processFile(v.getAbstractFileByPath("a.md"));
    await quiet();
    check("4b Check-Ordner mit Backslash greift (Bar nicht dupliziert), Foo in My/Cats", !exists(v, "My/Cats/Bar.md") && exists(v, "My/Cats/Foo.md") && exists(v, "B/X/Foo.base"), catFiles(v, "My/"));
    check("4c Template-Datei mit Backslash-Pfad wird genutzt", (v.content("B/X/Foo.base") || "").startsWith('custom link("Foo")'), v.content("B/X/Foo.base"));
  }
  {
    const { plugin } = await setup(Plugin, {});
    obs.settingsLog.length = 0;
    plugin.settingTab.display();
    const byName = (n) => obs.settingsLog.find((s) => s.name === n).components[0];
    await byName("Categories folder").changeHandler(" C:\\Vault\\Cats\\ ");
    await byName("Additional category check folders").changeHandler("A\\B , , \\C\\");
    check("4d Settings-Tab: Backslash-Eingaben normalisiert", plugin.settings.categoriesFolder === "C:/Vault/Cats" && J(plugin.settings.categoryCheckFolders) === J(["A/B", "C"]), plugin.settings);
  }
  {
    const r = await viaEvent({ "a.md": note(`categories:\n  - "Travel\\\\Europe"\n`) }, "a.md");
    info("4e Kategoriewert mit Backslash 'Travel\\Europe'", r.cats);
    check("4e Backslash im Kategorienamen sanitisiert, konvergiert", J(r.cats) === J(["[[Travel-Europe]]"]) && r.settled, r.cats);
  }
  // ---------- 5 Rename mit Kollision ----------
  {
    const { plugin, v } = await setup(Plugin, {
      "Categories/Old.md": "![[Old.base]]", "Templates/Bases/Old.base": 'link("Old")', "Projects/Taken.md": "x",
      "a.md": note(`categories:\n  - "[[Old]]"\n`),
    }, { categoryCheckFolders: ["Projects"] });
    const ok = await plugin.renameCategory("Old", "Taken");
    check("5a Rename auf Namen im Check-Ordner -> abgelehnt, nichts geändert", ok === false && exists(v, "Categories/Old.md") && exists(v, "Templates/Bases/Old.base") && state.writes.length === 0, { ok, n: state.notices });
  }
  {
    const { plugin, v } = await setup(Plugin, {
      "Categories/Old.md": "x", "Categories/taken.md": "x", "a.md": note(`categories:\n  - "[[Old]]"\n`),
    }, { caseSensitive: false });
    const ok = await plugin.renameCategory("Old", "TAKEN");
    check("5b Rename-Kollision nur in Groß/Kleinschreibung (case-insensitive) -> abgelehnt", ok === false && exists(v, "Categories/Old.md") && state.writes.length === 0, { ok, n: state.notices });
  }
  {
    const { app, plugin, v } = await setup(Plugin, {
      "Categories/Old.md": "![[Old.base]]", "Templates/Bases/Old.base": 'link("Old")',
      "a.md": note(`categories:\n  - "[[Old]]"\n  - "[[New]]"\n`),
    });
    const ok = await plugin.renameCategory("Old", "New");
    const settled = await quiet();
    check("5c Rename in benutzte, dateilose Kategorie -> Merge + Dedupe, konvergiert", ok && settled && J(fmOf(app, "a.md").categories) === J(["[[New]]"]) && exists(v, "Categories/New.md") && !exists(v, "Categories/Old.md") && !exists(v, "Templates/Bases/Old.base"), { ok, fm: fmOf(app, "a.md"), k: keys(v) });
  }
  {
    const { app, plugin, v } = await setup(Plugin, {
      "Categories/Old.md": "![[Old.base]]", "Templates/Bases/Old.base": 'link("Old")',
      "a.md": note(`categories: "[[Old]], [[old|x]], [[Keep]]"\n`),
    }, { caseSensitive: false });
    app.fileManager.autoUpdateLinks = false;
    const ok = await plugin.renameCategory("Old", "New");
    const settled = await quiet();
    check("5d Rename im Mehrfachlink mit case-Dublette -> konvergiert ohne Old", ok && settled && J(fmOf(app, "a.md").categories) === J(["[[New|x]]", "[[Keep]]"]) && !exists(v, "Categories/Old.md"), { fm: fmOf(app, "a.md"), k: catFiles(v) });
  }
  {
    const { plugin, v } = await setup(Plugin, { "Categories/Old.md": "x", "a.md": note(`categories:\n  - "[[Old]]"\n`) });
    const r1 = await plugin.renameCategory("Old", "Bad#Name");
    const r2 = await plugin.renameCategory("Old", " / ");
    check("5e Rename auf ungültigen/leer-nach-Flatten Namen -> abgelehnt", r1 === false && r2 === false && exists(v, "Categories/Old.md") && state.writes.length === 0, { r1, r2, n: state.notices });
  }
  // ---------- 6 Check-Ordner nie im Papierkorb ----------
  for (const checks of [["Projects"], ["/"], ["Projects", "Notes"]]) {
    const { plugin, v } = await setup(Plugin, {
      "Categories/X.md": "x", "Templates/Bases/X.base": "b", "Categories/Sub/y.md": "x",
      "Projects/X.md": "project X", "Projects/Y.md": "project Y", "Projects/Z.md": "project Z",
      "Notes/x.md": "note", "Notes/Used.md": "u", "Categories/Used.md": "u",
      "a.md": note(`categories:\n  - "[[Used]]"\n`),
    }, { categoryCheckFolders: checks, caseSensitive: false });
    plugin.findOrphanCategories();
    const m = state.modals[state.modals.length - 1];
    const all = m && m.contentEl.findAll((e) => e.tag === "button" && /delete all/i.test(e.text))[0];
    if (all) await all.onclick();
    // plus direct deletes of names that only exist in check folders
    await plugin.deleteCategory("Z");
    await plugin.deleteCategory("Y");
    const bad = state.trashed.filter((p) => !p.startsWith("Categories/") && !p.startsWith("Templates/Bases/"));
    check(`6 Check-Ordner ${J(checks)}: nichts außerhalb Categories/ bzw. Bases im Papierkorb`, bad.length === 0 && state.deleted.length === 0 && exists(v, "Projects/X.md") && exists(v, "Projects/Y.md") && exists(v, "Projects/Z.md") && exists(v, "Notes/x.md"), { trashed: state.trashed });
    check(`6 Check-Ordner ${J(checks)}: Orphans im Kategorienordner gelöscht`, state.trashed.includes("Categories/X.md") && state.trashed.includes("Categories/Sub/y.md") && !state.trashed.includes("Categories/Used.md"), state.trashed);
  }
  {
    const { plugin, v } = await setup(Plugin, {
      "Notes/Categories/Orphan.md": "x", "Notes/Project.md": "p", "Notes/Sub/Other.md": "o",
      "a.md": note(`categories:\n  - "[[Used]]"\n`),
    }, { categoriesFolder: "Notes/Categories", categoryCheckFolders: ["Notes"] });
    plugin.findOrphanCategories();
    const m = state.modals[state.modals.length - 1];
    const items = m ? m.contentEl.findAll((e) => e.tag === "span").map((e) => e.text) : [];
    const del = m && m.contentEl.findAll((e) => e.tag === "button" && e.text === "Delete");
    for (const b of del || []) await b.onclick();
    check("6b Check-Ordner ist Elternordner des Kategorienordners: nur Notes/Categories/* gelöscht", J(items) === J(["Orphan"]) && J(state.trashed) === J(["Notes/Categories/Orphan.md"]) && exists(v, "Notes/Project.md"), { items, trashed: state.trashed });
  }
  {
    // orphan file vanished meanwhile; a check-folder note with the same (case-insensitive) name exists
    const { plugin, v } = await setup(Plugin, { "Categories/Gone.md": "x", "Projects/gone.md": "keep me" }, { categoryCheckFolders: ["Projects"], caseSensitive: false });
    plugin.findOrphanCategories();
    v.entries.delete("Categories/Gone.md");
    const m = state.modals[state.modals.length - 1];
    const b = m.contentEl.findAll((e) => e.tag === "button" && e.text === "Delete")[0];
    await b.onclick();
    check("6c verschwundener Orphan + gleichnamige Check-Ordner-Notiz: Notiz bleibt", exists(v, "Projects/gone.md") && !state.trashed.includes("Projects/gone.md"), state.trashed);
  }
  // ---------- 7 Gleichzeitige Events ----------
  {
    const files = {};
    for (let i = 0; i < 30; i++) files[`n${i}.md`] = note(i % 3 === 0 ? `categories: Shared\n` : i % 3 === 1 ? `categories:\n  - "[[Shared]]"\n  - "[[Other|o]]"\n` : `categories: "[[Shared]], Third"\n`);
    const { plugin, v, app } = await setup(Plugin, files);
    for (const p of Object.keys(files)) app.metadataCache._changedLater(v.getAbstractFileByPath(p));
    const sync = plugin.syncAllCategories();
    const direct = Promise.all(Object.keys(files).slice(0, 10).map((p) => plugin.processFile(v.getAbstractFileByPath(p))));
    await Promise.all([sync, direct]);
    const settled = await quiet(4000);
    const maxW = Math.max(...Object.keys(files).map(writesOf));
    check("7a 30 Notizen: Events + Sync + processFile parallel -> keine Fehler, konvergiert", settled && errors().length === 0, { settled, e: errors().slice(0, 3) });
    check("7a jede Kategorie genau einmal angelegt", J(catFiles(v).sort()) === J(["Categories/Other.md", "Categories/Shared.md", "Categories/Third.md"]), catFiles(v));
    check("7a jede Notiz höchstens 2x geschrieben (parallel stale) und am Ende normalisiert", maxW <= 2 && Object.keys(files).every((p) => (fmOf(app, p).categories || []).every((c) => /^\[\[[^\]]+\]\]$/.test(c))), { maxW });
  }
  {
    const { plugin, v, app } = await setup(Plugin, { "a.md": note(`categories:\n  - Foo\n`) }, { debounceDelay: 30 });
    const f = v.getAbstractFileByPath("a.md");
    let calls = 0; const orig = plugin.processFile.bind(plugin); plugin.processFile = (x) => { if (x.path === "a.md") calls++; return orig(x); };
    for (let i = 0; i < 20; i++) { app.metadataCache._changedLater(f); await tick(1); }
    await quiet();
    check("7b 20 Events in Debounce-Fenster -> processFile 1x (+1 nach eigenem Schreiben)", calls <= 2 && writesOf("a.md") === 1, { calls, w: writesOf("a.md") });
  }
  {
    const { plugin, v, app } = await setup(Plugin, { "a.md": note(`categories:\n  - Books\n`) }, { debounceDelay: 5000 });
    v.entries.get("a.md").content = note(`categories:\n  - Books\n  - Fiction\n`); // cache stale
    const f = v.getAbstractFileByPath("a.md");
    const [r1, r2] = await Promise.all([plugin.processFile(f), plugin.processFile(f)]);
    const c = v.content("a.md");
    check("7c zweimal processFile parallel auf veraltetem Cache -> kein Verlust, keine Dublette", r1 && r2 && (c.match(/\[\[Books\]\]/g) || []).length === 1 && (c.match(/\[\[Fiction\]\]/g) || []).length === 1, c);
  }
  {
    const { plugin, v, app } = await setup(Plugin, { "a.md": note(`categories:\n  - Foo\n`) }, { debounceDelay: 50 });
    app.metadataCache._changedLater(v.getAbstractFileByPath("a.md"));
    await tick(10);
    plugin.onunload();
    await tick(200);
    check("7d onunload verwirft ausstehende Debounce-Timer", state.writes.length === 0 && catFiles(v).length === 0, state.writes);
  }
  {
    // Race: debounced event for a note still referencing Old fires while rename is running
    const { app, plugin, v } = await setup(Plugin, {
      "Categories/Old.md": "![[Old.base]]", "Templates/Bases/Old.base": 'link("Old")',
      "a.md": note(`categories:\n  - "[[Old]]"\n`), "b.md": note(`categories:\n  - "[[Old]]"\n`),
    }, { debounceDelay: 3 });
    app.fileManager.autoUpdateLinks = false;
    app.metadataCache._changedLater(v.getAbstractFileByPath("b.md"));
    const ok = await plugin.renameCategory("Old", "New");
    await quiet();
    info("7e Rename während ausstehendem Event (b.md mit [[Old]])", { ok, cats: catFiles(v), bases: keys(v).filter((k) => k.endsWith(".base")), b: fmOf(app, "b.md").categories });
    check("7e Rename-Race: Old nicht neu angelegt", ok && !exists(v, "Categories/Old.md") && !exists(v, "Templates/Bases/Old.base"), { cats: catFiles(v) });
  }
  {
    // Rename and sync at the same time
    const { app, plugin, v } = await setup(Plugin, {
      "Categories/Old.md": "![[Old.base]]", "Templates/Bases/Old.base": 'link("Old")',
      "a.md": note(`categories:\n  - "[[Old]]"\n  - Plain\n`), "b.md": note(`categories: Old\n`),
    });
    const [ok] = await Promise.all([plugin.renameCategory("Old", "New"), plugin.syncAllCategories()]);
    await quiet();
    info("7f Rename + Sync parallel", { ok, cats: catFiles(v), a: fmOf(app, "a.md").categories, b: fmOf(app, "b.md").categories, e: errors() });
    check("7f Rename + Sync parallel: Notizen zeigen auf New, keine Fehler", ok && errors().length === 0 && !J(fmOf(app, "a.md").categories).includes("Old") && !J(fmOf(app, "b.md").categories).includes("Old"), { a: fmOf(app, "a.md").categories, b: fmOf(app, "b.md").categories, cats: catFiles(v) });
  }
  // ---------- 8 Sonstiges ----------
  for (const sep of ["/", " / ", ":", "#", "]]"]) {
    const r = await viaEvent({ "a.md": note(`categories:\n  - Travel/Europe\n`) }, "a.md", { nestedSeparator: sep });
    check(`8a Separator ${J(sep)}: konvergiert (<=1 Schreibvorgang)`, r.settled && r.writes <= 1, { w: r.writes, cats: r.cats, k: catFiles(r.v) });
  }
  {
    const r = await viaEvent({ "a.md": note(`categories:\n  - Foo\n`), "Categories/x.md": note(`categories:\n  - Inner\n`) }, "Categories/x.md");
    check("8b Notiz im Kategorienordner wird nie verarbeitet", r.writes === 0 && !exists(r.v, "Categories/Inner.md"));
  }
  {
    const r = await viaEvent({ "a.md": note(`categories: 2024\n`) }, "a.md");
    info("8c numerischer Wert", r.cats);
    const r2 = await viaEvent({ "a.md": note(`categories: true\n`) }, "a.md");
    info("8c boolescher Wert", { cats: r2.cats, k: catFiles(r2.v) });
  }
  {
    const { plugin, v } = await setup(Plugin, { "a.md": note(`categories:\n  - "[[A]]"\n`) }, { basesFolder: "Deep/Er/Bases", categoriesFolder: "X/Y/Cats" });
    await Promise.all([plugin.ensureCategoryExists("A"), plugin.ensureCategoryExists("B"), plugin.ensureCategoryExists("A")]);
    check("8d tiefe neue Ordner parallel angelegt, keine Fehler", exists(v, "X/Y/Cats/A.md") && exists(v, "Deep/Er/Bases/B.base") && errors().length === 0, { k: keys(v), e: errors() });
  }

});
