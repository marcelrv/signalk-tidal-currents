import { Theme } from './ThemeProvider';

/**
 * Mirror of tokens.css's hex values, for contexts that can't use CSS
 * variables (Leaflet vector layers set SVG presentation attributes directly,
 * which don't resolve var(...) the way a `style` property would).
 *
 * `type*` are DEDICATED to distinguishing the 3 catalog source types
 * (harmonic/grib2/utcef) on the map — kept separate from success/warn/danger
 * (which encode STATUS on the same map) so the two visual channels don't
 * collide. In red mode true distinct hues aren't possible (PRD §4: shades of
 * red/black/white only), so the 3 type colors there are 3 different
 * LIGHTNESS levels instead — still distinguishable, just not by hue.
 */
export interface ThemePalette {
  success: string;
  warn: string;
  danger: string;
  muted: string;
  accent: string;
  typeHarmonic: string;
  typeGrib2: string;
  typeUtcef: string;
}

export const THEME_COLORS: Record<Theme, ThemePalette> = {
  day: {
    success: '#15803d', warn: '#b45309', danger: '#b91c1c', muted: '#64748b', accent: '#0369a1',
    typeHarmonic: '#7c3aed', typeGrib2: '#1d4ed8', typeUtcef: '#0f766e',
  },
  dark: {
    success: '#4ade80', warn: '#fbbf24', danger: '#f87171', muted: '#94a3b8', accent: '#38bdf8',
    typeHarmonic: '#c4b5fd', typeGrib2: '#60a5fa', typeUtcef: '#5eead4',
  },
  red: {
    success: '#ff4040', warn: '#cc2020', danger: '#ffffff', muted: '#a03030', accent: '#ff4040',
    // 3 lightness levels — light/bright/dark — since hue can't vary here.
    typeHarmonic: '#ffb3b3', typeGrib2: '#ff3333', typeUtcef: '#800000',
  },
};
