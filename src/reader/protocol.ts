import type { Metadata, MetadataValue } from './frontmatter';
import type { ParsedMarkdown } from './parse';
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function metadataValue(value: unknown, depth = 0): value is MetadataValue {
  if (!record(value) || depth > 9) return false;
  if (value.kind === 'scalar') return typeof value.text === 'string';
  if (value.kind === 'list')
    return (
      Array.isArray(value.items) &&
      value.items.every((item: unknown) => metadataValue(item, depth + 1))
    );
  return (
    value.kind === 'mapping' &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry: unknown) =>
        record(entry) &&
        typeof entry.key === 'string' &&
        metadataValue(entry.value, depth + 1),
    )
  );
}
function metadata(value: unknown): value is Metadata {
  return (
    value === null ||
    (record(value) &&
      ((value.kind === 'value' && metadataValue(value.value)) ||
        (value.kind === 'fallback' &&
          typeof value.raw === 'string' &&
          typeof value.diagnostic === 'string' &&
          typeof value.malformed === 'boolean')))
  );
}
export function isParsedMarkdown(value: unknown): value is ParsedMarkdown {
  return (
    record(value) &&
    typeof value.html === 'string' &&
    typeof value.prefix === 'string' &&
    /^mdr-[a-f0-9]{32}-$/.test(value.prefix) &&
    metadata(value.metadata) &&
    Array.isArray(value.codeKeys) &&
    value.codeKeys.every(
      (key: unknown) =>
        typeof key === 'string' && key.startsWith(String(value.prefix)),
    ) &&
    Array.isArray(value.diagrams) &&
    value.diagrams.every(
      (diagram: unknown, index: number) =>
        record(diagram) &&
        typeof diagram.slot === 'string' &&
        value.codeKeys instanceof Array &&
        value.codeKeys.includes(diagram.slot) &&
        typeof diagram.source === 'string' &&
        value.diagrams instanceof Array &&
        value.diagrams.findIndex(
          (item: unknown) => record(item) && item.slot === diagram.slot,
        ) === index,
    ) &&
    Array.isArray(value.notes) &&
    value.notes.every(
      (note: unknown) =>
        record(note) &&
        typeof note.label === 'string' &&
        typeof note.key === 'string' &&
        /^n\d+$/.test(note.key) &&
        typeof note.number === 'number' &&
        Number.isSafeInteger(note.number) &&
        note.number > 0 &&
        typeof note.occurrences === 'number' &&
        Number.isSafeInteger(note.occurrences) &&
        note.occurrences > 0,
    )
  );
}
