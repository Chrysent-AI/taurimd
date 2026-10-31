import { useEffect, useRef, useState } from 'react';
import source from './guide.md?raw';
import { parseInWorker, type ParseJob } from './reader/worker';
import type { Reading } from './reader/parse';

export function Guide() {
  const [reading, setReading] = useState<Reading | 'failed' | null>(null);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let job: ParseJob | undefined;
    void Promise.resolve()
      .then(() => {
        if (disposed) return;
        job = parseInWorker(source, undefined, 'guide');
        return job.result;
      })
      .then((result) => {
        if (!disposed && result) setReading(result);
      })
      .catch(() => {
        if (!disposed) setReading('failed');
      });
    const element = host.current;
    const activate = (event: MouseEvent) => {
      const link =
        event.target instanceof Element ? event.target.closest('a') : null;
      if (!link || !element?.contains(link)) return;
      event.preventDefault();
      const href = link.getAttribute('href');
      if (!href?.startsWith('#reader-guide-')) return;
      const target = window.document.getElementById(href.slice(1));
      if (target && element.contains(target)) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'start' });
      }
    };
    const prevent = (event: Event) => {
      event.preventDefault();
    };
    element?.addEventListener('click', activate);
    element?.addEventListener('auxclick', prevent);
    return () => {
      disposed = true;
      job?.cancel();
      element?.removeEventListener('click', activate);
      element?.removeEventListener('auxclick', prevent);
    };
  }, []);
  return (
    <div ref={host} className="guide">
      {reading === null ? (
        <p>Loading guide…</p>
      ) : reading === 'failed' ? (
        <>
          <p>Guide formatting unavailable. The bundled text follows.</p>
          <pre className="literal">{source}</pre>
        </>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: reading.html }} />
      )}
    </div>
  );
}
