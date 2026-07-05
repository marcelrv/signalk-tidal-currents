import { useAppStore } from '../../store/useAppStore';

/** [ 🗺 Map | ☰ List ] — shared state: the same filters/selection/inspector serve both (PRD §5.1). */
export function ViewToggle() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  return (
    <div role="group" aria-label="View" className="inline-flex overflow-hidden rounded border border-muted/40">
      {(['map', 'list'] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          aria-pressed={view === v}
          className={`min-h-11 px-4 text-sm ${view === v ? 'bg-accent/10 text-accent' : 'text-muted'}`}
        >
          {v === 'map' ? '🗺 Map' : '☰ List'}
        </button>
      ))}
    </div>
  );
}
