// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Parser for the legacy OpenCPN/XTide ASCII harmonic tide files:
 * a `HARMONIC` data file plus a `HARMONIC.IDX` station index.
 *
 * Format (reimplemented from the file layout; OpenCPN's
 * tcds_ascii_harmonic.cpp served as the format reference):
 *
 * HARMONIC:
 *   <numConstituents>
 *   <name> <speed deg/hr>            × numConstituents
 *   <firstYear>
 *   <numYears>
 *   <name>\n<equilibrium args, one per year, wrapped>   × numConstituents
 *   *END*
 *   <numYears>
 *   <name>\n<node factors, one per year, wrapped>       × numConstituents
 *   *END*
 *   then station records:
 *     <station name>
 *     <meridian ±HH:MM> [:tzname]
 *     <datum> <units>                 (units "knots" ⇒ current station)
 *     <name> <amplitude> <phase°>     × numConstituents (name may be "x")
 *
 * HARMONIC.IDX:
 *   XREF/REGION/COUNTRY/TZ header lines, then station lines:
 *     <type><zone> <lon> <lat> <TZH>:<TZM> <name>
 *   type: T=tide ref, t=tide sub, C=current ref, c=current sub (U/u legacy)
 *   Subordinate stations are followed by an offsets line:
 *     ^<floodOffMin> <floodMpy> <floodAdd> <ebbOffMin> <ebbMpy> <ebbAdd>
 *      <staId> <floodDir°> <ebbDir°> <refFileNum> <reference name>   (currents)
 *     &<hOffMin> <hMpy> <hAdd> <lOffMin> <lMpy> <lAdd> <staId> [tz]
 *      <refFileNum> <reference name>                                  (tides)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ConstituentTable {
  names: string[];
  speeds: number[];       // degrees per hour
  firstYear: number;
  numYears: number;
  equilibrium: number[][]; // [constituent][yearIndex] degrees
  nodeFactor: number[][];  // [constituent][yearIndex]
}

export interface HarmonicStation {
  name: string;
  meridianSeconds: number; // phase reference offset from UTC (e.g. +3600 for "01:00")
  tzname?: string;
  datum: number;
  units: string;           // "meters", "feet", "knots", …
  isCurrent: boolean;
  amplitude: number[];     // per constituent
  epoch: number[];         // per constituent, degrees
}

export interface SubordinateOffsets {
  floodOffsetMinutes: number;
  floodMultiplier: number;
  floodAdd: number;
  ebbOffsetMinutes: number;
  ebbMultiplier: number;
  ebbAdd: number;
  floodDir: number | null; // degrees true, null when unusable (>360)
  ebbDir: number | null;
  referenceName: string;
}

export interface IdxStation {
  id: string;              // stable slug derived from the name
  type: 'T' | 't' | 'C' | 'c';
  zone: string;
  name: string;
  latitude: number;
  longitude: number;
  timeZoneMinutes: number;
  isCurrent: boolean;
  isSubordinate: boolean;
  offsets?: SubordinateOffsets;
}

export interface HarmonicsData {
  constituents: ConstituentTable;
  /** Reference-station harmonic records by exact name. */
  records: Map<string, HarmonicStation>;
  stations: IdxStation[];
  sourceDir: string;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "±HH:MM" → seconds east of UTC. Accepts "+1:00", "01:00", "-3:30". */
export function meridianToSeconds(spec: string): number {
  const m = spec.match(/^([+-]?)(\d+):(\d+)/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 3600 + parseInt(m[3], 10) * 60);
}

// Lazily scans the source text for lines rather than splitting the whole
// file into an array upfront — large community harmonic files can be
// 10-20MB, and a full split() retains hundreds of thousands of string
// objects for the life of the parse.
class LineReader {
  private text: string;
  private pos = 0;
  constructor(text: string) {
    this.text = text;
  }
  private readLineAt(pos: number): { line: string; next: number } | null {
    if (pos >= this.text.length) return null;
    let nl = this.text.indexOf('\n', pos);
    if (nl === -1) nl = this.text.length;
    let line = this.text.slice(pos, nl);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    return { line, next: nl + 1 };
  }
  /** Next non-comment, non-blank line, or null at EOF. */
  next(): string | null {
    let cursor = this.pos;
    for (;;) {
      const r = this.readLineAt(cursor);
      if (r === null) {
        this.pos = cursor;
        return null;
      }
      cursor = r.next;
      const trimmed = r.line.trim();
      if (trimmed !== '' && !trimmed.startsWith('#')) {
        this.pos = cursor;
        return trimmed;
      }
    }
  }
  /** Peek variant of next(): the next non-comment line, without consuming it. */
  peek(): string | null {
    return this.peekAt(0);
  }
  /** Look ahead `n` non-comment lines (0 = same as peek()) without consuming. */
  peekAt(n: number): string | null {
    let cursor = this.pos;
    let count = 0;
    for (;;) {
      const r = this.readLineAt(cursor);
      if (r === null) return null;
      cursor = r.next;
      const trimmed = r.line.trim();
      if (trimmed !== '' && !trimmed.startsWith('#')) {
        if (count === n) return trimmed;
        count++;
      }
    }
  }
  eof(): boolean {
    return this.peek() === null;
  }
}

/** Read `count` whitespace-separated floats spanning as many lines as needed. */
function readFloats(r: LineReader, count: number, label: string): number[] {
  const out: number[] = [];
  while (out.length < count) {
    const line = r.next();
    if (line === null) throw new Error(`Unexpected EOF reading ${label}`);
    for (const tok of line.split(/\s+/)) {
      if (tok) out.push(parseFloat(tok));
    }
  }
  if (out.length !== count || out.some((v) => Number.isNaN(v))) {
    throw new Error(`Malformed ${label}: expected ${count} numbers, got ${out.length}`);
  }
  return out;
}

function parseYearTable(r: LineReader, names: string[], numYears: number, label: string): number[][] {
  const table: number[][] = [];
  for (let i = 0; i < names.length; i++) {
    const nameLine = r.next();
    if (nameLine === null) throw new Error(`Unexpected EOF in ${label} table`);
    // Identifier line is for readability only; values follow in file order.
    table.push(readFloats(r, numYears, `${label}[${nameLine}]`));
  }
  const end = r.next();
  if (end === null || !end.startsWith('*END*')) {
    throw new Error(`Missing *END* after ${label} table (got ${end})`);
  }
  return table;
}

export function parseHarmonicFile(text: string): {
  constituents: ConstituentTable;
  records: Map<string, HarmonicStation>;
} {
  const r = new LineReader(text);

  const numCsts = parseInt(r.next() ?? '', 10);
  if (!Number.isFinite(numCsts) || numCsts <= 0) {
    throw new Error('HARMONIC: bad constituent count');
  }
  const names: string[] = [];
  const speeds: number[] = [];
  for (let i = 0; i < numCsts; i++) {
    const line = r.next();
    const m = line?.match(/^(\S+)\s+([\d.]+)/);
    if (!m) throw new Error(`HARMONIC: bad constituent line: ${line}`);
    names.push(m[1]);
    speeds.push(parseFloat(m[2]));
  }

  const firstYear = parseInt(r.next() ?? '', 10);
  const numYears = parseInt(r.next() ?? '', 10);
  if (!Number.isFinite(firstYear) || !Number.isFinite(numYears)) {
    throw new Error('HARMONIC: bad year table header');
  }
  const equilibrium = parseYearTable(r, names, numYears, 'equilibrium');

  const numYears2 = parseInt(r.next() ?? '', 10);
  const nodeFactor = parseYearTable(r, names, numYears2, 'node factor');

  // ── Station records ────────────────────────────────────────────────
  // Real-world files are ragged: records may list more or fewer constituent
  // lines than the table defines, and stray lines occur between records. A
  // record start is detected STRUCTURALLY — a line followed by a meridian
  // line ("±HH:MM …") and a datum line ("<number> <unit>"). Constituent
  // lines are matched by shape ("name number number") and mapped by
  // constituent name when known, positionally otherwise ("x" placeholders).
  const cstIndex = new Map<string, number>();
  names.forEach((n, i) => cstIndex.set(n, i));
  const CST_LINE_RE = /^(\S+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/;
  const MERIDIAN_RE = /^[+-]?\d+:\d+(\s|$)/;
  const DATUM_RE = /^(-?[\d.]+)\s+(\S+)\s*$/;

  // Detected via a small 3-line lookahead window rather than buffering every
  // remaining line of the file — community files can run 10-20MB and the
  // record body is otherwise the only thing that needs lookahead.
  const isRecordStart = (): boolean => {
    const meridianLine = r.peekAt(1);
    const datumLine = r.peekAt(2);
    return meridianLine !== null && datumLine !== null &&
      MERIDIAN_RE.test(meridianLine) && DATUM_RE.test(datumLine);
  };

  const records = new Map<string, HarmonicStation>();
  const warnedUnrecognizedNames = new Set<string>();
  while (!r.eof()) {
    if (!isRecordStart()) {
      r.next(); // stray/extra line between records — skip
      continue;
    }
    const name = r.next()!;
    const meridianLine = r.next()!;
    const dm = r.next()!.match(DATUM_RE)!;
    const tzMatch = meridianLine.match(/:(\S+)\s*$/);

    const amplitude: number[] = new Array(numCsts).fill(0);
    const epoch: number[] = new Array(numCsts).fill(0);
    let cursor = 0;
    while (!r.eof() && !isRecordStart()) {
      const line = r.peek()!;
      const m = line.match(CST_LINE_RE);
      if (!m) {
        console.warn(`[signalk-tidal-currents] malformed constituent line for station "${name}", skipping rest of record: ${line}`);
        break; // stray line ends the record body
      }
      r.next();
      const byName = cstIndex.get(m[1]);
      if (byName === undefined && m[1].toLowerCase() !== 'x' && !warnedUnrecognizedNames.has(m[1])) {
        warnedUnrecognizedNames.add(m[1]);
        console.debug(`[signalk-tidal-currents] unrecognized constituent "${m[1]}" (station "${name}"), mapping positionally`);
      }
      const idx = byName !== undefined ? byName : cursor;
      if (idx < numCsts) {
        amplitude[idx] = parseFloat(m[2]) || 0;
        epoch[idx] = parseFloat(m[3]) || 0;
      }
      cursor = idx + 1;
    }

    const units = dm[2].toLowerCase();
    records.set(name, {
      name,
      meridianSeconds: meridianToSeconds(meridianLine),
      tzname: tzMatch ? tzMatch[1] : undefined,
      datum: parseFloat(dm[1]),
      units,
      isCurrent: units.startsWith('knot'),
      amplitude,
      epoch,
    });
  }

  return {
    constituents: { names, speeds, firstYear, numYears, equilibrium, nodeFactor },
    records,
  };
}

const IDX_STATION_RE = /^([TtCcUu])(\S*)\s+([-\d.`]+)\s+([-\d.]+)\s+(-?\d+):(\d+)\s+(.+?)\s*$/;

export function parseIdxFile(text: string): IdxStation[] {
  const lines = text.split(/\r?\n/);
  const stations: IdxStation[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#')) continue;
    if (/^(XREF|REGION|COUNTRY|TZ|\*)/.test(line)) continue;

    const m = line.match(IDX_STATION_RE);
    if (!m) continue;
    const type = m[1] === 'U' ? 'C' : m[1] === 'u' ? 'c' : (m[1] as IdxStation['type']);
    // Some community files use a backtick as the minus sign on longitudes.
    const lon = parseFloat(m[3].replace('`', '-'));
    const lat = parseFloat(m[4]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const name = m[7].trim();
    const isSub = type === 't' || type === 'c';

    let offsets: SubordinateOffsets | undefined;
    if (isSub) {
      // The offsets line follows immediately: '^' (currents) or '&' (tides).
      const next = lines[i + 1] ?? '';
      if (next.startsWith('^')) {
        const p = next.slice(1).trim().split(/\s+/);
        // ^fOff fMpy fAdd eOff eMpy eAdd staId floodDir ebbDir refNum refName…
        if (p.length >= 11) {
          const floodDir = parseInt(p[7], 10);
          const ebbDir = parseInt(p[8], 10);
          offsets = {
            floodOffsetMinutes: parseInt(p[0], 10) || 0,
            floodMultiplier: parseFloat(p[1]) || 1,
            floodAdd: parseFloat(p[2]) || 0,
            ebbOffsetMinutes: parseInt(p[3], 10) || 0,
            ebbMultiplier: parseFloat(p[4]) || 1,
            ebbAdd: parseFloat(p[5]) || 0,
            floodDir: Math.abs(floodDir) <= 360 ? ((floodDir % 360) + 360) % 360 : null,
            ebbDir: Math.abs(ebbDir) <= 360 ? ((ebbDir % 360) + 360) % 360 : null,
            referenceName: p.slice(10).join(' '),
          };
          if (offsets.floodMultiplier === 0) offsets.floodMultiplier = 1;
          if (offsets.ebbMultiplier === 0) offsets.ebbMultiplier = 1;
        }
        i++;
      } else if (next.startsWith('&')) {
        const p = next.slice(1).trim().split(/\s+/);
        // &hOff hMpy hAdd lOff lMpy lAdd staId [tzname] refNum refName…
        // (tz name optional — detect by whether field 7 is numeric)
        const hasTz = p.length >= 9 && !/^-?\d+$/.test(p[7]);
        const refStart = hasTz ? 9 : 8;
        offsets = {
          floodOffsetMinutes: parseInt(p[0], 10) || 0,
          floodMultiplier: parseFloat(p[1]) || 1,
          floodAdd: parseFloat(p[2]) || 0,
          ebbOffsetMinutes: parseInt(p[3], 10) || 0,
          ebbMultiplier: parseFloat(p[4]) || 1,
          ebbAdd: parseFloat(p[5]) || 0,
          floodDir: null,
          ebbDir: null,
          referenceName: p.slice(refStart).join(' '),
        };
        if (offsets.floodMultiplier === 0) offsets.floodMultiplier = 1;
        if (offsets.ebbMultiplier === 0) offsets.ebbMultiplier = 1;
        i++;
      }
    }

    // Stable unique id (duplicate names get a numeric suffix).
    let id = slugify(name);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n + 1}`;

    stations.push({
      id,
      type,
      zone: m[2],
      name,
      latitude: lat,
      longitude: lon,
      timeZoneMinutes:
        (m[5].startsWith('-') ? -1 : 1) * (Math.abs(parseInt(m[5], 10)) * 60 + parseInt(m[6], 10)),
      isCurrent: type === 'C' || type === 'c',
      isSubordinate: isSub,
      offsets,
    });
  }
  return stations;
}

function normalizeStationName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Cached per records Map instance: normalized name -> station, built once on
// first lookup and reused for the life of the loaded HarmonicsData. Avoids
// re-normalizing every key on every fallback lookup.
const normalizedIndexCache = new WeakMap<Map<string, HarmonicStation>, Map<string, HarmonicStation>>();

function getNormalizedIndex(records: Map<string, HarmonicStation>): Map<string, HarmonicStation> {
  let idx = normalizedIndexCache.get(records);
  if (!idx) {
    idx = new Map();
    for (const [key, rec] of records) {
      const norm = normalizeStationName(key);
      if (!idx.has(norm)) idx.set(norm, rec);
    }
    normalizedIndexCache.set(records, idx);
  }
  return idx;
}

/**
 * Relaxed record lookup: IDX reference names may differ from HARMONIC record
 * names in case, spacing, or by being a prefix (OpenCPN's "slackcmp").
 */
export function findStationHarmonics(
  records: Map<string, HarmonicStation>,
  name: string,
): HarmonicStation | undefined {
  const exact = records.get(name);
  if (exact) return exact;
  const want = normalizeStationName(name);
  const normExact = getNormalizedIndex(records).get(want);
  if (normExact) return normExact;
  // Rare fallback: prefix match, e.g. IDX truncates or extends the name.
  for (const [key, rec] of records) {
    const have = normalizeStationName(key);
    if (have.startsWith(want) || want.startsWith(have)) return rec;
  }
  return undefined;
}

/**
 * Locate a harmonic data/index pair in a directory: any `<base>.IDX` file
 * (case-insensitive) with a matching `<base>` data file — covers both the
 * classic `HARMONIC`/`HARMONIC.IDX` naming and OpenCPN's
 * `HARMONICS_NO_US`/`HARMONICS_NO_US.IDX`. Prefers `HARMONIC` when several
 * pairs exist.
 */
export function findHarmonicFiles(dir: string): { harmonic: string; idx: string } | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const pairs: Array<{ harmonic: string; idx: string }> = [];
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.idx')) continue;
    const base = f.slice(0, -4);
    const data = entries.find((e) => e === base || e.toLowerCase() === base.toLowerCase());
    if (data && data.toLowerCase() !== f.toLowerCase()) {
      pairs.push({ harmonic: path.join(dir, data), idx: path.join(dir, f) });
    }
  }
  if (pairs.length === 0) return null;
  pairs.sort((a, b) => {
    const pa = path.basename(a.harmonic).toLowerCase() === 'harmonic' ? 0 : 1;
    const pb = path.basename(b.harmonic).toLowerCase() === 'harmonic' ? 0 : 1;
    return pa - pb;
  });
  return pairs[0];
}

export function loadHarmonicsDir(dir: string): HarmonicsData {
  const files = findHarmonicFiles(dir);
  if (!files) {
    throw new Error(`No HARMONIC / HARMONIC.IDX pair found in ${dir}`);
  }
  // Legacy files are ISO-8859-1 (French accents in names).
  const harmonicText = fs.readFileSync(files.harmonic, 'latin1');
  const idxText = fs.readFileSync(files.idx, 'latin1');
  const { constituents, records } = parseHarmonicFile(harmonicText);
  const stations = parseIdxFile(idxText);
  return { constituents, records, stations, sourceDir: dir };
}
