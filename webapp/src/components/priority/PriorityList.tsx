import { useAppStore } from '../../store/useAppStore';
import { SourceType } from '../../api/types';
import { Icon } from '../shared/Icon';

const LABEL: Record<SourceType, string> = { grib2: 'GRIB2', utcef: 'UTCEF', harmonic: 'Harmonic' };

/**
 * Source-TYPE priority (PRD §5.3 Phase 1) — since Phase 3 this is only the
 * FALLBACK order: it ranks anything the per-dataset stack doesn't cover
 * (freshly-installed datasets before they're ranked, manually-dropped files,
 * the legacy harmonic pair). Reordered via arrow buttons, not drag-and-drop
 * (touch-first rule). The parent (ManageSheet) fetches /priority; this
 * component only renders and writes.
 */
export function PriorityList() {
  const priority = useAppStore((s) => s.priority);
  const setPriority = useAppStore((s) => s.setPriority);

  const move = (index: number, dir: -1 | 1) => {
    const next = [...priority];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setPriority(next);
  };

  return (
    <ol className="flex flex-col gap-1.5">
      {priority.map((type, i) => (
        <li key={type} className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-1">
          <span className="w-5 shrink-0 text-center text-xs font-semibold text-muted tabular-nums">{i + 1}</span>
          <span className="flex-1 text-sm font-medium">{LABEL[type]}</span>
          <button
            type="button"
            aria-label={`Move ${LABEL[type]} up`}
            disabled={i === 0}
            onClick={() => move(i, -1)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 disabled:opacity-25"
          >
            <Icon name="arrowUp" className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={`Move ${LABEL[type]} down`}
            disabled={i === priority.length - 1}
            onClick={() => move(i, 1)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 disabled:opacity-25"
          >
            <Icon name="arrowDown" className="h-4 w-4" />
          </button>
        </li>
      ))}
    </ol>
  );
}
