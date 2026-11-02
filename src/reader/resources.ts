export interface Resource {
  slot: string;
  kind: 'img' | 'audio' | 'video';
  sources: string[];
  poster?: string;
  warnings: string[];
  // An absolute HTTPS image address. The native owner decides whether its
  // host is permitted before any request is made.
  remote?: string;
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
// Classifies an absolute HTTPS reference that the native owner may deliver.
// The native host policy, the redirect checks and the image boundary remain
// the authority; this only separates a candidate from an unusable address.
export function remoteImageResource(reference: string) {
  const trimmed = reference.trim();
  if (trimmed !== reference) return null;
  if (!/^https:\/\//i.test(reference)) return null;
  if (Array.from(reference).some((character) => character.charCodeAt(0) < 32))
    return null;
  if (reference.includes('\\')) return null;
  return reference;
}
