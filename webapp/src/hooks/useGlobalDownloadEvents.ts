import { useEffect, useState } from 'react';

import { useAppStore } from '../store/useAppStore';
import { api } from '../api/client';
import { DownloadJob } from '../api/types';

const API_BASE = '/plugins/signalk-tidal-currents';

/**
 * Keeps `datasets`/`storage` fresh for EVERY download job, independent of
 * whether any particular row's `DownloadButton` (the per-job SSE/poll
 * subscription in `useDownloadProgress`) happens to be mounted for it. Without
 * this, a job started while in Map view, or while a search/type/tag filter
 * hides that row, finishes on the backend but the frontend never finds out —
 * the dataset/banner keeps showing stale status forever, looking exactly like
 * clicking "Update" did nothing. Mounted ONCE at the app root (see App.tsx),
 * for the whole session, rather than per-row.
 */
export function useGlobalDownloadEvents(): void {
  const setDownloadJob = useAppStore((s) => s.setDownloadJob);
  const [fellBack, setFellBack] = useState(false);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setFellBack(true);
      return;
    }
    setFellBack(false);
    const source = new EventSource(`${API_BASE}/downloads/events`);
    source.onmessage = (ev) => {
      try {
        setDownloadJob(JSON.parse(ev.data) as DownloadJob);
      } catch {
        // malformed frame — ignore, the next one (or the polling fallback) will correct the state
      }
    };
    source.onerror = () => {
      setFellBack(true);
      source.close();
    };
    return () => source.close();
  }, [setDownloadJob]);

  usePollingFallback(fellBack, setDownloadJob);
}

function usePollingFallback(active: boolean, setDownloadJob: (job: DownloadJob) => void): void {
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      api.listDownloads().then((jobs) => jobs.forEach(setDownloadJob)).catch(() => {
        // transient fetch failure — next tick retries
      });
    }, 3000);
    return () => clearInterval(id);
  }, [active, setDownloadJob]);
}
