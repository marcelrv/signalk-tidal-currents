import { SVGProps } from 'react';

/**
 * Minimal inline SVG icon set (lucide-style 24px stroke paths, bundled — no
 * icon font, no CDN, per the offline-first rule). Emoji are deliberately not
 * used for UI chrome: they render inconsistently across the embedded/older
 * browsers found on plotters and ignore the red night theme's palette.
 */
const PATHS: Record<string, string> = {
  anchor: 'M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0v14m-7-10H2a10 10 0 0 0 20 0h-3',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.35-4.35',
  map: 'M9 18.5 3 21V5.5l6-2.5 6 2.5 6-2.5V19l-6 2.5-6-3zm0 0V3m6 2.5v15',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v5h-5',
  compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm4.2-14.2-2.1 6.3-6.3 2.1 2.1-6.3 6.3-2.1z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-14v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  sliders: 'M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 14h6m2-6h6m2 8h6',
  trash: 'M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-6 5v6m4-6v6',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3',
  chevronDown: 'm6 9 6 6 6-6',
  chevronRight: 'm9 6 6 6-6 6',
  arrowUp: 'M12 19V5m-7 7 7-7 7 7',
  arrowDown: 'M12 5v14m7-7-7 7-7-7',
  autoSort: 'M11 5h10m-10 4h7m-7 4h4M3 17l3 3 3-3m-3 2V4',
  tag: 'M12.6 2.9 21 11.3a2 2 0 0 1 0 2.8l-6.9 6.9a2 2 0 0 1-2.8 0L2.9 12.6A2 2 0 0 1 2.3 11L2 4a2 2 0 0 1 2-2l7 .3a2 2 0 0 1 1.6.6zM7.5 7.5h.01',
  layers: 'm12 2 9.5 5.5L12 13 2.5 7.5 12 2zm-9.5 10L12 17.5l9.5-5.5m-19 5L12 22.5l9.5-5.5',
  alert: 'M12 9v4m0 4h.01M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z',
};

export type IconName = keyof typeof PATHS | 'nightMode';

export function Icon({ name, className, ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className ?? 'h-5 w-5'}
      {...rest}
    >
      {name === 'nightMode' ? (
        // Red night mode: an outlined circle with a solid core — reads as a
        // "dim red lamp" without needing a hue of its own.
        <>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
        </>
      ) : (
        <path d={PATHS[name]} />
      )}
    </svg>
  );
}
