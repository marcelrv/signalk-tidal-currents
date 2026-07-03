// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Synthetic GRIB2 encoder for tests — grid template 3.0, product template
 * 4.0, data representation 5.0 (simple packing), optional bitmap (derived
 * from NaN values). Independent of the decoder under test so round-trip
 * tests exercise real byte layouts.
 */

export class ByteWriter {
  private bytes: number[] = [];
  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v >> 8).u8(v);
  }
  u32(v: number): this {
    return this.u8(v / 0x1000000).u8(v >> 16).u8(v >> 8).u8(v);
  }
  /** GRIB2 sign-magnitude 32-bit. */
  s32sm(v: number): this {
    return v < 0 ? this.u32(0x80000000 + Math.abs(v)) : this.u32(v);
  }
  s16sm(v: number): this {
    return v < 0 ? this.u16(0x8000 + Math.abs(v)) : this.u16(v);
  }
  f32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, false);
    for (const x of b) this.u8(x);
    return this;
  }
  raw(b: Uint8Array | number[]): this {
    for (const x of b) this.u8(x);
    return this;
  }
  get length(): number {
    return this.bytes.length;
  }
  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export class BitWriter {
  private bits: number[] = [];
  write(value: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
    return this;
  }
  align(): this {
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    return this;
  }
  toUint8Array(): Uint8Array {
    this.align();
    const out = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) {
      out[i >> 3] |= this.bits[i] << (7 - (i & 7));
    }
    return out;
  }
}

export interface EncodeField {
  discipline?: number; // default 10 (oceanographic)
  category?: number; // default 1 (currents)
  param: number; // 0 dir, 1 speed, 2 u, 3 v
  refTime: number; // ms epoch
  forecastHours: number;
  /** First grid point per the scan mode (default scan 0x40: south-west corner). */
  la1: number;
  lo1: number;
  dLat: number; // positive
  dLon: number; // positive
  ni: number;
  nj: number;
  scan?: number; // 0x00, 0x40 (default) or 0x80 variants
  /** Values in scan order; NaN entries become bitmap-missing points. */
  values: number[];
  surfaceType?: number; // default 1 (surface)
  surfaceValue?: number;
  decScale?: number; // default 3 (milli-precision)
}

export function section(num: number, body: (w: ByteWriter) => void): Uint8Array {
  const w = new ByteWriter();
  body(w);
  const content = w.toUint8Array();
  const out = new ByteWriter();
  out.u32(content.length + 5).u8(num).raw(content);
  return out.toUint8Array();
}

/** Section 1 (identification) for a given reference time. */
export function makeSection1(refTime: number): Uint8Array {
  const d = new Date(refTime);
  return section(1, (w) => {
    w.u16(0).u16(0).u8(2).u8(0).u8(1);
    w.u16(d.getUTCFullYear())
      .u8(d.getUTCMonth() + 1)
      .u8(d.getUTCDate())
      .u8(d.getUTCHours())
      .u8(d.getUTCMinutes())
      .u8(d.getUTCSeconds());
    w.u8(0).u8(1);
  });
}

/** Section 3, grid template 3.0. la1/lo1 = first point per scan mode. */
export function makeSection3(
  ni: number,
  nj: number,
  la1: number,
  lo1: number,
  dLat: number,
  dLon: number,
  scan = 0x40,
): Uint8Array {
  const iPlus = (scan & 0x80) === 0;
  const jPlus = (scan & 0x40) !== 0;
  const la2 = la1 + (jPlus ? 1 : -1) * (nj - 1) * dLat;
  const lo2 = lo1 + (iPlus ? 1 : -1) * (ni - 1) * dLon;
  const toMicro = (deg: number) => Math.round(deg * 1e6);
  return section(3, (w) => {
    w.u8(0).u32(ni * nj).u8(0).u8(0).u16(0);
    w.u8(6);
    w.u8(0).u32(0).u8(0).u32(0).u8(0).u32(0);
    w.u32(ni).u32(nj);
    w.u32(0).u32(0);
    w.s32sm(toMicro(la1)).s32sm(toMicro(lo1));
    w.u8(0x30);
    w.s32sm(toMicro(la2)).s32sm(toMicro(lo2));
    w.u32(toMicro(dLon)).u32(toMicro(dLat));
    w.u8(scan);
  });
}

/** Section 4, product template 4.0. */
export function makeSection4(
  category: number,
  param: number,
  forecastHours: number,
  surfaceType = 1,
  surfaceValue = 0,
): Uint8Array {
  return section(4, (w) => {
    w.u16(0).u16(0).u8(category).u8(param);
    w.u8(2).u8(0).u8(0).u16(0).u8(0);
    w.u8(1).u32(forecastHours);
    w.u8(surfaceType).u8(0).u32(Math.round(surfaceValue));
    w.u8(255).u8(0).u32(0);
  });
}

/** Wrap sections into a complete GRIB2 message (indicator + '7777'). */
export function wrapMessage(sections: Uint8Array[], discipline = 10): Uint8Array {
  const bodyLen = sections.reduce((a, s) => a + s.length, 0);
  const total = 16 + bodyLen + 4;
  const w = new ByteWriter();
  w.raw([0x47, 0x52, 0x49, 0x42]).u16(0).u8(discipline).u8(2).u32(0).u32(total);
  for (const s of sections) w.raw(s);
  w.raw([0x37, 0x37, 0x37, 0x37]);
  return w.toUint8Array();
}

export function encodeGrib2Message(f: EncodeField): Uint8Array {
  const discipline = f.discipline ?? 10;
  const category = f.category ?? 1;
  const scan = f.scan ?? 0x40;
  const decScale = f.decScale ?? 3;
  const nPoints = f.ni * f.nj;
  if (f.values.length !== nPoints) throw new Error('values length must be ni*nj');

  // Simple packing: E = 0, so X = round(v·10^D) − R with R the minimum.
  const present = f.values.filter((v) => !Number.isNaN(v));
  const hasBitmap = present.length !== f.values.length;
  const scaled = present.map((v) => Math.round(v * Math.pow(10, decScale)));
  const refValue = scaled.length > 0 ? Math.min(...scaled) : 0;
  const xs = scaled.map((s) => s - refValue);
  const maxX = xs.length > 0 ? Math.max(...xs) : 0;
  const nbits = maxX > 0 ? Math.ceil(Math.log2(maxX + 1)) : 0;

  const sections: Uint8Array[] = [
    makeSection1(f.refTime),
    makeSection3(f.ni, f.nj, f.la1, f.lo1, f.dLat, f.dLon, scan),
    makeSection4(category, f.param, f.forecastHours, f.surfaceType ?? 1, f.surfaceValue ?? 0),
    // Section 5 — data representation template 5.0
    section(5, (w) => {
      w.u32(present.length).u16(0).f32(refValue).s16sm(0).s16sm(decScale).u8(nbits).u8(0);
    }),
    // Section 6 — bitmap
    section(6, (w) => {
      if (!hasBitmap) {
        w.u8(255);
        return;
      }
      w.u8(0);
      const bw = new BitWriter();
      for (const v of f.values) bw.write(Number.isNaN(v) ? 0 : 1, 1);
      w.raw(bw.toUint8Array());
    }),
    // Section 7 — data
    section(7, (w) => {
      if (nbits > 0) {
        const bw = new BitWriter();
        for (const x of xs) bw.write(x, nbits);
        w.raw(bw.toUint8Array());
      }
    }),
  ];
  return wrapMessage(sections, discipline);
}

/** Concatenate messages into one file buffer. */
export function encodeGrib2File(fields: EncodeField[]): Uint8Array {
  const msgs = fields.map(encodeGrib2Message);
  const total = msgs.reduce((a, m) => a + m.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const m of msgs) {
    out.set(m, off);
    off += m.length;
  }
  return out;
}
