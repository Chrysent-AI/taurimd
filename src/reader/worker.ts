import { sanitizeReading } from './sanitize';
export interface ParseJob {
  result: Promise<string>;
  cancel(): void;
}
export function parseInWorker(source: string): ParseJob {
  const worker = new Worker(new URL('./parse.worker.ts', import.meta.url), {
    type: 'module',
  });
  let rejectJob: (reason: Error) => void = () => {};
  const result = new Promise<string>((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      worker.terminate();
      const data = event.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        'html' in data &&
        typeof data.html === 'string'
      ) {
        try {
          resolve(sanitizeReading(data.html));
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
