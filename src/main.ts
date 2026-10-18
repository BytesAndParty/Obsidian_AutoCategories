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
  Menu,
  normalizePath,
} from "obsidian";

interface AutoCategoriesSettings {
  categoriesFolder: string;
  basesFolder: string;
  excludeFolders: string[];
  categoryCheckFolders: string[];
  showNotifications: boolean;
  caseSensitive: boolean;
  syncOnStartup: boolean;
  nestedSeparator: string;
  baseTemplate: string;
  baseTemplatePath: string;
  debounceDelay: number;
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
  categoryCheckFolders: [],
  showNotifications: true,
  caseSensitive: true,
  syncOnStartup: false,
  nestedSeparator: " - ",
  baseTemplate: DEFAULT_BASE_TEMPLATE,
  baseTemplatePath: "",
  debounceDelay: 500,
};

// Characters not allowed in category names (file names; "#", "^", "[", "]" and "|" would break wikilinks)
const INVALID_CHARS = /[\\:*?"<>|#^[\]]/g;

// Splits a frontmatter value into text and wikilinks: [[Name]], [[Name|Alias]], [[Name#Heading]]
const LINK_SPLIT = /(\[\[[^[\]|]*(?:\|.*?)?\]\])/;

// Commands (registered in onload and listed in the settings tab)
const COMMANDS: { id: string; name: string; description: string; run: (plugin: AutoCategoriesPlugin) => unknown }[] = [
  { id: "sync-all-categories", name: "Sync all categories", description: "Process all notes in vault", run: (p) => p.syncAllCategories() },
  { id: "process-current-file", name: "Process current file categories", description: "Process only the active note", run: (p) => p.processCurrentFile() },
  { id: "show-categories-overview", name: "Show categories overview", description: "View all categories", run: (p) => p.showCategoriesOverview() },
  { id: "find-orphan-categories", name: "Find orphan categories", description: "Find unused categories", run: (p) => p.findOrphanCategories() },
];

interface ParsedCategory {
  name: string;
  alias?: string;
  // true if the entry is not written as a single wikilink and has to be rewritten
  rewrite: boolean;
  // Link target as written (e.g. "Categories/Name"), kept when the frontmatter is rewritten
  target?: string;
}

/**
 * Trim and normalize a vault path entered by the user. "" stays "" and the vault root
 * ("/", "\", ".") also becomes "", so a folder setting can never point to the whole vault.
 */
function normalizeUserPath(value: string): string {
  const trimmed = value.trim();
  const path = trimmed ? normalizePath(trimmed) : "";
  return path === "/" || path === "." ? "" : path;
}

/**
 * Normalize a list of folder paths and drop empty entries
 */
function normalizeFolderList(folders: string[]): string[] {
  return folders.map(normalizeUserPath).filter((folder) => folder.length > 0);
}

/**
 * Check if a path lies inside a folder (including subfolders)
 */
function isInFolder(path: string, folder: string): boolean {
  return !!folder && path.startsWith(folder + "/");
}

export default class AutoCategoriesPlugin extends Plugin {
  settings: AutoCategoriesSettings = DEFAULT_SETTINGS;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Changed note that is still open in the active editor; processed when the user leaves it
  private pendingActiveFile: TFile | null = null;
  // Serializes category file creation (see ensureCategoryExists)
  private categoryQueue: Promise<void> = Promise.resolve();

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new AutoCategoriesSettingTab(this.app, this));
    this.addRibbonIcon("folder-sync", "Sync all categories", () =>
      this.syncAllCategories()
    );
    for (const command of COMMANDS) {
      this.addCommand({ id: command.id, name: command.name, callback: () => command.run(this) });
    }

    // Process file when metadata changes (frontmatter is parsed)
    this.registerEvent(
      this.app.metadataCache.on('changed', (file: TFile) => this.onFileChanged(file))
    );

    // The note being edited is processed when the user leaves it (other tab, other note, closed)
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.flushPendingActiveFile(false)));
    this.registerEvent(this.app.workspace.on("file-open", () => this.flushPendingActiveFile(false)));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.flushPendingActiveFile(false)));
    this.registerEvent(this.app.workspace.on("quit", () => this.flushPendingActiveFile(true)));

    // Auto-sync on startup if enabled (wait for vault to be fully loaded)
    if (this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        this.syncAllCategories();
      });
    }
  }

  onunload() {
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    // The note being edited must not stay unprocessed
    this.flushPendingActiveFile(true);
  }

  /**
   * A note changed: the active note is processed when the user leaves it (so categories are not
   * created while typing), all other notes after the debounce delay
   */
  private onFileChanged(file: TFile) {
    if (!this.isActiveNote(file)) {
      this.debouncedProcessFile(file);
      return;
    }
    if (this.pendingActiveFile && this.pendingActiveFile.path !== file.path) {
      this.flushPendingActiveFile(true);
    }
    const timer = this.debounceTimers.get(file.path);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(file.path);
    }
    this.pendingActiveFile = file;
  }

  /**
   * Process the pending note once it is no longer the active note (or always, if force is set)
   */
  private flushPendingActiveFile(force: boolean) {
    const file = this.pendingActiveFile;
    if (!file || (!force && this.isActiveNote(file))) return;
    this.pendingActiveFile = null;
    this.processFile(file);
  }

  /**
   * The note is the active file (also while a sidebar such as the properties view has the focus)
   * and still open in an editor; getActiveFile() may still return a note that was just closed
   */
  private isActiveNote(file: TFile): boolean {
    return (
      this.app.workspace.getActiveFile()?.path === file.path &&
      this.app.workspace.getLeavesOfType("markdown").some(
        (leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path
      )
    );
  }

  /**
   * Debounced version of processFile to avoid excessive processing
   */
  private debouncedProcessFile(file: TFile) {
    const existingTimer = this.debounceTimers.get(file.path);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(file.path);
      this.processFile(file);
    }, this.settings.debounceDelay);

    this.debounceTimers.set(file.path, timer);
  }

  async loadSettings() {
    const settings: AutoCategoriesSettings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Paths saved by older versions may not be normalized
    settings.categoriesFolder = normalizeUserPath(settings.categoriesFolder) || DEFAULT_SETTINGS.categoriesFolder;
    settings.basesFolder = normalizeUserPath(settings.basesFolder) || DEFAULT_SETTINGS.basesFolder;
    settings.excludeFolders = normalizeFolderList(settings.excludeFolders);
    settings.categoryCheckFolders = normalizeFolderList(settings.categoryCheckFolders);
    settings.baseTemplatePath = normalizeUserPath(settings.baseTemplatePath);
    this.settings = settings;
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
    return [this.settings.categoriesFolder, ...this.settings.excludeFolders].some((folder) =>
      isInFolder(file.path, folder)
    );
  }

  /**
   * The categories frontmatter value of a note from the metadata cache
   * (undefined for excluded notes and notes without categories)
   */
  private getCachedCategories(file: TFile): unknown {
    if (this.shouldExcludeFile(file)) return undefined;
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.categories || undefined;
  }

  private getCategoryPath(categoryName: string): string {
    return `${this.settings.categoriesFolder}/${categoryName}.md`;
  }

  private getBasePath(categoryName: string): string {
    return `${this.settings.basesFolder}/${categoryName}.base`;
  }

  /**
   * Convert nested category path to flat name with separator
   * e.g., "Travel/Europe/Germany" -> "Travel - Europe - Germany"
   */
  private flattenCategoryName(name: string): string {
    if (!name.includes("/")) {
      return name;
    }
    return name
      .split("/")
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .join(this.settings.nestedSeparator);
  }

  /**
   * Parse a single entry of the categories frontmatter field.
   * An entry may contain several links ("[[A]], [[B]]"), which become separate categories.
   * Returns [] for empty entries and for unfinished links (e.g. still being typed).
   * sourcePath is the note containing the entry (used to resolve path links).
   */
  private parseCategoryValue(value: unknown, sourcePath: string): ParsedCategory[] {
    if (value === null || value === undefined) return [];
    if (typeof value === "object" && !Array.isArray(value)) return [];

    const str = String(value).trim();
    if (!str.includes("[[")) {
      return str ? [{ name: str, rewrite: true }] : [];
    }

    // Odd indices are links, even indices the text around them
    const parts = str.split(LINK_SPLIT);
    if (parts.length === 1) return [];
    const singleLink = parts.length === 3 && !parts[0] && !parts[2];

    const result: ParsedCategory[] = [];
    parts.forEach((part, index) => {
      if (index % 2 === 0) {
        // Text next to links ("[[A]], B"): comma-separated plain categories, leftover brackets are dropped
        for (const text of part.split(",")) {
          const name = text.replace(/[[\]]/g, "").trim();
          if (name) result.push({ name, rewrite: true });
        }
        return;
      }

      // [[Category|Alias]] -> Category (alias is kept separately)
      const inner = part.slice(2, -2);
      const pipeIndex = inner.indexOf("|");
      const target = pipeIndex === -1 ? inner : inner.slice(0, pipeIndex);
      const alias = pipeIndex === -1 ? undefined : inner.slice(pipeIndex + 1) || undefined;

      // [[Category#Heading]] -> Category
      const hashIndex = target.indexOf("#");
      const linkpath = hashIndex === -1 ? target : target.slice(0, hashIndex);
      // Path links ([[Categories/Sub/Category]]) are resolved to the existing category file
      const file = linkpath.includes("/") ? this.resolveCategoryLink(linkpath, sourcePath) : null;
      const name = file ? file.basename : this.stripFolderPrefix(linkpath);
      if (name.trim()) {
        const rewrite = !singleLink || hashIndex !== -1;
        result.push({ name, alias, rewrite, target: rewrite ? undefined : target });
      }
    });
    return result;
  }

  /**
   * The category file a path link points to (only files in the categories folder or a check folder)
   */
  private resolveCategoryLink(linkpath: string, sourcePath: string): TFile | null {
    const file = this.app.metadataCache.getFirstLinkpathDest(linkpath.trim(), sourcePath);
    const folders = [this.settings.categoriesFolder, ...this.settings.categoryCheckFolders];
    return file && file.extension === "md" && folders.some((folder) => isInFolder(file.path, folder)) ? file : null;
  }

  /**
   * Fallback for path links that cannot be resolved (e.g. the category file does not exist yet):
   * [[Categories/Category]] -> Category (longest matching folder, case-insensitive)
   */
  private stripFolderPrefix(name: string): string {
    const lowerName = name.toLowerCase();
    let prefixLength = 0;
    for (const folder of [this.settings.categoriesFolder, ...this.settings.categoryCheckFolders]) {
      const prefix = folder.toLowerCase() + "/";
      if (folder && prefix.length > prefixLength && lowerName.startsWith(prefix)) {
        prefixLength = prefix.length;
      }
    }
    return name.slice(prefixLength);
  }

  /**
   * Resolve the categories frontmatter value: final (flattened, sanitized, deduplicated) category names,
   * the wikilinks to write back and whether the frontmatter has to be rewritten.
   * Entries that are already written correctly (e.g. [[Categories/Name]]) are written back as they are.
   */
  private normalizeCategories(value: unknown, sourcePath: string): {
    names: string[];
    links: string[];
    needsUpdate: boolean;
    warnings: string[];
  } {
    type Category = { name: string; alias?: string; target?: string };
    // Keyed by normalized name, so aliases of case-insensitive duplicates are kept
    const categories = new Map<string, Category>();
    // Order of the entries to write back; unfinished links (e.g. still being typed) are kept as written
    const output: (string | Category)[] = [];
    const warnings: string[] = [];
    let needsUpdate = false;

    for (const entry of Array.isArray(value) ? value : [value]) {
      const parsedEntries = this.parseCategoryValue(entry, sourcePath);
      if (parsedEntries.length === 0 && typeof entry === "string" && entry.includes("[[")) {
        output.push(entry);
        continue;
      }

      for (const parsed of parsedEntries) {
        // Validate and potentially flatten category name
        const validation = this.validateCategoryName(parsed.name);
        if (validation.error) {
          warnings.push(validation.error);
        }

        const name = validation.sanitized;
        if (parsed.rewrite || name !== parsed.name) {
          needsUpdate = true;
        }
        if (!name) continue;

        const key = this.normalizeCategoryName(name);
        const existing = categories.get(key);
        if (existing) {
          needsUpdate = true;
          existing.alias = existing.alias || parsed.alias;
        } else {
          const category = { name, alias: parsed.alias, target: name === parsed.name ? parsed.target : undefined };
          categories.set(key, category);
          output.push(category);
        }
      }
    }

    return {
      names: Array.from(categories.values(), (c) => c.name),
      links: output.map((c) => (typeof c === "string" ? c : this.formatCategoryLink(c.target ?? c.name, c.alias))),
      needsUpdate,
      warnings,
    };
  }

  /**
   * Build the wikilink stored in the frontmatter
   */
  private formatCategoryLink(categoryName: string, alias?: string): string {
    return alias ? `[[${categoryName}|${alias}]]` : `[[${categoryName}]]`;
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
    const trimmed = this.flattenCategoryName(name).trim();
    if (!trimmed) {
      return { valid: false, sanitized: "", error: "Category name is empty" };
    }

    const sanitized = trimmed.replace(INVALID_CHARS, "-");
    if (sanitized !== trimmed) {
      return {
        valid: false,
        sanitized,
        error: `Invalid characters in "${trimmed}", sanitized to "${sanitized}"`,
      };
    }

    return { valid: true, sanitized };
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
    if (this.pendingActiveFile?.path === activeView.file.path) {
      this.pendingActiveFile = null;
    }
    if (await this.processFile(activeView.file)) {
      this.notify("Categories processed");
    }
  }

  /**
   * Process a single file. Returns false if an error occurred.
   */
  async processFile(file: TFile): Promise<boolean> {
    try {
      // The note may have been deleted meanwhile (debounce, note left after deleting it)
      if (!this.app.vault.getAbstractFileByPath(file.path)) return true;

      const cachedCategories = this.getCachedCategories(file);
      if (!cachedCategories) return true;

      let result = this.normalizeCategories(cachedCategories, file.path);

      // Update frontmatter if needed (atomic, YAML is written by Obsidian). The result is recomputed
      // from the frontmatter being written, because the metadata cache may lag behind the file.
      if (result.needsUpdate) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          result = this.normalizeCategories(frontmatter.categories, file.path);
          if (result.needsUpdate) {
            frontmatter.categories = result.links;
          }
        });
      }

      for (const warning of result.warnings) {
        new Notice(warning);
      }

      // Create category and base files (a failing category does not stop the others)
      let success = true;
      for (const categoryName of result.names) {
        if (!(await this.ensureCategoryExists(categoryName))) {
          success = false;
        }
      }
      return success;
    } catch (error) {
      console.error("Auto Categories: Error processing file", error);
      new Notice(`Error processing ${file.name}: ${error}`);
      return false;
    }
  }

  /**
   * Ensure a category file and its base file exist. Returns false if an error occurred.
   * Calls are serialized so that concurrent processing (debounced events, sync)
   * never tries to create the same file twice.
   */
  ensureCategoryExists(categoryName: string): Promise<boolean> {
    const task = this.categoryQueue.then(() => this.createMissingCategoryFiles(categoryName));
    this.categoryQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async createMissingCategoryFiles(categoryName: string): Promise<boolean> {
    try {
      await this.ensureFolderExists(this.settings.categoriesFolder);
      await this.ensureFolderExists(this.settings.basesFolder);

      // An existing category file may live in a subfolder, a check folder or differ in case
      const existingFile = this.findCategoryFile(categoryName);
      const basePath = this.getBasePath(existingFile ? existingFile.basename : categoryName);

      if (!existingFile) {
        const categoryContent = `---
tags:
  - categories
---

![[${categoryName}.base]]
`;
        await this.app.vault.create(this.getCategoryPath(categoryName), categoryContent);
        this.notify(`Created category: ${categoryName}`);
      }

      if (!this.app.vault.getAbstractFileByPath(basePath)) {
        const baseContent = await this.generateBaseContent(categoryName);
        await this.app.vault.create(basePath, baseContent);
      }
      return true;
    } catch (error) {
      console.error(
        `Auto Categories: Error creating category "${categoryName}"`,
        error
      );
      new Notice(`Error creating category "${categoryName}": ${error}`);
      return false;
    }
  }

  /**
   * Ensure a folder exists
   */
  async ensureFolderExists(folderPath: string) {
    let currentPath = "";

    for (const part of folderPath.split("/")) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(currentPath)) {
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
   * Generate base content using the template (from file or inline)
   */
  async generateBaseContent(categoryName: string): Promise<string> {
    let template = this.settings.baseTemplate;

    // Try to load template from file if path is specified
    if (this.settings.baseTemplatePath) {
      const templateFile = this.app.vault.getAbstractFileByPath(this.settings.baseTemplatePath);
      if (templateFile instanceof TFile) {
        try {
          template = await this.app.vault.read(templateFile);
        } catch (error) {
          console.warn(`Auto Categories: Could not read template file "${this.settings.baseTemplatePath}", using inline template`);
        }
      } else {
        console.warn(`Auto Categories: Template file "${this.settings.baseTemplatePath}" not found, using inline template`);
      }
    }

    // Use a replacer function so "$" in category names is not interpreted as a replacement pattern
    return template.replace(/\{\{categoryName\}\}/g, () => categoryName) + "\n";
  }

  /**
   * Get all categories used in the vault
   */
  getAllUsedCategories(): Set<string> {
    const allCategories = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      for (const categoryName of this.normalizeCategories(this.getCachedCategories(file), file.path).names) {
        allCategories.add(categoryName);
      }
    }
    return allCategories;
  }

  /**
   * Get all category files from categoriesFolder (including subfolders) and optionally
   * from categoryCheckFolders. Check folders are only used to detect existing categories,
   * never for orphans or deletion.
   */
  private getCategoryFiles(includeCheckFolders: boolean): TFile[] {
    const files: TFile[] = [];
    const seenPaths = new Set<string>();

    const processFolder = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === "md") {
          if (!seenPaths.has(child.path)) {
            seenPaths.add(child.path);
            files.push(child);
          }
        } else if (child instanceof TFolder) {
          processFolder(child);
        }
      }
    };

    // Main categories folder first, then additional category check folders
    const { categoriesFolder, categoryCheckFolders } = this.settings;
    for (const folderPath of includeCheckFolders ? [categoriesFolder, ...categoryCheckFolders] : [categoriesFolder]) {
      const folder = folderPath && this.app.vault.getAbstractFileByPath(folderPath);
      // Never scan the whole vault
      if (folder instanceof TFolder && !folder.isRoot()) {
        processFolder(folder);
      }
    }

    return files;
  }

  /**
   * Get all existing category names (categoriesFolder only, unless includeCheckFolders is set)
   */
  getAllExistingCategories(includeCheckFolders = false): string[] {
    const categories = new Map<string, string>();
    for (const file of this.getCategoryFiles(includeCheckFolders)) {
      const key = this.normalizeCategoryName(file.basename);
      if (!categories.has(key)) {
        categories.set(key, file.basename);
      }
    }
    return Array.from(categories.values());
  }

  /**
   * Find the file of a category (respecting caseSensitive setting).
   * Looks in categoriesFolder and (unless includeCheckFolders is false) categoryCheckFolders,
   * including subfolders.
   */
  private findCategoryFile(categoryName: string, includeCheckFolders = true): TFile | null {
    const direct = this.app.vault.getAbstractFileByPath(this.getCategoryPath(categoryName));
    if (direct instanceof TFile) {
      return direct;
    }

    return (
      this.getCategoryFiles(includeCheckFolders).find((file) =>
        this.categoryNamesMatch(file.basename, categoryName)
      ) ?? null
    );
  }

  /**
   * Category pages in the categories folder that are not used in any note
   */
  private getOrphanCategories(usedCategories: Set<string>, existingCategories = this.getAllExistingCategories()): string[] {
    const used = new Set(Array.from(usedCategories, (cat) => this.normalizeCategoryName(cat)));
    return existingCategories.filter((cat) => !used.has(this.normalizeCategoryName(cat)));
  }

  /**
   * Show categories overview modal
   */
  showCategoriesOverview() {
    const usedCategories = this.getAllUsedCategories();
    const existingCategories = this.getAllExistingCategories().sort();
    // Categories with a file in a check folder are not missing
    const known = new Set(this.getAllExistingCategories(true).map((cat) => this.normalizeCategoryName(cat)));

    new CategoriesOverviewModal(this.app, this, {
      used: Array.from(usedCategories).sort(),
      missing: new Set(Array.from(usedCategories).filter((cat) => !known.has(this.normalizeCategoryName(cat)))),
      fileCount: existingCategories.length,
      orphans: this.getOrphanCategories(usedCategories, existingCategories),
    }).open();
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
    const orphans = this.getOrphanCategories(this.getAllUsedCategories());
    if (orphans.length === 0) {
      new Notice("No orphan categories found!");
      return;
    }

    new OrphanCategoriesModal(this.app, this, orphans).open();
  }

  /**
   * Delete a category and its base file (moved to trash according to the user's settings).
   * Returns false if nothing was deleted.
   */
  async deleteCategory(categoryName: string): Promise<boolean> {
    try {
      // Only category pages inside the categories folder are deleted, never notes in check folders
      const found = this.findCategoryFile(categoryName, false);
      const categoryFile = found && isInFolder(found.path, this.settings.categoriesFolder) ? found : null;
      const baseFile = this.app.vault.getAbstractFileByPath(
        this.getBasePath(categoryFile ? categoryFile.basename : categoryName)
      );

      if (!categoryFile && !baseFile) {
        new Notice(`Category "${categoryName}" not found`);
        return false;
      }

      if (categoryFile) {
        await this.app.fileManager.trashFile(categoryFile);
      }

      if (baseFile) {
        await this.app.fileManager.trashFile(baseFile);
      }

      this.notify(`Deleted category: ${categoryName}`);
      return true;
    } catch (error) {
      new Notice(`Error deleting category: ${error}`);
      return false;
    }
  }

  /**
   * Rename a category
   */
  async renameCategory(oldName: string, newName: string): Promise<boolean> {
    // Validate new name
    const validation = this.validateCategoryName(newName);
    if (!validation.valid || !validation.sanitized) {
      new Notice(`Invalid category name: ${validation.error || "Name is empty"}`);
      return false;
    }
    newName = validation.sanitized;

    // Check if old and new name are the same
    if (oldName === newName) {
      new Notice("New name is the same as the old name");
      return false;
    }

    // Existing category file (may be in a subfolder/check folder or differ in case from oldName)
    const categoryFile = this.findCategoryFile(oldName);
    const oldFileName = categoryFile ? categoryFile.basename : oldName;

    // Notes in check folders are never renamed by the plugin
    if (categoryFile && !isInFolder(categoryFile.path, this.settings.categoriesFolder)) {
      new Notice(`"${categoryFile.path}" is outside the categories folder. Rename it manually.`);
      return false;
    }

    // Check if new category already exists
    const existingCategory = this.findCategoryFile(newName);
    if (existingCategory && existingCategory !== categoryFile) {
      new Notice(`Category "${newName}" already exists`);
      return false;
    }

    const newBasePath = this.getBasePath(newName);
    const baseFile = this.app.vault.getAbstractFileByPath(this.getBasePath(oldFileName));
    const existingBase = this.app.vault.getAbstractFileByPath(newBasePath);
    if (baseFile instanceof TFile && existingBase && existingBase !== baseFile) {
      new Notice(`Base file "${newBasePath}" already exists`);
      return false;
    }

    const regexFlags = this.settings.caseSensitive ? "g" : "gi";
    const replaceInFile = (file: TFile, pattern: string, replacement: string) =>
      this.app.vault.process(file, (content) =>
        content.replace(new RegExp(pattern, regexFlags), () => replacement)
      );

    try {
      // 1. Rename category file (in its folder; links are updated according to the user's settings)
      if (categoryFile) {
        const parentPath = categoryFile.parent ? categoryFile.parent.path : this.settings.categoriesFolder;
        await this.app.fileManager.renameFile(
          categoryFile,
          normalizePath(`${parentPath}/${newName}.md`)
        );
      }

      // 2. Rename base file
      if (baseFile instanceof TFile) {
        await this.app.fileManager.renameFile(baseFile, newBasePath);
      }

      // 3. Update content of category file (wikilink to base)
      if (categoryFile) {
        await replaceInFile(categoryFile, `!\\[\\[${this.escapeRegex(oldFileName)}\\.base\\]\\]`, `![[${newName}.base]]`);
      }

      // 4. Update content of base file (link filter)
      if (baseFile instanceof TFile) {
        await replaceInFile(baseFile, `link\\("${this.escapeRegex(oldFileName)}"\\)`, `link("${newName}")`);
      }

      // 5. Update all notes that use this category
      for (const file of this.app.vault.getMarkdownFiles()) {
        const hasOldCategory = this.normalizeCategories(this.getCachedCategories(file), file.path).names.some(
          (categoryName) => this.categoryNamesMatch(categoryName, oldName)
        );
        if (!hasOldCategory) continue;

        // Replace the category in the frontmatter (plain text and wikilinks, keeps aliases)
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const value = fm.categories;
          if (value === null || value === undefined) return;

          const list: unknown[] = Array.isArray(value) ? value : [value];
          let changed = false;
          const updated: unknown[] = [];
          for (const cat of list) {
            const parsed = this.parseCategoryValue(cat, file.path);
            const sanitized = parsed.map((p) => this.validateCategoryName(p.name).sanitized);
            if (!sanitized.some((name) => this.categoryNamesMatch(name, oldName))) {
              updated.push(cat);
              continue;
            }
            // An entry with several links ("[[Old]], [[B]]") is split into separate links
            changed = true;
            parsed.forEach((p, i) => {
              if (sanitized[i]) {
                const name = this.categoryNamesMatch(sanitized[i], oldName) ? newName : sanitized[i];
                updated.push(this.formatCategoryLink(name, p.alias));
              }
            });
          }

          if (changed) {
            fm.categories = Array.isArray(value) || updated.length !== 1 ? updated : updated[0];
          }
        });
      }

      // 6. Refresh the active editor if it was affected (re-render by setting the same state)
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView?.file && this.app.metadataCache.getFileCache(activeView.file)?.frontmatter?.categories) {
        await activeView.setState(activeView.getState(), { history: false });
      }

      this.notify(`Renamed category: ${oldName} → ${newName}`);
      return true;
    } catch (error) {
      console.error("Auto Categories: Error renaming category", error);
      new Notice(`Error renaming category: ${error}`);
      return false;
    }
  }

  /**
   * Escape special regex characters in a string
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Sync all categories across the vault
   */
  async syncAllCategories() {
    let processedCount = 0;
    let errorCount = 0;
    const allCategories = new Set<string>();

    for (const file of this.app.vault.getMarkdownFiles()) {
      const cachedCategories = this.getCachedCategories(file);
      if (!cachedCategories) continue;

      for (const categoryName of this.normalizeCategories(cachedCategories, file.path).names) {
        allCategories.add(this.normalizeCategoryName(categoryName));
      }

      // processFile handles its own errors and reports them via its return value
      if (await this.processFile(file)) {
        processedCount++;
      } else {
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
 * Rename Category Modal
 */
class RenameCategoryModal extends Modal {
  categoryName: string;
  onRename: (newName: string) => void;

  constructor(app: App, categoryName: string, onRename: (newName: string) => void) {
    super(app);
    this.categoryName = categoryName;
    this.onRename = onRename;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Rename category");

    contentEl.createEl("p", { text: `Current name: ${this.categoryName}` });

    const inputContainer = contentEl.createDiv({ cls: "auto-categories-rename-input" });
    const input = inputContainer.createEl("input", {
      type: "text",
      value: this.categoryName,
    });
    input.focus();
    input.select();

    const buttonContainer = contentEl.createDiv({ cls: "auto-categories-rename-buttons" });

    const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();

    const renameBtn = buttonContainer.createEl("button", { text: "Rename", cls: "mod-cta" });
    renameBtn.onclick = () => {
      const newName = input.value.trim();
      if (!newName) {
        new Notice("Category name cannot be empty");
        return;
      }
      this.close();
      this.onRename(newName);
    };

    // Enter submits, Escape cancels
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        renameBtn.click();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Categories Overview Modal
 */
interface CategoriesOverview {
  used: string[];
  // Used categories without a category file
  missing: Set<string>;
  fileCount: number;
  orphans: string[];
}

class CategoriesOverviewModal extends Modal {
  plugin: AutoCategoriesPlugin;
  overview: CategoriesOverview;

  constructor(app: App, plugin: AutoCategoriesPlugin, overview: CategoriesOverview) {
    super(app);
    this.plugin = plugin;
    this.overview = overview;
  }

  /**
   * Add a list item with a right-click context menu to rename the category
   */
  private addCategoryItem(list: HTMLElement, categoryName: string, text?: string): HTMLElement {
    const li = list.createEl("li", { text, cls: "auto-categories-item" });
    li.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      new Menu()
        .addItem((item) => {
          item.setTitle("Rename")
            .setIcon("pencil")
            .onClick(() => {
              new RenameCategoryModal(this.app, categoryName, async (newName) => {
                if (await this.plugin.renameCategory(categoryName, newName)) {
                  // Refresh the modal
                  this.close();
                  this.plugin.showCategoriesOverview();
                }
              }).open();
            });
        })
        .showAtMouseEvent(event);
    });
    return li;
  }

  onOpen() {
    const { contentEl } = this;
    const { used, missing, fileCount, orphans } = this.overview;
    contentEl.empty();
    this.setTitle("Categories overview");

    // Stats
    const statsEl = contentEl.createDiv({ cls: "auto-categories-stats" });
    statsEl.createEl("p", { text: `Used in notes: ${used.length}` });
    statsEl.createEl("p", { text: `Category files: ${fileCount}` });

    // Used categories
    contentEl.createEl("h3", { text: "Used categories" });
    const usedList = contentEl.createEl("ul");
    for (const cat of used) {
      const li = this.addCategoryItem(usedList, cat);
      li.createEl("span", { text: cat });
      if (missing.has(cat)) {
        li.createEl("span", {
          text: " (missing file)",
          cls: "auto-categories-warning",
        });
      }
    }

    // Orphans
    if (orphans.length > 0) {
      contentEl.createEl("h3", { text: "Orphan categories (unused)" });
      const orphanList = contentEl.createEl("ul", { cls: "auto-categories-orphan-list" });
      for (const cat of orphans) {
        this.addCategoryItem(orphanList, cat, cat);
      }
    }
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
    this.setTitle("Orphan categories");

    contentEl.createEl("p", {
      text: `Found ${this.orphans.length} categories that are not used in any note:`,
    });

    const list = contentEl.createEl("ul", { cls: "auto-categories-orphan-list" });
    for (const cat of this.orphans) {
      const li = list.createEl("li", { cls: "auto-categories-orphan-item" });
      li.createEl("span", { text: cat });

      const deleteBtn = li.createEl("button", { text: "Delete" });
      deleteBtn.onclick = async () => {
        // Prevent double clicks while deleting
        deleteBtn.disabled = true;
        if (!(await this.plugin.deleteCategory(cat))) {
          deleteBtn.disabled = false;
          return;
        }
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
        text: "Delete all orphans",
        cls: "auto-categories-delete-all",
      });
      deleteAllBtn.onclick = async () => {
        deleteAllBtn.disabled = true;
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

  /**
   * Text setting that stores the converted value and saves the settings on change
   */
  private addTextSetting(name: string, desc: string, placeholder: string, value: string, store: (value: string) => void) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text
          .setPlaceholder(placeholder)
          .setValue(value)
          .onChange(async (newValue) => {
            store(newValue);
            await this.plugin.saveSettings();
          })
      );
  }

  private addToggleSetting(name: string, desc: string, key: "syncOnStartup" | "caseSensitive" | "showNotifications") {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings[key])
          .onChange(async (value) => {
            this.plugin.settings[key] = value;
            await this.plugin.saveSettings();
          })
      );
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    containerEl.empty();
    const folderList = (value: string) => normalizeFolderList(value.split(","));

    // Folders Section
    new Setting(containerEl).setName("Folders").setHeading();

    this.addTextSetting("Categories folder", "Folder where category pages are created", "Categories",
      settings.categoriesFolder, (value) => (settings.categoriesFolder = normalizeUserPath(value) || "Categories"));
    this.addTextSetting("Bases folder", "Folder where base files are created", "Templates/Bases",
      settings.basesFolder, (value) => (settings.basesFolder = normalizeUserPath(value) || "Templates/Bases"));
    this.addTextSetting("Exclude folders", "Folders to exclude from processing (comma-separated)", "Templates, Archive",
      settings.excludeFolders.join(", "), (value) => (settings.excludeFolders = folderList(value)));
    this.addTextSetting("Additional category check folders",
      "Additional folders to check for existing categories (comma-separated). Used to determine if a category already exists.",
      "Notes/Categories, Projects",
      settings.categoryCheckFolders.join(", "), (value) => (settings.categoryCheckFolders = folderList(value)));

    // Behavior Section
    new Setting(containerEl).setName("Behavior").setHeading();

    this.addToggleSetting("Sync on startup", "Automatically sync all categories when Obsidian starts", "syncOnStartup");
    this.addToggleSetting("Case sensitive", "Treat 'Urlaub' and 'urlaub' as different categories", "caseSensitive");
    this.addToggleSetting("Show notifications", "Show notices when categories are created", "showNotifications");
    this.addTextSetting("Nested category separator", "Separator for nested categories (e.g., Travel/Europe becomes Travel - Europe)", " - ",
      settings.nestedSeparator, (value) => (settings.nestedSeparator = value || " - "));
    this.addTextSetting("Debounce delay (ms)", "Delay before processing changes to notes that are not open in the active editor. The note you are editing is processed when you leave it.", "500",
      String(settings.debounceDelay), (value) => {
        const num = parseInt(value, 10);
        settings.debounceDelay = isNaN(num) || num < 0 ? 500 : num;
      });

    // Template Section
    new Setting(containerEl).setName("Base template").setHeading();

    this.addTextSetting("Base template file path",
      "Path to a template file in your vault (e.g., Templates/category.base). If set, this file is used instead of the inline template below. Use {{categoryName}} as placeholder.",
      "Templates/category-template.base",
      settings.baseTemplatePath, (value) => (settings.baseTemplatePath = normalizeUserPath(value)));

    new Setting(containerEl)
      .setName("Base file template (fallback)")
      .setDesc("Inline template for new .base files. Used when no template file path is set. Use {{categoryName}} as placeholder.")
      .addTextArea((text) => {
        text
          .setPlaceholder(DEFAULT_BASE_TEMPLATE)
          .setValue(settings.baseTemplate)
          .onChange(async (value) => {
            settings.baseTemplate = value || DEFAULT_BASE_TEMPLATE;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 15;
        text.inputEl.cols = 50;
      });

    const resetBtn = containerEl.createEl("button", {
      text: "Reset to default template",
    });
    resetBtn.onclick = async () => {
      settings.baseTemplate = DEFAULT_BASE_TEMPLATE;
      await this.plugin.saveSettings();
      this.display();
    };

    // Commands Section
    new Setting(containerEl).setName("Commands").setHeading();
    containerEl.createEl("p", {
      text: "Open the command palette and search for 'Auto Categories' to access commands:",
      cls: "setting-item-description",
    });

    const list = containerEl.createEl("ul");
    for (const command of COMMANDS) {
      const li = list.createEl("li");
      li.createEl("strong", { text: command.name });
      li.appendText(` - ${command.description}`);
    }
  }
}
