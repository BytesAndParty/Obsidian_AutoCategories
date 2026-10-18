// One endless-loop scenario, run in its own process by loop.test.js (a looping plugin would keep
// its timers running and disturb other tests). Prints the result as JSON.
// usage: bun --preload ./tests/setup.js tests/loop-case.js <case>
import { loadPlugin, setup, fmOf, catFiles, writesOf, tick } from "./helpers.js";

export const LOOP_CASES = {
  textprop: `categories: "[[A]], [[B]]"\n`,
  bracket: `categories:\n  - "Foo]"\n`,
  heading: `categories:\n  - "[[Foo#Sec]]"\n`,
  books: `categories:\n  - Books\n`,
  aliasbracket: `categories:\n  - "[[Foo|a]b]]"\n`,
  nested: `categories:\n  - "[[[[A]]]]"\n`,
  hash: `categories:\n  - "C#"\n`,
  caret: `categories:\n  - "x^y"\n`,
  unfinished: `categories:\n  - "[[Foo"\n`,
  mixed: `categories:\n  - "[[A]] B, [[C|c]]"\n  - "D]]"\n  - "[[E#x]]"\n`,
  pipe: `categories:\n  - "a|b"\n`,
  unfinishedmix: `categories:\n  - Bar\n  - "[[Baz"\n  - "[[]]"\n`,
  pathlink: `categories:\n  - "[[Categories/Sub/Foo]]"\n  - "[[Categories/Bar]]"\n  - Plain\n`,
};

if (import.meta.main) {
  const name = process.argv[2];
  const Plugin = await loadPlugin();
  console.error = console.warn = () => {};
  const { app } = await setup(Plugin, { "a.md": `---\n${LOOP_CASES[name]}---\nbody\n` });
  app.metadataCache._changedLater(app.vault.getAbstractFileByPath("a.md"));
  await tick(800);
  const cats = catFiles(app.vault);
  console.log(JSON.stringify({ name, writes: writesOf("a.md"), cats, fm: fmOf(app, "a.md")?.categories }));
  process.exit(0);
}
