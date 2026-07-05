import { CatalogSource, DatasetEntry } from '../../api/types';

const LONG_TEXT_THRESHOLD = 160;

/** Collapses long license/citation text behind a disclosure (same `<details>/<summary>` pattern as App.tsx's "Source priority") so a FES2014-length paragraph doesn't blow out the card. */
function ExpandableText({ text }: { text: string }) {
  if (text.length <= LONG_TEXT_THRESHOLD) return <span>{text}</span>;
  return (
    <details>
      <summary className="cursor-pointer text-accent">
        {text.slice(0, 140)}… <span className="underline">show full text</span>
      </summary>
      <p className="mt-1">{text}</p>
    </details>
  );
}

/**
 * Attribution & License Surface (PRD §5.7). Catalog-level `contributor`/`url`
 * are always shown; for an installed UTCEF dataset the file's own metadata
 * carries real structured license/citation data (parsed in utcef.ts) that's
 * richer than the catalog — e.g. FES2014's AVISO+ license requires citation
 * and is non-commercial. The license/citation block gets its own visual
 * weight (a warn-toned callout + a citation-required badge) since it's
 * legally load-bearing, not just "nice to know" like the contributor line.
 */
export function AttributionPanel({ source, dataset }: { source: CatalogSource; dataset: DatasetEntry | undefined }) {
  const hasLicenseInfo = Boolean(dataset?.license || dataset?.citationRequired);

  return (
    <div className="flex flex-col gap-2 text-sm text-muted">
      <p>
        <span className="font-medium text-fg">Contributor:</span> {source.contributor || '—'}
        {source.url && (
          <>
            {' · '}
            <a href={source.url} target="_blank" rel="noreferrer" className="text-accent underline">
              {source.url}
            </a>
          </>
        )}
      </p>
      {dataset?.copyright && (
        <p>
          <span className="font-medium text-fg">Copyright:</span> {dataset.copyright}
        </p>
      )}
      {hasLicenseInfo && (
        <div className="rounded border border-warn/40 bg-warn/5 p-2">
          {dataset?.citationRequired && (
            <p className="mb-1 flex items-center gap-1 font-medium text-warn">
              <span aria-hidden>⚠</span> Citation required
            </p>
          )}
          {dataset?.license && (
            <p>
              <span className="font-medium text-fg">License:</span> <ExpandableText text={dataset.license} />
              {dataset.licenseUrl && (
                <>
                  {' · '}
                  <a href={dataset.licenseUrl} target="_blank" rel="noreferrer" className="text-accent underline">
                    full text
                  </a>
                </>
              )}
            </p>
          )}
          {dataset?.citationRequired && (
            <p className="mt-1">
              <span className="font-medium text-fg">Citation:</span> <ExpandableText text={dataset.citationRequired} />
            </p>
          )}
        </div>
      )}
    </div>
  );
}
