import { Marked } from 'marked';
const parser = new Marked({ gfm: true, breaks: false });
export function parseMarkdown(source: string): string {
  return parser.parse(source.replace(/^\uFEFF/, ''), { async: false });
}
