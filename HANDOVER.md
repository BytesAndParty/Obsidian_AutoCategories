# AutoCategories: Übergabe für den nächsten Agent

Stand: 2026-10-18, nach Runde 4. Basis ist Commit `1bef881` auf `main` (gepusht nach `BytesAndParty/Obsidian_AutoCategories`). Die Änderungen der Runde 4 sind **noch nicht committet** (Arbeitskopie). Dies ist die Übergabe nach vier Runden Review (Analyse und Bugfix, Validierung, Folgerunden). Details zum Projekt selbst stehen in `CLAUDE.md` und `README.md`.

## Kontext

- Das Repo liegt unter `Development/Obsidian Plugin/AutoCategories/`. Daneben liegen weitere Plugins, die noch **nicht** geprüft wurden: CommandOverview, CopyFilePath, ObsidianRecall, ObsidianSwipeNavigation, OpenVaultInVSCode.
- Das Plugin legt für Einträge im Frontmatter-Feld `categories` Kategorieseiten (`.md`) und Base-Dateien (`.base`) an. Es hat außerdem Rename, Delete, Orphans, Übersicht und Sync.
- Plugin-Code: eine Datei, `src/main.ts` (rund 1400 Zeilen). `main.js` ist das Build-Artefakt und steht in `.gitignore`.
- Projektregeln: **immer bun**, nie npm. Umlaute normal schreiben (ä, ö, ü, ß). Commit-Messages ohne KI-Hinweise und ohne Gedankenstrich.

## Befehle

```bash
bun install
bun run build        # tsc --noEmit + esbuild production, erzeugt main.js
bun run test         # bun test gegen src/main.ts, ca. 35 s (echte Timer)
bun run test:build   # baut und testet main.js (PLUGIN=main.js)
bunx tsc --noEmit --noUnusedLocals --noUnusedParameters
bunx fallow          # Dead Code, Duplikate, Health (Fallow 3.33.1)
```

Erwartet:
- `tsc` läuft sauber.
- 257 von 257 Tests sind grün, sowohl gegen `src/main.ts` als auch gegen `main.js`.
- Fallow meldet keinen Dead Code und keine Duplikate. Health von `src/` ist 93 (A).
- Fallow meldet „obsidian ist devDependency, wird aber in Produktion genutzt“. Das ist ein Fehlalarm, denn `obsidian` ist in esbuild `external`.

## Architektur (Kurzfassung)

Datenfluss:

1. `metadataCache 'changed'` löst `onFileChanged` aus.
   - Hintergrund-Notizen laufen mit Debounce.
   - Die **aktive Notiz** wird nur als `pendingActiveFile` vorgemerkt. Verarbeitet wird sie beim Verlassen: bei `active-leaf-change`, `file-open` oder `layout-change`, sofern sie nicht mehr aktiv ist. Bei `quit` und Unload wird sie immer verarbeitet. Zuständig sind `flushPendingActiveFile` und `isActiveNote`.
   - `isActiveNote` heißt: `getActiveFile()` ist die Notiz **und** sie ist noch in einem Markdown-Tab offen. Der zweite Teil ist nötig, weil `getActiveFile()` nach dem Schließen weiter die letzte Datei liefert.
2. `processFile` wartet zuerst auf einen laufenden Rename (`this.renaming`). Dann läuft `processFileNow`, registriert in `this.processing`.
   - Die Kette ist `getCachedCategories` → `normalizeCategories` → `parseCategoryValue` → `stripFolderPrefix` → `validateCategoryName` → Dedupe mit Alias-Merge.
   - Pfad-Links werden über `getFirstLinkpathDest` auf die echte Datei aufgelöst.
3. Falls nötig, schreibt `fileManager.processFrontMatter` die Liste. Die neue Liste wird **im Callback** aus dem frischen `frontmatter.categories` berechnet.
4. `ensureCategoryExists` läuft seriell über `categoryQueue` (Promise-Kette). Der Ablauf ist `createMissingCategoryFiles` → `findCategoryFile` → Ordner anlegen → `.md` und `.base` erzeugen.
5. `renameCategory` läuft über den Lock `this.renaming`; Renames laufen dadurch nacheinander.
   1. Es wartet auf bereits laufende `processFileNow`-Aufrufe.
   2. Dann folgt `renameCategoryNow`.
   3. Am Ende wartet `waitForReindex`, bis der Metadata-Cache die umgeschriebenen Notizen neu indiziert hat (Timeout 2 s). Erst danach dürfen wartende `processFile`-Aufrufe weiterlaufen, sonst würden sie den alten Namen aus dem Cache neu anlegen.

Wichtige Helfer:
- Pfade: `getCategoryPath`, `getBasePath`, `normalizeUserPath`.
- Ordnervergleich (case-insensitiv): `folderKey` (NFC plus `toLowerCase()` ohne Locale), `isInFolder`, `getFolder` (sucht pro Segment case-insensitiv), `resolveFolderPath` (echte Schreibweise eines vorhandenen Ordners).
- Dateisuche: `getCategoryFiles(includeCheckFolders)`, `findCategoryFile(name, includeCheckFolders = true)`, `usesCategory`.
- Weitere: `getOrphanCategories`, `COMMANDS` (Tabelle für Befehle und Settings-Anzeige), `addTextSetting` und `addToggleSetting`.

## Verbindliche Invarianten (nicht brechen)

- **Löschen nur im categoriesFolder.**
  - Orphan-Liste und `deleteCategory` sehen nie Check-Ordner oder die Vault-Wurzel.
  - Liegt die Kategorieseite nur in einem Check-Ordner, lehnt `deleteCategory` mit einer Notice ab und löscht auch die `.base` nicht.
  - Löschen geht über `fileManager.trashFile` (Papierkorb), nie `vault.delete`.
- **Die Vault-Wurzel ist nie Kategorien- oder Bases-Ordner.** `/`, `\`, `.` und `//` fallen auf den Default zurück.
- **Ordner werden case-insensitiv verglichen**: Kategorien-, Bases-, Exclude- und Check-Ordner.
  - Die Schreibweise in den Settings bleibt erhalten.
  - Neue Dateien landen im vorhandenen Ordner in dessen Schreibweise.
  - Ordnerlisten werden case-insensitiv entdoppelt.
  - Kategorienamen folgen weiter der Einstellung `caseSensitive`.
- **Keine Schreibschleifen.** Die Normalisierung muss idempotent sein: ein zweiter `processFile`-Lauf schreibt nichts. Zeichen `[ ] # ^` werden in Namen sanitisiert. Prüfen mit `tests/loop.test.js`.
- **Rename-Lock:** `processFile` und `syncAllCategories` warten auf einen laufenden Rename. Neue Einstiegspunkte, die Kategorien anlegen, müssen ebenfalls über `processFile` gehen.
- **Eigene Schreibvorgänge nur über `processFrontMatter`** (kein eigener YAML-Parser).
- **Unfertige Links** (`[[Foo`, `[[]]`) werden ignoriert, aber beim Umschreiben wörtlich behalten.
- **Korrekt geschriebene Einträge** (z. B. `[[Categories/Foo]]`) bleiben beim Umschreiben wörtlich erhalten.
- **API-Mindestversion:** Alle genutzten Obsidian-APIs müssen älter als `minAppVersion` 1.9.0 sein (Bases gibt es erst ab 1.9). Höchstes `@since` ist 1.6.6 (`trashFile`). Neu in Runde 4 sind `getRoot` und `offref`, beide 0.9.7. Das Lockfile zieht Typen 1.14.4, daher bei neuen Aufrufen `@since` in `node_modules/obsidian/obsidian.d.ts` prüfen.
- **Command-IDs nicht ändern** (Hotkeys der Nutzer hängen daran).
- **UI-Texte:** Sentence case, `setHeading()` statt h2/h3, kein `innerHTML`, keine Inline-Styles (Klassen in `styles.css`).

## Tests

- Ordner `tests/`: Obsidian-Mock (`tests/mock/obsidian.js`, per `tests/setup.js` und `bunfig.toml` als virtuelles Modul `obsidian`) und sieben Suiten.
  - Die Suiten heißen `core`, `fixes`, `adversarial`, `paths`, `active-note`, `loop` und `snapshot`.
  - Der Mock nutzt `Bun.YAML`. Snapshots in `tests/__snapshots__/` hängen daher am YAML-Format von Bun. Bei einem Bun-Update ggf. `bun test --update-snapshots` und den Diff prüfen.
- Bekannte Fehler können als `test.failing` registriert werden (Parameter `knownFailures` von `runChecks`). Aktuell gibt es **keinen** solchen Eintrag; 7e (Rename-Race) ist seit Runde 4 ein normaler Test.
- Die Rename-Mechanismen sind durch Mutationstests geprüft. Ohne das Warten auf laufende Verarbeitung, ohne das Warten auf den Index oder ohne den Lock wird jeweils mindestens ein Test rot.
- Es gibt **keinen** Test gegen ein echtes Obsidian. Manueller Test im Test-Vault steht aus.

## Was bisher erledigt wurde

- Runde 1 (20 Fixes): eigener YAML-Parser durch `processFrontMatter` ersetzt, Kategorie `null`, endgültiges Löschen, Link-Alias und Ordnerpräfix, Race beim Anlegen, Existenzprüfung in Unterordnern und Check-Ordnern, `renameCategory` neu geschrieben, `innerHTML`, `$`-Muster in Ersetzungen, normalizePath, setHeading, Sentence case, Styles nach CSS, tsc im Build, README-Abgleich.
- Runde 2: H1 (Löschen nur im Kategorienordner), H2 (Sonderzeichen, Mehrfachlinks, Schleife), M1 (Neuberechnung im Callback), Anker abtrennen, Fallow und Refactor (rund 13 % weniger Zeilen, `tslib` entfernt), `minAppVersion` 1.9.0.
- Runde 3: Vault-Wurzel abgesichert (N1), Pfad-Links aufgelöst und wörtlich behalten, aktive Notiz erst beim Verlassen, Tests ins Repo, `package-lock.json` gelöscht und `bun.lock` eingecheckt.
- Runde 4:
  - Rename-Race behoben (Lock, Warten auf laufende Verarbeitung und auf den Index). Nebeneffekt: Die Übersicht ist nach einem Rename sofort aktuell.
  - `deleteCategory` lehnt Kategorien mit Seite im Check-Ordner ab.
  - Ordnervergleich ist case-insensitiv und Unicode-sicher.
  - `Obsidian Plugin Development Guide.md` auf bun umgestellt.
  - README: Voraussetzungen (1.9.0 und Bases), Migrationshinweis, Ordnervergleich.
- Validierung: Zwei unabhängige Validatoren haben Runde 1 und 2 freigegeben. Runde 3 und 4 hat nur der ausführende Agent geprüft (Typecheck, Build, Tests, Fallow), kein unabhängiger Validator.

## Entscheidungen des Nutzers (bereits getroffen, nicht neu aufrollen)

- Orphans und Löschen nur im Kategorien-Ordner; Check-Ordner nur für die Existenzprüfung.
- Zeichen `[ ] # ^` in Kategorienamen sanitisieren, `"[[A]], [[B]]"` in mehrere Kategorien aufteilen.
- `minAppVersion` 1.9.0 (Bases).
- Refactor: Duplikate zusammenführen, keine Aufteilung in Module.
- Vault-Wurzel als Kategorien-Ordner wie leer behandeln (Fallback auf Default).
- Pfad-Links per `getFirstLinkpathDest` auflösen und korrekte Einträge wörtlich behalten.
- Aktive Notiz erst beim Verlassen verarbeiten.
- Tests ins Repo (`bun test`), `package-lock.json` löschen, `bun.lock` einchecken.
- Exclude- und Check-Ordner **case-insensitiv** vergleichen (nicht "auf den echten Pfad auflösen").
- Nicht ausgewählt (bewusst offen): Kategorie-Index.

## Nächste Schritte

1. Runde 4 und diese Datei committen und pushen (Nutzer sagt Bescheid; Commit-Message ohne KI-Hinweise). Optional vorher einen unabhängigen Validator über Runde 3 und 4 laufen lassen.
2. Manueller Test im Test-Vault (Pfad in `CLAUDE.md`), vor allem: Rename mit Link-Update (kollidiert Obsidians Link-Update mit dem anschließenden `processFrontMatter`?), Verlassen der aktiven Notiz, Löschen in den Papierkorb.
3. Empfohlene Entscheidungen für die offenen Punkte unten sind jeweils zuerst genannt. Mein Vorschlag: Punkt 1 per Zusammenfassen pro Pfad umsetzen, Rename-Vorprüfung und Version 1.1.0 beim nächsten Release, den Kategorie-Index erst bei Performance-Rückmeldungen.
4. Danach die weiteren Plugins nach demselben Ablauf (Analyse und Fix durch einen Opus-5.5-Agent, danach Validierung durch einen zweiten): CommandOverview, CopyFilePath, ObsidianRecall, ObsidianSwipeNavigation, OpenVaultInVSCode.

## Offene Punkte (Entscheidung des Nutzers nötig)

Empfehlung jeweils zuerst. Der Nutzer wollte bei offenen Punkten immer Optionen sehen.

1. **Parallele Verarbeitung derselben Notiz** (Sync, Events und Befehl gleichzeitig): Auf veraltetem Cache kann jeder Lauf `processFrontMatter` aufrufen, eine Notiz wird dann bis zu dreimal ohne inhaltliche Änderung geschrieben. Das ist keine Schleife, die Läufe konvergieren.
   - Test `adversarial` 7a (höchstens zwei Schreibvorgänge) ist im Repo stabil grün. Im langsameren Scratchpad-Mock war er schon in Runde 3 zeitabhängig rot (1 von 5 Läufen), in Runde 4 in 3 von 5. Risiko: gelegentlich rot in einer langsamen CI.
   - (a) `processFile` pro Pfad zusammenfassen: Läuft schon eine Verarbeitung, nur einen Nachlauf einplanen (Empfehlung). (b) Test-Schwelle lockern. (c) lassen.
2. **Links mit `[` oder `]` im Namen** (`[[A[1]]]`) werden nie als Kategorie erkannt und bleiben stehen (in der README dokumentiert).
   (a) lassen (Empfehlung), (b) solche Links beim Sync als Warnung melden.
3. **„Notiz verlassen“ greift nicht bei Tabs ohne Notiz** (Graph, Canvas); `quit` ist nicht garantiert.
   (a) lassen (Empfehlung), (b) Fallback-Timer (z. B. 30 s), (c) beim Fensterfokus-Verlust verarbeiten.
4. **Pfad-Links auf normale Notizen** (`[[Travel/Europe]]`) werden zu „Travel - Europe“.
   (a) lassen (Empfehlung), (b) jeden auflösbaren Pfad-Link auf den Basename abbilden.
5. **Snapshots und Bun-Version:** (a) Version festlegen, (b) bei Bedarf erneuern (Empfehlung).
6. **Obsidian-Typen 1.14.4 über minAppVersion 1.9.0:** (a) `@since` bei neuen Aufrufen prüfen (Empfehlung), (b) devDependency pinnen.
7. **Testlaufzeit ca. 35 s:** (a) lassen (Empfehlung), (b) Fake-Timer.
8. **Aus früheren Runden, nicht umgesetzt:**
   - Kategorie-Index (Map auf `TFile`, Invalidierung über Vault-Events) statt Ordner-Scans pro Kategorie. Empfohlen für große Vaults; Minimalvariante ist ein Cache pro Sync-Lauf.
   - `renameCategoryNow`: vollständige Vorprüfung und klare Meldung bei Teilfehlschlag, es gibt kein Rollback. Fallow stuft die Funktion als komplexeste Einheit ein (CRITICAL).
   - Version beim nächsten Release auf 1.1.0 anheben, `versions.json` als `{"1.0.0":"1.0.0","1.1.0":"1.9.0"}` führen (falls 1.0.0 schon veröffentlicht wurde).
   - Parser als reines Modul herauslösen (Modulaufteilung war ausdrücklich nicht gewünscht).
9. **Dokumentation in `CLAUDE.md`:** Die Zeile mit „Watch mode“ stimmt nicht (`esbuild.config.mjs` hat keinen), und `RenameCategoryModal` fehlt in der Klassenliste. Nur auf Anweisung des Nutzers ändern.

## Bekannte Grenzen (kein Bug, bewusst)

- Das Frontmatter wird beim Umschreiben komplett neu serialisiert (Obsidians Properties-Verhalten). YAML-Kommentare gehen dabei verloren.
- Mit `caseSensitive=true` auf macOS/Windows scheitert das Anlegen von „book“ neben „Book.md“ (Dateisystem).
- Namen mit führendem Punkt (`.NET`) erzeugen versteckte Dateien, die Obsidian nicht indexiert.
- Ordner sind case-insensitiv: Auf case-sensitiven Dateisystemen (Linux) gelten zwei Ordner, die sich nur in der Schreibweise unterscheiden (`Archive` und `archive`), als derselbe; es wird der zuerst gefundene genutzt.
- Ein Rename wartet bis zu 2 s auf den Metadata-Index, wenn Obsidian für eine betroffene Notiz kein `changed` meldet. In dieser Zeit wartet auch die Verarbeitung anderer Notizen.
- Ein unformatiertes `C#` wird zu `C-`. Der Link `[[C#]]` gilt als Überschriften-Link und wird zu `[[C]]` (README, Abschnitt „Upgrading from earlier versions“).
- „Delete all orphans“ fragt weiterhin nicht nach (aber Papierkorb).

## Zusammenarbeit mit dem Nutzer

- Sprache: Deutsch.
- Für Analyse, Fix und Validierung wurden getrennte Subagents mit Modell Opus 5.5 genutzt. Der Validator ändert keinen Code.
- „Commit und push“ nur, wenn der Nutzer es sagt. Commit-Skill: `/commit-push`.
- Die anderen Plugins stehen als Nächstes an, jeweils mit demselben Ablauf (Analyse und Fix, dann Validierung).
- Die Scratchpad-Dateien der Session (Backups und Validierungsskripte) sind temporär. Was bleiben soll, liegt im Repo unter `tests/`.
