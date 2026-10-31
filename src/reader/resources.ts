export interface Resource {
  slot: string;
  kind: 'img' | 'audio' | 'video';
  sources: string[];
  poster?: string;
  warnings: string[];
}
export interface ReadingAction {
  slot: string;
  href: string;
}
export function localResource(reference: string) {
  return (
    Boolean(reference) &&
    reference.trim() === reference &&
    !Array.from(reference).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !reference.includes('\\') &&
    !reference.startsWith('/') &&
    !reference.startsWith('#') &&
    !/^[a-z][a-z\d+.-]*:/i.test(reference)
  );
}
