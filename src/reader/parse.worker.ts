import { parseMarkdown } from './parse';
self.onmessage = (event: MessageEvent<string>) => {
  try {
    self.postMessage(parseMarkdown(event.data));
  } catch {
    self.postMessage({
      error:
        'Markdown parsing failed. The previous document is still available.',
    });
  }
};
