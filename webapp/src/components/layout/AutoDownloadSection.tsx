import { useEffect, useState } from 'react';

import { AutoDownloadInterval, AutoDownloadSettings } from '../../api/types';
import { timeAgo, timeUntil } from '../../lib/format';
import { READ_ONLY_HINT, useAppStore, useReadOnly } from '../../store/useAppStore';

const LABELS: Record<AutoDownloadInterval, string> = {
  0: 'Off',
  1: 'Every hour',
  6: 'Every 6 h',
  12: 'Every 12 h',
  24: 'Daily',
};

/** One line of feedback under the title: what the last sweep did and when the next one is due. */
function feedback(s: AutoDownloadSettings): string {
  if (s.intervalHours === 0) return 'Off · installed data only updates when you press Update All';
  if (s.running) return 'Checking for updates…';
  const parts: string[] = [];
  const last = s.lastSweep;
  if (!last) parts.push('Not run yet');
  else if (last.error) parts.push(`Last run failed ${timeAgo(last.at)}`);
  else {
    parts.push(`Last run ${timeAgo(last.at)}`);
    parts.push(last.started.length > 0 ? `started ${last.started.length}` : 'all up to date');
    if (last.skippedDiskFull.length > 0) parts.push(`${last.skippedDiskFull.length} skipped: disk almost full`);
  }
  if (s.nextCheckAt) parts.push(`next ${timeUntil(s.nextCheckAt)}`);
  return parts.join(' · ');
}

/**
 * Auto-download (a scheduled "Update All"): ONE control — Off or how often.
 * While on, every installed dataset that has gone stale is re-downloaded,
 * except those opted out on their own row.
 */
export function AutoDownloadSection() {
  const settings = useAppStore((s) => s.autoDownload);
  const fetchAutoDownload = useAppStore((s) => s.fetchAutoDownload);
  const setAutoDownload = useAppStore((s) => s.setAutoDownload);
  const readOnly = useReadOnly();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAutoDownload();
  }, [fetchAutoDownload]);

  // A sweep started by the change runs server-side; re-read once it has had
  // time to finish so the feedback line shows what it did.
  useEffect(() => {
    if (!settings?.running) return;
    const t = setTimeout(() => fetchAutoDownload(), 2000);
    return () => clearTimeout(t);
  }, [settings, fetchAutoDownload]);

  const choices = settings?.choices ?? ([0, 1, 6, 12, 24] as AutoDownloadInterval[]);
  const onChange = async (value: AutoDownloadInterval) => {
    setSaving(true);
    setError(null);
    try {
      await setAutoDownload(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Auto-download" className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2">
      <div className="min-w-0 text-sm">
        <label htmlFor="auto-download-interval" className="font-medium">Auto-download</label>
        <div className={`text-xs ${error ? 'text-danger' : 'text-muted'}`}>
          {error ?? (settings ? feedback(settings) : '…')}
        </div>
      </div>
      <select
        id="auto-download-interval"
        value={settings?.intervalHours ?? 0}
        disabled={!settings || saving || readOnly}
        title={readOnly ? READ_ONLY_HINT : undefined}
        onChange={(e) => onChange(Number(e.target.value) as AutoDownloadInterval)}
        className="min-h-11 shrink-0 rounded-full bg-surface-2 px-3 text-sm font-medium text-accent disabled:opacity-50"
      >
        {choices.map((h) => (
          <option key={h} value={h}>{LABELS[h] ?? `Every ${h} h`}</option>
        ))}
      </select>
    </section>
  );
}
