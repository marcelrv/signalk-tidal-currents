import { Dispatch, SetStateAction, useEffect, useMemo, useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { coveringRows, groupByTier } from '../../lib/wizard';
import { datasetForRow, isRowInstalled, rowsForSources, SourceRow } from '../../lib/sources';
import { formatBytes } from '../../lib/format';
import { DatasetEntry } from '../../api/types';
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
  const datasets = useAppStore((s) => s.datasets);
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
    const all = rowsForSources(catalog.document.sources);
    return coveringRows(all, position.latitude, position.longitude);
  }, [position, catalog]);

  // Default-select only rows that are NOT already installed.
  const notInstalled = useMemo(() => candidates.filter((row) => !isRowInstalled(datasets, row)), [candidates, datasets]);

  // Grouped for display (includes already-installed rows, so they still show under the right tier).
  const allGrouped = useMemo(() => groupByTier(candidates), [candidates]);

  // Best not-installed row per tier — the one TierSection must always render
  // plainly (not tucked inside the collapsed "more options" disclosure, even
  // if an already-installed row outranks it in allGrouped).
  const notInstalledGrouped = useMemo(() => groupByTier(notInstalled), [notInstalled]);

  // A tier only gets a recommendation when NOTHING in it is installed yet for
  // this position. Otherwise, accepting one recommendation would immediately
  // surface another the next time the wizard opens — e.g. this position has
  // three overlapping "backup" sources (utcef_netherlands, utcef_atn_north_sea,
  // utcef_north_sea); installing the smallest one must not make the
  // next-smallest pop up as a fresh "recommended" pick.
  const liveRecommendedKey = allGrouped.live.some((r) => isRowInstalled(datasets, r)) ? null : (notInstalledGrouped.live[0]?.key ?? null);
  const backupRecommendedKey = allGrouped.backup.some((r) => isRowInstalled(datasets, r)) ? null : (notInstalledGrouped.backup[0]?.key ?? null);

  // Default-select only the recommended row per tier (≤ 2 total), not every covering row.
  useEffect(() => {
    const keys = new Set<string>();
    if (liveRecommendedKey) keys.add(liveRecommendedKey);
    if (backupRecommendedKey) keys.add(backupRecommendedKey);
    setSelected(keys);
  }, [liveRecommendedKey, backupRecommendedKey]);

  if (!wizard.open) return null;

  const newDownloads = notInstalled.filter((c) => selected.has(c.key));
  const totalBytes = newDownloads.reduce((sum, c) => {
    const d = datasetForRow(datasets, c);
    return sum + ((d ? d.sizeBytes : c.sizeBytes) ?? 0);
  }, 0);
  const anyUnknownSize = newDownloads.some((c) => c.sizeBytes === null);
  const hasNewDownloads = newDownloads.length > 0;

  const install = async () => {
    setInstalling(true);
    try {
      await Promise.all(newDownloads.map((row) => startDownload(row.source.id, row.regionId ? { region_id: row.regionId, type: row.fileType, variant: row.variant } : undefined)));
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
              className="min-h-11 w-1/2 rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
              onChange={(e) => setManualPos((p) => ({ lat: e.target.value, lon: p?.lon ?? '' }))}
            />
            <input
              type="number"
              step="any"
              placeholder="Longitude"
              aria-label="Longitude"
              className="min-h-11 w-1/2 rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
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
          <TierSection
            title="Live forecast"
            explainer="Updates automatically when you have internet — best accuracy while it's available."
            emptyMessage="No live forecast available here."
            rows={allGrouped.live}
            recommendedKey={liveRecommendedKey}
            datasets={datasets}
            selected={selected}
            setSelected={setSelected}
          />
          <TierSection
            title="Always-available backup"
            explainer="Downloads once and keeps working offline — usually lower resolution."
            emptyMessage="No offline backup available here."
            rows={allGrouped.backup}
            recommendedKey={backupRecommendedKey}
            datasets={datasets}
            selected={selected}
            setSelected={setSelected}
          />
          <button
            type="button"
            disabled={installing}
            onClick={hasNewDownloads ? install : dismissWizard}
            className="min-h-11 rounded-full bg-accent px-4 text-sm font-medium text-bg disabled:opacity-50"
          >
            {installing
              ? 'Starting…'
              : hasNewDownloads
                ? `Install selected (~${formatBytes(totalBytes)}${anyUnknownSize ? '+' : ''})`
                : 'Close'}
          </button>
        </div>
      )}
    </Modal>
  );
}

/**
 * One tier ("Live forecast" / "Always-available backup") of the wizard's
 * candidate list. `rows` is best-first ranked (`groupByTier`) and includes
 * already-installed rows so they still show under the right tier.
 * `recommendedKey` is the best NOT-installed row's key — null once the tier
 * already has a working install for this position, so accepting one
 * recommendation doesn't surface another next time. The recommended row (if
 * any) is surfaced plainly together with any already-installed rows;
 * everything else (genuinely redundant coverage, e.g. the global OpenCPN
 * harmonic pack, or a second overlapping regional pack once the tier is
 * satisfied) is collapsed under a disclosure so the default view stays small
 * while still letting the user opt into extras.
 */
function TierSection({
  title,
  explainer,
  emptyMessage,
  rows,
  recommendedKey,
  datasets,
  selected,
  setSelected,
}: {
  title: string;
  explainer: string;
  emptyMessage: string;
  rows: SourceRow[];
  recommendedKey: string | null;
  datasets: DatasetEntry[];
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}) {
  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderRow = (row: SourceRow, recommended: boolean) => {
    const d = datasetForRow(datasets, row);
    return (
      <li key={row.key}>
        <WizardSourceCard row={row} dataset={d ?? null} checked={selected.has(row.key)} onToggle={() => toggle(row.key)} recommended={recommended} />
      </li>
    );
  };

  const primary = rows.filter((r) => r.key === recommendedKey || isRowInstalled(datasets, r));
  const extra = rows.filter((r) => r.key !== recommendedKey && !isRowInstalled(datasets, r));

  return (
    <div className="flex flex-col gap-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted">{explainer}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">{emptyMessage}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {primary.map((row) => renderRow(row, row.key === recommendedKey))}
          {extra.length > 0 && (
            <li>
              <details>
                <summary className="min-h-11 cursor-pointer py-1 text-sm text-accent">
                  Show {extra.length} more option{extra.length === 1 ? '' : 's'} covering this area
                </summary>
                <ul className="mt-2 flex flex-col gap-2">{extra.map((row) => renderRow(row, false))}</ul>
              </details>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
