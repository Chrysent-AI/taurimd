import type { Metadata, MetadataValue } from './frontmatter';
function Value({ value }: { value: MetadataValue }) {
  if (value.kind === 'scalar') return <span>{value.text}</span>;
  if (value.kind === 'list')
    return (
      <ul>
        {value.items.map((item, index) => (
          <li key={index}>
            <Value value={item} />
          </li>
        ))}
      </ul>
    );
  return (
    <dl>
      {value.entries.map(({ key, value }, index) => (
        <div key={index}>
          <dt>{key}</dt>
          <dd>
            <Value value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function MetadataCard({ metadata }: { metadata: Metadata }) {
  if (!metadata) return null;
  return (
    <section className="metadata" aria-label="Document metadata">
      <strong>Document metadata</strong>
      {metadata.kind === 'value' ? (
        <Value value={metadata.value} />
      ) : (
        <>
          <p>
            {metadata.malformed
              ? 'Metadata could not be read. The document body is shown below.'
              : 'Metadata is shown as complete YAML to keep its structure readable.'}
          </p>
          <p className="metadata-diagnostic">{metadata.diagnostic}</p>
          <details>
            <summary>
              {metadata.malformed
                ? 'View raw metadata'
                : 'View complete metadata (YAML)'}
            </summary>
            {/* Keyboard access to this locally scrolling, read-only text region. */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
            <pre role="region" tabIndex={0} aria-label="Complete raw metadata">
              {metadata.raw}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
