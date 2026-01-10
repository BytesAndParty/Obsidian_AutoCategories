import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  TFolder,
  MarkdownView,
  Modal,
} from "obsidian";

interface AutoCategoriesSettings {
  categoriesFolder: string;
  basesFolder: string;
  excludeFolders: string[];
  showNotifications: boolean;
  caseSensitive: boolean;
  syncOnStartup: boolean;
  nestedSeparator: string;
  baseTemplate: string;
}

const DEFAULT_BASE_TEMPLATE = `filters:
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
        direction: DESC`;

const DEFAULT_SETTINGS: AutoCategoriesSettings = {
  categoriesFolder: "Categories",
  basesFolder: "Templates/Bases",
  excludeFolders: ["Templates"],
  showNotifications: true,
  caseSensitive: true,
  syncOnStartup: false,
  nestedSeparator: " - ",
  baseTemplate: DEFAULT_BASE_TEMPLATE,
};

// Characters not allowed in file names
const INVALID_CHARS = /[\\:*?"<>|]/g;

export default class AutoCategoriesPlugin extends Plugin {
  settings: AutoCategoriesSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    // Add settings tab
    this.addSettingTab(new AutoCategoriesSettingTab(this.app, this));

    // Add ribbon icon
    this.addRibbonIcon("folder-sync", "Sync All Categories", () =>
      this.syncAllCategories()
    );

    // Command: Sync All Categories
    this.addCommand({
      id: "sync-all-categories",
      name: "Sync All Categories",
      callback: () => this.syncAllCategories(),
    });

    // Command: Process Current File
    this.addCommand({
      id: "process-current-file",
      name: "Process Current File Categories",
      callback: () => this.processCurrentFile(),
    });

    // Command: Show Categories Overview
    this.addCommand({
      id: "show-categories-overview",
      name: "Show Categories Overview",
      callback: () => this.showCategoriesOverview(),
    });

    // Command: Find Orphan Categories
    this.addCommand({
      id: "find-orphan-categories",
      name: "Find Orphan Categories",
      callback: () => this.findOrphanCategories(),
    });

    // Process file when metadata changes (frontmatter is parsed)
    this.registerEvent(
      this.app.metadataCache.on('changed', (file: TFile) => {
        this.processFile(file);
      })
    );

    // Auto-sync on startup if enabled
    if (this.settings.syncOnStartup) {
      // Wait for vault to be fully loaded
      this.app.workspace.onLayoutReady(() => {
        this.syncAllCategories();
      });
    }

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
   * Show a notice if notifications are enabled
   */
  private notify(message: string) {
    if (this.settings.showNotifications) {
      new Notice(message);
    }
  }

  /**
   * Check if a file should be excluded from processing
   */
  private shouldExcludeFile(file: TFile): boolean {
    if (file.path.startsWith(this.settings.categoriesFolder + "/")) {
      return true;
    }

    for (const folder of this.settings.excludeFolders) {
      if (folder && file.path.startsWith(folder + "/")) {
        return true;
      }
    }

    return false;
  }

  /**
   * Convert nested category path to flat name with separator
   * e.g., "Travel/Europe/Germany" -> "Travel - Europe - Germany"
   */
  private flattenCategoryName(name: string): string {
    if (!name.includes("/")) {
      return name;
    }
    return name.split("/").map(s => s.trim()).join(this.settings.nestedSeparator);
  }

  /**
   * Validate and sanitize a category name
   */
  private validateCategoryName(name: string): {
    valid: boolean;
    sanitized: string;
    error?: string;
  } {
    // First flatten nested paths
    let processed = this.flattenCategoryName(name);
    const trimmed = processed.trim();

    if (!trimmed) {
      return { valid: false, sanitized: "", error: "Category name is empty" };
    }

    if (INVALID_CHARS.test(trimmed)) {
      const sanitized = trimmed.replace(INVALID_CHARS, "-");
      return {
        valid: false,
        sanitized,
        error: `Invalid characters in "${trimmed}", sanitized to "${sanitized}"`,
      };
    }

    return { valid: true, sanitized: trimmed };
  }

  /**
   * Remove duplicates from categories array
   */
  private deduplicateCategories(categories: string[]): string[] {
    const seen = new Map<string, string>();

    for (const cat of categories) {
      const key = this.settings.caseSensitive ? cat : cat.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, cat);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Process the currently active file
   */
  async processCurrentFile() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView?.file) {
      new Notice("No active file");
      return;
    }
    await this.processFile(activeView.file);
    this.notify("Categories processed");
  }

  /**
   * Process a single file
   */
  async processFile(file: TFile) {
    try {
      if (this.shouldExcludeFile(file)) {
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
      const warnings: string[] = [];

      for (const cat of categories) {
        const catStr = String(cat);
        const match = catStr.match(/^\[\[([^\]]+)\]\]$/);

        let categoryName: string;

        if (match) {
          categoryName = match[1];
        } else if (catStr.trim()) {
          categoryName = catStr.trim();
          needsUpdate = true;
        } else {
          continue;
        }

        // Validate and potentially flatten category name
        const validation = this.validateCategoryName(categoryName);
        if (!validation.valid && validation.error) {
          warnings.push(validation.error);
        }

        categoryName = validation.sanitized;

        // Check if name changed due to flattening
        if (categoryName !== catStr.trim() && categoryName !== match?.[1]) {
          needsUpdate = true;
        }

        if (categoryName) {
          extractedCategories.push(categoryName);
        }
      }

      // Deduplicate categories
      const uniqueCategories = this.deduplicateCategories(extractedCategories);

      if (uniqueCategories.length !== extractedCategories.length) {
        needsUpdate = true;
      }

      // Show warnings
      for (const warning of warnings) {
        new Notice(warning);
      }

      // Update frontmatter if needed
      if (needsUpdate) {
        const uniqueNewCategories = uniqueCategories.map((c) => `"[[${c}]]"`);
        await this.updateFrontmatterCategories(file, uniqueNewCategories);
      }

      // Create category and base files
      for (const categoryName of uniqueCategories) {
        await this.ensureCategoryExists(categoryName);
      }
    } catch (error) {
      console.error("Auto Categories: Error processing file", error);
      new Notice(`Error processing ${file.name}: ${error}`);
    }
  }

  /**
   * Update the frontmatter categories to use wikilinks
   */
  async updateFrontmatterCategories(file: TFile, newCategories: string[]) {
    try {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");

      // Check for valid frontmatter start
      if (lines[0] !== "---") return;

      let frontmatterEnd = -1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === "---") {
          frontmatterEnd = i;
          break;
        }
      }

      if (frontmatterEnd === -1) return;

      let inCategories = false;
      let categoriesStartLine = -1;
      let categoriesEndLine = -1;
      let categoriesIndent = "";

      for (let i = 1; i < frontmatterEnd; i++) {
        const line = lines[i];

        // Match "categories:" with optional trailing content
        const categoriesMatch = line.match(/^(\s*)categories:\s*(.*)$/);

        if (categoriesMatch) {
          categoriesIndent = categoriesMatch[1];
          const trailingContent = categoriesMatch[2].trim();
          categoriesStartLine = i;

          // Handle inline array format: categories: [a, b, c]
          if (trailingContent.startsWith("[")) {
            categoriesEndLine = i;
            // Check if array spans multiple lines
            if (!trailingContent.endsWith("]")) {
              // Multi-line array - find the closing bracket
              for (let j = i + 1; j < frontmatterEnd; j++) {
                categoriesEndLine = j;
                if (lines[j].includes("]")) {
                  break;
                }
              }
            }
            break;
          }
          // Handle inline single value: categories: foo
          else if (trailingContent && !trailingContent.startsWith("-")) {
            categoriesEndLine = i;
            break;
          }
          // Start of list format
          else {
            inCategories = true;
            categoriesEndLine = i;
          }
        } else if (inCategories) {
          // Check if this is a list item (with proper indentation)
          if (line.match(/^\s+-\s/) || line.match(/^\s+-$/)) {
            categoriesEndLine = i;
          }
          // Empty lines within categories are OK
          else if (line.match(/^\s*$/)) {
            continue;
          }
          // A new key starts - stop looking
          else if (line.match(/^\s*\S+:/)) {
            break;
          }
          // Comments or other content - stop
          else if (line.trim() && !line.match(/^\s+-/)) {
            break;
          }
        }
      }

      if (categoriesStartLine === -1) return;

      // Build new categories block with consistent formatting
      const newCategoriesLines = [`${categoriesIndent}categories:`];
      for (const cat of newCategories) {
        newCategoriesLines.push(`${categoriesIndent}  - ${cat}`);
      }

      const newLines = [
        ...lines.slice(0, categoriesStartLine),
        ...newCategoriesLines,
        ...lines.slice(categoriesEndLine + 1),
      ];

      await this.app.vault.modify(file, newLines.join("\n"));
    } catch (error) {
      console.error("Auto Categories: Error updating frontmatter", error);
      throw error;
    }
  }

  /**
   * Ensure a category file and its base file exist
   */
  async ensureCategoryExists(categoryName: string) {
    const categoryPath = `${this.settings.categoriesFolder}/${categoryName}.md`;
    const basePath = `${this.settings.basesFolder}/${categoryName}.base`;

    try {
      await this.ensureFolderExists(this.settings.categoriesFolder);
      await this.ensureFolderExists(this.settings.basesFolder);

      if (!this.app.vault.getAbstractFileByPath(categoryPath)) {
        const categoryContent = `---
tags:
  - categories
---

![[${categoryName}.base]]
`;
        await this.app.vault.create(categoryPath, categoryContent);
        this.notify(`Created category: ${categoryName}`);
      }

      if (!this.app.vault.getAbstractFileByPath(basePath)) {
        const baseContent = this.generateBaseContent(categoryName);
        await this.app.vault.create(basePath, baseContent);
      }
    } catch (error) {
      console.error(
        `Auto Categories: Error creating category "${categoryName}"`,
        error
      );
      new Notice(`Error creating category "${categoryName}": ${error}`);
    }
  }

  /**
   * Ensure a folder exists
   */
  async ensureFolderExists(folderPath: string) {
    const parts = folderPath.split("/");
    let currentPath = "";

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const folder = this.app.vault.getAbstractFileByPath(currentPath);
      if (!folder) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch (error) {
          if (!this.app.vault.getAbstractFileByPath(currentPath)) {
            throw error;
          }
        }
      }
    }
  }

  /**
   * Generate base content using the template
   */
  generateBaseContent(categoryName: string): string {
    return this.settings.baseTemplate.replace(/\{\{categoryName\}\}/g, categoryName) + "\n";
  }

  /**
   * Get all categories used in the vault
   */
  getAllUsedCategories(): Set<string> {
    const allCategories = new Set<string>();
    const allFiles = this.app.vault.getMarkdownFiles();

    for (const file of allFiles) {
      if (this.shouldExcludeFile(file)) continue;

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
          allCategories.add(this.flattenCategoryName(catStr.trim()));
        }
      }
    }

    return allCategories;
  }

  /**
   * Get all existing category files
   */
  getAllExistingCategories(): string[] {
    const categoriesFolder = this.app.vault.getAbstractFileByPath(
      this.settings.categoriesFolder
    );

    if (!categoriesFolder || !(categoriesFolder instanceof TFolder)) {
      return [];
    }

    const categories: string[] = [];

    const processFolder = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === "md") {
          categories.push(child.basename);
        } else if (child instanceof TFolder) {
          processFolder(child);
        }
      }
    };

    processFolder(categoriesFolder);
    return categories;
  }

  /**
   * Show categories overview modal
   */
  showCategoriesOverview() {
    const usedCategories = this.getAllUsedCategories();
    const existingCategories = this.getAllExistingCategories();

    new CategoriesOverviewModal(
      this.app,
      Array.from(usedCategories).sort(),
      existingCategories.sort(),
      this.settings.caseSensitive
    ).open();
  }

  /**
   * Normalize category name based on caseSensitive setting
   */
  private normalizeCategoryName(name: string): string {
    return this.settings.caseSensitive ? name : name.toLowerCase();
  }

  /**
   * Check if two category names match (respecting caseSensitive setting)
   */
  private categoryNamesMatch(a: string, b: string): boolean {
    return this.normalizeCategoryName(a) === this.normalizeCategoryName(b);
  }

  /**
   * Find and show orphan categories
   */
  findOrphanCategories() {
    const usedCategories = this.getAllUsedCategories();
    const existingCategories = this.getAllExistingCategories();

    // Create a normalized set of used categories for comparison
    const normalizedUsedCategories = new Set(
      Array.from(usedCategories).map(cat => this.normalizeCategoryName(cat))
    );

    const orphans = existingCategories.filter(
      (cat) => !normalizedUsedCategories.has(this.normalizeCategoryName(cat))
    );

    if (orphans.length === 0) {
      new Notice("No orphan categories found!");
      return;
    }

    new OrphanCategoriesModal(this.app, this, orphans).open();
  }

  /**
   * Delete a category and its base file
   */
  async deleteCategory(categoryName: string) {
    const categoryPath = `${this.settings.categoriesFolder}/${categoryName}.md`;
    const basePath = `${this.settings.basesFolder}/${categoryName}.base`;

    try {
      const categoryFile = this.app.vault.getAbstractFileByPath(categoryPath);
      if (categoryFile) {
        await this.app.vault.delete(categoryFile);
      }

      const baseFile = this.app.vault.getAbstractFileByPath(basePath);
      if (baseFile) {
        await this.app.vault.delete(baseFile);
      }

      this.notify(`Deleted category: ${categoryName}`);
    } catch (error) {
      new Notice(`Error deleting category: ${error}`);
    }
  }

  /**
   * Sync all categories across the vault
   */
  async syncAllCategories() {
    const allFiles = this.app.vault.getMarkdownFiles();
    let processedCount = 0;
    const allCategories = new Set<string>();
    let errorCount = 0;

    for (const file of allFiles) {
      if (this.shouldExcludeFile(file)) {
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
          allCategories.add(this.flattenCategoryName(catStr.trim()));
        }
      }

      try {
        await this.processFile(file);
        processedCount++;
      } catch (error) {
        errorCount++;
      }
    }

    let message = `Synced ${allCategories.size} categories from ${processedCount} files`;
    if (errorCount > 0) {
      message += ` (${errorCount} errors)`;
    }
    new Notice(message);
  }
}

/**
 * Categories Overview Modal
 */
class CategoriesOverviewModal extends Modal {
  usedCategories: string[];
  existingCategories: string[];
  caseSensitive: boolean;

  constructor(app: App, usedCategories: string[], existingCategories: string[], caseSensitive: boolean) {
    super(app);
    this.usedCategories = usedCategories;
    this.existingCategories = existingCategories;
    this.caseSensitive = caseSensitive;
  }

  /**
   * Check if a category exists in the list (respecting case sensitivity)
   */
  private categoryExistsIn(category: string, list: string[]): boolean {
    if (this.caseSensitive) {
      return list.includes(category);
    }
    const lowerCategory = category.toLowerCase();
    return list.some(c => c.toLowerCase() === lowerCategory);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Categories Overview" });

    // Stats
    const statsEl = contentEl.createDiv({ cls: "auto-categories-stats" });
    statsEl.createEl("p", {
      text: `Used in notes: ${this.usedCategories.length}`,
    });
    statsEl.createEl("p", {
      text: `Category files: ${this.existingCategories.length}`,
    });

    // Used categories
    contentEl.createEl("h3", { text: "Used Categories" });
    const usedList = contentEl.createEl("ul");
    for (const cat of this.usedCategories) {
      const li = usedList.createEl("li");
      li.createEl("span", { text: cat });
      if (!this.categoryExistsIn(cat, this.existingCategories)) {
        li.createEl("span", {
          text: " (missing file)",
          cls: "auto-categories-warning",
        });
      }
    }

    // Orphans
    const orphans = this.existingCategories.filter(
      (cat) => !this.categoryExistsIn(cat, this.usedCategories)
    );
    if (orphans.length > 0) {
      contentEl.createEl("h3", { text: "Orphan Categories (unused)" });
      const orphanList = contentEl.createEl("ul");
      for (const cat of orphans) {
        orphanList.createEl("li", { text: cat });
      }
    }

    // Style
    contentEl.createEl("style", {
      text: `
        .auto-categories-stats { margin-bottom: 1em; }
        .auto-categories-stats p { margin: 0.25em 0; }
        .auto-categories-warning { color: var(--text-error); margin-left: 0.5em; font-size: 0.85em; }
      `,
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Orphan Categories Modal
 */
class OrphanCategoriesModal extends Modal {
  plugin: AutoCategoriesPlugin;
  orphans: string[];

  constructor(app: App, plugin: AutoCategoriesPlugin, orphans: string[]) {
    super(app);
    this.plugin = plugin;
    this.orphans = orphans;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Orphan Categories" });
    contentEl.createEl("p", {
      text: `Found ${this.orphans.length} categories that are not used in any note:`,
    });

    const list = contentEl.createEl("ul");
    for (const cat of this.orphans) {
      const li = list.createEl("li");
      li.createEl("span", { text: cat });

      const deleteBtn = li.createEl("button", { text: "Delete" });
      deleteBtn.style.marginLeft = "1em";
      deleteBtn.onclick = async () => {
        await this.plugin.deleteCategory(cat);
        li.remove();
        this.orphans = this.orphans.filter((c) => c !== cat);
        if (this.orphans.length === 0) {
          this.close();
        }
      };
    }

    // Delete all button
    if (this.orphans.length > 1) {
      const deleteAllBtn = contentEl.createEl("button", {
        text: "Delete All Orphans",
      });
      deleteAllBtn.style.marginTop = "1em";
      deleteAllBtn.onclick = async () => {
        for (const cat of [...this.orphans]) {
          await this.plugin.deleteCategory(cat);
        }
        this.close();
      };
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Settings Tab
 */
class AutoCategoriesSettingTab extends PluginSettingTab {
  plugin: AutoCategoriesPlugin;

  constructor(app: App, plugin: AutoCategoriesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Auto Categories Settings" });

    // Folders Section
    containerEl.createEl("h3", { text: "Folders" });

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

    new Setting(containerEl)
      .setName("Exclude folders")
      .setDesc("Folders to exclude from processing (comma-separated)")
      .addText((text) =>
        text
          .setPlaceholder("Templates, Archive")
          .setValue(this.plugin.settings.excludeFolders.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.excludeFolders = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          })
      );

    // Behavior Section
    containerEl.createEl("h3", { text: "Behavior" });

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Automatically sync all categories when Obsidian starts")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Case sensitive")
      .setDesc("Treat 'Urlaub' and 'urlaub' as different categories")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.caseSensitive)
          .onChange(async (value) => {
            this.plugin.settings.caseSensitive = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show notifications")
      .setDesc("Show notices when categories are created")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showNotifications)
          .onChange(async (value) => {
            this.plugin.settings.showNotifications = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Nested category separator")
      .setDesc("Separator for nested categories (e.g., Travel/Europe becomes Travel - Europe)")
      .addText((text) =>
        text
          .setPlaceholder(" - ")
          .setValue(this.plugin.settings.nestedSeparator)
          .onChange(async (value) => {
            this.plugin.settings.nestedSeparator = value || " - ";
            await this.plugin.saveSettings();
          })
      );

    // Template Section
    containerEl.createEl("h3", { text: "Base Template" });

    new Setting(containerEl)
      .setName("Base file template")
      .setDesc("Template for new .base files. Use {{categoryName}} as placeholder.")
      .addTextArea((text) => {
        text
          .setPlaceholder(DEFAULT_BASE_TEMPLATE)
          .setValue(this.plugin.settings.baseTemplate)
          .onChange(async (value) => {
            this.plugin.settings.baseTemplate = value || DEFAULT_BASE_TEMPLATE;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 15;
        text.inputEl.cols = 50;
      });

    const resetBtn = containerEl.createEl("button", {
      text: "Reset to Default Template",
    });
    resetBtn.onclick = async () => {
      this.plugin.settings.baseTemplate = DEFAULT_BASE_TEMPLATE;
      await this.plugin.saveSettings();
      this.display();
    };

    // Commands Section
    containerEl.createEl("h3", { text: "Commands" });
    containerEl.createEl("p", {
      text: "Use Cmd+P and search for 'Auto Categories' to access commands:",
      cls: "setting-item-description",
    });

    const list = containerEl.createEl("ul");
    list.createEl("li").innerHTML =
      "<strong>Sync All Categories</strong> - Process all notes in vault";
    list.createEl("li").innerHTML =
      "<strong>Process Current File</strong> - Process only the active note";
    list.createEl("li").innerHTML =
      "<strong>Show Categories Overview</strong> - View all categories";
    list.createEl("li").innerHTML =
      "<strong>Find Orphan Categories</strong> - Find unused categories";
  }
}
