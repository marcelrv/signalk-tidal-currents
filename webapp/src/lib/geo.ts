import { BoundingBox, GeoJsonGeometry } from '../api/types';

export function bboxContains(bbox: BoundingBox, lat: number, lon: number): boolean {
  return lat >= bbox.min_lat && lat <= bbox.max_lat && lon >= bbox.min_lon && lon <= bbox.max_lon;
}

/** Ray-casting point-in-polygon over one ring ([lon,lat] pairs, GeoJSON order). */
function pointInRing(ring: number[][], lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
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
