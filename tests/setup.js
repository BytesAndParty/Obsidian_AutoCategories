// fallow-ignore-file unused-file
// Preload (bunfig.toml, which fallow does not read): serve tests/mock/obsidian.js as the "obsidian" module, for ESM imports
// of src/main.ts as well as require("obsidian") in the built main.js
import { plugin } from "bun";
import * as obsidian from "./mock/obsidian.js";

plugin({
  name: "obsidian-mock",
  setup(build) {
    build.module("obsidian", () => ({ exports: obsidian, loader: "object" }));
  },
});
