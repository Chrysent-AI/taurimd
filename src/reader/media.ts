import type { Rendered } from '../types';
import type { ReaderController } from '../controller';
import { mediaURL } from '../native';

function failureMessage(error: unknown) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : null;
  if (code === 'notFound')
    return 'Local resource unavailable — file not found.';
  if (code === 'denied')
    return 'Local resource blocked — permission or document scope denied.';
  if (code === 'unsupported')
    return 'Local resource unavailable — unsupported format.';
  return 'Local resource unavailable — file missing, denied or unsupported.';
}
export function mountMedia(
  host: HTMLElement,
  document: Rendered,
  controller: ReaderController,
) {
  let retired = false;
  const cleanup: (() => void)[] = [];
  for (const resource of document.resources ?? []) {
    const element = host.querySelector(
      `[data-reader-media="${resource.slot}"]`,
    );
    const feedback = host.querySelector(
      `[data-reader-media-feedback="${resource.slot}"]`,
    );
    if (
      !(
        element instanceof HTMLImageElement ||
        element instanceof HTMLMediaElement
      ) ||
      !feedback
    )
      continue;
    const messages = [...resource.warnings];
    const show = (message: string) => {
      if (!retired)
        feedback.textContent = [...messages, message].filter(Boolean).join(' ');
    };
    const ready = () => {
      show('');
    };
    const failed = () => {
      show(
        resource.kind === 'img'
          ? 'Image unavailable — the file could not be decoded.'
          : 'Audio/video could not play — this encoding may not be supported, or the file may be damaged.',
      );
    };
    element.addEventListener(
      element instanceof HTMLImageElement ? 'load' : 'loadedmetadata',
      ready,
    );
    element.addEventListener('error', failed);
    cleanup.push(() => {
      element.removeEventListener(
        element instanceof HTMLImageElement ? 'load' : 'loadedmetadata',
        ready,
      );
      element.removeEventListener('error', failed);
      if (element instanceof HTMLMediaElement) element.pause();
      element.removeAttribute('src');
      element.removeAttribute('poster');
      element.querySelectorAll('source').forEach((source) => {
        source.remove();
      });
      if (element instanceof HTMLMediaElement) element.load();
    });
    const resolve = async (
      reference: string,
      kind: 'image' | 'audio' | 'video',
    ) => {
      const result = await controller.resolve(document, reference);
      const compatible =
        kind === 'image'
          ? result.mime.startsWith('image/')
          : /^(audio|video)\//.test(result.mime);
      if (!compatible)
        throw new Error('The local resource has an incompatible media type.');
      return { url: mediaURL(result), mime: result.mime };
    };
    if (resource.poster && element instanceof HTMLVideoElement) {
      void resolve(resource.poster, 'image')
        .then(({ url }) => {
          if (!retired) element.poster = url;
        })
        .catch(() => {
          if (!retired) {
            messages.push('Video poster unavailable.');
            feedback.textContent = `${feedback.textContent} Video poster unavailable.`;
          }
        });
    }
    if (!resource.sources.length) continue;
    void Promise.allSettled(
      resource.sources.map((reference) =>
        resolve(reference, resource.kind === 'img' ? 'image' : resource.kind),
      ),
    )
      .then((results) => {
        if (retired) return;
        const available = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        const denied = results.filter((result) => result.status === 'rejected');
        if (denied.length)
          messages.push(
            'Some local sources are missing, denied or unsupported.',
          );
        if (!available.length) {
          show(denied.map((result) => failureMessage(result.reason)).join(' '));
          return;
        }
        if (element instanceof HTMLImageElement) element.src = available[0].url;
        else {
          let failedSources = 0;
          for (const source of available) {
            const node = window.document.createElement('source');
            const unavailable = () => {
              failedSources += 1;
              if (
                failedSources === available.length &&
                element.readyState === 0
              )
                failed();
            };
            node.addEventListener('error', unavailable);
            cleanup.push(() => {
              node.removeEventListener('error', unavailable);
            });
            node.src = source.url;
            node.type = source.mime;
            element.append(node);
          }
          // Resolve all alternatives before asking the engine to choose; one bad
          // alternate must not mark an otherwise playable resource as failed.
          element.load();
        }
      })
      .catch(() => {
        show('Local resource unavailable — loading could not finish.');
      });
  }
  return () => {
    retired = true;
    cleanup.forEach((stop) => {
      stop();
    });
  };
}
