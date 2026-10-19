# Auto Categories

An Obsidian plugin that automatically creates category pages and base files when you add categories to your notes' frontmatter.

Inspired by [Steph Ango's Vault](https://stephango.com/vault) organization system.

## Features

- **Automatic Category Detection**: When the `categories` field in a note's frontmatter changes, the plugin automatically processes the note as soon as you leave it (open another note or close it; working in a sidebar such as the properties view, or in a tab without a note, still counts as editing). A note that is still being edited is also processed when the plugin is disabled and, as far as Obsidian allows, when Obsidian quits; otherwise the next **Sync all categories** catches it. Notes that change in the background (sync, other plugins) are processed after a short debounce delay. Processing:
  - Converts plain text to wikilinks (`Urlaub` → `[[Urlaub]]`)
  - Creates a category page in your Categories folder
  - Creates a corresponding `.base` file for database views

- **Sync Commands**:
  - Sync all categories across your entire vault
  - Process only the current file

- **Categories Overview**: View all used and existing categories in a modal. Right-click a category to rename it (category page, base file and all notes are updated)

- **Orphan Cleanup**: Find and delete categories that are no longer used. Only category pages in the categories folder (and its subfolders) are considered; files are moved to the trash according to your Obsidian settings

- **Nested Categories**: Support for hierarchical categories (e.g., `Travel/Europe` becomes `Travel - Europe`)

- **Customizable**:
  - Configure category and base folder locations
  - Custom base file template with `{{categoryName}}` placeholder
  - Adjustable nested category separator
  - Case sensitivity options for category names
  - Notification preferences

## Requirements

- Obsidian **1.9.0** or later
- The core plugin **Bases** must be enabled (Settings → Core plugins → Bases). The plugin creates `.base` files, and every category page embeds its base (`![[Category.base]]`); without Bases these views cannot be shown.

## Installation

### From Community Plugins (Coming Soon)

1. Open Obsidian Settings
2. Go to Community plugins and turn off Restricted mode
3. Click Browse and search for "Auto Categories"
4. Install and enable the plugin

### Manual Installation

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/BytesAndParty/Obsidian_AutoCategories/releases)
2. Create a folder `your-vault/.obsidian/plugins/auto-categories/`
3. Copy `main.js`, `manifest.json` and `styles.css` into this folder
4. Reload Obsidian and enable the plugin in Settings → Community Plugins

## Usage

### Basic Usage

1. Add a `categories` field to your note's frontmatter:

```yaml
---
categories:
  - Books
  - Fiction
---
```

2. Switch to another note (or close the note), or run **Process current file categories**
3. The plugin will automatically:
   - Convert to `[[Books]]` and `[[Fiction]]`
   - Create `Categories/Books.md` and `Categories/Fiction.md`
   - Create `Templates/Bases/Books.base` and `Templates/Bases/Fiction.base`

### Commands

Open the command palette and search for "Auto Categories":

| Command | Description |
|---------|-------------|
| **Sync all categories** | Process all notes in your vault |
| **Process current file categories** | Process only the active note |
| **Show categories overview** | View all categories in a modal |
| **Find orphan categories** | Find and delete unused categories |

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Categories folder | Where category pages are created (the vault root is not allowed and falls back to the default) | `Categories` |
| Bases folder | Where base files are created (the vault root is not allowed and falls back to the default) | `Templates/Bases` |
| Exclude folders | Folders to skip (comma-separated) | `Templates` |
| Additional category check folders | Extra folders searched for existing category pages (comma-separated) | (empty) |
| Sync on startup | Auto-sync when Obsidian opens | Off |
| Case sensitive | Treat `Book` and `book` as different categories (folder names are always compared case-insensitively) | On |
| Show notifications | Display notices on category creation | On |
| Nested category separator | Separator for nested categories | ` - ` |
| Debounce delay (ms) | Delay before a note that changed in the background is processed (the note you are editing is processed when you leave it) | `500` |
| Base template file path | Vault file used as template for .base files instead of the inline template | (empty) |
| Base file template (fallback) | Inline template for .base files | (see below) |

### Category Names

- Characters that are not allowed in file names or would break wikilinks (`\ : * ? " < > | # ^ [ ]`) are replaced with `-`
- An entry with several links (`"[[A]], [[B]]"`) is split into separate categories
- Heading links are reduced to the note: `[[Books#Fiction]]` becomes `[[Books]]`
- Links with a folder path (`[[Categories/Books]]`, `[[Categories/Media/Books]]`) are resolved to the existing category page in the categories folder or a check folder; the category is the name of that page and the link is kept as written. If no such page exists yet, the folder prefix is removed and the rest is treated as a nested category
- Unfinished links that are still being typed (`[[Boo`) are ignored and kept as written until they are complete. This also applies to links whose name contains `[` or `]` (e.g. `[[A[1]]]`): they are never read as a category, so fix them by hand

### Folders

- Folder settings (categories, bases, exclude and check folders) are compared **case-insensitively**: `templates` matches the folder `Templates/`, and `ärchiv` matches `ÄRCHIV/`. New pages are created in the existing folder, whatever its spelling in the settings. Duplicate entries that differ only in case are removed.
- **Exclude folders**: Notes in these folders are never processed. Renaming a category does not change the frontmatter of notes in excluded folders either (plain-text categories there keep the old name; wikilinks are only updated if Obsidian's *Automatically update internal links* is on).
- **Additional category check folders**: Only used to decide whether a category already exists, so no duplicate page is created in the categories folder. Notes in check folders are never listed as orphans, never deleted and never renamed by the plugin; deleting a category whose page lives in a check folder is refused (its base file is kept, too). To rename a category whose page lives in a check folder, rename that note yourself in Obsidian. The vault root (`/`) is ignored as a check folder.
- When the plugin rewrites the `categories` list, entries that are already correct wikilinks are kept exactly as written.

### Upgrading from earlier versions

Category names are sanitized more strictly than before. Check your categories after updating:

- `[`, `]`, `#` and `^` are now replaced with `-`, like other characters that are not allowed: `x^y` becomes `x-y`, a plain `C#` becomes `C-`.
- A link with `#` is read as a heading link: `[[C#]]` becomes `[[C]]` (use the plain text `C#` or rename the category if you meant the name "C#").
- The plugin rewrites the frontmatter of affected notes when they are processed (or run **Sync all categories**) and creates pages with the new names. The old pages (e.g. `Categories/x^y.md`) are no longer used: they show up in **Find orphan categories** and can be deleted there. Move your own content from an old page to the new one first.

### Default Base Template

```yaml
filters:
  and:
    - categories.contains(link("{{categoryName}}"))
    - '!file.name.contains("Template")'
properties:
  file.name:
    displayName: Name
  created:
    displayName: Created
  file.ctime:
    displayName: File Created
  file.mtime:
    displayName: Modified
  tags:
    displayName: Tags
views:
  - type: table
    name: All
    order:
      - file.name
      - created
      - file.mtime
      - tags
    sort:
      - property: file.mtime
        direction: DESC
  - type: cards
    name: Cards
    coverProperty: cover
    order:
      - file.name
      - created
    sort:
      - property: file.mtime
        direction: DESC
```

## Development

```bash
# Install dependencies
bun install

# Build (development)
bun run dev

# Typecheck + build (production)
bun run build

# Build and deploy to vault
bun run deploy

# Tests (against src/main.ts, with a mocked Obsidian API in tests/mock)
bun run test

# Production build + tests against the built main.js
bun run test:build
```

After an intended behaviour change, review and update the state snapshots with `bun test --update-snapshots`.

## Works Well with Other BytesAndParty Plugins

- [Command Overview](https://github.com/BytesAndParty/CommandOverview) - Keep category sync and orphan cleanup commands one shortcut away.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Support

- [Report Issues](https://github.com/BytesAndParty/Obsidian_AutoCategories/issues)
- [GitHub Repository](https://github.com/BytesAndParty/Obsidian_AutoCategories)
