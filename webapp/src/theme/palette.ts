import { Theme } from './ThemeProvider';

/**
 * Mirror of tokens.css's hex values, for contexts that can't use CSS
 * variables (Leaflet vector layers set SVG presentation attributes directly,
 * which don't resolve var(...) the way a `style` property would).
 */
export const THEME_COLORS: Record<Theme, { success: string; warn: string; danger: string; muted: string; accent: string }> = {
  day: { success: '#15803d', warn: '#b45309', danger: '#b91c1c', muted: '#64748b', accent: '#0369a1' },
  dark: { success: '#4ade80', warn: '#fbbf24', danger: '#f87171', muted: '#94a3b8', accent: '#38bdf8' },
  red: { success: '#ff4040', warn: '#cc2020', danger: '#ffffff', muted: '#a03030', accent: '#ff4040' },
};
