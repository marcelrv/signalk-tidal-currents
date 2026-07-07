# Vendored JPX (JPEG2000) Decoder

## Origin

This decoder is extracted from the [`jpeg2000`](https://github.com/runk/jpeg2000) npm
package (v1.1.1) by Dmitry Shirokov (runk), itself derived from
[Mozilla PDF.js](https://github.com/mozilla/pdf.js) `src/core/jpx.js`.

**License:** Apache-2.0 (Mozilla header retained in all source files).

## Why vendored?

The upstream `jpeg2000` package always produces `Uint8ClampedArray` (0–255, 8-bit)
output in its `transformComponents` function:

```js
var out = new Uint8ClampedArray(tile0.items.length * componentsCount);
// …
shift = components[c].precision - 8;       // 16-bit input → shift=8
offset = (128 << shift) + 0.5;             // 32768.5
out[pos] = (items[j] + offset) >> shift;   // discards lower 8 bits
```

This is correct for image display (canvas pixel data must be 8-bit), but
destroys precision for GRIB2 data where JPEG2000 stores 16-bit integer
values. The GRIB2 scaling formula `value = R + X × 2ᴱ / 10ᴰ` requires the
full `X` — losing 8 bits of `X` means losing the least-significant 0.128 m/s
of precision for typical current data.

## Specific changes vs. upstream v1.1.1

### 1. Module format (CJS → ESM TypeScript)

- Converted CommonJS `require()` / `module.exports` to ES module `import` /
  `export`.
- Renamed `.js` to `.ts`, added `// @ts-nocheck` on `jpx.ts` to suppress
  strict-type errors in the vendored JS code (the TypeScript types for the
  wrapper are in `index.ts`).

### 2. Float64Array output with full precision (critical)

**File:** `jpx.ts`, inside `transformComponents()`.

**Before:**
```js
var out = new Uint8ClampedArray(tile0.items.length * componentsCount);
// …
for (c = 0; c < componentsCount; c++) {
  var items = transformedTiles[c].items;
  shift = components[c].precision - 8;
  offset = (128 << shift) + 0.5;
  for (pos = c, j = 0, jj = items.length; j < jj; j++) {
    out[pos] = (items[j] + offset) >> shift;
    pos += componentsCount;
  }
}
```

**After:**
```js
var out = new Float64Array(tile0.items.length * componentsCount);
// …
for (c = 0; c < componentsCount; c++) {
  var items = transformedTiles[c].items;
  var dcShift = 1 << (components[c].precision - 1);
  for (pos = c, j = 0, jj = items.length; j < jj; j++) {
    out[pos] = items[j] + dcShift;
    pos += componentsCount;
  }
}
```

The change:
1. Outputs a `Float64Array` instead of `Uint8ClampedArray` — no clamping, no
   range restriction.
2. Applies only the JPEG2000 *inverse DC level shift* (add back
   `2^(precision-1)`), without the `>> (precision-8)` downshift that
   truncated to 8 bits.

### 3. Dynamic `bitsPerComponent`

**File:** `jpx.ts`, inside `parseImageProperties()`.

Previously hardcoded `this.bitsPerComponent = 8`. Changed to read the actual
component precision from the SIZ marker so callers can discover the original
bit depth.

### 4. Wrapper with typed interface

**File:** `index.ts`

Provides a clean `decodeJpeg2000Codestream(data: Uint8Array): Float64Array`
function that internally instantiates the decoder and returns the raw
full-precision pixel values.

## Could these changes be upstreamed?

### What we changed

The core change is making `transformComponents` output configurable precision
instead of always clamping to 8 bits.

### Upstream compatibility

The `jpeg2000` package is designed as a decoder for image *display* (PDF.js
rendering, browser canvas). Uint8ClampedArray is the correct output type for
that use case. Switching unconditionally to Float64Array would break every
existing consumer.

### A better upstream PR

A backward-compatible addition would be a constructor option, e.g.:

```js
class JpxImage {
  constructor(opts) {
    this.outputType = opts?.outputType ?? 'uint8clamped';
    // …
  }
}
```

Then `transformComponents` checks `this.outputType`:

```js
if (this.outputType === 'float64') {
  var out = new Float64Array(tile0.items.length * componentsCount);
  // full-precision branch
} else {
  var out = new Uint8ClampedArray(tile0.items.length * componentsCount);
  // original 8-bit branch
}
```

The same approach could be extended to expose the raw *pre-DC-level-shift*
coefficients (useful for scientific applications that need access to the
wavelet subbands). This would not break existing users (default stays
`'uint8clamped'`).

### Worth proposing?

Yes — the change is small (~10 lines), zero-cost for default path, and opens
the decoder to scientific/geospatial use cases (GRIB2, NetCDF, remote sensing)
without forking the codebase. The package author is active on GitHub and
accepted the single patch for v1.1.1 (the `index.d.ts` was added based on a PR).

## Updating to a future upstream version

1. Copy the new `src/` files from the upstream npm package into `src/jpx/`.
2. Re-apply the `Float64Array` / DC-level-shift patch in `transformComponents`.
3. Re-apply the `parseImageProperties` `bitsPerComponent` fix.
4. Convert CJS → ESM (import/export syntax).
5. Remove any downstream-only additions (`index.ts` wrapper, this README).
