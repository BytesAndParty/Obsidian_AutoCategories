# Company Knowledge Vault

A shared Obsidian vault for collaborative knowledge management.

> Based on [Steph Ango's Vault Template](https://stephango.com/vault) — optimized for team collaboration.

---

## Quick Start for New Contributors

### Prerequisites

1. **GitHub Account** — [Create one here](https://github.com/join) if you don't have one
2. **Git** — [Download & Install](https://git-scm.com/downloads)
3. **Obsidian** — [Download](https://obsidian.md/)

### Setup Steps

#### 1. Clone the Repository

```bash
# Via HTTPS
git clone https://github.com/YOUR-ORG/YOUR-REPO.git

# Or via SSH (recommended if you have SSH keys set up)
git clone git@github.com:YOUR-ORG/YOUR-REPO.git
```

#### 2. Open in Obsidian

1. Open Obsidian
2. Click "Open folder as vault"
3. Select the cloned folder
4. Trust the vault when prompted (to enable plugins)

#### 3. Configure Git Identity (First Time Only)

```bash
git config user.name "Your Name"
git config user.email "your.email@company.com"
```

---

## How This Vault Works

### Public vs Private

This vault separates **public** (shared) and **private** (personal) content:

| Folder | Content | Synced to GitHub |
|--------|---------|------------------|
| `Public/` | Shared team notes | Yes |
| `Notes/` | Personal notes | No |
| `Categories/` | Overview pages | No |
| Everything else | Personal | No |

**Only the `Public/` folder is synced to GitHub.**

### Publishing a Note

To share a note with the team, add these properties:

```yaml
---
publish: true
publication_date: 2026-01-09
---
```

Then run the **Sync Public** command (see below).

---

## Git Workflow

### Pulling Latest Changes

```bash
# Get latest changes from team
git pull origin main
```

### Pushing Your Changes

```bash
# Stage all changes in Public folder
git add Public/

# Commit with a message
git commit -m "Add meeting notes for Project X"

# Push to remote
git push origin main
```

### Using Obsidian Git Plugin

The vault includes the **Obsidian Git** plugin for easier syncing:

1. **Pull** — `Ctrl/Cmd + P` → "Obsidian Git: Pull"
2. **Commit & Push** — `Ctrl/Cmd + P` → "Obsidian Git: Commit and push"

---

## Automations (Vault Automation Plugin)

### Available Commands

Open Command Palette (`Cmd/Ctrl + P`) and search for:

| Command | What it does |
|---------|--------------|
| `Vault Automation: Sync Categories` | Creates missing category files automatically |
| `Vault Automation: Publish Current Note` | Copies current note to `Public/` (if eligible) |
| `Vault Automation: Sync All Public Notes` | Syncs all `publish: true` notes to `Public/` |

### Recommended Hotkeys

Set up in Settings → Hotkeys:

| Command | Hotkey |
|---------|--------|
| Sync Categories | `Cmd + Shift + C` |
| Publish Current Note | `Cmd + Shift + P` |
| Sync All Public | `Cmd + Shift + S` |

---

## Folder Structure

```
Vault/
├── Public/          # SHARED — Synced to GitHub
├── Notes/           # Personal notes (not synced)
├── Categories/      # Overview pages with Bases
├── References/      # External references (books, people)
├── Templates/       # Note templates
│   └── Bases/       # Base files for category views
├── Attachments/     # Images, PDFs
├── Clippings/       # Web articles
└── Daily/           # Daily notes
```

---

## Creating Content

### New Note

1. Press `Cmd/Ctrl + N`
2. Name your note
3. Press `Cmd/Ctrl + Shift + T` to insert a template

### New Category

1. Create a note in `Categories/` folder
2. Apply the `Category Template`
3. Run `Vault Automation: Sync Categories` to create the Base file

### Linking

Use double brackets to link to other notes:

```markdown
Discussed with [[Max Mustermann]] about [[Project Alpha]].
See also: [[Meetings]]
```

---

## Troubleshooting

### "Permission denied" when pushing

Your SSH key might not be set up:

```bash
# Generate SSH key (if you don't have one)
ssh-keygen -t ed25519 -C "your.email@company.com"

# Copy public key
cat ~/.ssh/id_ed25519.pub

# Add to GitHub: Settings → SSH and GPG keys → New SSH key
```

### Merge conflicts

If you get conflicts when pulling:

```bash
# See which files have conflicts
git status

# Open conflicting files, resolve manually, then:
git add .
git commit -m "Resolve merge conflicts"
```

### Plugins not working

1. Go to **Settings** → **Community Plugins**
2. Click "Turn on community plugins"
3. Enable the required plugins

---

## Required Plugins

These plugins should be enabled for full functionality:

- **Vault Automation** — Sync categories, publish notes
- **Obsidian Git** — Git integration
- **Calendar** — Calendar view for daily notes
- **Homepage** — Set a default homepage

---

## Questions?

- Check `Home.md` for vault overview
- Read `Embrace Chaos.md` for the philosophy
- See `Notes/Obsidian Plugin Development Guide.md` for plugin details

---

## License

Internal use only. Do not share outside the organization.
