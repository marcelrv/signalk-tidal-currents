import { ReactNode } from 'react';

import { Icon } from './Icon';

/**
 * Bottom sheet on small screens (thumb-reachable, PRD touch-first), centered
 * dialog from `sm:` up. The drag-handle bar is decorative — dismissal is the
 * scrim tap or the close button (both ≥44px targets).
 */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-t-2xl border border-border bg-surface shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border sm:hidden" aria-hidden />
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-2 sm:pt-3">
          <h2 className="min-w-0 truncate text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted hover:bg-surface-2"
          >
            <Icon name="x" className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-1">{children}</div>
      </div>
    </div>
  );
}
