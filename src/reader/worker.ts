import { isParsedMarkdown } from './protocol';
import type { Reading } from './parse';
import type { Snapshot } from '../types';
import { sanitizeReading } from './sanitize';
export interface ParseJob {
  result: Promise<Reading>;
  cancel(): void;
}
export function parseInWorker(
  source: string,
  snapshot?: Snapshot,
  namespace?: string,
): ParseJob {
  const worker = new Worker(new URL('./parse.worker.ts', import.meta.url), {
    type: 'module',
  });
  let rejectJob: (reason: Error) => void = () => {};
  const result = new Promise<Reading>((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      worker.terminate();
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
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('The Markdown worker failed.'));
    };
    worker.onmessageerror = () => {
      worker.terminate();
      reject(new Error('The Markdown response could not be read.'));
    };
    worker.postMessage(source);
  });
  return {
    result,
    cancel: () => {
      worker.terminate();
      rejectJob(new Error('Cancelled'));
    },
  };
}
