import { CatalogSource, DatasetEntry } from '../../api/types';

/**
 * Attribution & License Surface (PRD §5.7). Catalog-level `contributor`/`url`
 * are always shown; for an installed UTCEF dataset the file's own metadata
 * carries real structured license/citation data (parsed in utcef.ts) that's
 * richer than the catalog — e.g. FES2014's AVISO+ license requires citation
 * and is non-commercial. Plain text, no design polish beyond correct
 * wrapping/contrast — legally required, and it makes cards look finished.
 */
export function AttributionPanel({ source, dataset }: { source: CatalogSource; dataset: DatasetEntry | undefined }) {
  return (
    <div className="flex flex-col gap-1 text-sm text-muted">
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
      {dataset?.license && (
        <p>
          <span className="font-medium text-fg">License:</span> {dataset.license}
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
        <p>
          <span className="font-medium text-fg">Citation required:</span> {dataset.citationRequired}
        </p>
      )}
    </div>
  );
}
