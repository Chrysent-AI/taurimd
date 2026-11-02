import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks';
import { native, mediaURL } from '../src/native';
import { ReaderController } from '../src/controller';
import { sanitizeReading } from '../src/reader/sanitize';
import { parseMarkdown } from '../src/reader/parse';
import { mountMedia } from '../src/reader/media';
import type { NativeReader, Snapshot } from '../src/types';
const id = '0'.repeat(31) + '1';
const snapshot: Snapshot = {
  documentId: 1,
  revision: 2,
  name: 'media.md',
  location: 'fixture/media.md',
  source: '# Media',
  format: 'markdown',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(() => {
  clearMocks();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
describe('production inert resource boundary and native adapter', () => {
  it('keeps every hostile fetch/action surface inert and reconstructs only owned slots', () => {
    const reading = sanitizeReading(
      parseMarkdown(`<base href="https://invalid.example"><link rel="stylesheet" href="https://invalid.example/style"><meta http-equiv="refresh" content="0;url=https://invalid.example">
<img src="figure.svg" srcset="https://invalid.example/image 2x" alt="" width="320" height="180" data-reader-media="forged" style="background:url(https://invalid.example/css)" onload="evil()">
<audio src="missing.mp3" autoplay loop><source src="sound.wav"><source src="//invalid.example/sound"></audio>
<video src="clip.webm" poster="https://invalid.example/poster"><track src="https://invalid.example/caption"></video>
<svg><image href="https://invalid.example/svg"></image></svg><math href="https://invalid.example/math">math</math>
<a href="https://invalid.example" download target="_blank" data-reader-link="99">Safe activation</a>`),
    );
    const host = document.createElement('div');
    host.innerHTML = reading.html;
    expect(
      host.querySelector(
        '[src],[srcset],[poster],[style],[onload],[autoplay],[loop],[download],[target],base,meta,link,svg,math,source,track',
      ),
    ).toBeNull();
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(host.querySelector('img')?.getAttribute('width')).toBe('320');
    expect(host.querySelector('audio')?.hasAttribute('controls')).toBe(true);
    expect(reading.resources?.map((value) => value.sources)).toEqual([
      ['figure.svg'],
      ['missing.mp3', 'sound.wav'],
      ['clip.webm'],
    ]);
    expect(reading.resources?.[2].poster).toBeUndefined();
    expect(reading.actions).toEqual([
      { slot: '0', href: 'https://invalid.example' },
    ]);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('#');
    expect(host.textContent).toContain('Blocked srcset');
    expect(reading.resources?.[2].warnings).toContain(
      'Caption track unavailable — this resource type is not supported.',
    );
    const video = host.querySelector('video');
    expect(video?.textContent).not.toContain('Caption track unavailable');
    expect(
      video?.nextElementSibling?.getAttribute('data-reader-media-feedback'),
    ).toBe('2');
    expect(video?.nextElementSibling?.textContent).toContain(
      'Caption track unavailable',
    );
  });
  it('routes only document identity/inert references and uses convertFileSrc with the opaque id', async () => {
    const calls: unknown[] = [];
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      return command === 'resolve_media'
        ? { id, mime: 'image/png' }
        : { status: 'externalOpened' };
    });
    mockConvertFileSrc('linux');
    const result = await native.resolve(snapshot, 'figure.png');
    expect(mediaURL(result)).toBe(`reader-media://localhost/${id}`);
    await native.activate(3, snapshot, 'https://invalid.example/');
    expect(calls).toEqual([
      {
        command: 'resolve_media',
        payload: {
          documentId: 1,
          revision: 2,
          relativeReference: 'figure.png',
        },
      },
      {
        command: 'activate_link',
        payload: {
          documentId: 1,
          revision: 2,
          requestId: 3,
          href: 'https://invalid.example/',
        },
      },
    ]);
    mockConvertFileSrc('windows');
    expect(mediaURL(result)).toBe(`http://reader-media.localhost/${id}`);
    expect(() =>
      mediaURL({ id: 'fixture/figure.png', mime: 'image/png' }),
    ).toThrow();
    expect(() => mediaURL({ id, mime: 'text/html' })).toThrow();
  });
});
describe('mounted media ownership and actual controller', () => {
  it('keeps valid alternatives, reports local failures, and releases retired players/listeners', async () => {
    mockConvertFileSrc('linux');
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, 'pause')
      .mockImplementation(() => {});
    const load = vi
      .spyOn(HTMLMediaElement.prototype, 'load')
      .mockImplementation(() => {});
    const pending = deferred<{ id: string; mime: string }>();
    const bridge: NativeReader = {
      openEntry: () => Promise.reject(new Error('No navigation fixture')),
      select: () => Promise.resolve({ status: 'ready', snapshot }),
      reload: () => Promise.resolve(snapshot),
      commit: async () => {},
      cancel: async () => {},
      activate: () => Promise.resolve({ status: 'externalOpened' }),
      resolve: vi.fn(async (_document, reference) => {
        if (reference === 'late.png') return pending.promise;
        if (reference === 'bad.mp3') throw new Error('denied');
        return { id, mime: 'audio/wav' };
      }),
    };
    const reading = sanitizeReading(
      parseMarkdown(
        '<audio><source src="bad.mp3"><source src="sound.wav"></audio>\n<img src="late.png">',
      ),
    );
    const controller = new ReaderController(bridge, () => ({
      result: Promise.resolve(reading),
      cancel() {},
    }));
    await controller.run('open');
    const displayed = controller.state.displayed;
    if (!displayed) throw new Error('Expected displayed document');
    const host = document.createElement('div');
    host.innerHTML = reading.html;
    document.body.append(host);
    const stop = mountMedia(host, displayed, controller);
    await vi.waitFor(() => {
      expect(host.querySelector('source')?.getAttribute('src')).toBe(
        `reader-media://localhost/${id}`,
      );
    });
    host.querySelector('audio')?.dispatchEvent(new Event('loadedmetadata'));
    expect(host.textContent).toContain('Some local sources');
    expect(host.textContent).not.toContain('could not play');
    const player = host.querySelector('audio');
    stop();
    pending.resolve({ id, mime: 'image/png' });
    await pending.promise;
    await Promise.resolve();
    expect(host.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(host.querySelector('source')).toBeNull();
    expect(pause).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(2);
    const feedback = host.textContent;
    player?.dispatchEvent(new Event('error'));
    expect(host.textContent).toBe(feedback);
  });
});
describe('remote image classification and opaque publication', () => {
  const remote = 'https://raw.githubusercontent.com/a/b.png';
  function bridgeFor(
    resolve: NativeReader['resolve'],
    cancelRemote?: NativeReader['cancelRemote'],
  ): NativeReader {
    return {
      openEntry: () => Promise.reject(new Error('No navigation fixture')),
      select: () => Promise.resolve({ status: 'ready', snapshot }),
      reload: () => Promise.resolve(snapshot),
      commit: async () => {},
      cancel: async () => {},
      activate: () => Promise.resolve({ status: 'externalOpened' }),
      resolve,
      cancelRemote,
    };
  }
  async function mount(source: string, bridge: NativeReader) {
    const reading = sanitizeReading(parseMarkdown(source));
    const controller = new ReaderController(bridge, () => ({
      result: Promise.resolve(reading),
      cancel() {},
    }));
    await controller.run('open');
    const displayed = controller.state.displayed;
    if (!displayed) throw new Error('Expected displayed document');
    const host = document.createElement('div');
    host.innerHTML = reading.html;
    document.body.append(host);
    const stop = mountMedia(host, displayed, controller);
    return { reading, controller, displayed, host, stop };
  }
  it('classifies an HTTPS image as a remote candidate and keeps its address out of the document', () => {
    const reading = sanitizeReading(
      parseMarkdown(
        `![Remote figure](${remote})\n\n![Local](figure.svg)\n\n<img src="${remote}">`,
      ),
    );
    expect(reading.resources?.[0].remote).toBe(remote);
    expect(reading.resources?.[0].sources).toEqual([]);
    expect(reading.resources?.[1].remote).toBeUndefined();
    expect(reading.resources?.[1].sources).toEqual(['figure.svg']);
    expect(reading.resources?.[2].remote).toBe(remote);
    const host = document.createElement('div');
    host.innerHTML = reading.html;
    expect(host.querySelector('img')?.hasAttribute('src')).toBe(false);
    // An author alt is kept; a generated alt never carries an address.
    const images = host.querySelectorAll('img');
    expect(images[0].getAttribute('alt')).toBe('Remote figure');
    expect(images[2].getAttribute('alt')).toBe('Remote image');
    expect(
      [...host.querySelectorAll('*')].flatMap((element) =>
        [...element.attributes].map((attribute) => attribute.value),
      ),
    ).not.toContain(remote);
    expect(host.textContent).toContain('Loading remote img');
  });
  it('publishes the validated bytes through the opaque grant and asks the native owner with a binding', async () => {
    mockConvertFileSrc('linux');
    const calls: unknown[] = [];
    const { host } = await mount(
      `![Remote figure](${remote})`,
      bridgeFor(
        vi.fn<NativeReader['resolve']>((_document, reference, binding) => {
          calls.push({ reference, binding });
          return Promise.resolve({ id, mime: 'image/png' });
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(host.querySelector('img')?.getAttribute('src')).toBe(
        `reader-media://localhost/${id}`,
      );
    });
    expect(calls).toHaveLength(1);
    const [call] = calls as { reference: string; binding?: unknown }[];
    expect(call.reference).toBe(remote);
    const binding = call.binding as { slot: string; attempt: number };
    expect(binding.slot).toBe('0');
    expect(binding.attempt).toBeGreaterThan(0);
    expect(
      [...host.querySelectorAll('*')].flatMap((element) =>
        [...element.attributes].map((attribute) => attribute.value),
      ),
    ).not.toContain(remote);
  });
  it('reports a denied host locally and leaves the rest of the document readable', async () => {
    mockConvertFileSrc('linux');
    const { host } = await mount(
      `# Reading\n\n![Remote figure](${remote})\n\nReadable paragraph.`,
      bridgeFor(
        vi.fn<NativeReader['resolve']>(() =>
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects a command with the serialized AppError DTO, not a JS Error.
          Promise.reject({
            code: 'blockedHost',
            message:
              'Image blocked — raw.githubusercontent.com is not permitted. Manage hosts in Settings.',
          }),
        ),
      ),
    );
    await vi.waitFor(() => {
      expect(host.textContent).toContain('is not permitted');
    });
    expect(host.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(host.textContent).toContain('Readable paragraph.');
    expect(host.textContent).not.toContain('Some local sources');
  });
  it('retires an obsolete attempt and never publishes a late result', async () => {
    mockConvertFileSrc('linux');
    const pending = deferred<{ id: string; mime: string }>();
    const cancelRemote = vi.fn<NonNullable<NativeReader['cancelRemote']>>(() =>
      Promise.resolve(null),
    );
    const { host, stop } = await mount(
      `![Remote figure](${remote})`,
      bridgeFor(
        vi.fn<NativeReader['resolve']>((_document, reference) =>
          reference === remote
            ? pending.promise
            : Promise.resolve({ id, mime: 'image/png' }),
        ),
        cancelRemote,
      ),
    );
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Loading remote img');
    });
    stop();
    await vi.waitFor(() => {
      expect(cancelRemote).toHaveBeenCalledWith(
        snapshot,
        '0',
        expect.anything(),
      );
    });
    pending.resolve({ id, mime: 'image/png' });
    await pending.promise;
    await Promise.resolve();
    expect(host.querySelector('img')?.hasAttribute('src')).toBe(false);
  });
});
