import { useEffect, useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { usePolling } from '../../hooks/usePolling';
import { api } from '../../api/client';
import { VectorResponse } from '../../api/types';

const SOURCE_LABEL: Record<VectorResponse['source'], string> = { grib: 'GRIB2', utcef: 'UTCEF', station: 'Station' };

/**
 * Persistent header element (PRD §5.6): "1.2 kn @ 108° — UTCEF · netherlands".
 * One glance answers "is it working, and which data is it using?" — also a
 * health check. This is the ONLY prediction display in the app (see PRD
 * Non-Goals — this is a data manager, not a current viewer). Lives as the
 * app bar's subtitle line, with a status dot doubling as the health signal.
 */
export function LiveSourceChip() {
  const vesselPosition = useAppStore((s) => s.vesselPosition);
  const [vector, setVector] = useState<VectorResponse | null>(null);
  const [failed, setFailed] = useState(false);

  const poll = () => {
    if (!vesselPosition) return;
    api
      .getVectorAt(vesselPosition.latitude, vesselPosition.longitude)
      .then((v) => {
        setVector(v);
        setFailed(false);
      })
      .catch(() => {
        setVector(null);
        setFailed(true);
      });
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(poll, [vesselPosition?.latitude, vesselPosition?.longitude]);
  usePolling(poll, vesselPosition ? 15_000 : null);

  const ok = Boolean(vesselPosition && !failed && vector);
  let text: string;
  if (!vesselPosition) text = 'No vessel position';
  else if (!ok) text = 'No current data here';
  else {
    const { sample, source, station } = vector!;
    const value =
      sample.speedKn !== null && sample.direction !== null
        ? `${Math.abs(sample.speedKn).toFixed(1)} kn @ ${Math.round(sample.direction)}°`
        : '—';
    text = `${value} · ${SOURCE_LABEL[source]}${station ? ` · ${station.name}` : ''}`;
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? 'bg-success' : 'bg-muted/40'}`} />
      <span className={`truncate tabular-nums ${ok ? 'text-fg/80' : ''}`}>{text}</span>
    </span>
  );
}
