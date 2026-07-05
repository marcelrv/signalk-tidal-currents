import { useEffect } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { api } from '../../api/client';
import { SourceType } from '../../api/types';

const LABEL: Record<SourceType, string> = { grib2: 'GRIB2', utcef: 'UTCEF', harmonic: 'Harmonic' };

/**
 * Source-type priority (PRD §5.3 Phase 1: an ordered list of the three
 * source TYPES, not yet per-dataset). Reordered via up/down arrow buttons
 * (44×44 px targets), not drag-and-drop — native HTML5 drag is
 * desktop-mouse-only and would violate the touch-first rule outright for a
 * list this small. Labeled honestly: applies per data type.
 */
export function PriorityList() {
  const priority = useAppStore((s) => s.priority);
  const setPriority = useAppStore((s) => s.setPriority);

  useEffect(() => {
    api.getPriority().then((r) => setPriority(r.order)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = (index: number, dir: -1 | 1) => {
    const next = [...priority];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setPriority(next);
  };

  return (
    <div>
      <p className="mb-2 text-xs text-muted">Priority applies per data type (not yet per dataset)</p>
      <ol className="flex flex-col gap-1">
        {priority.map((type, i) => (
          <li key={type} className="flex items-center gap-2 rounded border border-muted/30 px-3 py-1.5">
            <span className="flex-1 text-sm font-medium">
              {i + 1}. {LABEL[type]}
            </span>
            <button
              type="button"
              aria-label={`Move ${LABEL[type]} up`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
              className="min-h-11 min-w-11 rounded text-muted hover:bg-muted/10 disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Move ${LABEL[type]} down`}
              disabled={i === priority.length - 1}
              onClick={() => move(i, 1)}
              className="min-h-11 min-w-11 rounded text-muted hover:bg-muted/10 disabled:opacity-30"
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
