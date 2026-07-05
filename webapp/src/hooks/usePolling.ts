import { useEffect, useRef } from 'react';

/** Calls `fn` every `intervalMs` while intervalMs is non-null; pauses (clears the interval) when null. */
export function usePolling(fn: () => void, intervalMs: number | null): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (intervalMs === null) return;
    const id = setInterval(() => fnRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
