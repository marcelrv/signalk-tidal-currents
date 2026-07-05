import { useEffect, useState } from 'react';

import { useAppStore } from '../store/useAppStore';
import { DownloadJob } from '../api/types';

const API_BASE = '/plugins/signalk-tidal-currents';

/**
 * Subscribes to live download progress via Server-Sent Events (PRD §9 Phase
 * 2) — an upgrade over polling, not a replacement. Returns `true` when the
 * caller should fall back to polling (no `EventSource` support, or the
 * connection errored); the caller keeps its existing `usePolling(...,
 * fellBack ? 800 : null)` call for that case, unchanged.
 */
export function useDownloadProgress(jobId: string | null): boolean {
  const setDownloadJob = useAppStore((s) => s.setDownloadJob);
  const [fellBack, setFellBack] = useState(false);

  useEffect(() => {
    if (!jobId) return;
    if (typeof EventSource === 'undefined') {
      setFellBack(true);
      return;
    }
    setFellBack(false);
    const source = new EventSource(`${API_BASE}/downloads/${encodeURIComponent(jobId)}/events`);
    source.onmessage = (ev) => {
      try {
        setDownloadJob(JSON.parse(ev.data) as DownloadJob);
      } catch {
        // malformed frame — ignore, next one will correct the state
      }
    };
    source.onerror = () => {
      setFellBack(true);
      source.close();
    };
    return () => source.close();
  }, [jobId, setDownloadJob]);

  return fellBack;
}
