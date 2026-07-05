import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../shared/Icon';

/** [ Map | List ] segmented control — shared state: the same filters/selection/inspector serve both (PRD §5.1). */
export function ViewToggle() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  return (
    <div role="group" aria-label="View" className="flex shrink-0 rounded-xl bg-surface-2 p-1">
      {(['map', 'list'] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          aria-pressed={view === v}
          className={`flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors ${
            view === v ? 'bg-surface text-fg shadow-sm' : 'text-muted'
          }`}
        >
          <Icon name={v === 'map' ? 'map' : 'list'} className="h-4 w-4" />
          <span className="hidden sm:inline">{v === 'map' ? 'Map' : 'List'}</span>
        </button>
      ))}
    </div>
  );
}
