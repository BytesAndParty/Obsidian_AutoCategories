import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  TFolder,
} from "obsidian";

interface AutoCategoriesSettings {
  categoriesFolder: string;
  basesFolder: string;
}

const DEFAULT_SETTINGS: AutoCategoriesSettings = {
  categoriesFolder: "Categories",
  basesFolder: "Templates/Bases",
};

export default class AutoCategoriesPlugin extends Plugin {
  settings: AutoCategoriesSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    // Add settings tab
    this.addSettingTab(new AutoCategoriesSettingTab(this.app, this));

    // Command: Sync All Categories
    this.addCommand({
      id: "sync-all-categories",
      name: "Sync All Categories",
      callback: () => this.syncAllCategories(),
    });

    // Listen to file modifications
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.processFile(file);
        }
      })
    );

    // Also process on metadata cache change (for frontmatter updates)
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.processFile(file);
        }
      })
    );

    console.log("Auto Categories plugin loaded");
  }

  onunload() {
    console.log("Auto Categories plugin unloaded");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Process a single file: convert plain categories to links and create missing files
   */
  async processFile(file: TFile) {
    // Skip files in Categories or Templates folders
    if (
      file.path.startsWith(this.settings.categoriesFolder + "/") ||
      file.path.startsWith("Templates/")
    ) {
      return;
    }

    const metadata = this.app.metadataCache.getFileCache(file);
    const frontmatter = metadata?.frontmatter;

    if (!frontmatter?.categories) return;

    let categories = frontmatter.categories;
    if (!Array.isArray(categories)) {
      categories = [categories];
    }

    const extractedCategories: string[] = [];
    let needsUpdate = false;
    const newCategories: string[] = [];

    for (const cat of categories) {
      const catStr = String(cat);
      const match = catStr.match(/^\[\[([^\]]+)\]\]$/);

      if (match) {
        // Already a link
        extractedCategories.push(match[1]);
        newCategories.push(`"[[${match[1]}]]"`);
      } else if (catStr.trim()) {
        // Plain text - needs conversion
        const categoryName = catStr.trim();
        extractedCategories.push(categoryName);
        newCategories.push(`"[[${categoryName}]]"`);
        needsUpdate = true;
      }
    }

    // Update frontmatter if needed (convert plain text to links)
    if (needsUpdate) {
      await this.updateFrontmatterCategories(file, newCategories);
    }

    // Create category and base files for each category
    for (const categoryName of extractedCategories) {
      await this.ensureCategoryExists(categoryName);
    }
  }

  /**
   * Update the frontmatter categories to use wikilinks
   */
  async updateFrontmatterCategories(file: TFile, newCategories: string[]) {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");

    // Find frontmatter boundaries
    if (lines[0] !== "---") return;

    let frontmatterEnd = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "---") {
        frontmatterEnd = i;
        break;
      }
    }

    if (frontmatterEnd === -1) return;

    // Find and replace categories in frontmatter
    let inCategories = false;
    let categoriesStartLine = -1;
    let categoriesEndLine = -1;

    for (let i = 1; i < frontmatterEnd; i++) {
      const line = lines[i];

      if (line.match(/^categories:\s*$/)) {
        // Multi-line categories
        inCategories = true;
        categoriesStartLine = i;
      } else if (line.match(/^categories:\s*\[/)) {
        // Inline array categories
        categoriesStartLine = i;
        categoriesEndLine = i;
        break;
      } else if (inCategories) {
        if (line.match(/^\s+-\s/)) {
          categoriesEndLine = i;
        } else if (!line.match(/^\s*$/)) {
          // End of categories list
          break;
        }
      }
    }

    if (categoriesStartLine === -1) return;

    // Build new categories section
    const newCategoriesLines = ["categories:"];
    for (const cat of newCategories) {
      newCategoriesLines.push(`  - ${cat}`);
    }

    // Replace old categories with new
    const newLines = [
      ...lines.slice(0, categoriesStartLine),
      ...newCategoriesLines,
      ...lines.slice(categoriesEndLine + 1),
    ];

    await this.app.vault.modify(file, newLines.join("\n"));
  }

  /**
   * Ensure a category file and its base file exist
   */
  async ensureCategoryExists(categoryName: string) {
    const categoryPath = `${this.settings.categoriesFolder}/${categoryName}.md`;
    const basePath = `${this.settings.basesFolder}/${categoryName}.base`;

    // Ensure folders exist
    await this.ensureFolderExists(this.settings.categoriesFolder);
    await this.ensureFolderExists(this.settings.basesFolder);

    // Create category file if missing
    if (!this.app.vault.getAbstractFileByPath(categoryPath)) {
      const categoryContent = `---
tags:
  - categories
---

![[${categoryName}.base]]
`;
      await this.app.vault.create(categoryPath, categoryContent);
      new Notice(`Created category: ${categoryName}`);
    }

    // Create base file if missing
    if (!this.app.vault.getAbstractFileByPath(basePath)) {
      const baseContent = this.generateBaseContent(categoryName);
      await this.app.vault.create(basePath, baseContent);
    }
  }

  /**
   * Ensure a folder exists, creating it if necessary
   */
  async ensureFolderExists(folderPath: string) {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await this.app.vault.createFolder(folderPath);
    }
  }

  /**
   * Generate minimal base content for a category
   */
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
`;
  }

  /**
   * Sync all categories across the vault
   */
  async syncAllCategories() {
    const allFiles = this.app.vault.getMarkdownFiles();
    let processedCount = 0;
    const allCategories = new Set<string>();

    for (const file of allFiles) {
      // Skip files in Categories or Templates folders
      if (
        file.path.startsWith(this.settings.categoriesFolder + "/") ||
        file.path.startsWith("Templates/")
      ) {
        continue;
      }

      const metadata = this.app.metadataCache.getFileCache(file);
      const frontmatter = metadata?.frontmatter;

      if (!frontmatter?.categories) continue;

      let categories = frontmatter.categories;
      if (!Array.isArray(categories)) {
        categories = [categories];
      }

      for (const cat of categories) {
        const catStr = String(cat);
        const match = catStr.match(/\[\[([^\]]+)\]\]/);

        if (match) {
          allCategories.add(match[1]);
        } else if (catStr.trim()) {
          allCategories.add(catStr.trim());
        }
      }

      await this.processFile(file);
      processedCount++;
    }

    new Notice(
      `Synced ${allCategories.size} categories from ${processedCount} files`
    );
  }
}

class AutoCategoriesSettingTab extends PluginSettingTab {
  plugin: AutoCategoriesPlugin;

  constructor(app: App, plugin: AutoCategoriesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Categories folder")
      .setDesc("Folder where category pages are created")
      .addText((text) =>
        text
          .setPlaceholder("Categories")
          .setValue(this.plugin.settings.categoriesFolder)
          .onChange(async (value) => {
            this.plugin.settings.categoriesFolder = value || "Categories";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Bases folder")
      .setDesc("Folder where base files are created")
      .addText((text) =>
        text
          .setPlaceholder("Templates/Bases")
          .setValue(this.plugin.settings.basesFolder)
          .onChange(async (value) => {
            this.plugin.settings.basesFolder = value || "Templates/Bases";
            await this.plugin.saveSettings();
          })
      );
  }
}
