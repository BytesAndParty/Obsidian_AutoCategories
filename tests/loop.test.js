// No endless write loop (processFrontMatter -> 'changed' -> processFile): each case in its own process
import { describe, test } from "bun:test";
import path from "node:path";
import { LOOP_CASES } from "./loop-case.js";

const root = path.resolve(import.meta.dir, "..");

describe("loop", () => {
  for (const name of Object.keys(LOOP_CASES)) {
    test(`${name}: at most one write, no file with [ ] # ^ |`, () => {
      const proc = Bun.spawnSync([process.execPath, "--preload", "./tests/setup.js", "tests/loop-case.js", name], {
        cwd: root,
        env: process.env,
        timeout: 20000,
      });
      const output = proc.stdout.toString().trim();
      if (proc.exitCode !== 0 || !output) throw new Error(`case ${name} failed: ${proc.stderr.toString()}`);
      const r = JSON.parse(output.split("\n").pop());
      const ok = r.writes <= 1 && r.cats.length <= 6 && !r.cats.some((k) => /[[\]#^|]/.test(k));
      if (!ok) throw new Error(JSON.stringify(r));
    });
  }
});
