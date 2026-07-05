import { useEffect, useMemo, useState } from 'react';
import { CircleMarker, GeoJSON, MapContainer, useMapEvents } from 'react-leaflet';
import type { LatLng } from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { useAppStore } from '../../store/useAppStore';
import { useTheme } from '../../theme/ThemeProvider';
import { THEME_COLORS } from '../../theme/palette';
import { CatalogSource } from '../../api/types';
import { datasetForSource, displayStatus, DisplayStatus, matchesFilters } from '../../lib/sources';
import { pointInGeometry } from '../../lib/geo';
import { RegionInspector } from './RegionInspector';

// Deliberately opaque, like the backend's GeoJsonGeometry type (catalogTypes.ts)
// — this webapp never interprets coordinates itself, only hands them to Leaflet.
interface FeatureCollection {
  type: 'FeatureCollection';
  features: unknown[];
}

const STATUS_COLOR_KEY: Record<DisplayStatus, keyof typeof THEME_COLORS.day> = {
  active: 'success',
  'update-available': 'warn',
  'not-installed': 'muted',
  error: 'danger',
};

/** Captures map clicks to open the Region Inspector (react-leaflet requires this inside <MapContainer>). */
function ClickCapture({ onClick }: { onClick: (latlng: LatLng) => void }) {
  useMapEvents({ click: (e) => onClick(e.latlng) });
  return null;
}

/**
 * Map view (PRD §5.1): bundled offline coastline + per-source region
 * polygons colored by status + vessel marker. Local vector source only —
 * never a tile/style/CDN URL (PRD §6.3).
 */
export function SourceMap() {
  const { theme } = useTheme();
  const colors = THEME_COLORS[theme];
  const catalog = useAppStore((s) => s.catalog);
  const datasets = useAppStore((s) => s.datasets);
  const filters = useAppStore((s) => s.filters);
  const vesselPosition = useAppStore((s) => s.vesselPosition);
  const select = useAppStore((s) => s.select);
  const [coastline, setCoastline] = useState<FeatureCollection | null>(null);
  const [inspecting, setInspecting] = useState<CatalogSource[] | null>(null);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}coastline-110m.geojson`)
      .then((r) => r.json())
      .then(setCoastline)
      .catch(() => setCoastline({ type: 'FeatureCollection', features: [] }));
  }, []);

  const sources = useMemo(
    () => (catalog?.document?.sources ?? []).filter((s) => matchesFilters(s, filters)),
    [catalog, filters],
  );

  const handleMapClick = (latlng: LatLng) => {
    const covering = sources.filter((s) => pointInGeometry(s.region.boundary_geometry, latlng.lat, latlng.lng));
    if (covering.length > 0) setInspecting(covering);
  };

  return (
    <div className="h-[60vh] overflow-hidden rounded border border-muted/30">
      <MapContainer
        center={[20, 0]}
        zoom={2}
        minZoom={1}
        worldCopyJump
        className="h-full w-full"
        style={{ background: 'var(--color-bg)' }}
      >
        {coastline && (
          <GeoJSON
            data={coastline as never}
            style={{ color: colors.muted, weight: 1, fillColor: colors.muted, fillOpacity: 0.15 }}
          />
        )}
        {sources.map((source) => {
          const status = displayStatus(datasetForSource(datasets, source.id));
          const color = colors[STATUS_COLOR_KEY[status]];
          return (
            <GeoJSON
              key={source.id}
              data={source.region.boundary_geometry as never}
              style={{
                color,
                weight: 2,
                fillColor: color,
                fillOpacity: status === 'not-installed' ? 0.08 : 0.25,
                dashArray: status === 'not-installed' ? '6 4' : undefined,
              }}
              eventHandlers={{ click: () => select(source.id) }}
            />
          );
        })}
        {vesselPosition && (
          <CircleMarker
            center={[vesselPosition.latitude, vesselPosition.longitude]}
            radius={7}
            pathOptions={{ color: colors.accent, fillColor: colors.accent, fillOpacity: 1 }}
          />
        )}
        <ClickCapture onClick={handleMapClick} />
      </MapContainer>
      {inspecting && <RegionInspector sources={inspecting} onClose={() => setInspecting(null)} />}
    </div>
  );
}
