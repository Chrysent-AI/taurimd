---
title: Offline rich reading
published: 2026-10-30
values:
  enabled: false
  count: 0
  optional: null
topics:
  - metadata
  - code
  - footnotes
---

# Offline text reading

Metadata is separate from the body. All values are read-only text.

[Go to code](#code) or read a note[^label] and its repeated reference[^label].

## Code

```typescript
// Highlighting is bundled locally.
interface Reading {
  title: string;
  count: number;
}
const reading: Reading = { title: 'Offline', count: 42 };
console.log(reading.title, true);
```

Unknown languages remain literal, including angle brackets:

```unknown-language
<example key="literal"> & unchanged
```

## Repeated heading

Heading destinations remain distinct.

## Repeated heading

[Go to the second repeated heading](#repeated-heading-2).

- [x] Read-only task
- [ ] No source changes

[^label]: Footnote definitions have their own destinations. Each return link goes to its exact reference occurrence.
