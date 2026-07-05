import { DisplayStatus } from '../../lib/sources';

const LABELS: Record<DisplayStatus, string> = {
  active: 'Downloaded & active',
  'update-available': 'Update available',
  'not-installed': 'Available — not downloaded',
  error: 'Error',
};

/** The 5-symbol status vocabulary from PRD §4, used consistently on map polygons, list rows, and cards. */
export function StatusBadge({ status }: { status: DisplayStatus }) {
  const label = LABELS[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm" title={label}>
      <span
        aria-hidden
        className={
          {
            active: 'inline-block h-2.5 w-2.5 rounded-full bg-success',
            'update-available': 'inline-block h-2.5 w-2.5 rounded-full bg-warn motion-safe:animate-pulse',
            'not-installed': 'inline-block h-2.5 w-2.5 rounded-full border-2 border-dashed border-muted',
            error: 'inline-block h-2.5 w-2.5 rounded-full bg-danger',
          }[status]
        }
      />
      <span className="text-muted">{label}</span>
    </span>
  );
}
