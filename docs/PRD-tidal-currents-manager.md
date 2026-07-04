# Product Requirements Document: SignalK Tidal Currents Manager

**Status:** Draft v2 · 2026-07-04
**Depends on:** [Tide/Current Catalog spec](https://github.com/marcelrv/signalk-router-data) (`specs/tide-current-catalog.md`, schema 1.0.0) · [UTCEF spec](https://github.com/marcelrv/signalk-router-data) (`specs/utcef-specification.md`)

## 1. Executive Summary

The **SignalK Tidal Currents Manager** is a responsive web application shipped *inside* the signalk-tidal-currents plugin package (SignalK webapp convention). It is the zero-configuration interface for **discovering, downloading, prioritizing, and updating** marine tidal-current data (`UTCEF`, `GRIB2`, `Harmonic`) from the tide-current catalog.

Marine environments lack reliable internet. The app is **offline-first**: no external tile servers, no CDN assets, cached catalog. Everything needed to render — including a bundled vector coastline map — ships in the package.

## 2. Goals & Non-Goals

**Goals**
1. A first-time user gets working current predictions for their location in **under one minute** ("Download around me").
2. Users always know **which data is installed, which is stale, and which source is actually feeding predictions** right now.
3. Storage-constrained devices (Raspberry Pi, Cerbo GX) stay healthy: visible disk usage, pre-download checks, easy cleanup.
4. Fully usable offline after first sync, on a gloved thumb at the helm, at night.

**Non-Goals**
- ❌ **Not a current viewer.** Rendering current arrows, animation, timelines on charts is viewers's job (it consumes the same plugin API). This app manages *data*, it does not visualize *predictions* (except the single live "source chip", §5.6).
- ❌ Not a catalog editor/producer — the catalog is generated in `signalk-router-data`.
- ❌ Not a general SignalK file manager; it only touches the plugin's three data directories.
- ❌ No user accounts, no cloud sync, no telemetry.

## 3. Personas

| Persona | Context | Needs |
|---|---|---|
| **Skipper** (primary) | Tablet at the helm, gloves, sunlight or red-lit night | Big targets, glanceable status, one-tap actions |
| **Installer/tinkerer** | Configures a Pi/Cerbo at the dock, decent connectivity | Full catalog browse, priorities, storage control |

## 4. Design Language & UX Rules

- **Three themes as design tokens (CSS variables) from day one:** Day (high-contrast light), Dark, and **Red night mode** (preserves night vision). No hardcoded colors in components.
- **Touch-first, hover never required.** Every hover affordance has a tap equivalent. Minimum touch target 44×44 px. Swipeable side panels.
- **Status vocabulary** (used consistently on map polygons, list rows, and cards):
  - 🟢 Solid — Downloaded & active
  - 🟡 Pulsing — Update available / expiring
  - 🔵 Dashed — Available in catalog, not downloaded
  - ⚪ Dimmed — Inactive/disabled
  - 🔴 — Error (failed download, integrity mismatch)
- **Motion:** fluid but restrained; honor `prefers-reduced-motion`; no animation blocking interaction on low-power devices.
- **Empty & error states are designed, not accidental:** no catalog yet ("Sync when online"), offline ("Last catalog sync: 3 days ago"), disk full, download failed mid-transfer (resume/retry).
- **Bundle budget: ≤ 2 MB gzipped total** including coastline data (Natural Earth 110m ≈ 0.7 MB).

## 5. Core Features

### 5.1 Source Browser — synchronized **List + Map** views

*Two co-equal views of the same catalog; neither is secondary.*

- **View toggle** `[ 🗺 Map | ☰ List ]` — shared state: the same filters, selection, and inspector panel serve both. Selecting a row highlights the polygon; tapping a polygon scrolls/expands the row.
- **List view (text-first browsing):**
  - Rows grouped by provider (`source` field), showing: name, type badge (`UTCEF`/`GRIB2`/`Harmonic`), region name, size, status icon, and an inline action button (Download / Update / ✓).
  - **Search-as-you-type** across name/description/region/tags; sort by name, size, distance-from-vessel, or status.
  - Fully keyboard- and screen-reader-accessible; works even if map rendering is disabled on very low-power devices.
- **Map view (offline slippy map):**
  - Bundled Natural Earth 110m GeoJSON coastlines via MapLibre GL (or Leaflet) with a **local vector source only** — never `mapbox://` styles or OSM tile URLs.
  - Renders each source's `region.boundary_geometry`; overlapping polygons → tapping opens the **Region Inspector** panel listing all covering datasets.
  - Vessel position marker (if available from the plugin backend).
- **Quick filters** (shared by both views): pill toggles `[ All ] [ UTCEF ] [ GRIB2 ] [ Harmonic ]` + free filtering on catalog `tags`. Filtering keys strictly off the catalog `type` field.
- **1-click download with progress:** row/card button → downloading state (progress %, animated border on polygon) → 🟢. Backend performs the transfer (§7); UI polls progress.

### 5.2 First-Run Wizard — "Download data around me" ⭐

*The MVP headline. Kills all configuration friction.*

- On first launch (no installed data): read vessel position from the backend, intersect with catalog `bounding_box`es, present the covering sources ranked by resolution/size with a single **"Install selected (~xx MB)"** action.
- No position available → fall back to tapping the map once or picking from the list.
- Re-runnable anytime from settings ("Plan a trip: download for another area" — enter/tap a position).

### 5.3 Priority & Auto-Resolution

*Manage overlapping data (global coarse model vs. high-res coastal model).*

- **Phase 1 (matches current backend):** an ordered list of the three **source types** (default: GRIB2 → UTCEF → Harmonic), drag-to-reorder; extends the existing `preferGrib` mechanism.
- **Phase 3 (needs backend refactor, see §7):** per-dataset priority stack — cards, top wins; tap (not hover) a card to highlight its polygon; **"Auto-Sort Priority"** orders by bounding-box area ascending (small/high-res on top). Manual drag overrides.
- The UI must label Phase-1 mode honestly ("Priority applies per data type") rather than implying per-file control that doesn't exist yet.

### 5.4 Storage & Health Dashboard

- **Disk gauge** (persistent, compact): "3.2 GB used / 16 GB total" for the volume holding the data directories.
- **Pre-download check:** if `size_bytes` would push the disk past 90%, warn in a modal before starting.
- **Smart Cleanup:** one button calls the backend's `GET /cleanup-candidates?maxDistanceNm=X` (distance math is **server-side** — the backend already has vessel position and geodesy). UI lists candidates with sizes; user confirms deletion.
- **Integrity:** surface per-file `sha256` verification failures as 🔴 with a re-download action.

### 5.5 Update & Sync Center

- **Detection per the catalog spec §5:** `sha256` compare for static sources; `latest_cycle`/`max_age_hours` expiry for forecast sources. Requires the **local install manifest** (§8) — the record of what was installed, from which source id, with which hash/cycle.
- **GRIB expiry countdown** on cards/rows: "expires in 14 h" → 🟡 at <25% remaining → 🔴 when past.
- **"Update All" banner:** "3 regions have new data · [Update All (45 MB)]".
- **Offline resilience:** catalog cached server-side; UI shows "Last catalog sync: X ago" and never blocks on connectivity.
- Optional per-source **auto-update toggle** ("keep fresh when online"), mirroring the plugin's existing weekly re-check pattern.

### 5.6 Live Source Chip ⭐

A persistent header element that calls the existing `GET /vector` at the vessel position and shows: **"1.2 kn @ 108° — UTCEF · netherlands"**. One glance answers *is it working, and which data is it using?* Doubles as a health check. Tapping opens the dataset's card. (This is the only prediction display in the app — see Non-Goals.)

### 5.7 Attribution & License Surface

Dataset detail shows `contributor`, `url`, and license/citation from the data metadata (e.g. FES2014 requires citation and is non-commercial — the UTCEF files already carry `copyright` / `license` / `citation_required`). Legally required and it makes cards look finished.

## 6. Technical Directives

1. **Stack:** React 18 + TypeScript + Vite, TailwindCSS, Zustand. Components: Map, List, Filters, Inspector, StorageGauge, PriorityList, UpdateCenter — decoupled, synchronized through the store.
2. **Packaging:** built into `public/` of this npm package with the `signalk-webapp` keyword → appears in the SignalK Admin UI Webapps list automatically. No separate install.
3. **Offline map:** MapLibre GL with a bundled GeoJSON source (or Leaflet if materially smaller). **DO NOT** reference any external tile/style/CDN URL anywhere in the bundle.
4. **All external I/O goes through the plugin backend** (catalog fetch, downloads, position). The browser never fetches upstream URLs — avoids CORS, centralizes caching, works when only the server has connectivity.
5. **Data contract:** catalog per `tide-current-catalog.md` schema 1.0.0 (`type ∈ harmonic | grib2 | utcef`). Reject/ignore unknown major versions gracefully.

## 7. Backend API Contract (plugin side)

Base: `/plugins/signalk-tidal-currents` (existing prediction endpoints stay unchanged).

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /catalog` | Cached catalog | Server fetches + caches `tide-current-index.json`; returns cache with `fetchedAt` when offline |
| `POST /catalog/refresh` | Force re-fetch | 502 + cached copy on failure |
| `GET /datasets` | Installed inventory | Per-file: id, type, dir, size, mtime, parsed metadata (UTCEF title/bbox, GRIB time range), manifest link |
| `DELETE /datasets/:id` | Remove a file | Refuses ids outside the managed dirs |
| `GET /storage` | Disk usage | `fs.statfs` on the data volume: total/free/used-by-plugin |
| `POST /downloads` | Start download | Body: catalog source id (+ file/region selection); resolves URL or `url_template`, streams to the right dir, verifies `sha256`, writes manifest |
| `GET /downloads` / `GET /downloads/:id` | Progress | `{state: queued|active|done|error, bytes, totalBytes}`; polling now, SSE later |
| `GET /cleanup-candidates?maxDistanceNm=` | Smart cleanup | Server-side distance from vessel position to dataset bboxes |
| `GET /priority` / `PUT /priority` | Source-type order | Phase 1: ordered `["grib2","utcef","harmonic"]`; persisted in plugin config |

**Backend work implied (be honest about cost):** generalize `src/download.ts` (currently hardcoded to one OpenCPN URL) into a catalog-driven download engine with progress + integrity + manifest; add the endpoints above; per-dataset priority (Phase 3) additionally requires per-file provenance in the source-merging logic of `utcef.ts`/`gribcurrents.ts` — the single largest backend item, deferred by design.

## 8. Local Install Manifest

`<dataDirRoot>/install-manifest.json` — the source of truth for update detection:

```json
{
  "manifest_version": 1,
  "installs": [
    {
      "id": "noaa-rtofs-west-conus",
      "catalogSourceId": "noaa-rtofs",
      "type": "grib2",
      "files": ["rtofs_west.grb2"],
      "dir": "grib",
      "sha256": "…",
      "size_bytes": 48211234,
      "downloaded_at": "2026-07-04T10:00:00Z",
      "cycle": "2026-07-04T00:00:00Z"
    }
  ]
}
```

## 9. Phasing & Acceptance

**Phase 1 — MVP:** List+Map browser, quick filters, wizard, downloads with progress, storage gauge, manifest + update badges, source-type priority, live source chip.
✔ *Accept when:* fresh install → wizard → predictions at vessel position in <60 s; airplane-mode reload → app fully renders with cached catalog and correct statuses.

**Phase 2 — Comfort:** Update-All, expiry countdowns, smart cleanup, attribution panels, red-mode polish, SSE progress.

**Phase 3 — Advanced:** per-dataset priority stack + auto-sort (backend refactor), template-based GRIB cycle downloads with per-cycle update automation.

## 10. Open Questions

1. Catalog hosting URL (raw GitHub in `signalk-router-data`?) and refresh cadence default.
2. Should the wizard preselect UTCEF over GRIB2 for first install (static, no expiry) — or best-resolution-first?
3. Cerbo GX browser floor — confirm MapLibre GL runs; if not, auto-fall back to list-only mode (already supported by design).
