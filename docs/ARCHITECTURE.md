# Architecture and safety model

This page records how released taurimd 0.1.9 keeps reading safe: what the renderer may load, what grants media, what links may do, and what each window owns. Day-to-day behavior is in [USAGE.md](USAGE.md); licensing detail is in [DEPENDENCIES.md](../DEPENDENCIES.md).

## Rendering pipeline

Markdown uses a bundled worker and one inert sanitizer boundary. Parsing, sanitizing and highlighting run in that worker; the article never receives raw HTML to interpret. Fenced code uses the locally bundled Highlight.js common language set, footnotes use the published Marked footnote extension, and frontmatter uses js-yaml's standard schema — no CDN, custom YAML executable tags, upstream patch or dependency theme injection is used.

Mermaid is bundled locally and renders strict-mode inline SVG diagrams. Its generated SVG/CSS is trusted for display and SVG export; it is not an independently sanitized or resource-free image contract.

Task boxes remain disabled. Frontmatter appears as read-only metadata, and footnotes and heading links focus their exact destinations.

## File and media grants

Local images and native audio/video controls use revocable, read-only media grants within the active document's canonical directory. The reader's custom protocol serves that media with GET, HEAD and range requests inside the grant boundary; granted URLs are opaque and are revoked when the document is replaced, reloaded or its reader closes. Bytes already buffered by the engine cannot be retracted.

Remote resources, document CSS and automatic navigation stay blocked. Attempted remote or protocol-relative references, `data:`/`blob:`/`file:` references, `srcset`, poster/source/track/CSS fetches, parent-prefix lookalikes, encoded traversal and symlinks escaping the document's directory fail closed: no automatic remote fetch, out-of-scope read, page replacement, new window or download is permitted. Caption tracks and untrusted `srcset` are inactive with visible fallback, and external SVG is image-only, never inline document markup.

Missing, denied or undecodable media shows feedback beside that resource without hiding the article, and unsupported encodings are reported explicitly rather than guessed.

## External link handoff

Only a real pointer or Enter activation can request a permitted external HTTP/HTTPS/mail/telephone handoff through the default OS application. The reader reports acknowledgement, not that an external page loaded; handler failure stays separate from reader and preferences status. No automatic navigation, prefetch or new window exists.

## Document links and one-document readers

Local supported-document links create a one-document reader, or activate an existing canonical-path reader without reloading it, then request the linked section. The receiving reader uses its own read/format/commit transaction. The origin keeps its document, root and media; a busy, modal or composing destination rejects section navigation rather than queuing it. A denied link does not grant a new directory or automatically open a chooser.

A missing target, a fragment miss or a denied escape keeps the receiving reader's last good document with visible recovery; only a matching commit focuses the requested section.

## Window ownership

Each native window owns its document, roots, queries, watcher/index, media and export lifetime; there is no shared mutable reading state. In-app Open replaces an unopened target in the invoking reader; selecting an already displayed canonical path activates its live reader without reloading it or replacing the origin. Sidebar/sibling navigation and Reload replace only their current reader. Closing a reader during scans, reads, export preparation or an atomic save reaps that reader's owned resources and reports any completed export truthfully; other readers remain usable.

There are no tabs, recents, session restoration or dedicated CLI. Reopening the application with no document restores nothing.

## Preferences persistence

Preferences are stored only in `settings-v1.json` under the application's configuration directory, never beside a source document. Saves are revisioned and atomically replaced. Valid fields survive a partially invalid record; missing or invalid fields use defaults with a visible notice, except a valid older record missing only status visibility receives the new default `true` without a corruption notice. If saving or synchronization fails, the applied appearance remains for now and **Retry preferences** is offered; that state does not claim persistence.

Shared appearance preferences propagate committed revisions, not local roots or queries: readers receive each other's committed palette and zoom changes, never each other's folders or queries.

## Intentionally absent

- No document write commands — the reader never modifies sources or directories.
- No network service, remote fetch or automatic navigation.
- No tabs, recents or session restoration; no CLI mode.
- No MDX, and no Markdown parsing for `.txt`/`.log`.
- No automatic path history saved between sessions, and no app-owned helper process left running after exit.
