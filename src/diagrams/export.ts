import type { DiagramImage } from './engine';

export type ExportMode = 'svg' | 'png';
export interface ExportImage {
  ordinal: number;
  image: DiagramImage;
  fonts: { font: string; text: string }[];
}
export function standalone(image: DiagramImage) {
  if (
    !image.viewBox.every(Number.isFinite) ||
    image.width <= 0 ||
    image.height <= 0 ||
    !Number.isFinite(image.width) ||
    !Number.isFinite(image.height)
  )
    throw new Error('Invalid full-image geometry.');
  const parsed = new DOMParser().parseFromString(image.svg, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (parsed.querySelector('parsererror') || !(svg instanceof SVGSVGElement))
    throw new Error('The vendor output is not an SVG image.');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('viewBox', image.viewBox.join(' '));
  svg.setAttribute('width', String(image.width));
  svg.setAttribute('height', String(image.height));
  svg.style.width = `${String(image.width)}px`;
  svg.style.height = `${String(image.height)}px`;
  svg.style.maxWidth = 'none';
  return new XMLSerializer().serializeToString(svg);
}
export function pngGeometry(bytes: Uint8Array) {
  if (
    bytes.length < 45 ||
    ![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every(
      (value, index) => bytes[index] === value,
    )
  )
    throw new Error('PNG serialization returned an invalid image.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}
export async function prepareImage(
  entry: ExportImage,
  mode: ExportMode,
  current: () => void,
  background: string,
): Promise<Uint8Array> {
  let stage = 'SVG serialization';
  let url: string | undefined;
  let image: HTMLImageElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    current();
    const svg = standalone(entry.image);
    if (mode === 'svg') return new TextEncoder().encode(svg);
    stage = 'font readiness';
    await document.fonts.ready;
    current();
    for (const request of entry.fonts) {
      await document.fonts.load(request.font, request.text);
      current();
      if (!document.fonts.check(request.font, request.text))
        throw new Error('A used diagram font is unavailable.');
    }
    stage = 'image decode';
    url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    image = new Image();
    image.src = url;
    await image.decode();
    current();
    if (!(image.naturalWidth > 0 && image.naturalHeight > 0))
      throw new Error('The decoded image has no dimensions.');
    stage = 'canvas allocation';
    const width = Math.ceil(entry.image.width);
    const height = Math.ceil(entry.image.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height))
      throw new Error('Full-image canvas dimensions are not representable.');
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    if (canvas.width !== width || canvas.height !== height)
      throw new Error('The engine cannot allocate the full-image canvas.');
    const context = canvas.getContext('2d');
    if (!context)
      throw new Error('The engine could not allocate a drawing context.');
    stage = 'canvas drawing/readback';
    context.drawImage(image, 0, 0, width, height);
    let painted = false;
    for (let y = 0; y < height && !painted; y += 32) {
      const pixels = context.getImageData(
        0,
        y,
        width,
        Math.min(32, height - y),
      ).data;
      for (let offset = 3; offset < pixels.length; offset += 4)
        if (pixels[offset]) {
          painted = true;
          break;
        }
    }
    if (!painted) throw new Error('The diagram drawing was blank.');
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    stage = 'PNG serialization';
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas?.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error('The engine returned no PNG image.'));
      }, 'image/png');
    });
    current();
    if (blob.type !== 'image/png' || !blob.size)
      throw new Error('The engine returned no PNG bytes.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    current();
    const [actualWidth, actualHeight] = pngGeometry(bytes);
    if (actualWidth !== width || actualHeight !== height)
      throw new Error(
        'Serialized PNG geometry differs from the whole diagram.',
      );
    return bytes;
  } catch (error) {
    throw new Error(
      `Diagram ${String(entry.ordinal)}, ${stage}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (image) image.removeAttribute('src');
    if (url) URL.revokeObjectURL(url);
    if (canvas) canvas.width = canvas.height = 0;
  }
}
