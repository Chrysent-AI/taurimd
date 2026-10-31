import { parseInWorker } from '../../src/reader/worker';
declare global {
  interface Window {
    renderDocument: (
      source: string,
      format: 'markdown' | 'text',
    ) => Promise<void>;
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
