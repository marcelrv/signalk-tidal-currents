import { DisplayStatus } from '../../lib/sources';

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  active: 'Downloaded & active',
  'update-available': 'Update available',
  'not-installed': 'Available — not downloaded',
  error: 'Error',
};

const DOT_CLASS: Record<DisplayStatus, string> = {
  active: 'bg-success',
  'update-available': 'bg-warn motion-safe:animate-pulse',
  'not-installed': 'border-2 border-dashed border-muted',
  error: 'bg-danger',
};

/** Dot-only form of the PRD §4 status vocabulary — for dense list rows where the label would repeat on every line. */
export function StatusDot({ status, className }: { status: DisplayStatus; className?: string }) {
  return (
    <span
      aria-label={STATUS_LABELS[status]}
      title={STATUS_LABELS[status]}
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT_CLASS[status]} ${className ?? ''}`}
    />
  );
}

/** The 5-symbol status vocabulary from PRD §4, used consistently on map polygons, list rows, and cards. */
export function StatusBadge({ status }: { status: DisplayStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <StatusDot status={status} />
      <span className="text-muted">{STATUS_LABELS[status]}</span>
    </span>
  );
}
