import type { DiagramDefinition } from '../reader/parse';
import type { Palette } from '../settings/model';
import { diagramIdentity, renderDiagram, type DiagramImage } from './engine';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}
export function mountDiagram(
  slot: Element,
  definition: DiagramDefinition,
  context: string,
  allowed: () => boolean,
) {
  const identity = diagramIdentity(`${context}-${definition.slot}`);
  const name = `Diagram ${definition.slot}`;
  const figure = node('figure');
  figure.className = 'diagram';
  figure.setAttribute('aria-label', name);
  figure.append(node('figcaption', name));
  const enter = node('button', `Interact with diagram ${definition.slot}`);
  enter.type = 'button';
  enter.tabIndex = 0;
  const viewport = node('div');
  viewport.className = 'diagram-viewport';
  viewport.tabIndex = -1;
  viewport.setAttribute('data-pannable', 'false');
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', `${name} viewport`);
  const scene = node('div');
  scene.className = 'diagram-scene';
  viewport.append(scene);
  const instructions = node(
    'p',
    `Arrows pan; +/− zoom; 0 resets; Escape leaves diagram. Tab moves to the next control. ${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}+wheel zooms this diagram; plain wheel scrolls the document.`,
  );
  instructions.className = 'diagram-instructions';
  instructions.id = `${identity}-help`;
  viewport.setAttribute('aria-describedby', instructions.id);
  const feedback = node('p');
  feedback.setAttribute('role', 'status');
  const controls = node('div');
  controls.className = 'commands';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', `${name} controls`);
  const zoom = node('output');
  zoom.setAttribute('aria-label', 'Diagram zoom');
  zoom.setAttribute('aria-live', 'off');
  const details = node('details');
  const code = node('code', definition.source);
  const pre = node('pre');
  pre.append(code);
  details.append(node('summary', 'Original definition'), pre);
  figure.append(enter, viewport, instructions, feedback, controls, details);
  slot.replaceWith(figure);
  let image: DiagramImage | undefined;
  let fit = true;
  let manual = false;
  let scale = 1;
  let x = 0;
  let y = 0;
  let disposed = false;
  let generation = 0;
  let readiness: 'pending' | 'ready' | 'failed' = 'pending';
  let published = 0;
  let palette: Palette | undefined;
  let drag: { id: number; x: number; y: number } | undefined;
  // Overflow slack in CSS pixels: a fitted image computes its scale from the
  // same client sizes, so anything not overflowing beyond rounding and
  // floating-point jitter leaves nothing to pan.
  const overflowTolerance = 0.5;
  const pannable = () =>
    Boolean(
      image &&
      viewport.clientWidth > 0 &&
      viewport.clientHeight > 0 &&
      (image.width * scale > viewport.clientWidth + overflowTolerance ||
        image.height * scale > viewport.clientHeight + overflowTolerance),
    );
  const events = new AbortController();
  const options = { signal: events.signal };
  function release() {
    if (drag && viewport.hasPointerCapture(drag.id))
      viewport.releasePointerCapture(drag.id);
    drag = undefined;
    viewport.removeAttribute('data-dragging');
  }
  function paint() {
    if (!image) return;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (width <= 0 || height <= 0) return;
    if (!manual) {
      scale = fit ? Math.min(width / image.width, height / image.height) : 1;
      x = 0;
      y = 0;
    }
    scene.style.width = `${String(image.width)}px`;
    scene.style.height = `${String(image.height)}px`;
    scene.style.transform = `translate(${String((width - image.width * scale) / 2 + x)}px, ${String((height - image.height * scale) / 2 + y)}px) scale(${String(scale)})`;
    zoom.value = `${String(Math.round(scale * 100))}%`;
    viewport.setAttribute('data-pannable', pannable() ? 'true' : 'false');
  }
  function action(command: string) {
    if (!image || disposed || !allowed()) return;
    release();
    if (command === 'reset' || command === 'fit') {
      manual = command === 'fit';
      scale =
        command === 'fit'
          ? Math.min(
              viewport.clientWidth / image.width,
              viewport.clientHeight / image.height,
            )
          : scale;
      x = y = 0;
    } else {
      manual = true;
      if (command === 'in' || command === 'out') {
        const next = scale * (command === 'in' ? 1.2 : 1 / 1.2);
        if (
          next > 0 &&
          Number.isFinite(image.width * next) &&
          Number.isFinite(image.height * next)
        )
          scale = next;
      }
      if (command === 'left') x -= 32;
      if (command === 'right') x += 32;
      if (command === 'up') y -= 32;
      if (command === 'down') y += 32;
    }
    paint();
  }
  const buttons = [enter];
  for (const [command, label] of [
    ['out', 'Zoom out'],
    ['in', 'Zoom in'],
    ['reset', 'Reset diagram'],
    ['fit', 'Fit to view'],
    ['left', 'Pan left'],
    ['right', 'Pan right'],
    ['up', 'Pan up'],
    ['down', 'Pan down'],
  ]) {
    const button = node('button', label);
    button.type = 'button';
    button.tabIndex = 0;
    button.addEventListener(
      'click',
      () => {
        action(command);
      },
      options,
    );
    controls.append(button);
    buttons.push(button);
    if (command === 'out') controls.append(zoom);
  }
  const enable = (ready: boolean) => {
    for (const button of buttons) button.disabled = !ready;
    viewport.setAttribute('aria-disabled', String(!ready));
  };
  enable(false);
  enter.addEventListener(
    'click',
    () => {
      if (image && allowed()) viewport.focus({ preventScroll: true });
    },
    options,
  );
  viewport.addEventListener(
    'keydown',
    (event) => {
      if (
        !image ||
        !allowed() ||
        event.defaultPrevented ||
        event.isComposing ||
        event.target !== viewport ||
        document.activeElement !== viewport ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.shiftKey && event.key !== '+')
      )
        return;
      const commands: Record<string, string> = {
        ArrowLeft: 'left',
        ArrowRight: 'right',
        ArrowUp: 'up',
        ArrowDown: 'down',
        '+': 'in',
        '-': 'out',
        '−': 'out',
        '0': 'reset',
      };
      if (event.key === 'Escape') {
        release();
        enter.focus({ preventScroll: true });
      } else if (commands[event.key]) action(commands[event.key] ?? '');
      else return;
      event.preventDefault();
      event.stopPropagation();
    },
    options,
  );
  viewport.addEventListener(
    'wheel',
    (event) => {
      const modifier = /Mac/.test(navigator.platform)
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (
        !image ||
        !allowed() ||
        event.defaultPrevented ||
        !modifier ||
        event.altKey ||
        event.shiftKey ||
        !event.deltaY
      )
        return;
      event.preventDefault();
      action(event.deltaY < 0 ? 'in' : 'out');
    },
    { ...options, passive: false },
  );
  viewport.addEventListener(
    'pointerdown',
    (event) => {
      if (
        !image ||
        !allowed() ||
        event.defaultPrevented ||
        !event.isPrimary ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        !pannable()
      )
        return;
      release();
      viewport.focus({ preventScroll: true });
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      viewport.setPointerCapture(event.pointerId);
      viewport.setAttribute('data-dragging', 'true');
      event.preventDefault();
    },
    options,
  );
  viewport.addEventListener(
    'pointermove',
    (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      if (!allowed()) {
        release();
        return;
      }
      manual = true;
      x += event.clientX - drag.x;
      y += event.clientY - drag.y;
      drag = { id: drag.id, x: event.clientX, y: event.clientY };
      paint();
    },
    options,
  );
  for (const event of [
    'pointerup',
    'pointercancel',
    'lostpointercapture',
    'blur',
  ])
    viewport.addEventListener(event, release, options);
  window.addEventListener('blur', release, options);
  const observer = new ResizeObserver(paint);
  observer.observe(viewport);
  return {
    figure,
    get image() {
      return image;
    },
    exportState(requested: Palette) {
      if (
        disposed ||
        readiness === 'pending' ||
        palette !== requested ||
        published !== generation
      )
        return { status: 'pending' as const };
      if (readiness === 'failed' || !image)
        return { status: 'failed' as const, ordinal: Number(definition.slot) };
      const fonts = [...scene.querySelectorAll('text, tspan')]
        .map((text) => {
          const style = getComputedStyle(text);
          return {
            font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
            text: text.textContent,
          };
        })
        .filter((request) => request.text.length > 0);
      return {
        status: 'ready' as const,
        ordinal: Number(definition.slot),
        image,
        fonts,
      };
    },
    interrupt: release,
    retire() {
      readiness = 'pending';
      generation++;
      palette = undefined;
    },
    fit(value: boolean) {
      if (fit === value) return;
      fit = value;
      manual = false;
      paint();
    },
    async palette(value: Palette) {
      if (palette === value || disposed) return;
      palette = value;
      readiness = 'pending';
      const revision = ++generation;
      const current = () =>
        !disposed && revision === generation && figure.isConnected;
      feedback.textContent = `Rendering diagram ${definition.slot}…`;
      try {
        const result = await renderDiagram(
          definition.source,
          `${identity}-g${String(revision)}`,
          value,
          current,
        );
        if (!current() || !result) return;
        image = result;
        published = revision;
        readiness = 'ready';
        scene.innerHTML = result.svg;
        const svg = scene.querySelector('svg');
        svg?.setAttribute('role', 'img');
        svg?.setAttribute('aria-label', name);
        svg?.removeAttribute('aria-roledescription');
        for (const link of scene.querySelectorAll('a'))
          link.setAttribute('tabindex', '-1');
        figure.dataset.palette = value;
        feedback.textContent = '';
        enable(true);
        paint();
      } catch (error) {
        if (!current()) return;
        readiness = 'failed';
        published = revision;
        image = undefined;
        scene.replaceChildren();
        enable(false);
        release();
        viewport.setAttribute('data-pannable', 'false');
        feedback.textContent = `${name} could not render: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    dispose() {
      disposed = true;
      generation++;
      release();
      observer.disconnect();
      events.abort();
      image = undefined;
    },
  };
}
export type DiagramView = ReturnType<typeof mountDiagram>;
