// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal pure-TypeScript GRIB2 decoder — no native/runtime dependencies.
 *
 * Written from the WMO FM 92 GRIB edition 2 specification and NCEP's public
 * template documentation (format reference only; no code derived from GPL
 * decoders such as wgrib2/g2c/OpenCPN).
 *
 * Deliberately scoped to what gridded current/forecast files in the wild
 * actually use:
 *  - Grid definition template 3.0  (regular latitude/longitude grid)
 *  - Product definition templates sharing the 4.0 leading layout
 *    (4.0-4.2, 4.8 ... — category/number/forecast-time/level octets)
 *  - Data representation templates 5.0 (simple packing) and 5.2/5.3
 *    (complex packing, optionally with spatial differencing)
 *  - Bitmap section (indicator 0 / 254 / 255)
 *
 * Anything else is skipped with a reason in `skipped` rather than throwing,
 * so one exotic message doesn't break a whole file.
 *
 * Decoded fields are normalized to a row-major values array with
 * i = 0..ni-1 running WEST→EAST and j = 0..nj-1 running SOUTH→NORTH
 * (index j*ni + i), regardless of the scanning mode in the file.
 */

export interface Grib2Grid {
  ni: number;
  nj: number;
  /** Southernmost row latitude, degrees. */
  lat0: number;
  /** Westernmost column longitude, degrees (as stored, typically 0..360). */
  lon0: number;
  /** Positive increments, degrees. */
  di: number;
  dj: number;
  /** True when the grid wraps the full 360° in longitude. */
  globalLon: boolean;
}

export interface Grib2Field {
  discipline: number;
  centre: number;
  refTime: number; // ms epoch
  productTemplate: number;
  paramCategory: number;
  paramNumber: number;
  validTime: number; // ms epoch
  surfaceType: number | null;
  surfaceValue: number | null; // e.g. depth in m for type 160
  grid: Grib2Grid;
  /** Row-major (j*ni + i), south→north / west→east. NaN = missing. */
  values: Float64Array;
}

export interface Grib2ParseResult {
  fields: Grib2Field[];
  /** Human-readable reasons for any skipped messages/fields. */
  skipped: string[];
}

// ── binary helpers ─────────────────────────────────────────────────────

function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function u32(b: Uint8Array, o: number): number {
  return b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function u64(b: Uint8Array, o: number): number {
  return u32(b, o) * 0x100000000 + u32(b, o + 4);
}
/** GRIB2 signed integers are sign-magnitude: MSB set ⇒ negative. */
function s16sm(b: Uint8Array, o: number): number {
  const v = u16(b, o);
  return v & 0x8000 ? -(v & 0x7fff) : v;
}
function s32sm(b: Uint8Array, o: number): number {
  const v = u32(b, o);
  return v >= 0x80000000 ? -(v - 0x80000000) : v;
}
function s8sm(v: number): number {
  return v & 0x80 ? -(v & 0x7f) : v;
}
function f32(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, false);
}

/** Big-endian bit reader for the packed data section. */
class BitReader {
  private bitPos = 0;
  constructor(private buf: Uint8Array) {}
  /** Read n (≤ 32) bits as an unsigned integer. */
  read(n: number): number {
    let result = 0;
    let remaining = n;
    while (remaining > 0) {
      const byte = this.buf[this.bitPos >> 3];
      if (byte === undefined) throw new Error('GRIB2: bit reader ran past end of data section');
      const avail = 8 - (this.bitPos & 7);
      const take = Math.min(avail, remaining);
      const shift = avail - take;
      result = result * (1 << take) + ((byte >> shift) & ((1 << take) - 1));
      this.bitPos += take;
      remaining -= take;
    }
    return result;
  }
  /** Advance to the next byte boundary (blocks in template 7.2/7.3 are byte-aligned). */
  align(): void {
    this.bitPos = (this.bitPos + 7) & ~7;
  }
}

// ── section state carried across a message ─────────────────────────────

interface DataRepr {
  template: number; // 0, 2 or 3
  numDataPoints: number;
  refValue: number; // R
  binScale: number; // E
  decScale: number; // D
  nbits: number;
  // complex packing (5.2/5.3):
  missingMgmt: number;
  numGroups: number;
  refGroupWidths: number;
  bitsGroupWidths: number;
  refGroupLengths: number;
  lengthIncrement: number;
  lastGroupLength: number;
  bitsScaledLengths: number;
  // spatial differencing (5.3):
  sdOrder: number;
  sdExtraOctets: number;
}

interface ProductInfo {
  template: number;
  paramCategory: number;
  paramNumber: number;
  validTime: number;
  surfaceType: number | null;
  surfaceValue: number | null;
}

const TIME_UNIT_MS: Record<number, number> = {
  0: 60_000, // minute
  1: 3_600_000, // hour
  2: 86_400_000, // day
  10: 3 * 3_600_000,
  11: 6 * 3_600_000,
  12: 12 * 3_600_000,
  13: 1_000, // second
};

// ── section parsers ────────────────────────────────────────────────────

/** Section 3, grid definition template 3.0 (regular lat/lon). */
function parseGrid(sec: Uint8Array): { grid: Grib2Grid; scan: number } {
  const source = sec[5];
  if (source !== 0) throw new Error(`grid definition source ${source} not supported`);
  if (sec[10] !== 0) throw new Error('quasi-regular grids (optional point list) not supported');
  const template = u16(sec, 12);
  if (template !== 0) throw new Error(`grid template 3.${template} not supported (only 3.0 regular lat/lon)`);

  const ni = u32(sec, 30);
  const nj = u32(sec, 34);
  const basicAngle = u32(sec, 38);
  const subdivisions = u32(sec, 42);
  const unit =
    basicAngle === 0 || basicAngle === 0xffffffff || subdivisions === 0 || subdivisions === 0xffffffff
      ? 1e-6
      : basicAngle / subdivisions;
  const la1 = s32sm(sec, 46) * unit;
  const lo1 = s32sm(sec, 50) * unit;
  const resFlags = sec[54];
  const la2 = s32sm(sec, 55) * unit;
  const lo2 = s32sm(sec, 59) * unit;
  const scan = sec[71];
  if (scan & 0x30) throw new Error(`scanning mode 0x${scan.toString(16)} (j-consecutive/boustrophedon) not supported`);
  const iPlus = (scan & 0x80) === 0; // bit 1 clear: points scan +i (west→east)
  const jPlus = (scan & 0x40) !== 0; // bit 2 set: points scan +j (south→north)

  // Increments; fall back to deriving from the corner coordinates when the
  // "increments given" flag is off or the value is coded as missing.
  const rawDi = u32(sec, 63);
  const rawDj = u32(sec, 67);
  let di = resFlags & 0x20 && rawDi !== 0xffffffff ? rawDi * unit : NaN;
  let dj = resFlags & 0x10 && rawDj !== 0xffffffff ? rawDj * unit : NaN;
  if (!Number.isFinite(di)) {
    let span = iPlus ? lo2 - lo1 : lo1 - lo2;
    span = ((span % 360) + 360) % 360;
    if (span === 0 && ni > 1) span = 360;
    di = ni > 1 ? span / (ni - 1) : 0;
  }
  if (!Number.isFinite(dj)) {
    dj = nj > 1 ? Math.abs(la2 - la1) / (nj - 1) : 0;
  }
  if (!(ni >= 1) || !(nj >= 1) || !(di > 0) || (nj > 1 && !(dj > 0))) {
    throw new Error('grid geometry could not be determined');
  }

  const lat0 = jPlus ? la1 : la2; // southernmost row
  const lon0 = iPlus ? lo1 : lo2; // westernmost column
  const globalLon = ni * di >= 360 - di / 2;
  return { grid: { ni, nj, lat0, lon0, di, dj, globalLon }, scan };
}

/** Section 4 — templates that share the 4.0 leading octet layout. */
function parseProduct(sec: Uint8Array, refTime: number): ProductInfo {
  const template = u16(sec, 7);
  const paramCategory = sec[9];
  const paramNumber = sec[10];
  const timeUnit = sec[17];
  const rawFt = u32(sec, 18);
  const forecastTime = rawFt >= 0x80000000 ? -(rawFt - 0x80000000) : rawFt;
  const unitMs = TIME_UNIT_MS[timeUnit];
  if (unitMs === undefined) throw new Error(`forecast time unit ${timeUnit} not supported`);

  let validTime = refTime + forecastTime * unitMs;
  // Statistical templates (4.8 layout): valid time is the END of the overall
  // time interval, coded as an explicit timestamp at octets 35-41.
  if (template === 8) {
    validTime = Date.UTC(u16(sec, 34), sec[36] - 1, sec[37], sec[38], sec[39], sec[40]);
  } else if (template > 8 && template !== 15) {
    // Other interval templates shift these octets around per-template; the
    // simple forecast-time interpretation would silently mislabel them.
    throw new Error(`product template 4.${template} not supported`);
  }

  const surfaceTypeRaw = sec[22];
  let surfaceType: number | null = null;
  let surfaceValue: number | null = null;
  if (surfaceTypeRaw !== 255) {
    surfaceType = surfaceTypeRaw;
    const scale = sec[23];
    const raw = u32(sec, 24);
    if (scale !== 255 && raw !== 0xffffffff) {
      surfaceValue = (raw >= 0x80000000 ? -(raw - 0x80000000) : raw) * Math.pow(10, -s8sm(scale));
    }
  }
  return { template, paramCategory, paramNumber, validTime, surfaceType, surfaceValue };
}

/** Section 5 — data representation templates 5.0, 5.2, 5.3. */
function parseDataRepr(sec: Uint8Array): DataRepr {
  const template = u16(sec, 9);
  if (template !== 0 && template !== 2 && template !== 3) {
    throw new Error(
      `data representation template 5.${template} not supported ` +
        '(only 5.0 simple and 5.2/5.3 complex packing; 5.40/5.41 JPEG/PNG need a codec)',
    );
  }
  const repr: DataRepr = {
    template,
    numDataPoints: u32(sec, 5),
    refValue: f32(sec, 11),
    binScale: s16sm(sec, 15),
    decScale: s16sm(sec, 17),
    nbits: sec[19],
    missingMgmt: 0,
    numGroups: 0,
    refGroupWidths: 0,
    bitsGroupWidths: 0,
    refGroupLengths: 0,
    lengthIncrement: 0,
    lastGroupLength: 0,
    bitsScaledLengths: 0,
    sdOrder: 0,
    sdExtraOctets: 0,
  };
  if (template === 2 || template === 3) {
    repr.missingMgmt = sec[22];
    if (repr.missingMgmt > 1) {
      throw new Error(`missing value management ${repr.missingMgmt} (secondary missing) not supported`);
    }
    repr.numGroups = u32(sec, 31);
    repr.refGroupWidths = sec[35];
    repr.bitsGroupWidths = sec[36];
    repr.refGroupLengths = u32(sec, 37);
    repr.lengthIncrement = sec[41];
    repr.lastGroupLength = u32(sec, 42);
    repr.bitsScaledLengths = sec[46];
    if (template === 3) {
      repr.sdOrder = sec[47];
      repr.sdExtraOctets = sec[48];
      // Order 0 (seen from eccodes re-encoding) means no differencing was
      // applied — decode as plain complex packing.
      if (repr.sdOrder !== 0 && repr.sdOrder !== 1 && repr.sdOrder !== 2) {
        throw new Error(`spatial differencing order ${repr.sdOrder} not supported`);
      }
    }
  }
  return repr;
}

// ── data section decoding ──────────────────────────────────────────────

/** Template 7.0: X values, one per encoded point. null = missing (never here). */
function unpackSimple(data: Uint8Array, repr: DataRepr): Array<number | null> {
  const out: Array<number | null> = new Array(repr.numDataPoints);
  if (repr.nbits === 0) {
    out.fill(0);
    return out;
  }
  const br = new BitReader(data);
  for (let k = 0; k < repr.numDataPoints; k++) out[k] = br.read(repr.nbits);
  return out;
}

/** Templates 7.2/7.3: complex packing, optionally with spatial differencing. */
function unpackComplex(data: Uint8Array, repr: DataRepr): Array<number | null> {
  const br = new BitReader(data);

  // Spatial differencing descriptors (template 7.3 only): the first
  // original value(s), then the overall minimum of the differences, each in
  // sdExtraOctets bytes, sign-magnitude.
  const firstVals: number[] = [];
  let minsd = 0;
  const spatialDiff = repr.template === 3 && repr.sdOrder > 0 && repr.sdExtraOctets > 0;
  if (spatialDiff) {
    const bits = repr.sdExtraOctets * 8;
    const readSm = (): number => {
      const sign = br.read(1);
      const mag = br.read(bits - 1);
      return sign ? -mag : mag;
    };
    for (let i = 0; i < repr.sdOrder; i++) firstVals.push(readSm());
    minsd = readSm();
  }

  const ng = repr.numGroups;
  const refs = new Array<number>(ng);
  for (let g = 0; g < ng; g++) refs[g] = repr.nbits > 0 ? br.read(repr.nbits) : 0;
  br.align();
  const widths = new Array<number>(ng);
  for (let g = 0; g < ng; g++) {
    widths[g] = repr.refGroupWidths + (repr.bitsGroupWidths > 0 ? br.read(repr.bitsGroupWidths) : 0);
  }
  br.align();
  const lengths = new Array<number>(ng);
  for (let g = 0; g < ng; g++) {
    const scaled = repr.bitsScaledLengths > 0 ? br.read(repr.bitsScaledLengths) : 0;
    lengths[g] = repr.refGroupLengths + repr.lengthIncrement * scaled;
  }
  if (ng > 0) lengths[ng - 1] = repr.lastGroupLength;
  br.align();

  const out: Array<number | null> = new Array(repr.numDataPoints);
  let k = 0;
  for (let g = 0; g < ng; g++) {
    const width = widths[g];
    // With primary missing value management, an all-ones pattern marks a
    // missing point (group-wide via the reference when width is 0).
    const missingPattern = width > 0 ? (1 << width) - 1 : -1;
    const groupAllMissing =
      repr.missingMgmt === 1 && width === 0 && repr.nbits > 0 && refs[g] === (1 << repr.nbits) - 1;
    for (let n = 0; n < lengths[g] && k < repr.numDataPoints; n++, k++) {
      if (width === 0) {
        out[k] = groupAllMissing ? null : refs[g];
      } else {
        const raw = br.read(width);
        out[k] = repr.missingMgmt === 1 && raw === missingPattern ? null : refs[g] + raw;
      }
    }
  }
  for (; k < repr.numDataPoints; k++) out[k] = null;

  // Undo spatial differencing over the non-missing subsequence.
  if (spatialDiff) {
    const idx: number[] = [];
    for (let i = 0; i < out.length; i++) if (out[i] !== null) idx.push(i);
    if (repr.sdOrder === 1) {
      if (idx.length > 0) out[idx[0]] = firstVals[0];
      for (let n = 1; n < idx.length; n++) {
        out[idx[n]] = (out[idx[n]] as number) + minsd + (out[idx[n - 1]] as number);
      }
    } else {
      if (idx.length > 0) out[idx[0]] = firstVals[0];
      if (idx.length > 1) out[idx[1]] = firstVals[1];
      for (let n = 2; n < idx.length; n++) {
        out[idx[n]] =
          (out[idx[n]] as number) +
          minsd +
          2 * (out[idx[n - 1]] as number) -
          (out[idx[n - 2]] as number);
      }
    }
  }
  return out;
}

/**
 * Decode section 7 into grid-ordered physical values (in scan order),
 * expanding through the bitmap. NaN = missing.
 */
function decodeValues(
  dataSec: Uint8Array,
  repr: DataRepr,
  bitmap: Uint8Array | null,
  gridPoints: number,
): Float64Array {
  const packed = dataSec.subarray(5);
  const xs = repr.template === 0 ? unpackSimple(packed, repr) : unpackComplex(packed, repr);
  const scale = Math.pow(2, repr.binScale) / Math.pow(10, repr.decScale);
  const base = repr.refValue / Math.pow(10, repr.decScale);
  const toValue = (x: number | null): number => (x === null ? NaN : base + x * scale);

  const out = new Float64Array(gridPoints);
  if (!bitmap) {
    for (let i = 0; i < gridPoints; i++) out[i] = toValue(xs[i] ?? null);
    return out;
  }
  let k = 0;
  for (let i = 0; i < gridPoints; i++) {
    const set = (bitmap[i >> 3] >> (7 - (i & 7))) & 1;
    out[i] = set ? toValue(xs[k++] ?? null) : NaN;
  }
  return out;
}

/** Reorder scan-order values into south→north / west→east row-major. */
function normalizeScanOrder(values: Float64Array, grid: Grib2Grid, scan: number): Float64Array {
  const iPlus = (scan & 0x80) === 0;
  const jPlus = (scan & 0x40) !== 0;
  if (iPlus && jPlus) return values;
  const { ni, nj } = grid;
  const out = new Float64Array(values.length);
  for (let j = 0; j < nj; j++) {
    const srcJ = jPlus ? j : nj - 1 - j;
    for (let i = 0; i < ni; i++) {
      const srcI = iPlus ? i : ni - 1 - i;
      out[j * ni + i] = values[srcJ * ni + srcI];
    }
  }
  return out;
}

// ── message / file iteration ───────────────────────────────────────────

/**
 * Parse all GRIB2 messages in a buffer. Unsupported messages/fields are
 * reported in `skipped` instead of aborting the parse.
 */
export function parseGrib2(buf: Uint8Array): Grib2ParseResult {
  const fields: Grib2Field[] = [];
  const skipped: string[] = [];

  let off = 0;
  while (off + 16 <= buf.length) {
    // Messages may be separated by padding/headers — hunt for the magic.
    if (!(buf[off] === 0x47 && buf[off + 1] === 0x52 && buf[off + 2] === 0x49 && buf[off + 3] === 0x42)) {
      off++;
      continue;
    }
    const edition = buf[off + 7];
    const totalLength = u64(buf, off + 8);
    if (totalLength < 16 || off + totalLength > buf.length) {
      skipped.push(`message at byte ${off}: truncated (declared length ${totalLength})`);
      break;
    }
    if (edition !== 2) {
      skipped.push(`message at byte ${off}: GRIB edition ${edition} (only edition 2 supported)`);
      off += totalLength;
      continue;
    }
    const discipline = buf[off + 6];
    try {
      parseMessage(buf.subarray(off, off + totalLength), discipline, fields, skipped);
    } catch (e) {
      skipped.push(`message at byte ${off}: ${e instanceof Error ? e.message : String(e)}`);
    }
    off += totalLength;
  }
  return { fields, skipped };
}

function parseMessage(
  msg: Uint8Array,
  discipline: number,
  fields: Grib2Field[],
  skipped: string[],
): void {
  let off = 16;
  let centre = 0;
  let refTime = 0;
  let grid: { grid: Grib2Grid; scan: number } | null = null;
  let gridError: string | null = null;
  let product: ProductInfo | null = null;
  let productError: string | null = null;
  let repr: DataRepr | null = null;
  let reprError: string | null = null;
  let bitmap: Uint8Array | null = null;

  while (off + 4 <= msg.length) {
    if (msg[off] === 0x37 && msg[off + 1] === 0x37 && msg[off + 2] === 0x37 && msg[off + 3] === 0x37) {
      return; // '7777' end section
    }
    if (off + 5 > msg.length) break;
    const len = u32(msg, off);
    const num = msg[off + 4];
    if (len < 5 || off + len > msg.length) throw new Error(`corrupt section ${num} at byte ${off}`);
    const sec = msg.subarray(off, off + len);

    switch (num) {
      case 1:
        centre = u16(sec, 5);
        refTime = Date.UTC(u16(sec, 12), sec[14] - 1, sec[15], sec[16], sec[17], sec[18]);
        break;
      case 2:
        break; // local use — ignore
      case 3:
        try {
          grid = parseGrid(sec);
          gridError = null;
        } catch (e) {
          grid = null;
          gridError = e instanceof Error ? e.message : String(e);
        }
        break;
      case 4:
        try {
          product = parseProduct(sec, refTime);
          productError = null;
        } catch (e) {
          product = null;
          productError = e instanceof Error ? e.message : String(e);
        }
        break;
      case 5:
        try {
          repr = parseDataRepr(sec);
          reprError = null;
        } catch (e) {
          repr = null;
          reprError = e instanceof Error ? e.message : String(e);
        }
        break;
      case 6: {
        const indicator = sec[5];
        if (indicator === 0) bitmap = sec.subarray(6);
        else if (indicator === 255) bitmap = null;
        // 254: reuse previously defined bitmap — keep current value
        else if (indicator !== 254) {
          bitmap = null;
          skipped.push(`field: pre-defined bitmap indicator ${indicator} not supported`);
        }
        break;
      }
      case 7: {
        const problem = gridError ?? productError ?? reprError;
        if (problem || !grid || !product || !repr) {
          skipped.push(`field (discipline ${discipline}): ${problem ?? 'incomplete message sections'}`);
          break;
        }
        const gridPoints = grid.grid.ni * grid.grid.nj;
        const raw = decodeValues(sec, repr, bitmap, gridPoints);
        fields.push({
          discipline,
          centre,
          refTime,
          productTemplate: product.template,
          paramCategory: product.paramCategory,
          paramNumber: product.paramNumber,
          validTime: product.validTime,
          surfaceType: product.surfaceType,
          surfaceValue: product.surfaceValue,
          grid: grid.grid,
          values: normalizeScanOrder(raw, grid.grid, grid.scan),
        });
        break;
      }
      default:
        break;
    }
    off += len;
  }
  throw new Error("missing '7777' end section");
}

/**
 * Bilinear sample of a normalized field at a position. Corners that are
 * missing (NaN, e.g. land in ocean-current grids) are dropped and the
 * remaining weights renormalized — returns null only when all contributing
 * corners are missing or the position is outside the grid.
 */
export function sampleGrid(grid: Grib2Grid, values: Float64Array, lat: number, lon: number): number | null {
  const fy = grid.nj > 1 ? (lat - grid.lat0) / grid.dj : Math.abs(lat - grid.lat0) < 1e-9 ? 0 : NaN;
  if (!Number.isFinite(fy) || fy < -1e-9 || fy > grid.nj - 1 + 1e-9) return null;
  let fx = (((lon - grid.lon0) % 360) + 360) % 360;
  fx /= grid.di;
  if (fx > grid.ni - 1 + 1e-9 && !grid.globalLon) return null;

  const j0 = Math.min(grid.nj - 1, Math.max(0, Math.floor(fy)));
  const j1 = Math.min(grid.nj - 1, j0 + 1);
  const i0 = Math.min(grid.ni - 1, Math.max(0, Math.floor(fx)));
  const i1 = grid.globalLon ? (i0 + 1) % grid.ni : Math.min(grid.ni - 1, i0 + 1);
  const wx = Math.min(1, Math.max(0, fx - i0));
  const wy = Math.min(1, Math.max(0, fy - j0));

  const corners: Array<[number, number]> = [
    [values[j0 * grid.ni + i0], (1 - wx) * (1 - wy)],
    [values[j0 * grid.ni + i1], wx * (1 - wy)],
    [values[j1 * grid.ni + i0], (1 - wx) * wy],
    [values[j1 * grid.ni + i1], wx * wy],
  ];
  let sum = 0;
  let wsum = 0;
  for (const [v, w] of corners) {
    if (!Number.isNaN(v) && w > 0) {
      sum += v * w;
      wsum += w;
    }
  }
  if (wsum <= 0) return null;
  return sum / wsum;
}
