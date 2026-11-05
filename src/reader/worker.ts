import { isParsedMarkdown } from './protocol';
import type { Reading } from './parse';
import type { Snapshot } from '../types';
import { sanitizeReading } from './sanitize';

// The parse worker is an optimization, never a correctness dependency.
// On macOS's packaged WKWebView, regex-heavy work inside a worker runs
// without the tiers the page context gets: measured parses grow
// quadratically (a 2MB document took 12s in the worker and 0.3s on the
// main thread of the same engine). Bound the worker attempt and fall
// back to the equivalent main-thread parse so a stalled or slow worker
// can never leave the reader stuck on its loading stage.
const WORKER_PARSE_BUDGET_MS = 3000;

export interface ParseInWorkerOptions {
  workerUrl?: URL;
  budgetMs?: number;
}
export interface ParseJob {
  result: Promise<Reading>;
  cancel(): void;
}
export function parseInWorker(
  source: string,
  snapshot?: Snapshot,
  namespace?: string,
  options?: ParseInWorkerOptions,
): ParseJob {
  // The literal `new URL(..., import.meta.url)` first argument is what the
  // bundler statically detects as a worker entry; keep it in its own branch
  // so the packaged worker stays a bundled chunk instead of an inline stub.
  const worker = options?.workerUrl
    ? new Worker(options.workerUrl, { type: 'module' })
    : new Worker(new URL('./parse.worker.ts', import.meta.url), {
        type: 'module',
      });
  let rejectJob: (reason: Error) => void = () => {};
  let resolveJob: (reading: Reading) => void = () => {};
  let settled = false;
  let budget: ReturnType<typeof setTimeout> | null = null;
  const startedAt = Date.now();
  // App Nap can suspend a backgrounded reader's timers, so the watchdog
  // timer may not fire while the window is occluded; when the reader gains
  // focus or visibility again, an elapsed budget fires immediately.
  const nudgeOnAttention = () => {
    if (Date.now() - startedAt >= (options?.budgetMs ?? WORKER_PARSE_BUDGET_MS))
      finishOnMainThread();
  };
  window.addEventListener('focus', nudgeOnAttention);
  window.document.addEventListener('visibilitychange', nudgeOnAttention);
  const settle = (run: () => void) => {
    if (settled) return;
    settled = true;
    if (budget !== null) clearTimeout(budget);
    window.removeEventListener('focus', nudgeOnAttention);
    window.document.removeEventListener('visibilitychange', nudgeOnAttention);
    run();
  };
  const result = new Promise<Reading>((resolve, reject) => {
    resolveJob = resolve;
    rejectJob = reject;
    budget = setTimeout(() => {
      window.removeEventListener('focus', nudgeOnAttention);
      window.document.removeEventListener('visibilitychange', nudgeOnAttention);
      finishOnMainThread();
    }, options?.budgetMs ?? WORKER_PARSE_BUDGET_MS);
    worker.onmessage = (event: MessageEvent<unknown>) => {
      worker.terminate();
      settle(() => {
        const data = event.data;
        if (isParsedMarkdown(data)) {
          try {
            resolve(
              sanitizeReading(
                data,
                snapshot
                  ? `d${String(snapshot.documentId)}-r${String(snapshot.revision)}`
                  : namespace,
              ),
            );
          } catch {
            reject(new Error('Content sanitization failed.'));
          }
        } else {
          reject(new Error('Markdown parsing failed.'));
        }
      });
    };
    worker.onerror = () => {
      worker.terminate();
      // A worker that never loads (or dies mid-parse) is exactly the case
      // the fallback exists for; the main thread produces the reading.
      finishOnMainThread();
    };
    worker.onmessageerror = () => {
      worker.terminate();
      settle(() => {
        reject(new Error('The Markdown response could not be read.'));
      });
    };
    worker.postMessage(source);
  });
  function finishOnMainThread() {
    worker.terminate();
    // Dynamic import keeps the parser and its highlighter out of the
    // initial bundle; the chunk only loads when the fallback fires.
    void import('./parse')
      .then(({ parseMarkdown }) => {
        settle(() => {
          try {
            resolveJob(
              sanitizeReading(
                parseMarkdown(source),
                snapshot
                  ? `d${String(snapshot.documentId)}-r${String(snapshot.revision)}`
                  : namespace,
              ),
            );
          } catch {
            settle(() => {
              rejectJob(new Error('Content sanitization failed.'));
            });
          }
        });
      })
      .catch(() => {
        settle(() => {
          rejectJob(new Error('The Markdown worker failed.'));
        });
      });
  }
  return {
    result,
    cancel: () => {
      worker.terminate();
      settle(() => {
        rejectJob(new Error('Cancelled'));
      });
    },
  };
}
