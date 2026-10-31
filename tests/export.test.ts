import { describe, expect, it } from 'vitest';
import { pngGeometry, prepareImage, standalone } from '../src/diagrams/export';
import type { DiagramImage } from '../src/diagrams/engine';
const image: DiagramImage = {
  identity: 'current-vendor-palette',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width:30px" viewBox="-20 -5 180.2 90.7"><style>text{fill:#123456}</style><defs><marker id="original"/></defs><text x="0" y="20">Whole image</text><image href="https://example.invalid/vendor-reference"/></svg>',
  width: 180.2,
  height: 90.7,
  viewBox: [-20, -5, 180.2, 90.7],
};
describe('whole vendor-image preparation', () => {
  it('normalizes only root geometry without serialization of viewport transforms or a new output policy', async () => {
    const svg = standalone(image);
    expect(svg).toContain('viewBox="-20 -5 180.2 90.7"');
    expect(svg).toContain('width="180.2"');
    expect(svg).toContain('height="90.7"');
    expect(svg).toContain('max-width: none');
    expect(svg).toContain('<style>text{fill:#123456}</style>');
    expect(svg).toContain('id="original"');
    expect(svg).toContain('href="https://example.invalid/vendor-reference"');
    const bytes = await prepareImage(
      { ordinal: 3, image, fonts: [] },
      'svg',
      () => {},
      '#ffffff',
    );
    expect(ArrayBuffer.isView(bytes)).toBe(true);
    expect(bytes.BYTES_PER_ELEMENT).toBe(1);
    expect(new TextDecoder().decode(bytes)).toBe(svg);
    expect(image.svg).toContain('width="100%"');
  });
  it('rejects obsolete work, malformed vendor XML and invalid full-image geometry explicitly', async () => {
    await expect(
      prepareImage(
        { ordinal: 3, image, fonts: [] },
        'svg',
        () => {
          throw new Error('retired');
        },
        '#fff',
      ),
    ).rejects.toThrow('Diagram 3, SVG serialization: retired');
    expect(() => standalone({ ...image, svg: '<svg><broken' })).toThrow(
      'not an SVG',
    );
    for (const width of [0, -1, Infinity, NaN])
      expect(() => standalone({ ...image, width })).toThrow('geometry');
  });
  it('checks the actual PNG signature and first IHDR dimensions', () => {
    const bytes = new Uint8Array(45);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 181);
    view.setUint32(20, 91);
    expect(pngGeometry(bytes)).toEqual([181, 91]);
    expect(() => pngGeometry(bytes.slice(0, 30))).toThrow('invalid image');
    bytes[12] = 0;
    expect(() => pngGeometry(bytes)).toThrow('invalid image');
  });
});
