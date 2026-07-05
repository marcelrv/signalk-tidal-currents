import { BoundingBox, GeoJsonGeometry } from '../api/types';

/**
 * Several real catalog regions cross the antimeridian (e.g. Bering Sea:
 * min_lon 155, max_lon -165 — the catalog's own convention for "wraps
 * through ±180", also used by `pointInRing` below). A plain `>=`/`<=` range
 * check is inverted in that case (min_lon > max_lon), so the wrapped range
 * — [min_lon, 180] ∪ [-180, max_lon] — needs its own branch.
 */
export function bboxContains(bbox: BoundingBox, lat: number, lon: number): boolean {
  if (lat < bbox.min_lat || lat > bbox.max_lat) return false;
  if (bbox.min_lon <= bbox.max_lon) return lon >= bbox.min_lon && lon <= bbox.max_lon;
  return lon >= bbox.min_lon || lon <= bbox.max_lon;
}

/**
 * Antimeridian-crossing rings (e.g. Bering Sea: `[[155,55],[-165,55],...]`)
 * jump from ~180 to ~-180 between adjacent vertices — left as raw degrees,
 * standard ray-casting reads that as "all the way around the wrong side of
 * the globe" and gets containment backwards. Unwrapping the ring into a
 * continuous (non-modular) longitude space relative to its first vertex —
 * and the query point into the SAME space — fixes both crossing and
 * non-crossing rings with one code path (non-crossing rings are untouched,
 * since no adjacent-vertex delta there exceeds 180°).
 */
function unwrapRingLongitudes(ring: number[][]): number[][] {
  const unwrapped: number[][] = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const prevLon = unwrapped[i - 1][0];
    let lon = ring[i][0];
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    unwrapped.push([lon, ring[i][1]]);
  }
  return unwrapped;
}

/** Ray-casting point-in-polygon over one ring ([lon,lat] pairs, GeoJSON order). */
function pointInRing(ring: number[][], lat: number, lon: number): boolean {
  if (ring.length === 0) return false;
  const unwrapped = unwrapRingLongitudes(ring);
  const ref = unwrapped[0][0];
  let queryLon = lon;
  while (queryLon - ref > 180) queryLon -= 360;
  while (queryLon - ref < -180) queryLon += 360;

  let inside = false;
  for (let i = 0, j = unwrapped.length - 1; i < unwrapped.length; j = i++) {
    const [xi, yi] = unwrapped[i];
    const [xj, yj] = unwrapped[j];
    const intersect = yi > lat !== yj > lat && queryLon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Approximate area of a bounding box in "equator-equivalent" square degrees
 * (lon span scaled by cos of the mid latitude). Only used to RANK datasets
 * by coverage size for Auto-Sort Priority (PRD §5.3 Phase 3) — small/high-res
 * first — so an approximation is exactly enough; wrap-aware for
 * antimeridian-crossing boxes (min_lon > max_lon).
 */
export function bboxAreaSqDeg(bbox: BoundingBox): number {
  const latSpan = Math.max(0, bbox.max_lat - bbox.min_lat);
  const lonSpan = bbox.min_lon <= bbox.max_lon ? bbox.max_lon - bbox.min_lon : 360 - bbox.min_lon + bbox.max_lon;
  const midLat = ((bbox.min_lat + bbox.max_lat) / 2) * (Math.PI / 180);
  return latSpan * lonSpan * Math.max(0.05, Math.cos(midLat));
}

/** Bounding box of a GeoJSON Polygon/MultiPolygon's coordinates (raw min/max scan — good enough for area ranking; see bboxAreaSqDeg). */
export function geometryBbox(geometry: GeoJsonGeometry): BoundingBox | null {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  const scanRing = (ring: number[][]) => {
    for (const [lon, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  };
  if (geometry.type === 'Polygon') for (const ring of geometry.coordinates as number[][][]) scanRing(ring);
  else if (geometry.type === 'MultiPolygon')
    for (const rings of geometry.coordinates as number[][][][]) for (const ring of rings) scanRing(ring);
  if (!Number.isFinite(minLat)) return null;
  return { min_lat: minLat, max_lat: maxLat, min_lon: minLon, max_lon: maxLon };
}

/** Point-in-polygon over the outer ring of a GeoJSON Polygon or MultiPolygon (holes not considered — outer-ring containment is enough for a coverage/region-inspector check). */
export function pointInGeometry(geometry: GeoJsonGeometry, lat: number, lon: number): boolean {
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates as number[][][];
    return rings.length > 0 && pointInRing(rings[0], lat, lon);
  }
  if (geometry.type === 'MultiPolygon') {
    const polygons = geometry.coordinates as number[][][][];
    return polygons.some((rings) => rings.length > 0 && pointInRing(rings[0], lat, lon));
  }
  return false;
}
