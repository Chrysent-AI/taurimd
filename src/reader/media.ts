import type { Rendered } from '../types';
import type { ReaderController } from '../controller';
import { mediaURL } from '../native';

// One attempt number per remote request. The native owner refuses an
// attempt that does not increase for its slot, so the counter only grows for
// the life of this reader.
let remoteAttempt = 0;

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

// The native owner reports a remote failure with its own plain wording and
// the canonical host only; never an address, a path, a query or a document
// location. An unrecognized failure keeps a generic remote wording.
const remoteCodes = new Set([
  'blockedHost',
  'invalidRemoteUrl',
  'redirectBlocked',
  'redirectLimit',
  'remoteTimeout',
  'remoteTls',
  'remoteNetwork',
  'remoteStatus',
  'unsupportedImage',
  'remoteBudget',
  'stale',
]);
function remoteFailureMessage(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    const message = 'message' in error ? error.message : null;
    if (
      typeof code === 'string' &&
      remoteCodes.has(code) &&
      typeof message === 'string' &&
      message
    )
      return message;
  }
  return 'Remote image unavailable — the image could not be loaded.';
}
interface Candidate {
  reference: string;
  remote: boolean;
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
    // At most one remote image per element. The attempt number is allocated
    // before the request starts, so a retirement can retire that attempt.
    const binding =
      resource.remote && element instanceof HTMLImageElement
        ? { slot: resource.slot, attempt: ++remoteAttempt }
        : undefined;
    if (binding) {
      cleanup.push(() => {
        // A replaced document has nothing left to cancel; the native side
        // owns the attempt and its outcome either way.
        void controller
          .cancelRemote(document, binding.slot, binding.attempt)
          .catch(() => {});
      });
    }
    const candidates: Candidate[] = [
      ...resource.sources.map((reference) => ({ reference, remote: false })),
      ...(binding && resource.remote
        ? [{ reference: resource.remote, remote: true }]
        : []),
    ];
    const resolve = async (
      candidate: Candidate,
      kind: 'image' | 'audio' | 'video',
    ) => {
      const result = await controller.resolve(
        document,
        candidate.reference,
        candidate.remote ? binding : undefined,
      );
      const compatible =
        kind === 'image'
          ? result.mime.startsWith('image/')
          : /^(audio|video)\//.test(result.mime);
      if (!compatible)
        throw new Error('The resource has an incompatible media type.');
      // The bytes are published through the opaque reader-media grant. The
      // document address never reaches a connected DOM attribute.
      return { url: mediaURL(result), mime: result.mime };
    };
    if (resource.poster && element instanceof HTMLVideoElement) {
      void resolve({ reference: resource.poster, remote: false }, 'image')
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
    if (!candidates.length) continue;
    void Promise.allSettled(
      candidates.map((candidate) =>
        resolve(candidate, resource.kind === 'img' ? 'image' : resource.kind),
      ),
    )
      .then((results) => {
        if (retired) return;
        const available = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        const failures = results.flatMap((result, index) =>
          result.status === 'rejected'
            ? [
                {
                  remote: candidates[index].remote,
                  reason: result.reason as unknown,
                },
              ]
            : [],
        );
        const localFailures = failures.filter((failure) => !failure.remote);
        const remoteFailures = failures.filter((failure) => failure.remote);
        if (localFailures.length)
          messages.push(
            'Some local sources are missing, denied or unsupported.',
          );
        if (remoteFailures.length && available.length)
          messages.push(
            ...remoteFailures.map((failure) =>
              remoteFailureMessage(failure.reason),
            ),
          );
        if (!available.length) {
          show(
            [
              ...localFailures.map((failure) => failureMessage(failure.reason)),
              ...remoteFailures.map((failure) =>
                remoteFailureMessage(failure.reason),
              ),
            ].join(' '),
          );
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
