# Offline reading examples

Open these local files in MDViewerRSX. The examples use original neutral content
under the repository's MIT license; the Mermaid examples require no remote
assets, fonts or services.

| File                                             | Expected outcome                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [Basic reading](reading.md)                      | Headings, a table, disabled task boxes and literal code.                                                                                        |
| [Rich text](rich-text.md)                        | Frontmatter, highlighted code, footnotes and heading links.                                                                                     |
| [Literal text](literal.txt)                      | Plain text displayed without Markdown interpretation.                                                                                           |
| [Mermaid gallery](mermaid.md)                    | Twelve valid diagrams, one of each type listed below; no render errors. The final `text` fence stays literal.                                   |
| [Intentional Mermaid failure](mermaid-errors.md) | Three Mermaid blocks: valid, intentionally invalid, then a valid duplicate. Only diagram 2 reports a local error; later content still displays. |

## Gallery contents

1. [Flowchart](mermaid.md#flowchart-decisions-and-a-subgraph): decision branches, a subgraph and a safe node style.
2. [Sequence](mermaid.md#sequence-alternatives-a-loop-and-a-note): participants, alternatives, a loop and a note.
3. [Class](mermaid.md#class-inheritance-and-composition): inheritance, composition and members.
4. [State](mermaid.md#state-a-document-lifecycle): start, transitions and end using `stateDiagram-v2`.
5. [Entity relationship](mermaid.md#entity-relationship-a-small-catalog): cardinality and key attributes.
6. [Gantt](mermaid.md#gantt-a-fixed-review-schedule): sections and fixed explicit dates without a today marker.
7. [Pie](mermaid.md#pie-an-illustrative-document-mix): labeled proportions.
8. [Journey](mermaid.md#journey-a-short-reading-session): sections, actors and scores.
9. [Git graph](mermaid.md#git-graph-a-branch-and-a-merge): commits, branching and merging.
10. [Mind map](mermaid.md#mind-map-a-reading-checklist): an indented hierarchy.
11. [Timeline](mermaid.md#timeline-a-fictional-revision-history): dated events.
12. [Quadrant chart](mermaid.md#quadrant-chart-comparing-small-tasks): axes, quadrants and normalized points.

## What to check

- Open the gallery offline: expect twelve nonempty diagrams with readable labels,
  not raw Mermaid code or error messages.
- Use **Original definition** to inspect a fence. Local interaction controls let
  you pan, zoom, fit and reset without editing the file.
- Open the intentional-error file separately: expect two drawings and one local
  diagnostic, not a blank article or a stalled rendering indicator. Check the
  original definition on the failed block and the valid block that follows it.
- Relative links to these documents are supported local-document links within
  the active document's directory scope. Remote images remain blocked. Folder
  browsing/directory navigation and export are not implemented.

The browser regression reads the two Mermaid files directly from disk and passes
those bytes through the actual App, parser worker, sanitizer and bundled Mermaid
renderer in Chromium, Firefox and WebKit. Native command responses are test
doubles: this does not certify the native file chooser, filesystem grants or
platform webviews.
