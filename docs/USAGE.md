# Using taurimd

This guide documents released taurimd 0.1.9 behavior. The [README](../README.md) covers install, build and platforms; [ARCHITECTURE.md](ARCHITECTURE.md) explains why the reader behaves the way it does.

## Opening documents

Open a UTF-8 `.md`, `.markdown`, `.mdown`, `.mkd` or `.mkdown` file using the native **File → Open File…** menu (⌘O on macOS, Ctrl+O elsewhere). Extension matching is case-insensitive. `.txt` and `.log` display literally and never enter Markdown parsing. MDX is not supported.

In-app Open replaces an unopened target in the invoking reader; selecting an already displayed canonical path activates its live reader without reloading it or replacing the origin. File-manager opens of different documents create separate one-document readers; repeated canonical paths focus existing readers instead. A forwarded filename that cannot be represented exactly requires explicit Open File recovery rather than granting a guessed path.

**File → Reload** (⌘R / Ctrl+R) reads the granted file again; files do not reload automatically. A failed replacement or reload preserves the last good document, identifies the attempted target and marks it stale. Choose another file or retry Reload after correcting the problem. Opening an empty file is different from having no document.

## Reading the page

Frontmatter appears as read-only metadata, fenced code uses bundled highlighting, and footnotes and heading links focus their exact destinations. Task boxes remain disabled. `.txt` and `.log` files render literally, so angle brackets and Markdown punctuation display without interpretation.

Find matches literal text. Mermaid diagrams render offline and stay interactive; **Diagram → Fit Diagrams** changes the saved fit preference without reparsing the document. Diagrams can be exported as SVG/PNG inside a ZIP.

Missing, denied or undecodable local media shows feedback beside that resource without hiding the article. Remote resources, document CSS and automatic navigation stay blocked — see [ARCHITECTURE.md](ARCHITECTURE.md#file-and-media-grants).

No network service is required. Try `examples/rich-text.md`, `examples/reading.md` and `examples/literal.txt` offline.

## Media

Local images and native audio/video controls use revocable, read-only media grants within the active document's canonical directory. Bytes already buffered by the engine cannot be retracted, but replacing or reloading a document, or closing its reader, revokes that document's grants. Replacing or reloading while media is loaded preserves the player and the last good document; a later change of palette or reading zoom retains playback, selection and disclosure state without reparsing.

Caption tracks and untrusted `srcset` are inactive with visible fallback. External SVG is image-only, never inline document markup.

## Links

Only a real pointer or Enter activation can request a permitted external HTTP/HTTPS/mail/telephone handoff through the default OS application. The reader reports acknowledgement, not that an external page loaded. Handler failure stays separate from reader and preferences status.

Local supported-document links create a one-document reader, or activate an existing canonical-path reader without reloading it, then request the linked section. The origin keeps its document, root and media; a busy, modal or composing destination rejects section navigation rather than queuing it, and a denied link does not grant a new directory or automatically open a chooser.

## Folder tree, siblings and Quick Open

Folder trees, sibling navigation, cached Quick Open, literal Find, offline Mermaid interaction and SVG/PNG diagram ZIP export are available through the native menus and their contextual controls. The reader watches the browsed folder for changes.

Sibling navigation uses Cmd/Ctrl+Left/Right, with the first and last sibling at Cmd/Ctrl+Up/Down. Reveal uses Cmd/Ctrl+Shift+R. Quick Open (⌘K / Ctrl+K) searches a cached index; accepting a cached file creates or focuses its reader, and the **Choose File…** fallback is an ordinary native Open authorization whose cancellation restores the query. Sidebar visibility uses Cmd/Ctrl+Shift+B and is a saved preference.

Sidebar/sibling navigation and Reload replace only their current reader, never other windows.

## Status, information and recovery

The compact bottom status describes the displayed file, not the pending selection. **View → Show Status Bar** hides or shows it and remembers the choice; it starts visible. **File → Document Information…** exposes the displayed file's full selectable path, name, type, read-only and stale state, even when the status bar is hidden.

Conditional recovery stays available outside the article and the hidden status, including supported Cancel and preference Retry. Cancel never changes the displayed source and is unavailable during the final display commit; it cannot interrupt a blocked engine. There are no document write commands.

## Guide and dialogs

**Help → User Guide** opens bundled Markdown without replacing the active file, borrowing its media grants, reparsing it or deliberately pausing playback. Guide, Settings, Document Information and About share one temporary dialog slot, with Close, composition-aware Escape, link-inclusive Tab traversal and reading-focus restoration. Guide is unavailable during pending reading so Cancel cannot be stranded behind it. About reports the product version and MIT ownership, not distribution qualification.

## Appearance and preferences

Open **Settings…** from the macOS application menu or the Settings menu on other platforms (⌘, on macOS, Ctrl+, elsewhere). Changes apply immediately; Close and Escape do not undo them. System appearance follows the OS; forced Light/Dark selects the corresponding saved palette slot. Both selectors always offer GitHub Light, GitHub Dark, Solarized Light, Solarized Dark, Dracula, Monokai and Nord — even a dark-toned palette in the Light slot or a light-toned palette in the Dark slot.

Page zoom scales reading content only, from 50% to 300% in 10-point steps, with reset to 100%. The native View menu provides the same actions (⌘/Ctrl+=, ⌘/Ctrl+−, ⌘/Ctrl+0). Fit diagrams and sidebar visibility are saved preferences, also available through Diagram and View. Appearance modes are discoverable in View; Light/Dark use ⌘/Ctrl+Shift+L/D. Background readers do not own the foreground menu checkmarks.

File order is a saved preference too. **Navigate → File Order** and the two labelled selects above the file tree set it: Name, Date modified or Size (bytes), each ascending or descending. The file list and the sibling navigation always use the same order, folders stay first, files whose date or size is unknown sort after known ones in both directions, and equal values keep the native name and path order. The choice applies everywhere in the app and is remembered between sessions; it never reorders the Quick Open list, and changing it never replaces the displayed document or its reading state.

## Where preferences live

Preferences are stored only in `settings-v1.json` under the application's configuration directory, never beside a source document. Valid fields survive a partially invalid record; missing or invalid fields use defaults with a visible notice, except a valid older record missing only status visibility receives the new default `true` without a corruption notice. Saves are revisioned and atomically replaced. If saving or synchronization fails, the current appearance remains applied for now and **Retry preferences** is available; that state does not claim persistence. Appearance changes do not reload or reparse the document.

Shared appearance preferences propagate committed revisions, not local roots or queries: changing the palette in one reader updates the menus and palettes of the others without touching their documents.
