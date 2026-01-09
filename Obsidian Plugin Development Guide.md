---
categories:
  - "[[Evergreen]]"
tags:
  - development
  - obsidian
  - plugin
created: 2026-01-09
---

# Obsidian Plugin Development Guide

Anleitung zum Erstellen eines eigenen Obsidian Plugins fur Vault-Automationen.

---

## Projektstruktur

```
obsidian-vault-automation/
├── src/
│   ├── main.ts              # Plugin Entry Point
│   ├── commands/
│   │   ├── syncCategories.ts
│   │   ├── syncPublic.ts
│   │   └── publishNote.ts
│   └── utils/
│       └── frontmatter.ts
├── manifest.json            # Plugin Manifest
├── package.json
├── tsconfig.json
├── esbuild.config.mjs       # Build Script
└── README.md
```

---

## Setup

### 1. Projekt erstellen

```bash
mkdir obsidian-vault-automation
cd obsidian-vault-automation
npm init -y
```

### 2. Dependencies installieren

```bash
npm install --save-dev \
  typescript \
  @types/node \
  obsidian \
  esbuild \
  builtin-modules
```

### 3. TypeScript Config (`tsconfig.json`)

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "inlineSourceMap": true,
    "inlineSources": true,
    "module": "ESNext",
    "target": "ES6",
    "allowJs": true,
    "noImplicitAny": true,
    "moduleResolution": "node",
    "importHelpers": true,
    "isolatedModules": true,
    "strictNullChecks": true,
    "lib": ["DOM", "ES5", "ES6", "ES7"]
  },
  "include": ["src/**/*.ts"]
}
```

### 4. Plugin Manifest (`manifest.json`)

```json
{
  "id": "vault-automation",
  "name": "Vault Automation",
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "description": "Automate vault operations: sync categories, publish notes",
  "author": "Your Name",
  "authorUrl": "https://github.com/yourusername",
  "isDesktopOnly": false
}
```

### 5. Build Script (`esbuild.config.mjs`)

```javascript
import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
}).catch(() => process.exit(1));
```

### 6. Package Scripts (`package.json`)

```json
{
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "node esbuild.config.mjs production"
  }
}
```

---

## Plugin Code

### Main Entry (`src/main.ts`)

```typescript
import { Plugin, Notice, TFile, TFolder } from "obsidian";

export default class VaultAutomationPlugin extends Plugin {
  async onload() {
    console.log("Loading Vault Automation Plugin");

    // Command: Sync Categories
    this.addCommand({
      id: "sync-categories",
      name: "Sync Categories",
      callback: () => this.syncCategories(),
    });

    // Command: Publish Current Note
    this.addCommand({
      id: "publish-note",
      name: "Publish Current Note",
      callback: () => this.publishCurrentNote(),
    });

    // Command: Sync All Public
    this.addCommand({
      id: "sync-public",
      name: "Sync All Public Notes",
      callback: () => this.syncPublic(),
    });
  }

  onunload() {
    console.log("Unloading Vault Automation Plugin");
  }

  // =====================
  // SYNC CATEGORIES
  // =====================
  async syncCategories() {
    const vault = this.app.vault;
    const usedCategories = new Set<string>();

    // Collect all categories from notes
    const allFiles = vault.getMarkdownFiles();

    for (const file of allFiles) {
      if (file.path.startsWith("Categories/")) continue;
      if (file.path.startsWith("Templates/")) continue;

      const metadata = this.app.metadataCache.getFileCache(file);
      const frontmatter = metadata?.frontmatter;

      if (!frontmatter?.categories) continue;

      let categories = frontmatter.categories;
      if (!Array.isArray(categories)) {
        categories = [categories];
      }

      for (const cat of categories) {
        const match = String(cat).match(/\[\[([^\]]+)\]\]/);
        if (match) {
          usedCategories.add(match[1]);
        } else if (typeof cat === "string" && cat.trim()) {
          usedCategories.add(cat.trim());
        }
      }
    }

    let createdCategories = 0;
    let createdBases = 0;

    for (const categoryName of usedCategories) {
      const categoryPath = `Categories/${categoryName}.md`;
      const basePath = `Templates/Bases/${categoryName}.base`;

      // Create category file if missing
      if (!vault.getAbstractFileByPath(categoryPath)) {
        const content = `---\ntags:\n  - categories\n---\n\n![[${categoryName}.base]]\n`;
        await vault.create(categoryPath, content);
        createdCategories++;
      }

      // Create base file if missing
      if (!vault.getAbstractFileByPath(basePath)) {
        const baseContent = this.generateBaseContent(categoryName);
        await vault.create(basePath, baseContent);
        createdBases++;
      }
    }

    new Notice(
      `Categories synced: ${createdCategories} categories, ${createdBases} bases created`
    );
  }

  generateBaseContent(categoryName: string): string {
    return `filters:
  and:
    - categories.contains(link("${categoryName}"))
    - '!file.name.contains("Template")'
properties:
  file.name:
    displayName: Name
  file.ctime:
    displayName: Created
  file.mtime:
    displayName: Modified
views:
  - type: table
    name: All
    order:
      - file.name
      - file.mtime
    sort:
      - property: file.mtime
        direction: DESC
  - type: cards
    name: Grid
    coverProperty: cover
    order:
      - file.name
    sort:
      - property: file.mtime
        direction: DESC
`;
  }

  // =====================
  // PUBLISH CURRENT NOTE
  // =====================
  async publishCurrentNote() {
    const currentFile = this.app.workspace.getActiveFile();

    if (!currentFile) {
      new Notice("No active file found");
      return;
    }

    const metadata = this.app.metadataCache.getFileCache(currentFile);
    const frontmatter = metadata?.frontmatter;

    if (!frontmatter) {
      new Notice("No frontmatter found in this note");
      return;
    }

    const isPublish = frontmatter.publish === true;
    const hasPublicationDate =
      frontmatter.publication_date !== undefined &&
      frontmatter.publication_date !== null &&
      frontmatter.publication_date !== "";

    if (!isPublish) {
      new Notice("Note not marked for publishing (publish: true missing)");
      return;
    }

    if (!hasPublicationDate) {
      new Notice("Publication date missing (publication_date required)");
      return;
    }

    if (currentFile.path.startsWith("Public/")) {
      new Notice("Note is already in Public folder");
      return;
    }

    const publicPath = `Public/${currentFile.name}`;
    const existingFile = this.app.vault.getAbstractFileByPath(publicPath);

    if (existingFile && existingFile instanceof TFile) {
      const content = await this.app.vault.read(currentFile);
      await this.app.vault.modify(existingFile, content);
      new Notice(`Updated: ${currentFile.name} in Public/`);
    } else {
      await this.app.vault.copy(currentFile, publicPath);
      new Notice(`Published: ${currentFile.name} to Public/`);
    }
  }

  // =====================
  // SYNC ALL PUBLIC
  // =====================
  async syncPublic() {
    const vault = this.app.vault;
    let published = 0;
    let updated = 0;
    let removed = 0;

    const shouldBePublic = new Set<string>();
    const allFiles = vault.getMarkdownFiles();

    // Process each file
    for (const file of allFiles) {
      if (file.path.startsWith("Public/")) continue;
      if (file.path.startsWith("Templates/")) continue;

      const metadata = this.app.metadataCache.getFileCache(file);
      const frontmatter = metadata?.frontmatter;

      if (!frontmatter) continue;

      const isPublish = frontmatter.publish === true;
      const hasPublicationDate =
        frontmatter.publication_date !== undefined &&
        frontmatter.publication_date !== null &&
        frontmatter.publication_date !== "";

      if (isPublish && hasPublicationDate) {
        shouldBePublic.add(file.name);
        const publicPath = `Public/${file.name}`;
        const existingFile = vault.getAbstractFileByPath(publicPath);
        const content = await vault.read(file);

        if (existingFile && existingFile instanceof TFile) {
          const existingContent = await vault.read(existingFile);
          if (existingContent !== content) {
            await vault.modify(existingFile, content);
            updated++;
          }
        } else {
          await vault.copy(file, publicPath);
          published++;
        }
      }
    }

    // Remove files that shouldn't be public anymore
    const publicFolder = vault.getAbstractFileByPath("Public");
    if (publicFolder && publicFolder instanceof TFolder) {
      for (const file of publicFolder.children) {
        if (
          file instanceof TFile &&
          file.extension === "md" &&
          !shouldBePublic.has(file.name)
        ) {
          await vault.delete(file);
          removed++;
        }
      }
    }

    new Notice(
      `Sync complete: ${published} published, ${updated} updated, ${removed} removed`
    );
  }
}
```

---

## Development Workflow

### 1. Build entwickeln

```bash
npm run dev
```

### 2. Plugin testen

1. Kopiere `main.js` und `manifest.json` nach:
   ```
   YOUR_VAULT/.obsidian/plugins/vault-automation/
   ```
2. Obsidian: Settings → Community Plugins → Reload
3. Aktiviere "Vault Automation"

### 3. Hotlink fur Entwicklung (optional)

```bash
# Symlink erstellen fur schnelleres Testen
ln -s /path/to/obsidian-vault-automation/main.js \
      /path/to/vault/.obsidian/plugins/vault-automation/main.js
```

---

## Commands nach Installation

Nach der Installation erscheinen im Command Palette (`Cmd + P`):

| Command | Beschreibung |
|---------|--------------|
| `Vault Automation: Sync Categories` | Erstellt fehlende Categories + Bases |
| `Vault Automation: Publish Current Note` | Kopiert aktuelle Note zu Public/ |
| `Vault Automation: Sync All Public Notes` | Synchronisiert alle publishable Notes |

---

## Hotkeys einrichten

1. Settings → Hotkeys
2. Suche nach "Vault Automation"
3. Empfohlene Hotkeys:
   - Sync Categories: `Cmd + Shift + C`
   - Publish Note: `Cmd + Shift + P`
   - Sync Public: `Cmd + Shift + S`

---

## Erweiterungsmoglichkeiten

- **Settings Tab**: Konfigurierbare Ordnerpfade
- **Ribbon Icon**: Button in der Sidebar
- **Auto-Sync**: Automatisches Sync bei File-Save
- **Status Bar**: Anzeige der Public-Note-Anzahl
