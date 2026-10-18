// The note in the active editor is processed when the user leaves it; other notes after the debounce delay
import { loadPlugin, runChecks, setup, quiet, note, fmOf, exists, catFiles, errors, writesOf, state, tick } from "./helpers.js";

const Plugin = await loadPlugin();
const J = JSON.stringify;

// Simulate typing in a note: new content + Obsidian's 'changed' event
function edit(app, path, fm) {
  app.vault.entries.get(path).content = note(fm);
  app.metadataCache._changedLater(app.vault.getAbstractFileByPath(path));
}

// Count processFile calls per path
function spy(plugin) {
  const calls = {};
  const original = plugin.processFile.bind(plugin);
  plugin.processFile = (file) => {
    calls[file.path] = (calls[file.path] || 0) + 1;
    return original(file);
  };
  return calls;
}

await runChecks("active note", async (check) => {
  {
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`x: 1\n`), "b.md": note(`x: 2\n`) });
    const a = v.getAbstractFileByPath("a.md");
    app.workspace.setActiveFile(a);
    edit(app, "a.md", `categories:\n  - B\n`);
    await tick(30);
    edit(app, "a.md", `categories:\n  - Bo\n`);
    await tick(30);
    edit(app, "a.md", `categories:\n  - Books\n`);
    await quiet(600);
    check("typing in the active note creates nothing", catFiles(v).length === 0 && writesOf("a.md") === 0, { k: catFiles(v), w: writesOf("a.md") });

    app.workspace.setActiveFile(v.getAbstractFileByPath("b.md"));
    const settled = await quiet();
    check("leaving the note processes it once with the final value", J(catFiles(v)) === J(["Categories/Books.md"]) && J(fmOf(app, "a.md").categories) === J(["[[Books]]"]) && writesOf("a.md") === 1, { k: catFiles(v), fm: fmOf(app, "a.md"), w: writesOf("a.md") });
    check("no write loop after leaving", settled && writesOf("a.md") === 1, writesOf("a.md"));

    // back to a: the plugin's own write must not be processed again into a new write
    app.workspace.setActiveFile(a);
    await quiet(300);
    app.workspace.setActiveFile(v.getAbstractFileByPath("b.md"));
    await quiet();
    check("switching back and forth does not write again", writesOf("a.md") === 1 && errors().length === 0, { w: writesOf("a.md"), e: errors() });
  }
  {
    // Background notes keep the debounce
    const { app, v } = await setup(Plugin, { "a.md": note(`x: 1\n`), "b.md": note(`categories:\n  - Bg\n`) });
    app.workspace.setActiveFile(v.getAbstractFileByPath("a.md"));
    app.metadataCache._changedLater(v.getAbstractFileByPath("b.md"));
    await quiet();
    check("background note is processed after the debounce delay", exists(v, "Categories/Bg.md") && J(fmOf(app, "b.md").categories) === J(["[[Bg]]"]), catFiles(v));
  }
  {
    // Closing the note (no active file) and opening the same note again
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`x: 1\n`) });
    const calls = spy(plugin);
    const a = v.getAbstractFileByPath("a.md");
    app.workspace.setActiveFile(a);
    edit(app, "a.md", `categories:\n  - Closed\n`);
    await tick(50);
    app.workspace.setActiveFile(a); // file-open for the same note (e.g. reopened in the same tab)
    await tick(50);
    check("re-opening the same note does not process it", !calls["a.md"] && catFiles(v).length === 0, calls);
    app.workspace.setActiveFile(null);
    await quiet();
    check("closing the note processes it", exists(v, "Categories/Closed.md"), catFiles(v));
  }
  {
    // Closing the tab while getActiveFile() still returns the note (Obsidian: "most recently active file")
    const { app, v } = await setup(Plugin, { "a.md": note(`x: 1\n`) });
    const a = v.getAbstractFileByPath("a.md");
    app.workspace.setActiveFile(a);
    edit(app, "a.md", `categories:\n  - Tab\n`);
    await tick(50);
    app.workspace.closeFile(a);
    await quiet();
    check("closing the tab processes the note although getActiveFile() still returns it", exists(v, "Categories/Tab.md") && app.workspace.getActiveFile() === a, catFiles(v));
    // A later change (e.g. sync) to the closed but "most recently active" note uses the debounce
    edit(app, "a.md", `categories:\n  - Tab\n  - Later\n`);
    await quiet();
    check("change to a closed, most recently active note is processed after the debounce", exists(v, "Categories/Later.md"), catFiles(v));
  }
  {
    // Focus moves to a sidebar (e.g. the properties view): getActiveFile() is still the note -> keep waiting
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`x: 1\n`) });
    const calls = spy(plugin);
    app.workspace.setActiveFile(v.getAbstractFileByPath("a.md"));
    edit(app, "a.md", `categories:\n  - Side\n`);
    await tick(50);
    app.workspace.trigger("active-leaf-change", null);
    app.workspace.trigger("layout-change");
    await quiet(300);
    check("sidebar focus / layout change keeps the note pending", !calls["a.md"] && !exists(v, "Categories/Side.md"), calls);
  }
  for (const [label, leave] of [
    ["plugin unload", (plugin) => plugin.onunload()],
    ["app quit", (plugin, app) => app.workspace.trigger("quit")],
  ]) {
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`x: 1\n`) });
    app.workspace.setActiveFile(v.getAbstractFileByPath("a.md"));
    edit(app, "a.md", `categories:\n  - Flushed\n`);
    await tick(50);
    leave(plugin, app);
    await quiet();
    check(`pending note is processed on ${label}`, exists(v, "Categories/Flushed.md") && J(fmOf(app, "a.md").categories) === J(["[[Flushed]]"]), catFiles(v));
  }
  {
    // Explicit command while the note is pending: processed once, nothing left pending
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`x: 1\n`), "b.md": note(`x: 2\n`) });
    const a = v.getAbstractFileByPath("a.md");
    app.workspace.setActiveFile(a);
    edit(app, "a.md", `categories:\n  - Cmd\n`);
    await tick(50);
    await plugin.processCurrentFile();
    await quiet();
    // The plugin's own write fires 'changed' while the note is still active; leaving it checks it again without writing
    app.workspace.setActiveFile(v.getAbstractFileByPath("b.md"));
    await quiet();
    check("'Process current file' processes the pending note right away, leaving it writes nothing more", exists(v, "Categories/Cmd.md") && writesOf("a.md") === 1 && state.notices.includes("Categories processed"), { w: writesOf("a.md"), n: state.notices });
  }
  {
    // Pending note renamed or deleted before it is left
    const { app, plugin, v } = await setup(Plugin, { "a.md": note(`x: 1\n`), "gone.md": note(`x: 1\n`) });
    const a = v.getAbstractFileByPath("a.md");
    app.workspace.setActiveFile(a);
    edit(app, "a.md", `categories:\n  - Renamed\n`);
    await tick(50);
    await app.vault.rename(a, "a2.md");
    app.workspace.setActiveFile(null);
    await quiet();
    check("renamed pending note is processed under its new path", exists(v, "Categories/Renamed.md") && J(fmOf(app, "a2.md").categories) === J(["[[Renamed]]"]), catFiles(v));

    const g = v.getAbstractFileByPath("gone.md");
    app.workspace.setActiveFile(g);
    edit(app, "gone.md", `categories:\n  - Gone\n`);
    await tick(50);
    v.entries.delete("gone.md");
    app.workspace.setActiveFile(null);
    await quiet();
    check("deleted pending note: no error, no category", errors().length === 0 && !exists(v, "Categories/Gone.md"), { e: errors(), k: catFiles(v) });
  }
  {
    // Switching directly from one edited note to another: each processed exactly once
    const { app, v } = await setup(Plugin, { "a.md": note(`x: 1\n`), "b.md": note(`x: 2\n`), "c.md": note(`x: 3\n`) });
    app.workspace.setActiveFile(v.getAbstractFileByPath("a.md"));
    edit(app, "a.md", `categories:\n  - One\n`);
    await tick(50);
    app.workspace.setActiveFile(v.getAbstractFileByPath("b.md"));
    edit(app, "b.md", `categories:\n  - Two\n`);
    await quiet(500);
    check("first note processed on switch, second still pending", exists(v, "Categories/One.md") && !exists(v, "Categories/Two.md"), catFiles(v));
    app.workspace.setActiveFile(v.getAbstractFileByPath("c.md"));
    await quiet();
    check("second note processed on the next switch, one write each", exists(v, "Categories/Two.md") && writesOf("a.md") === 1 && writesOf("b.md") === 1, { k: catFiles(v), a: writesOf("a.md"), b: writesOf("b.md") });
  }
});
