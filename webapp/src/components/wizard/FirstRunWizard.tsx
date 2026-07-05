import { useEffect, useMemo, useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { coveringSources } from '../../lib/wizard';
import { totalSizeBytes } from '../../lib/sources';
import { formatBytes } from '../../lib/format';
import { Modal } from '../shared/Modal';
import { WizardSourceCard } from './WizardSourceCard';

/**
 * First-Run Wizard (PRD §5.2) — "Download data around me". The MVP
 * headline: kills configuration friction by reading the vessel position,
 * intersecting it with the catalog, and offering a single install action.
 * Re-runnable anytime (openWizard()), with a manual position entry when no
 * vessel position is available or the user wants a different area ("Plan a
 * trip", per the PRD's own "enter/tap a position" wording).
 */
export function FirstRunWizard() {
  const wizard = useAppStore((s) => s.wizard);
  const dismissWizard = useAppStore((s) => s.dismissWizard);
  const catalog = useAppStore((s) => s.catalog);
  const vesselPosition = useAppStore((s) => s.vesselPosition);
  const startDownload = useAppStore((s) => s.startDownload);
  const setView = useAppStore((s) => s.setView);

  const [manualPos, setManualPos] = useState<{ lat: string; lon: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);

  const position = manualPos && manualPos.lat !== '' && manualPos.lon !== ''
    ? { latitude: Number(manualPos.lat), longitude: Number(manualPos.lon) }
    : vesselPosition;

  const candidates = useMemo(() => {
    if (!position || !catalog?.document) return [];
    return coveringSources(catalog.document.sources, position.latitude, position.longitude);
  }, [position, catalog]);

  // Default-select every covering source — "single install action" per PRD;
  // the user can still deselect individual ones.
  useEffect(() => {
    setSelected(new Set(candidates.map((c) => c.id)));
  }, [candidates]);

  if (!wizard.open) return null;

  const totalBytes = candidates
    .filter((c) => selected.has(c.id))
    .reduce((sum, c) => sum + (totalSizeBytes(c) ?? 0), 0);
  const anyUnknownSize = candidates.some((c) => selected.has(c.id) && totalSizeBytes(c) === null);

  const install = async () => {
    setInstalling(true);
    try {
      await Promise.all([...selected].map((id) => startDownload(id)));
      dismissWizard();
      setView('list');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Modal title="Download data around me" onClose={dismissWizard}>
      {!position ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted">
            No vessel position available yet. Enter a position to see which datasets cover it, or browse the
            full catalog instead.
          </p>
          <div className="flex gap-2">
            <input
              type="number"
              step="any"
              placeholder="Latitude"
              aria-label="Latitude"
              className="min-h-11 w-1/2 rounded border border-muted/40 bg-surface px-3"
              onChange={(e) => setManualPos((p) => ({ lat: e.target.value, lon: p?.lon ?? '' }))}
            />
            <input
              type="number"
              step="any"
              placeholder="Longitude"
              aria-label="Longitude"
              className="min-h-11 w-1/2 rounded border border-muted/40 bg-surface px-3"
              onChange={(e) => setManualPos((p) => ({ lat: p?.lat ?? '', lon: e.target.value }))}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              dismissWizard();
              setView('list');
            }}
            className="min-h-11 self-start text-sm text-accent underline"
          >
            Browse the full catalog instead
          </button>
        </div>
      ) : candidates.length === 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted">No catalog datasets cover this position yet.</p>
          <button
            type="button"
            onClick={() => {
              dismissWizard();
              setView('list');
            }}
            className="min-h-11 self-start text-sm text-accent underline"
          >
            Browse the full catalog
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            {candidates.length} dataset{candidates.length === 1 ? '' : 's'} cover{' '}
            {position.latitude.toFixed(2)}, {position.longitude.toFixed(2)}:
          </p>
          <ul className="flex flex-col gap-2">
            {candidates.map((source) => (
              <li key={source.id}>
                <WizardSourceCard
                  source={source}
                  checked={selected.has(source.id)}
                  onToggle={() => {
                    const next = new Set(selected);
                    if (next.has(source.id)) next.delete(source.id);
                    else next.add(source.id);
                    setSelected(next);
                  }}
                />
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={selected.size === 0 || installing}
            onClick={install}
            className="min-h-11 rounded bg-accent px-4 font-medium text-surface disabled:opacity-50"
          >
            {installing
              ? 'Starting…'
              : `Install selected (~${formatBytes(totalBytes)}${anyUnknownSize ? '+' : ''})`}
          </button>
        </div>
      )}
    </Modal>
  );
}
