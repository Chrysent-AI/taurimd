import { DEFAULT_SCHEMA, load } from 'js-yaml';

export type MetadataValue =
  | { kind: 'scalar'; text: string }
  | { kind: 'list'; items: MetadataValue[] }
  | { kind: 'mapping'; entries: { key: string; value: MetadataValue }[] };
export type Metadata =
  | { kind: 'value'; value: MetadataValue }
  | { kind: 'fallback'; raw: string; diagnostic: string; malformed: boolean }
  | null;

export function frontmatter(source: string): {
  body: string;
  metadata: Metadata;
} {
  const text = source.replace(/^\uFEFF/, '');
  const opening = /^---[ \t]*\r?\n/.exec(text);
  if (!opening) return { body: text, metadata: null };
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(text);
  if (!end) return { body: text, metadata: null };
  const raw = text.slice(opening[0].length, end.index);
  const body = text.slice(end.index + end[0].length);
  // A complete delimiter pair is split independently of YAML success.
  try {
    const value: unknown = load(raw, { schema: DEFAULT_SCHEMA });
    if (
      value === undefined ||
      (value === null &&
        raw.split(/\r?\n/).every((line) => /^\s*(?:#.*)?$/.test(line))) ||
      (typeof value === 'object' &&
        value !== null &&
        !(value instanceof Date) &&
        !(value instanceof Uint8Array) &&
        Object.keys(value).length === 0)
    )
      return { body, metadata: null };
    const visited = new Set<object>();
    let nodes = 0;
    let length = 0;
    function normalize(input: unknown, depth: number): MetadataValue {
      if (depth > 8 || ++nodes > 120)
        throw new Error('Metadata structure is extensive or deeply nested.');
      if (typeof input === 'object' && input !== null) {
        if (visited.has(input))
          throw new Error('Metadata contains shared aliases or a cycle.');
        visited.add(input);
        if (input instanceof Date)
          return { kind: 'scalar', text: input.toISOString() };
        if (input instanceof Uint8Array) {
          length += input.length * 3;
          if (length > 16000)
            throw new Error('Metadata binary value is lengthy.');
          return {
            kind: 'scalar',
            text: `Binary (hex): ${Array.from(input, (byte) => byte.toString(16).padStart(2, '0')).join(' ')}`,
          };
        }
        if (Array.isArray(input))
          return {
            kind: 'list',
            items: input.map((item: unknown) => normalize(item, depth + 1)),
          };
        return {
          kind: 'mapping',
          entries: Object.entries(input).map(
            ([key, item]: [string, unknown]) => {
              length += key.length;
              if (length > 16000) throw new Error('Metadata text is lengthy.');
              return { key, value: normalize(item, depth + 1) };
            },
          ),
        };
      }
      if (
        input !== null &&
        typeof input !== 'string' &&
        typeof input !== 'boolean' &&
        typeof input !== 'number' &&
        input !== undefined
      )
        throw new Error('Metadata value requires raw presentation.');
      const text =
        input === null ? 'null' : input === '' ? '""' : String(input);
      length += text.length;
      if (length > 16000) throw new Error('Metadata text is lengthy.');
      return { kind: 'scalar', text };
    }
    try {
      return { body, metadata: { kind: 'value', value: normalize(value, 0) } };
    } catch (error) {
      return {
        body,
        metadata: {
          kind: 'fallback',
          raw,
          malformed: false,
          diagnostic:
            error instanceof Error
              ? error.message
              : 'Metadata presentation is extensive.',
        },
      };
    }
  } catch (error) {
    return {
      body,
      metadata: {
        kind: 'fallback',
        raw,
        malformed: true,
        diagnostic:
          error instanceof Error ? error.message : 'YAML could not be read.',
      },
    };
  }
}
