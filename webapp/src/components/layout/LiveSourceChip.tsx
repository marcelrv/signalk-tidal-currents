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
 * Non-Goals — this is a data manager, not a current viewer).
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

  if (!vesselPosition) {
    return <span className="text-sm text-muted">No vessel position</span>;
  }
  if (failed || !vector) {
    return <span className="text-sm text-muted">No current data at vessel position</span>;
  }

  const { sample, source, station } = vector;
  return (
    <span className="text-sm">
      {sample.speedKn !== null && sample.direction !== null
        ? `${Math.abs(sample.speedKn).toFixed(1)} kn @ ${Math.round(sample.direction)}°`
        : '—'}
      {' — '}
      <span className="text-muted">
        {SOURCE_LABEL[source]}
        {station ? ` · ${station.name}` : ''}
      </span>
    </span>
  );
}
