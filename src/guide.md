# User Guide

[Opening and recovery](#opening-and-recovery) · [Appearance and status](#appearance-and-status) · [Reading safely](#reading-safely) · [Current limits](#current-limits)

## Opening and recovery

Use **File → Open File…** (⌘O on macOS, Ctrl+O on Windows/Linux) to select a local document. Supported Markdown extensions are `.md`, `.markdown`, `.mdown`, `.mkd` and `.mkdown`, case-insensitively. `.txt` and `.log` display literally, not as Markdown. All files must be UTF-8. MDX and editing are not supported.

**File → Reload** (⌘R / Ctrl+R) explicitly reads the displayed file again. Files do not reload automatically. A failed Open or Reload keeps the last good content, identifies the attempted target and marks the displayed content stale. Choose another file or retry Reload after correcting the problem. Opening an empty file is different from having no document.

**Cancel** is available during supported pending reading and formatting work. It ignores late results without replacing the displayed file. It is not available during the final display commit and cannot interrupt a blocked browser engine. The native file chooser also has its own Cancel.

Files are read only: reading, changing appearance and using this guide do not write to the source document or its directory. This guide is bundled with the application, not opened as a local file; closing it returns to the same reading context.

## Appearance and status

Open **Settings…** from the application menu on macOS or the Settings menu elsewhere (⌘, / Ctrl+,). Changes apply immediately; Close and Escape do not undo them. System appearance follows the OS. Both Light and Dark palette slots offer GitHub Light, GitHub Dark, Solarized Light, Solarized Dark, Dracula, Monokai and Nord, including opposite-toned combinations.

**View** provides page zoom in, out and reset (⌘/Ctrl+=, ⌘/Ctrl+− and ⌘/Ctrl+0). Reading content scales from 50% to 300%, in steps of 10%; controls stay at their normal size. Fit diagrams applies immediately to current diagrams without reparsing; the sidebar default is saved for its future feature.

**View → Show Status Bar** remembers whether the compact bottom summary is visible. It starts visible. Hiding it never hides errors, supported Cancel or preference recovery. **File → Document Information…** shows the displayed file's full selectable location, name, type, read-only and stale state even with status hidden.

Preferences are saved in application configuration, never beside documents. If saving or synchronization fails, the choice remains applied for now; use **Retry preferences**. A fallback notice means valid stored fields were retained while invalid fields use defaults. A valid older record without the new status preference starts with status visible.

## Reading safely

Leading YAML frontmatter is shown as read-only metadata. Invalid metadata exposes an escaped diagnostic and raw fallback while the body remains readable. Expand raw details for deep or lengthy values. Code fences are highlighted locally, task boxes are disabled, and heading/footnote links navigate within the displayed document.

```text
A .txt or .log file shows Markdown and HTML literally.
No document scripts or embedded programs are executed.
```

Local images, audio and video are scoped to the active file's canonical directory. Native player controls and codec support depend on the platform engine. Missing, blocked or undecodable resources show local feedback. Automatic remote resources, document CSS, caption tracks and srcset are not enabled. External SVG stays image-only.

Only a real pointer or keyboard activation can send permitted HTTP, HTTPS, mail or telephone links to the OS handler. That acknowledgement does not prove the external page loaded. Supported local-document links stay inside the active file's canonical directory, including symlink checks; currently they replace this reader. A denied link neither grants another directory nor automatically opens a chooser.

## Exporting diagrams

Use **Diagram → Export diagrams as SVG ZIP…** or **Export diagrams as PNG ZIP…** after the current palette finishes rendering. Export uses whole diagrams, not the panned or zoomed viewport. A partial export names failed diagram ordinals before confirmation and keeps numbering gaps. With no successful diagrams there is no Save action. A new conversion failure stops the whole export rather than silently omitting another diagram.

Preparation has **Cancel** at supported boundaries. Wait for cancellation and cleanup acknowledgement; synchronous image/canvas work cannot be interrupted instantly. Preparation releases its dialog before native Save. The native chooser owns Cancel/Escape, and replacement of an existing ordinary ZIP requires explicit **Replace** confirmation (the OS may ask as well). Only the confirmed destination entry is atomically replaced; source documents are never truncated. A completed save is reported only after native commit. Changing document or applied palette retires old work; an already-started atomic commit cannot be undone.

SVG files retain bundled vendor styling and may reference resources another viewer can load. PNG conversion requires usable fonts, full-image decode and nonblank canvas output; engine allocation, decode, taint and serialization failures remain explicit. The application does not fetch remote resources to complete an export. Normal completion, errors and cancellation clean application-owned temporary output; hard process/OS termination may leave a recognizable `.mdviewerrsx-export-*.zip.part` beside a selected destination. Startup recovery checks only its application cache, never source or selected folders. Native engine fidelity and Save/focus behavior still require platform testing.

## Current limits

Mermaid fences render offline using the bundled engine and the current palette. Use **Interact with diagram** to focus its viewport: arrows pan, +/− zoom, 0 resets to the current fit preference, and Escape returns to Interact without resetting. Tab leaves naturally. Equivalent buttons include local Fit, which does not change the saved preference. Plain wheel scrolls the document; ⌘+wheel on macOS or Ctrl+wheel elsewhere zooms only the diagram under the pointer. **Original definition** is available on success and failure. Each diagram has a 50,000-character and 500-edge limit; failures show escaped local diagnostics and leave other content readable. Diagram layout cannot be interrupted synchronously. Bundled strict-mode Mermaid SVG/CSS is trusted; ordinary document HTML/CSS and native grants retain their separate protections.

Folder browsing, sidebar/navigation/outlines, quick open, document Find, multiple document windows and OS file associations are not implemented yet. These features are planned, not supplied by the preferences or this guide.

The intended targets are macOS 14+ Apple Silicon, Windows 11 x64 and Ubuntu 24.04 x86_64 with X11/Wayland. Native menus, IME, assistive technology, restart persistence, real media/CSP transport and platform packaging still require recorded testing on those targets. Browser fixtures and compilation are not native qualification. No signing, public release or complete dependency-notice clearance is claimed.

[Back to User Guide](#user-guide)
