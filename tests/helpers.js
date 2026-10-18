// Shared helpers for the AutoCategories tests
import { describe, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import * as obsidian from "./mock/obsidian.js";
import { state, App, tick } from "./mock/obsidian.js";

export { obsidian, state, App, tick };

/**
 * The plugin class under test: src/main.ts, or a built bundle via PLUGIN=main.js
 */
export async function loadPlugin() {
  if (process.env.PLUGIN) {
    const require = createRequire(import.meta.url);
    return require(path.resolve(process.env.PLUGIN)).default;
  }
  return (await import("../src/main.ts")).default;
}

export function reset() {
  for (const key of ["notices", "modals", "trashed", "deleted", "writes"]) state[key].length = 0;
  state.events = 0;
}

/**
 * Fresh vault with the given files and a loaded plugin (data = stored plugin settings)
 */
export async function setup(Plugin, files, settings = {}, data = null) {
  reset();
  const app = new App();
  for (const [p, c] of Object.entries(files)) app.vault.seed(p, c);
  const plugin = new Plugin(app, { id: "auto-categories" });
  plugin._data = data;
  await plugin.onload();
  Object.assign(plugin.settings, { debounceDelay: 5, showNotifications: true }, settings);
  return { app, plugin, v: app.vault };
}

/**
 * Wait until no file was written for `idle` ms; false if writes never stop (endless loop)
 */
export async function quiet(maxMs = 2000, idle = 120) {
  const start = Date.now();
  let last = state.writes.length;
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    await tick(10);
    if (state.writes.length !== last) {
      last = state.writes.length;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > idle) {
      return true;
    }
  }
  return false;
}

export const note = (fm, body = "Body\n") => `---\n${fm}---\n${body}`;
export const fmOf = (app, p) => app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(p))?.frontmatter;
export const exists = (v, p) => !!v.getAbstractFileByPath(p);
export const keys = (v) => [...v.entries.keys()];
export const catFiles = (v, folder = "Categories/") => keys(v).filter((k) => k.startsWith(folder) && k.endsWith(".md"));
export const errors = () => state.notices.filter((n) => /error/i.test(n));
export const writesOf = (p) => state.writes.filter((x) => x === p).length;
export const lastModal = () => state.modals[state.modals.length - 1];

/**
 * The scenarios share one mocked vault state and real timers, so they run sequentially at load time.
 * Each check becomes its own bun test; names in knownFailures are registered with test.failing
 * (documented open issues: the test turns red once the issue is fixed, so it can be moved back).
 */
export async function runChecks(suiteName, scenarios, knownFailures = []) {
  const results = [];
  // info is serialized right away: later scenarios reuse (and clear) the shared state arrays
  const check = (name, ok, info) => results.push({ name, ok: !!ok, info: ok ? undefined : JSON.stringify(info) });
  // Expected errors (simulated failures) are logged by the plugin; keep the test output readable
  const { error, warn } = console;
  console.error = console.warn = () => {};
  try {
    await scenarios(check);
  } finally {
    Object.assign(console, { error, warn });
  }
  describe(suiteName, () => {
    for (const r of results) {
      const register = knownFailures.some((k) => r.name.startsWith(k)) ? test.failing : test;
      register(r.name, () => {
        if (!r.ok) throw new Error(`${r.name}\n  -> ${r.info}`);
      });
    }
  });
}
