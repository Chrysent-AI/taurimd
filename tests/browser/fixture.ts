import {
  parseInWorker,
  type ParseInWorkerOptions,
} from '../../src/reader/worker';
import type { Reading } from '../../src/reader/parse';
declare global {
  interface Window {
    renderDocument: (
      source: string,
      format: 'markdown' | 'text',
    ) => Promise<void>;
    renderWorkerParse: (
      source: string,
      options?: ParseInWorkerOptions,
    ) => Promise<{ html: Reading['html']; headings: number }>;
  }
}
window.renderDocument = async (source, format) => {
  const article = document.getElementById('reading');
  const literal = document.getElementById('literal');
  if (!article || !literal) throw new Error('Fixture root missing');
  article.replaceChildren();
  literal.textContent = '';
  if (format === 'text') literal.textContent = source;
  else article.innerHTML = (await parseInWorker(source).result).html;
};
window.renderWorkerParse = async (source, options) => {
  const reading = await parseInWorker(source, undefined, undefined, options)
    .result;
  return { html: reading.html, headings: reading.headings?.length ?? 0 };
};
