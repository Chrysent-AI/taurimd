# User Guide

[Opening and recovery](#opening-and-recovery) · [Appearance and status](#appearance-and-status) · [Reading safely](#reading-safely) · [Current limits](#current-limits)

## Opening and recovery

Use **File → Open File…** (⌘O on macOS, Ctrl+O on Windows/Linux) to select a local document. Supported Markdown extensions are `.md`, `.markdown`, `.mdown`, `.mkd` and `.mkdown`, case-insensitively. `.txt` and `.log` display literally, not as Markdown. All files must be UTF-8. MDX and editing are not supported.

Opening a file makes its containing folder the **working folder**: the File Explorer on the left shows it as a watched tree, and Quick Open searches the same index. No separate folder choice exists. A directory that cannot be read (for example, a permission-denied subfolder) degrades to a labeled issue or a partial tree in the explorer, never a dialog. An explicitly opened hidden or otherwise excluded file stays readable but may not appear in the tree.

In-app Open replaces this reader for an unopened path; an already displayed canonical path activates its existing reader without reload and leaves this document intact. File-manager opens of different documents create independent one-document windows. Reopening the same canonical path activates its live reader without reload. There are no tabs, recents or session restoration. Each reader owns its working folder, queries, media and work; committed appearance preferences are shared. A forwarded filename that cannot be represented exactly requires explicit Open File recovery rather than granting a guessed path.

**File → Reload** (⌘R / Ctrl+R) explicitly reads the displayed file again. Files do not reload automatically. A failed Open or Reload keeps the last good content, identifies the attempted target and marks the displayed content stale. Choose another file or retry Reload after correcting the problem. Opening an empty file is different from having no document.

**Cancel** is available during supported pending reading and formatting work. It ignores late results without replacing the displayed file. It is not available during the final display commit and cannot interrupt a blocked browser engine. The native file chooser also has its own Cancel.

Files are read only: reading, changing appearance and using this guide do not write to the source document or its directory. This guide is bundled with the application, not opened as a local file; closing it returns to the same reading context.

## Appearance and status

Open **Settings…** from the application menu on macOS or the Settings menu elsewhere (⌘, / Ctrl+,). Changes apply immediately; Close and Escape do not undo them. System appearance follows the OS. Both Light and Dark palette slots offer GitHub Light, GitHub Dark, Solarized Light, Solarized Dark, Dracula, Monokai and Nord, including opposite-toned combinations.

**View** provides page zoom in, out and reset (⌘/Ctrl+=, ⌘/Ctrl+− and ⌘/Ctrl+0). Reading content scales from 50% to 300%, in steps of 10%; controls stay at their normal size. Fit diagrams applies immediately to current diagrams without reparsing. **View → Show File Explorer** applies and remembers the left pane's visibility independently of the status bar, and **View → Show Table of Contents** does the same for the right-hand pane. Escape leaves native full screen (the macOS green-button state or its Windows/Linux equivalent) whenever no in-app surface owns the key: an open dialog, the find bar or a focused diagram viewport close or exit as usual first, and the next Escape then leaves full screen.

**View → Appearance** also offers System, Light and Dark; Light/Dark use ⌘/Ctrl+Shift+L/D. **Diagram → Fit Diagrams** changes the saved fit preference; **View → Show File Explorer** uses ⌘/Ctrl+Shift+B. Background readers do not own the foreground menu checkmarks.

**View → Show Status Bar** remembers whether the compact bottom summary is visible. It starts visible. Hiding it never hides errors, supported Cancel or preference recovery. **File → Document Information…** shows the displayed file's full selectable location, name, type, read-only and stale state even with status hidden.

Preferences are saved in application configuration, never beside documents. If saving or synchronization fails, the choice remains applied for now; use **Retry preferences**. A fallback notice means valid stored fields were retained while invalid fields use defaults. A valid older record without the status, depth or pane preferences starts with status visible, a two-level index and both panes visible.

## Reading safely

Leading YAML frontmatter is shown as read-only metadata. Invalid metadata exposes an escaped diagnostic and raw fallback while the body remains readable. Expand raw details for deep or lengthy values. Code fences are highlighted locally, task boxes are disabled, and heading/footnote links navigate within the displayed document.

```text
A .txt or .log file shows Markdown and HTML literally.
No document scripts or embedded programs are executed.
```

Local images, audio and video are scoped to the active file's canonical directory. Native player controls and codec support depend on the platform engine. Missing, blocked or undecodable resources show local feedback. Automatic remote resources, document CSS, caption tracks and srcset are not enabled. External SVG stays image-only.

Only a real pointer or keyboard activation can send permitted HTTP, HTTPS, mail or telephone links to the OS handler. That acknowledgement does not prove the external page loaded. Supported local-document links stay inside the active file's canonical directory, including symlink checks; they create or activate another reader without replacing the origin. Existing targets do not reload. A requested section belongs to that target's displayed revision; busy, composition and modal/native Save owners reject unavailable navigation rather than saving it for later. A denied link neither grants another directory nor automatically opens a chooser.

## Navigating files and headings

The **File Explorer** (left pane) lists the working folder's nested supported entries; a folder row expands or collapses in one click. Dot/native-hidden entries and directory links are excluded. The tree is indexed to the depth set in **Settings → File Explorer → Indexing depth** — 1 to 8 levels, defaulting to 2 — and changing the depth rescans the folder. Vendored, dependency and build-output directories — `node_modules`, `.git`, `target`, `dist`, `build`, `.venv`, `venv`, `__pycache__` — are never indexed or watched, whatever the depth; they are simply absent from the tree. Deeper directories may appear as boundary entries whose contents were never read; Quick Open's **Read this directory** flow can pull one specific directory into the index on demand. Opening another file from a different folder replaces the working folder and its watcher; reopening from the same folder keeps the existing index.

A filename opens the file; its separate **Headings** button lazily reads H1/H2 previews. Opening a Markdown file expands that file's own heading group once, so its headings are visible without a second action; hiding it again stays hidden until the next successful open of that same file. Plain text has no heading preview. **On this page** (right pane) always describes the displayed document. Heading actions focus the exact section, including repeated names. If a preview's source changed before opening, the fresh file opens without guessing the old destination: choose a heading again.

**Navigate → Refresh Folder** explicitly refreshes file metadata and previews, not the active article. Partial/unavailable folders are labeled rather than shown as complete empty results. **File → Reload** also invalidates previews, including failed reloads. Files do not reload automatically.

**Navigate → File Order** and the Settings dialog's File order section set the remembered order for the file list and for sibling navigation: Name, Date modified or Size (bytes), each ascending or descending. Folders stay first, files whose date or size is unknown sort after known ones in both directions, and equal values keep the native name and path order. The choice is a preference: it applies everywhere in this app, is remembered between sessions, and never reorders the Quick Open list.

Previous/Next File in the sidebar and **Navigate → Previous File / Next File** move to the previous or next sibling in that same order; **First File** and **Last File** in **Navigate** jump to its ends. They stop at endpoints, never wrap, and do not invent a neighbor if the displayed file is excluded. Previous/Next use ⌘/Ctrl+Left/Right and First/Last use ⌘/Ctrl+Up/Down; plain arrow keys keep their normal meaning, and a focused text field keeps its own caret keys. **File → Reveal** (⌘/Ctrl+Shift+R) sends the active file to the platform file manager without changing the reader; failures are reported.

## Finding in the document

Use **Navigate → Find in Document…** (⌘F / Ctrl+F). The nonmodal bar searches visible reading text, including metadata and code, literally and without case sensitivity. Punctuation such as `.`, `[` and `*` is not a pattern. Expand a reading or raw-metadata disclosure to include its text; navigation, help, controls and diagram-image internals are not searched.

Current/total counts, marks and wrapped navigation use the same matches. Enter advances; Shift+Enter goes back. Find Next/Previous also use ⌘G / ⌘Shift+G on macOS or F3 / Shift+F3 elsewhere. Empty input clears marks; unmatched text reports No matches. Tab leaves normally, and Escape within the bar closes it and restores reading focus. The query stays in this window for reopening, never in preferences or history. Other temporary surfaces close Find, and an actual displayed-file replacement/reload retires its old marks without changing source content.

## Exporting diagrams

Use **Diagram → Export diagrams as SVG ZIP…** or **Export diagrams as PNG ZIP…** after the current palette finishes rendering. Export uses whole diagrams, not the panned or zoomed viewport. A partial export names failed diagram ordinals before confirmation and keeps numbering gaps. With no successful diagrams there is no Save action. A new conversion failure stops the whole export rather than silently omitting another diagram.

Preparation has **Cancel** at supported boundaries. Wait for cancellation and cleanup acknowledgement; synchronous image/canvas work cannot be interrupted instantly. Preparation releases its dialog before native Save. The native chooser owns Cancel/Escape, and replacement of an existing ordinary ZIP requires explicit **Replace** confirmation (the OS may ask as well). Only the confirmed destination entry is atomically replaced; source documents are never truncated. A completed save is reported only after native commit. Changing document or applied palette retires old work; an already-started atomic commit cannot be undone.

SVG files retain bundled vendor styling and may reference resources another viewer can load. PNG conversion requires usable fonts, full-image decode and nonblank canvas output; engine allocation, decode, taint and serialization failures remain explicit. The application does not fetch remote resources to complete an export. Normal completion, errors and cancellation clean application-owned temporary output; hard process/OS termination may leave a recognizable `.taurimd-export-*.zip.part` beside a selected destination. Startup recovery checks only its application cache, never source or selected folders. Native engine fidelity and Save/focus behavior still require platform testing.

## Current limits

Mermaid fences render offline using the bundled engine and the current palette. Use **Interact with diagram** to focus its viewport: arrows pan, +/− zoom, 0 resets to the current fit preference, and Escape returns to Interact without resetting. Tab leaves naturally. Equivalent buttons include local Fit, which does not change the saved preference. Plain wheel scrolls the document; ⌘+wheel on macOS or Ctrl+wheel elsewhere zooms only the diagram under the pointer. **Original definition** is available on success and failure. Each diagram has a 50,000-character and 500-edge limit; failures show escaped local diagnostics and leave other content readable. Diagram layout cannot be interrupted synchronously. Bundled strict-mode Mermaid SVG/CSS is trusted; ordinary document HTML/CSS and native grants retain their separate protections.

Quick Open (Navigate → Quick Open…, Cmd+K on macOS or Ctrl+K elsewhere) searches the working folder's cached index — the folder established automatically when a file was opened, indexed to the configured depth. Type a fuzzy name or a relative, absolute, home-relative (`~/`) or parent-segment path. Paths outside that folder need an explicit Choose File… action; typing never grants access. Folder results come first. Arrows select, Enter opens a file or enters a folder, and Tab completes a folder — including beyond the indexed depth — or focuses the selected file. Escape restores prior focus. Results are capped at 100 with a count notice.

Live folder updates refresh metadata and invalidate heading previews, not the displayed document. A periodic refresh and Navigate → Refresh Folder recover missed updates; unavailable live updates and incomplete folders are disclosed. Use Reload to reread the displayed file. Quick Open cached-file acceptance creates a new reader or activates an existing canonical path, preserving the origin. Its explicit **Choose File…** authorization route remains ordinary in-app Open; cancellation restores the query. Sidebar, sibling and Reload actions replace only their current reader. Markdown Viewer associations cover the five Markdown aliases only, not `.txt`, `.log`, MDX or generic text.

The intended targets are macOS 15+ Apple Silicon, Windows 11 x64 and Ubuntu 24.04 x86_64 with X11/Wayland. Native menus, IME, assistive technology, restart persistence, real media/CSP transport and platform packaging still require recorded testing on those targets. Browser fixtures and compilation are not native qualification. No signing, public release or complete dependency-notice clearance is claimed.

[Back to User Guide](#user-guide)
