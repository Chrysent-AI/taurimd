import { useEffect, useRef, type ReactNode } from 'react';

export function TemporaryDialog({
  title,
  close,
  composing,
  origin,
  fallback,
  children,
  initialControl = false,
  initialInput = false,
  restoreFocus = true,
  footer,
  dismissDisabled = false,
}: {
  title: string;
  close: () => void;
  composing: { current: boolean };
  origin: HTMLElement | null;
  fallback: () => void;
  children: ReactNode;
  initialControl?: boolean;
  initialInput?: boolean;
  restoreFocus?: boolean;
  footer?: ReactNode;
  dismissDisabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const selection = window.getSelection();
    const ranges: Range[] = [];
    for (let index = 0; selection && index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      if (
        document.querySelector('main')?.contains(range.commonAncestorContainer)
      )
        ranges.push(range.cloneRange());
    }
    element?.showModal();
    if (initialInput)
      element
        ?.querySelector<HTMLInputElement>('input[type="text"]')
        ?.focus({ preventScroll: true });
    else if (initialControl)
      element
        ?.querySelector<HTMLElement>('select, button')
        ?.focus({ preventScroll: true });
    else heading.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (!restoreFocus) return;
      if (
        origin?.isConnected &&
        !origin.closest('[hidden]') &&
        !origin.matches(':disabled')
      )
        origin.focus({ preventScroll: true });
      else fallback();
      if (ranges.length) {
        const current = window.getSelection();
        current?.removeAllRanges();
        for (const range of ranges) {
          if (range.commonAncestorContainer.isConnected)
            current?.addRange(range);
        }
      }
    };
  }, [origin, fallback, initialControl, initialInput, restoreFocus]);
  useEffect(() => {
    if (
      dialog.current?.open &&
      !dialog.current.contains(document.activeElement)
    )
      (
        dialog.current.querySelector<HTMLElement>('button:not(:disabled)') ??
        heading.current
      )?.focus({ preventScroll: true });
  });
  return (
    <dialog
      ref={dialog}
      aria-labelledby="temporary-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!composing.current && !dismissDisabled) close();
      }}
      onKeyDown={(event) => {
        if (
          composing.current ||
          event.nativeEvent.isComposing ||
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy IME engines can report 229 without isComposing.
          event.keyCode === 229
        ) {
          if (
            event.key === 'Escape' ||
            ((event.key === 'Enter' || event.key === ' ') &&
              event.target instanceof Element &&
              !!event.target.closest('button'))
          )
            event.preventDefault();
          return;
        }
        if (event.key !== 'Tab' || event.defaultPrevented) return;
        const controls = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'a[href], button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
          ) ?? []),
        ].filter((node) => node.getClientRects().length > 0);
        const active = window.document.activeElement;
        const index =
          active instanceof HTMLElement ? controls.indexOf(active) : -1;
        const next = event.shiftKey
          ? controls.at(index <= 0 ? -1 : index - 1)
          : controls[
              index < 0 || index === controls.length - 1 ? 0 : index + 1
            ];
        // Explicit traversal also reaches buttons in engines whose platform
        // keyboard mode otherwise skips them after a chain of links.
        event.preventDefault();
        next?.focus();
      }}
    >
      <h2 id="temporary-title" tabIndex={-1} ref={heading}>
        {title}
      </h2>
      {children}
      {footer === undefined ? (
        <button
          onClick={() => {
            if (!composing.current && !dismissDisabled) close();
          }}
        >
          Close
        </button>
      ) : (
        footer
      )}
    </dialog>
  );
}
