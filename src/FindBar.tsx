import type { RefObject } from 'react';
import type { FindState } from './reader/find';

export function FindBar({
  input,
  query,
  result,
  composing,
  change,
  move,
  close,
}: {
  input: RefObject<HTMLInputElement | null>;
  query: string;
  result: FindState;
  composing: { current: boolean };
  change: (query: string) => void;
  move: (direction: number) => void;
  close: () => void;
}) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Delegate only the contained native controls' context keys; this is not a focusable widget.
    <section
      className="find-bar"
      aria-label="Find in document"
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        )
          return;
        if (
          composing.current ||
          event.nativeEvent.isComposing ||
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy IME engines may report 229 without isComposing.
          event.keyCode === 229
        ) {
          if (
            event.key === 'Enter' ||
            event.key === 'Escape' ||
            event.key === ' '
          )
            event.preventDefault();
          return;
        }
        if (event.key === 'Escape' && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === 'Enter' && event.target === input.current) {
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <label htmlFor="document-query">Find in document</label>
      <input
        id="document-query"
        type="text"
        ref={input}
        value={query}
        autoComplete="off"
        spellCheck={false}
        aria-describedby="find-help"
        onChange={(event) => {
          change(event.target.value);
        }}
      />
      <div className="commands">
        <button
          type="button"
          tabIndex={0}
          disabled={!result.total}
          onClick={() => {
            if (!composing.current) move(-1);
          }}
        >
          Previous match
        </button>
        <button
          type="button"
          tabIndex={0}
          disabled={!result.total}
          onClick={() => {
            if (!composing.current) move(1);
          }}
        >
          Next match
        </button>
        <button
          type="button"
          tabIndex={0}
          onClick={() => {
            if (!composing.current) close();
          }}
        >
          Close find
        </button>
      </div>
      <p role="status">
        {result.error ||
          (!query
            ? 'Type to find in this document'
            : result.total
              ? `${String(result.current)} of ${String(result.total)}`
              : 'No matches')}
      </p>
      <p id="find-help" className="sr-only">
        Enter: next match. Shift+Enter: previous match. Escape: close find.
      </p>
    </section>
  );
}
