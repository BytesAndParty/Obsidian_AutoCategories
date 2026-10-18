# AutoCategories Plugin

## Test Vault
/Users/robert.stickler/Library/CloudStorage/OneDrive-Personal/Dokumente/Obsidian/Obsidian-Full-Vault

## Projektstruktur

```
AutoCategories/
├── CLAUDE.md                 # Dieses Dokument
├── ideas.md                  # Zukünftige Feature-Ideen
├── src/
│   └── main.ts               # Haupt-Plugin-Code (alle Klassen)
├── manifest.json             # Plugin-Metadaten (ID, Version, etc.)
├── package.json              # Dependencies und Build-Scripts
├── esbuild.config.mjs        # Build-Konfiguration
├── tsconfig.json             # TypeScript-Konfiguration
├── styles.css                # UI-Styling für Modals
├── tests/                    # bun test: Obsidian-Mock (tests/mock), Testsuiten, Snapshots
├── bunfig.toml               # bun-test-Konfiguration (Preload des Obsidian-Mocks)
├── bun.lock                  # Lockfile (wird eingecheckt)
├── versions.json             # Versionskompatibilität
├── todo.md                   # Aktuelle TODOs
└── README.md                 # Plugin-Dokumentation
```

## Hauptklassen in main.ts

- **AutoCategoriesPlugin** - Haupt-Plugin-Klasse
- **CategoriesOverviewModal** - Modal für Kategorien-Übersicht
- **OrphanCategoriesModal** - Modal für verwaiste Kategorien
- **AutoCategoriesSettingTab** - Einstellungs-Tab

## Wie Kategorien funktionieren

- Kategorien werden im **Frontmatter** gespeichert: `categories: [["Kategorie"]]`
- Für jede Kategorie wird eine `.md` und `.base` Datei erstellt
- Standard-Ordner: `Categories/` (konfigurierbar)
- Base-Dateien in: `Templates/Bases/` (konfigurierbar)

## Build & Development

**WICHTIG: Niemals npm verwenden, immer bun!**

```bash
bun install
bun run dev    # Watch mode
bun run build  # Production build
bun run test   # Tests gegen src/main.ts (bun test)
bun run test:build  # Production build + Tests gegen main.js
```

## Plugin im Vault aktivieren

Das kompilierte `main.js` muss in den Vault kopiert werden:
```
<Vault>/.obsidian/plugins/auto-categories/
├── main.js
├── manifest.json
└── styles.css
```
