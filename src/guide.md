# User Guide

[Opening and recovery](#opening-and-recovery) · [Appearance and status](#appearance-and-status) · [Reading safely](#reading-safely) · [Current limits](#current-limits)

## Opening and recovery

Use **File → Open File…** (⌘O on macOS, Ctrl+O on Windows/Linux) to select a local document. Supported Markdown extensions are `.md`, `.markdown`, `.mdown`, `.mkd` and `.mkdown`, case-insensitively. `.txt` and `.log` display literally, not as Markdown. All files must be UTF-8. MDX and editing are not supported.

In-app Open replaces this reader for an unopened path; an already displayed canonical path activates its existing reader without reload and leaves this document intact. File-manager opens of different documents create independent one-document windows. Reopening the same canonical path activates its live reader without reload. There are no tabs, recents or session restoration. Each reader owns its root, queries, media and work; committed appearance preferences are shared. A forwarded filename that cannot be represented exactly requires explicit Open File recovery rather than granting a guessed path.

**File → Reload** (⌘R / Ctrl+R) explicitly reads the displayed file again. Files do not reload automatically. A failed Open or Reload keeps the last good content, identifies the attempted target and marks the displayed content stale. Choose another file or retry Reload after correcting the problem. Opening an empty file is different from having no document.

**Cancel** is available during supported pending reading and formatting work. It ignores late results without replacing the displayed file. It is not available during the final display commit and cannot interrupt a blocked browser engine. The native file chooser also has its own Cancel.

Files are read only: reading, changing appearance and using this guide do not write to the source document or its directory. This guide is bundled with the application, not opened as a local file; closing it returns to the same reading context.

## Appearance and status

Open **Settings…** from the application menu on macOS or the Settings menu elsewhere (⌘, / Ctrl+,). Changes apply immediately; Close and Escape do not undo them. System appearance follows the OS. Both Light and Dark palette slots offer GitHub Light, GitHub Dark, Solarized Light, Solarized Dark, Dracula, Monokai and Nord, including opposite-toned combinations.

**View** provides page zoom in, out and reset (⌘/Ctrl+=, ⌘/Ctrl+− and ⌘/Ctrl+0). Reading content scales from 50% to 300%, in steps of 10%; controls stay at their normal size. Fit diagrams applies immediately to current diagrams without reparsing. **View → Show Sidebar** applies and remembers sidebar visibility independently of the status bar.

**View → Appearance** also offers System, Light and Dark; Light/Dark use ⌘/Ctrl+Shift+L/D. **Diagram → Fit Diagrams** changes the saved fit preference; **View → Show Sidebar** uses ⌘/Ctrl+Shift+B. Background readers do not own the foreground menu checkmarks.

**View → Show Status Bar** remembers whether the compact bottom summary is visible. It starts visible. Hiding it never hides errors, supported Cancel or preference recovery. **File → Document Information…** shows the displayed file's full selectable location, name, type, read-only and stale state even with status hidden.

Preferences are saved in application configuration, never beside documents. If saving or synchronization fails, the choice remains applied for now; use **Retry preferences**. A fallback notice means valid stored fields were retained while invalid fields use defaults. A valid older record without the new status preference starts with status visible.

## Reading safely

Leading YAML frontmatter is shown as read-only metadata. Invalid metadata exposes an escaped diagnostic and raw fallback while the body remains readable. Expand raw details for deep or lengthy values. Code fences are highlighted locally, task boxes are disabled, and heading/footnote links navigate within the displayed document.

```text
A .txt or .log file shows Markdown and HTML literally.
No document scripts or embedded programs are executed.
```

Local images, audio and video are scoped to the active file's canonical directory. Native player controls and codec support depend on the platform engine. Missing, blocked or undecodable resources show local feedback. Automatic remote resources, document CSS, caption tracks and srcset are not enabled. External SVG stays image-only.

Only a real pointer or keyboard activation can send permitted HTTP, HTTPS, mail or telephone links to the OS handler. That acknowledgement does not prove the external page loaded. Supported local-document links stay inside the active file's canonical directory, including symlink checks; they create or activate another reader without replacing the origin. Existing targets do not reload. A requested section belongs to that target's displayed revision; busy, composition and modal/native Save owners reject unavailable navigation rather than saving it for later. A denied link neither grants another directory nor automatically opens a chooser.

## Navigating files and headings

**File → Open Folder…** selects a recursive navigation root without opening its first file or replacing the displayed article. Files lists nested supported entries; use folder Expand/Collapse buttons. Dot/native-hidden entries and directory links are excluded. Supported file links are included only when their regular targets stay inside the selected folder. An explicitly opened hidden or outside file can remain readable without appearing in Files.

A filename opens the file; its separate **Show headings** button lazily reads H1/H2 previews. Plain text has no heading preview. **On this page** always describes the displayed document. Heading actions focus the exact section, including repeated names. If a preview's source changed before opening, the fresh file opens without guessing the old destination: choose a heading again.

**Navigate → Refresh Folder** explicitly refreshes file metadata and previews, not the active article. Partial/unavailable folders are labeled rather than shown as complete empty results. **File → Reload** also invalidates previews, including failed reloads. Files do not reload automatically.

Previous/Next File and Sibling order in **Navigate** or the sidebar browse only the displayed file's immediate folder, alphabetically or newest modified with stable ties. They stop at endpoints, never wrap, and do not invent a neighbor if the displayed file is excluded. Previous/Next also use ⌘/Ctrl+Alt+Left/Right. **File → Reveal** (⌘/Ctrl+Shift+R) sends the active file to the platform file manager without changing the reader; failures are reported.

## Finding in the document

Use **Navigate → Find in Document…** (⌘F / Ctrl+F). The nonmodal bar searches visible reading text, including metadata and code, literally and without case sensitivity. Punctuation such as `.`, `[` and `*` is not a pattern. Expand a reading or raw-metadata disclosure to include its text; navigation, help, controls and diagram-image internals are not searched.

Current/total counts, marks and wrapped navigation use the same matches. Enter advances; Shift+Enter goes back. Find Next/Previous also use ⌘G / ⌘Shift+G on macOS or F3 / Shift+F3 elsewhere. Empty input clears marks; unmatched text reports No matches. Tab leaves normally, and Escape within the bar closes it and restores reading focus. The query stays in this window for reopening, never in preferences or history. Other temporary surfaces close Find, and an actual displayed-file replacement/reload retires its old marks without changing source content.

## Exporting diagrams

Use **Diagram → Export diagrams as SVG ZIP…** or **Export diagrams as PNG ZIP…** after the current palette finishes rendering. Export uses whole diagrams, not the panned or zoomed viewport. A partial export names failed diagram ordinals before confirmation and keeps numbering gaps. With no successful diagrams there is no Save action. A new conversion failure stops the whole export rather than silently omitting another diagram.

Preparation has **Cancel** at supported boundaries. Wait for cancellation and cleanup acknowledgement; synchronous image/canvas work cannot be interrupted instantly. Preparation releases its dialog before native Save. The native chooser owns Cancel/Escape, and replacement of an existing ordinary ZIP requires explicit **Replace** confirmation (the OS may ask as well). Only the confirmed destination entry is atomically replaced; source documents are never truncated. A completed save is reported only after native commit. Changing document or applied palette retires old work; an already-started atomic commit cannot be undone.

SVG files retain bundled vendor styling and may reference resources another viewer can load. PNG conversion requires usable fonts, full-image decode and nonblank canvas output; engine allocation, decode, taint and serialization failures remain explicit. The application does not fetch remote resources to complete an export. Normal completion, errors and cancellation clean application-owned temporary output; hard process/OS termination may leave a recognizable `.taurimd-export-*.zip.part` beside a selected destination. Startup recovery checks only its application cache, never source or selected folders. Native engine fidelity and Save/focus behavior still require platform testing.

## Current limits

Mermaid fences render offline using the bundled engine and the current palette. Use **Interact with diagram** to focus its viewport: arrows pan, +/− zoom, 0 resets to the current fit preference, and Escape returns to Interact without resetting. Tab leaves naturally. Equivalent buttons include local Fit, which does not change the saved preference. Plain wheel scrolls the document; ⌘+wheel on macOS or Ctrl+wheel elsewhere zooms only the diagram under the pointer. **Original definition** is available on success and failure. Each diagram has a 50,000-character and 500-edge limit; failures show escaped local diagnostics and leave other content readable. Diagram layout cannot be interrupted synchronously. Bundled strict-mode Mermaid SVG/CSS is trusted; ordinary document HTML/CSS and native grants retain their separate protections.

Quick Open (Navigate → Quick Open…, Cmd+K on macOS or Ctrl+K elsewhere) searches the explicitly selected folder's cached index. Type a fuzzy name or a relative, absolute, home-relative (`~/`) or parent-segment path. Paths outside that folder need an explicit Choose File… or Choose Folder… action; typing never grants access. Folder results come first. Arrows select, Enter opens a file or enters a folder, and Tab completes a folder or focuses the selected file. Escape restores prior focus. Results are capped at 100 with a count notice.

Live folder updates refresh metadata and invalidate heading previews, not the displayed document. A periodic refresh and Navigate → Refresh Folder recover missed updates; unavailable live updates and incomplete folders are disclosed. Use Reload to reread the displayed file. Quick Open cached-file acceptance creates a new reader or activates an existing canonical path, preserving the origin. Its explicit **Choose File…** authorization route remains ordinary in-app Open; cancellation restores the query. Sidebar, sibling and Reload actions replace only their current reader. Markdown Viewer associations cover the five Markdown aliases only, not `.txt`, `.log`, MDX or generic text.

The intended targets are macOS 14+ Apple Silicon, Windows 11 x64 and Ubuntu 24.04 x86_64 with X11/Wayland. Native menus, IME, assistive technology, restart persistence, real media/CSP transport and platform packaging still require recorded testing on those targets. Browser fixtures and compilation are not native qualification. No signing, public release or complete dependency-notice clearance is claimed.

[Back to User Guide](#user-guide)
