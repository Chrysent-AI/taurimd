import { useCallback, useEffect, useRef, useState } from 'react';
import { diagramExport, type ExportBinding } from '../native';
import type { Rendered } from '../types';
import type { Palette } from '../settings/model';
import type { DiagramView } from './view';
import { prepareImage, type ExportImage, type ExportMode } from './export';

interface Operation {
  document: Rendered;
  palette: Palette;
  mode: ExportMode;
  images: ExportImage[];
  omitted: number[];
  cancelled: boolean;
  binding?: ExportBinding;
  started: boolean;
  finishing: boolean;
  restore: () => void;
}
export interface ExportProgress {
  phase: 'partial' | 'preparing' | 'cancelling' | 'native';
  message: string;
  mode: ExportMode;
  count: number;
  omitted: number[];
}
function captureFocus(fallback: () => void) {
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges: Range[] = [];
  for (let index = 0; selection && index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (document.querySelector('main')?.contains(range.commonAncestorContainer))
      ranges.push(range.cloneRange());
  }
  return () => {
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active.isConnected
    )
      active.focus({ preventScroll: true });
    else fallback();
    if (ranges.length) {
      const current = window.getSelection();
      current?.removeAllRanges();
      for (const range of ranges)
        if (range.commonAncestorContainer.isConnected) current?.addRange(range);
    }
  };
}
export function useDiagramExport(
  document: Rendered | null,
  palette: Palette,
  views: { current: DiagramView[] },
  surface: (phase: 'preparing' | 'native' | 'closed') => void,
  fallback: () => void,
) {
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [feedback, setFeedback] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const operation = useRef<Operation | null>(null);
  const live = useRef({ document, palette, surface, fallback });
  useEffect(() => {
    live.current = { document, palette, surface, fallback };
  }, [document, palette, surface, fallback]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const job = operation.current;
      if (job) {
        job.cancelled = true;
        if (job.binding) void diagramExport.cancel(job.binding).catch(() => {});
      }
    };
  }, []);
  const restore = useRef<Operation | null>(null);
  useEffect(() => {
    const job = restore.current;
    if (progress === null && job) {
      restore.current = null;
      if (
        mounted.current &&
        !operation.current &&
        live.current.document === job.document
      )
        job.restore();
    }
  }, [progress]);
  const finishUI = useCallback(
    (job: Operation, message: string, error: boolean) => {
      if (operation.current !== job) return;
      operation.current = null;
      if (!mounted.current) return;
      restore.current = job;
      live.current.surface('closed');
      setProgress(null);
      // A completed atomic save remains true even if its reader has retired.
      setFeedback({
        message:
          live.current.document === job.document
            ? message
            : `${job.document.snapshot.name}: ${message}`,
        error,
      });
    },
    [],
  );
  useEffect(() => {
    const job = operation.current;
    if (job && (job.document !== document || job.palette !== palette)) {
      job.cancelled = true;
      if (!job.started) finishUI(job, 'Export cancelled.', false);
      else if (job.finishing && job.binding)
        void diagramExport.cancel(job.binding).catch(() => {});
    }
  }, [document, palette, finishUI]);
  const run = useCallback(
    async (job: Operation) => {
      if (job.started) return;
      job.started = true;
      const current = () => {
        if (
          job.cancelled ||
          !mounted.current ||
          live.current.document !== job.document ||
          live.current.palette !== job.palette
        ) {
          job.cancelled = true;
          throw new Error('Export cancelled.');
        }
      };
      let result = 'Export cancelled.';
      let error = false;
      const update = (phase: ExportProgress['phase'], message: string) => {
        if (mounted.current)
          setProgress({
            phase,
            message,
            mode: job.mode,
            count: job.images.length,
            omitted: job.omitted,
          });
      };
      try {
        current();
        update('preparing', 'Preparing ZIP…');
        const exportId = await diagramExport.begin(
          job.document.snapshot,
          job.mode,
          job.images.map((entry) => entry.ordinal),
        );
        job.binding = {
          exportId,
          documentId: job.document.snapshot.documentId,
          revision: job.document.snapshot.revision,
          mode: job.mode,
        };
        current();
        const background = getComputedStyle(window.document.documentElement)
          .getPropertyValue('--page')
          .trim();
        for (const [index, entry] of job.images.entries()) {
          current();
          update(
            'preparing',
            `Preparing diagram ${String(index + 1)} of ${String(job.images.length)} (document diagram ${String(entry.ordinal)})…`,
          );
          const bytes = await prepareImage(
            entry,
            job.mode,
            current,
            background,
          );
          current();
          await diagramExport.append(job.binding, entry.ordinal, bytes);
          current();
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
          current();
        }
        update(
          'native',
          'Finishing ZIP and choosing destination… Use the native dialog to cancel.',
        );
        live.current.surface('native');
        current();
        job.finishing = true;
        const outcome = await diagramExport.finish(job.binding);
        if (outcome.status === 'committed')
          result = `Exported ${String(outcome.count)} ${job.mode.toUpperCase()} diagrams to ${outcome.location}.`;
      } catch (cause) {
        if (!job.cancelled || job.finishing) {
          const message =
            cause instanceof Error
              ? cause.message
              : typeof cause === 'object' &&
                  cause !== null &&
                  'message' in cause
                ? String(cause.message)
                : String(cause);
          result = `Export stopped: ${message}`;
          error = true;
        }
      } finally {
        if (job.binding && !job.finishing) {
          try {
            await diagramExport.cancel(job.binding);
          } catch (cause) {
            result += ` Cleanup could not be confirmed: ${cause instanceof Error ? cause.message : typeof cause === 'object' && cause !== null && 'message' in cause ? String(cause.message) : String(cause)}.`;
            error = true;
          }
        }
        finishUI(job, result, error);
      }
    },
    [finishUI],
  );
  const start = useCallback(
    (mode: ExportMode) => {
      if (operation.current) return;
      const document = live.current.document;
      if (!document) {
        setFeedback({ message: 'No diagrams to export.', error: false });
        return;
      }
      const states = views.current.map((view) =>
        view.exportState(live.current.palette),
      );
      if (states.some((state) => state.status === 'pending')) {
        setFeedback({
          message:
            'Diagrams are still rendering. Try export when rendering finishes.',
          error: false,
        });
        return;
      }
      const images = states.flatMap((state) =>
        state.status === 'ready'
          ? [{ ordinal: state.ordinal, image: state.image, fonts: state.fonts }]
          : [],
      );
      if (!images.length) {
        setFeedback({
          message: states.length
            ? 'No successfully rendered diagrams to export.'
            : 'No diagrams to export.',
          error: false,
        });
        return;
      }
      const omitted = states.flatMap((state) =>
        state.status === 'failed' ? [state.ordinal] : [],
      );
      const job: Operation = {
        document,
        palette: live.current.palette,
        mode,
        images,
        omitted,
        cancelled: false,
        started: false,
        finishing: false,
        restore: captureFocus(live.current.fallback),
      };
      operation.current = job;
      setFeedback(null);
      live.current.surface('preparing');
      if (omitted.length)
        setProgress({
          phase: 'partial',
          message: `Export ${String(images.length)} diagrams. Diagrams ${omitted.join(', ')} could not render and will be omitted. Files will be numbered ${images.map((entry) => entry.ordinal).join(', ')}.`,
          mode,
          count: images.length,
          omitted,
        });
      else void run(job);
    },
    [views, run],
  );
  const cancel = () => {
    const job = operation.current;
    if (!job || job.finishing || job.cancelled) return;
    job.cancelled = true;
    if (progress?.phase === 'partial')
      finishUI(job, 'Export cancelled.', false);
    else
      setProgress((value) =>
        value
          ? {
              ...value,
              phase: 'cancelling',
              message:
                'Cancel requested… Finishing the current step and cleaning up.',
            }
          : value,
      );
  };
  return {
    progress,
    feedback,
    start,
    cancel,
    confirm: () => {
      const job = operation.current;
      if (job && progress?.phase === 'partial') void run(job);
    },
    dismiss: () => {
      setFeedback(null);
    },
  };
}
