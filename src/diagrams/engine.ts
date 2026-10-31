import type { MermaidConfig } from 'mermaid';
import type { Palette } from '../settings/model';

export interface DiagramImage {
  svg: string;
  viewBox: [number, number, number, number];
  width: number;
  height: number;
  identity: string;
}
let serial: Promise<unknown> = Promise.resolve();
let sequence = 0;
export function diagramIdentity(context: string) {
  return `diagram-${context}-${String(++sequence)}`;
}
export function checkedGeometry(svg: SVGSVGElement) {
  const box = svg
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    !box ||
    box.length !== 4 ||
    !box.every(Number.isFinite) ||
    (box[2] ?? 0) <= 0 ||
    (box[3] ?? 0) <= 0
  )
    throw new Error('The diagram has no finite positive viewBox dimensions.');
  const viewBox: DiagramImage['viewBox'] = [
    box[0] ?? 0,
    box[1] ?? 0,
    box[2] ?? 0,
    box[3] ?? 0,
  ];
  return { viewBox, width: viewBox[2], height: viewBox[3] };
}
export function trustedConfig(colors: Record<string, string>): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    maxTextSize: 50_000,
    maxEdges: 500,
    theme: 'base',
    fontFamily: 'system-ui, sans-serif',
    themeVariables: {
      background: colors.page,
      primaryColor: colors.panel,
      primaryTextColor: colors.text,
      primaryBorderColor: colors.border,
      secondaryColor: colors.panel,
      tertiaryColor: colors.page,
      lineColor: colors.text,
      textColor: colors.text,
      nodeTextColor: colors.text,
      mainBkg: colors.panel,
      actorBkg: colors.panel,
      actorTextColor: colors.text,
      actorBorder: colors.border,
      signalColor: colors.text,
      signalTextColor: colors.text,
      labelBoxBkgColor: colors.panel,
      labelTextColor: colors.text,
      edgeLabelBackground: colors.page,
      clusterBkg: colors.panel,
      clusterBorder: colors.border,
    },
    // Secure names are recursive keys, not dotted configuration paths.
    secure: [
      'secure',
      'startOnLoad',
      'securityLevel',
      'htmlLabels',
      'suppressErrorRendering',
      'maxTextSize',
      'maxEdges',
      'theme',
      'themeVariables',
      'themeCSS',
      'fontFamily',
      'altFontFamily',
      'dompurifyConfig',
      'fontSize',
      'actorFontFamily',
      'messageFontFamily',
      'noteFontFamily',
      'taskFontFamily',
      'titleFontFamily',
      'legacyMathML',
      'forceLegacyMathML',
    ],
  };
}
export function renderDiagram(
  source: string,
  identity: string,
  palette: Palette,
  current: () => boolean,
): Promise<DiagramImage | undefined> {
  const style = getComputedStyle(document.documentElement);
  const config = trustedConfig(
    Object.fromEntries(
      ['page', 'panel', 'text', 'border'].map((name) => [
        name,
        style.getPropertyValue(`--${name}`).trim(),
      ]),
    ),
  );
  const work = serial.then(async () => {
    if (!current()) return;
    if (source.length > 50_000)
      throw new Error('Definition exceeds the 50,000-character diagram limit.');
    const { default: mermaid } = await import('mermaid');
    if (!current()) return;
    const container = document.createElement('div');
    container.className = 'diagram-measure';
    container.inert = true;
    container.setAttribute('aria-hidden', 'true');
    document.body.append(container);
    try {
      mermaid.initialize(config);
      const { svg } = await mermaid.render(identity, source, container);
      if (!current()) return;
      container.innerHTML = svg;
      const element = container.querySelector('svg');
      if (!element) throw new Error('The renderer returned no diagram.');
      return {
        svg,
        ...checkedGeometry(element),
        identity: `${identity}-${palette}`,
      };
    } finally {
      // Disposal never removes the engine's active layout DOM mid-render.
      container.remove();
    }
  });
  serial = work.catch(() => {});
  return work;
}
