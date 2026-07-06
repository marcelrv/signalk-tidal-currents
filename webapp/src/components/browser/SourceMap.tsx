import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleMarker, GeoJSON, MapContainer, useMap, useMapEvents } from 'react-leaflet';
import L, { LatLng, Layer } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '../../theme/leaflet-theme.css';

import { useAppStore } from '../../store/useAppStore';
import { useTheme } from '../../theme/ThemeProvider';
import { THEME_COLORS, ThemePalette } from '../../theme/palette';
import { CatalogSourceType } from '../../api/types';
import { SourceRow, datasetForRow, displayStatus, DisplayStatus, matchesFilters, rowsForSources } from '../../lib/sources';
import { geometryBbox, pointInGeometry } from '../../lib/geo';
import { STATUS_LABELS } from '../shared/StatusBadge';
import { RegionInspector } from './RegionInspector';

// Deliberately opaque, like the backend's GeoJsonGeometry type (catalogTypes.ts)
// — this webapp never interprets coordinates itself, only hands them to Leaflet.
interface FeatureCollection {
  type: 'FeatureCollection';
  features: unknown[];
}

const TYPE_COLOR_KEY: Record<CatalogSourceType, keyof ThemePalette> = {
  harmonic: 'typeHarmonic',
  grib2: 'typeGrib2',
  utcef: 'typeUtcef',
};
const TYPE_LABEL: Record<CatalogSourceType, string> = { utcef: 'UTCEF', grib2: 'GRIB2', harmonic: 'Harmonic' };

/** Color by TYPE (so the 3 catalog types are always visually distinguishable); STATUS is conveyed via opacity/dash/weight on top, with 'error' overriding the color entirely since a broken dataset is more urgent than its type. */
function styleForRow(row: SourceRow, status: DisplayStatus, colors: ThemePalette) {
  const color = status === 'error' ? colors.danger : colors[TYPE_COLOR_KEY[row.source.type]];
  return {
    color,
    weight: status === 'update-available' ? 3 : 2,
    fillColor: color,
    fillOpacity: status === 'not-installed' ? 0.08 : 0.3,
    dashArray: status === 'not-installed' ? '6 4' : undefined,
  };
}

/** Small DOM-built tooltip (not an HTML string) so catalog-provided text (name/region) can never inject markup. */
function buildTooltip(row: SourceRow, status: DisplayStatus): HTMLElement {
  const el = document.createElement('div');
  const title = document.createElement('div');
  title.style.fontWeight = '600';
  title.textContent = row.name;
  const meta = document.createElement('div');
  meta.textContent = `${TYPE_LABEL[row.source.type]} · ${STATUS_LABELS[status]}`;
  const region = document.createElement('div');
  region.textContent = row.regionName;
  el.append(title, meta, region);
  return el;
}

/**
 * "Zoom to fit all data" — a standard Leaflet bar control (so it inherits the
 * theme styling `.leaflet-bar a` already gets, and stacks under the zoom
 * buttons automatically). Fits the map to the bounding box of every region
 * currently shown plus the vessel, so from a world view one tap frames
 * exactly the data you have. Implemented imperatively via `useMap` because
 * react-leaflet has no built-in custom-control component; the current
 * rows/vessel are read through a ref so the control is added once, not
 * rebuilt whenever the data changes.
 */
function FitAllControl({ rows, vessel }: { rows: SourceRow[]; vessel: { latitude: number; longitude: number } | null }) {
  const map = useMap();
  const dataRef = useRef({ rows, vessel });
  dataRef.current = { rows, vessel };

  useEffect(() => {
    const control = new L.Control({ position: 'topleft' });
    control.onAdd = () => {
      const container = L.DomUtil.create('div', 'leaflet-bar');
      const link = L.DomUtil.create('a', '', container) as HTMLAnchorElement;
      link.href = '#';
      link.title = 'Zoom to fit all data';
      link.setAttribute('role', 'button');
      link.setAttribute('aria-label', 'Zoom to fit all data');
      link.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-top:3px">' +
        '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M8 21H5a2 2 0 0 1-2-2v-3m18 0v3a2 2 0 0 1-2 2h-3"/></svg>';
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(link, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        const { rows: curRows, vessel: curVessel } = dataRef.current;
        const pts: L.LatLngExpression[] = [];
        for (const r of curRows) {
          const b = geometryBbox(r.geometry);
          if (!b) continue;
          pts.push([b.min_lat, b.min_lon], [b.max_lat, b.max_lon]);
        }
        if (curVessel) pts.push([curVessel.latitude, curVessel.longitude]);
        if (pts.length === 0) return;
        const bounds = L.latLngBounds(pts);
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
      });
      return container;
    };
    control.addTo(map);
    return () => {
      control.remove();
    };
  }, [map]);

  return null;
}

/** Captures map clicks to open the Region Inspector (react-leaflet requires this inside <MapContainer>). */
function ClickCapture({ onClick }: { onClick: (latlng: LatLng) => void }) {
  const map = useMapEvents({
    click: (e) => {
      // A tap on a touch device fires Leaflet's hover-emulation (opening a
      // `sticky: true` tooltip) AND this click handler — but a sticky
      // tooltip only follows a moving pointer, and touch has none after the
      // tap ends, so without this it stays visually "stuck" over/behind the
      // Region Inspector modal that's about to open.
      map.eachLayer((layer) => layer.closeTooltip());
      onClick(e.latlng);
    },
  });
  return null;
}

/**
 * Map view (PRD §5.1): bundled offline coastline + per-row region polygons
 * colored by TYPE (status conveyed via opacity/dash/weight) + vessel marker.
 * Local vector source only — never a tile/style/CDN URL (PRD §6.3). Tapping
 * a polygon ALWAYS goes through the Region Inspector (never straight to the
 * Detail modal) — a single, consistent interaction model that also avoids
 * both the map's click handler and a polygon's own click handler firing for
 * the same tap and opening two modals at once.
 */
export function SourceMap() {
  const { theme } = useTheme();
  const colors = THEME_COLORS[theme];
  const catalog = useAppStore((s) => s.catalog);
  const datasets = useAppStore((s) => s.datasets);
  const filters = useAppStore((s) => s.filters);
  const vesselPosition = useAppStore((s) => s.vesselPosition);
  const [coastline, setCoastline] = useState<FeatureCollection | null>(null);
  const [inspecting, setInspecting] = useState<SourceRow[] | null>(null);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}coastline-110m.geojson`)
      .then((r) => r.json())
      .then(setCoastline)
      .catch(() => setCoastline({ type: 'FeatureCollection', features: [] }));
  }, []);

  const rows = useMemo(() => {
    const sources = (catalog?.document?.sources ?? []).filter((s) => matchesFilters(s, filters));
    return rowsForSources(sources);
  }, [catalog, filters]);

  const handleMapClick = (latlng: LatLng) => {
    const covering = rows.filter((r) => pointInGeometry(r.geometry, latlng.lat, latlng.lng));
    if (covering.length > 0) setInspecting(covering);
  };

  return (
    // `isolate` gives Leaflet its own stacking context (its panes use
    // z-index up to ~700, which would otherwise paint over the app's sticky
    // header/footer). The MapContainer is a flex-1 CHILD, not h-full —
    // height:100% resolves to 0 when the parent's height comes from
    // flex/min-height rather than an explicit value, which left the map
    // invisible after the fixed h-[60vh] wrapper was replaced by the
    // flex-column shell.
    <div className="isolate flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-xl border border-border">
      <MapContainer
        center={[20, 0]}
        zoom={2}
        minZoom={1}
        worldCopyJump
        className="w-full min-h-0 flex-1"
        style={{ background: 'var(--color-bg)' }}
      >
        {coastline && (
          <GeoJSON
            data={coastline as never}
            style={{ color: colors.muted, weight: 1, fillColor: colors.muted, fillOpacity: 0.15 }}
          />
        )}
        {rows.map((row) => {
          const status = displayStatus(datasetForRow(datasets, row));
          return (
            // react-leaflet's GeoJSON/CircleMarker only re-apply style/
            // pathOptions when that PROP's object reference changes — a
            // fresh `style={{...}}` literal every render (as below) is what
            // makes map colors react live to theme switches. Memoizing this
            // object would silently break that.
            <GeoJSON
              key={row.key}
              data={row.geometry as never}
              style={styleForRow(row, status, colors)}
              onEachFeature={(_feature, layer: Layer) => {
                layer.bindTooltip(buildTooltip(row, status), { sticky: true, direction: 'top' });
              }}
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
        <FitAllControl rows={rows} vessel={vesselPosition} />
        <ClickCapture onClick={handleMapClick} />
      </MapContainer>
      {inspecting && <RegionInspector rows={inspecting} onClose={() => setInspecting(null)} />}
    </div>
  );
}
