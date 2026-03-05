import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const pluginId = "auto-categories";
const vaultPath = process.env.OBSIDIAN_VAULT_PATH;

if (!vaultPath) {
  console.error(
    "Missing OBSIDIAN_VAULT_PATH. Example: OBSIDIAN_VAULT_PATH=/path/to/vault bun run deploy"
  );
  process.exit(1);
}

const targetDir = path.join(vaultPath, ".obsidian", "plugins", pluginId);
mkdirSync(targetDir, { recursive: true });

for (const fileName of ["main.js", "manifest.json", "styles.css"]) {
  if (!existsSync(fileName)) continue;
  copyFileSync(fileName, path.join(targetDir, fileName));
}

console.log(`Deployed ${pluginId} to ${targetDir}`);
