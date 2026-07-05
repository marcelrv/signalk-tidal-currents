import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

export type Theme = 'day' | 'dark' | 'red';

const STORAGE_KEY = 'tidal-currents-manager.theme';

function systemDefault(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'day';
}

function initialTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  // Red mode is never auto-selected — it's an explicit, deliberate choice
  // (night-vision preservation), not something to guess at from OS prefs.
  if (saved === 'day' || saved === 'dark' || saved === 'red') return saved;
  return systemDefault();
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void } | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const setTheme = (t: Theme) => setThemeState(t);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
