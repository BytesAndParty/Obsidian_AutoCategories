# Auto Categories

An Obsidian plugin that automatically creates category pages and base files when you add categories to your notes' frontmatter.

Inspired by [Steph Ango's Vault](https://stephango.com/vault) organization system.

## Features

- **Automatic Category Detection**: When you leave the `categories` field in frontmatter, the plugin automatically:
  - Converts plain text to wikilinks (`Urlaub` → `[[Urlaub]]`)
  - Creates a category page in your Categories folder
  - Creates a corresponding `.base` file for database views

- **Sync Commands**:
  - Sync all categories across your entire vault
  - Process only the current file

- **Categories Overview**: View all used and existing categories in a modal

- **Orphan Cleanup**: Find and delete categories that are no longer used

- **Nested Categories**: Support for hierarchical categories (e.g., `Travel/Europe` becomes `Travel - Europe`)

- **Customizable**:
  - Configure category and base folder locations
  - Custom base file template with `{{categoryName}}` placeholder
  - Adjustable nested category separator
  - Case sensitivity options
  - Notification preferences

## Installation

### From Community Plugins (Coming Soon)

1. Open Obsidian Settings
2. Go to Community Plugins and disable Safe Mode
3. Click Browse and search for "Auto Categories"
4. Install and enable the plugin

### Manual Installation

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/BytesAndParty/Obsidian_AutoCategories/releases)
2. Create a folder `your-vault/.obsidian/plugins/auto-categories/`
3. Copy `main.js` and `manifest.json` into this folder
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

2. Move your cursor out of the categories field
3. The plugin will automatically:
   - Convert to `[[Books]]` and `[[Fiction]]`
   - Create `Categories/Books.md` and `Categories/Fiction.md`
   - Create `Templates/Bases/Books.base` and `Templates/Bases/Fiction.base`

### Commands

Access via Command Palette (Cmd/Ctrl + P):

| Command | Description |
|---------|-------------|
| **Sync All Categories** | Process all notes in your vault |
| **Process Current File Categories** | Process only the active note |
| **Show Categories Overview** | View all categories in a modal |
| **Find Orphan Categories** | Find and delete unused categories |

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Categories folder | Where category pages are created | `Categories` |
| Bases folder | Where base files are created | `Templates/Bases` |
| Exclude folders | Folders to skip (comma-separated) | `Templates` |
| Sync on startup | Auto-sync when Obsidian opens | Off |
| Case sensitive | Treat `Book` and `book` as different | On |
| Show notifications | Display notices on category creation | On |
| Nested separator | Separator for nested categories | ` - ` |
| Base template | Custom template for .base files | (see below) |

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
```

## Development

```bash
# Install dependencies
bun install

# Build (development)
bun run dev

# Build (production)
bun run build

# Build and deploy to vault
bun run deploy
```

## Part of the BytesAndParty Plugin Suite

This plugin works great alongside other plugins from the same author:

- [Better Gitignore](https://github.com/BytesAndParty/BetterGitignore) - Beautiful .gitignore editor with templates
- [Command Overview](https://github.com/BytesAndParty/CommandOverview) - Quick command palette with shortcuts
- [Company Knowledge Hub](https://github.com/BytesAndParty/CompanyKnowledgeHub) - Publish notes to a shared knowledge base
- [Customer Tag](https://github.com/BytesAndParty/CustomerTag) - Organize notes by customer tags

## License

MIT License - see [LICENSE](LICENSE) for details.

## Support

- [Report Issues](https://github.com/BytesAndParty/Obsidian_AutoCategories/issues)
- [GitHub Repository](https://github.com/BytesAndParty/Obsidian_AutoCategories)
