# Offline Mermaid gallery

Twelve small diagrams exercise different Mermaid grammars with the bundled
renderer. All twelve should render without a diagnostic and without fetching
external resources. Open **Original definition** on any diagram to compare its
source. See the [example index](README.md) for other reading samples and
[intentional failure and recovery](mermaid-errors.md) for the separate error case.

## Flowchart: decisions and a subgraph

A branch stays inside a local processing group. The chosen node uses a simple
fill, stroke and text color rather than document CSS.

```mermaid
flowchart LR
    Start[Select document] --> Kind{Markdown?}
    subgraph Local[Local processing]
        Kind -->|Yes| Parse[Format article]
        Kind -->|No| Literal[Show literal text]
    end
    Parse --> Read[Read offline]
    Literal --> Read
    classDef chosen fill:#e0eeee,stroke:#336666,color:#112222
    class Read chosen
```

## Sequence: alternatives, a loop and a note

The two alternatives are illustrative, not a request to access any resource.

```mermaid
sequenceDiagram
    participant Reader
    participant Cache
    Note over Reader,Cache: Local snapshot exchange
    Reader->>Cache: Request snapshot
    alt Snapshot available
        Cache-->>Reader: Return article
    else Not yet loaded
        Cache-->>Reader: Show empty state
    end
    loop Each visible section
        Reader->>Reader: Read next heading
    end
```

## Class: inheritance and composition

A specialized reader owns one snapshot.

```mermaid
classDiagram
    Reader <|-- LocalReader
    LocalReader "1" *-- "1" Snapshot : retains
    class Reader {
        +open()
    }
    class Snapshot {
        +String title
    }
```

## State: a document lifecycle

A failed reload can leave the existing reading state intact.

```mermaid
stateDiagram-v2
    [*] --> Empty
    Empty --> Reading: Open succeeds
    Reading --> Reloading: Reload
    Reloading --> Reading: Success or retained snapshot
    Reading --> [*]: Close
```

## Entity relationship: a small catalog

One collection contains many documents, each with a stable key.

```mermaid
erDiagram
    COLLECTION ||--o{ DOCUMENT : contains
    COLLECTION {
        int id PK
        string title
    }
    DOCUMENT {
        int id PK
        int collection_id FK
        string title
    }
```

## Gantt: a fixed review schedule

Explicit historical dates keep the task bars independent of the day this file is
opened. There is no moving today marker.

```mermaid
gantt
    title Offline review schedule
    dateFormat YYYY-MM-DD
    axisFormat %m-%d
    todayMarker off
    section Preparation
    Collect notes :notes, 2025-02-03, 2025-02-05
    section Review
    Read draft :read, 2025-02-05, 2025-02-07
    Check diagrams :check, 2025-02-07, 2025-02-09
```

## Pie: an illustrative document mix

The values describe a fictional set of twelve local files.

```mermaid
pie title Document mix
    "Guides" : 6
    "Notes" : 4
    "Logs" : 2
```

## Journey: a short reading session

Scores are illustrative satisfaction values, not elapsed time.

```mermaid
journey
    title Quiet reading session
    section Prepare
      Choose a document: 4: Reader
      Set a palette: 5: Reader
    section Read
      Follow headings: 5: Reader
      Review a diagram: 4: Reader
```

## Git graph: a branch and a merge

These are diagram-only commit labels, not commands to run.

```mermaid
gitGraph
    commit id: "draft"
    branch review
    checkout review
    commit id: "notes"
    checkout main
    commit id: "wording"
    merge review id: "combined"
```

## Mind map: a reading checklist

An indented hierarchy groups content and presentation checks.

```mermaid
mindmap
    root((Reading checklist))
        Content
            Headings
            Diagrams
        Presentation
            Contrast
            Text size
```

## Timeline: a fictional revision history

Fixed year labels describe stages rather than live dates.

```mermaid
timeline
    title Handbook revisions
    2023 : Gather notes
    2024 : Organize chapters : Review terminology
    2025 : Add diagrams
```

## Quadrant chart: comparing small tasks

Both coordinates are normalized values between zero and one.

```mermaid
quadrantChart
    title Review priorities
    x-axis Low effort --> High effort
    y-axis Low value --> High value
    quadrant-1 Plan
    quadrant-2 Do first
    quadrant-3 Reconsider
    quadrant-4 Simplify
    Fix typo: [0.15, 0.65]
    Rewrite chapter: [0.8, 0.85]
    Adjust spacing: [0.25, 0.2]
```

## Ordinary code remains ordinary

This fence deliberately uses `text`, so it should stay literal rather than become
a thirteenth diagram.

```text
flowchart LR
    This[Literal example] --> That[Not rendered]
```
