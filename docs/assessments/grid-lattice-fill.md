# Assessment: filling the /grid budget by thinning a denser lattice

Status: **not adopted.** The proposal is measured below. It fails the
acceptance criteria, so it is not implemented. A different way to get the
gain (quincunx half-levels) is described at the end for the owner to decide on.

## Proposal evaluated

`gridPoints` picks the densest power-of-two level `k` with
`C(k) + W <= maxPoints`. One level step changes the node count about 4x, so
the lattice often fills only 25-100 % of the budget. The proposal: take level
`k + 1` (one level denser), then thin those candidate POSITIONS down to
`maxPoints - W` with the global-origin cell ladder (`thinIndicesByCellLadder`)
before resolving.

## Why it does not deliver

1. **The cell ladder is as coarse as the lattice, and it is not aligned with
   it.** `CELL_LADDER_DEG` steps by 2x / 2.5x in cell size, so its occupancy
   steps by 4x / 6.25x, which is coarser than the lattice's own 4x. Thinning a
   regular lattice of spacing `d` with a cell size `L` gives about
   `area / L²` points. Only a ladder size strictly between `d` and `2d` can
   land between levels `k` and `k + 1`. Whether one exists depends on the
   grid's resolution and the zoom. When none does, the next ladder size above
   `2d` gives **fewer points than level `k` alone**:
   - the coastal case (150×150 @ 0.02°, whole grid in view, maxPoints 400):
     level `k` is stride 8 (0.16° spacing, 255 sea points). Level `k + 1` at
     0.08° thinned with the ladder lands on 0.2° cells: **160 points**, a loss.
   - Channel view on the large fixture, maxPoints 5000: 1651 → **1060** points.
2. **Guarding against that** (keep plain level `k` unless thinning beats it)
   removes the losses. But the gain is then grid- and zoom-dependent, and
   smaller than the alternative below.
3. **Pan stability / nesting breaks.** Lattice nodes sit on or near ladder
   cell boundaries. Which node represents a cell flips with sub-node
   placement, and the guard decision itself flips between neighbouring views.
   Share of lattice points in the overlap of a view and the same view panned
   by ¼ width that stay put: baseline **1.00**, ladder **0.96**, guarded
   **0.97**. Nesting across zoom levels is also lost: a thinned set is not a
   subset of the next denser level's set in general.
4. **Cost on small devices.** Candidates grow about 4x before thinning (16.5k
   for maxPoints 5000 on the large fixture). In typed arrays that is only about
   0.3 MB. But `pickCellReps` builds a hash table per ladder level it visits
   (coarse → fine, up to ~10 levels). Per request that adds **+2.9 to +3.8 MB
   of transient ArrayBuffer** and up to **+6 MB of heap allocation**, against
   no gain in those cases. Post-GC RSS after the benchmark was ~45 MB higher
   (469 → 512-521 MB: V8 keeps the larger high-water mark), which is the
   wrong direction for a Cerbo GX.

## Invariants (proposal vs. today)

| invariant | proposal |
|---|---|
| single resolver / parity with `/vector` | kept: every emitted point is still `resolveAt` |
| budget `<= maxPoints` | kept: thinning to `maxPoints - W` |
| resolver work `<= maxPoints` | kept: thinning happens before resolving |
| counted-work bounds (`ctx.counters`) | kept for resolves; extra uncounted `O(4·maxPoints × ladder levels)` scan work |
| geometry-only | kept: positions only |
| nesting (zoom) | **broken**: a thinned set is not nested in the next level |
| pan stability | **degraded** (0.96-0.97 overlap retention vs 1.00) |
| "stations first" | kept in spirit, but the "at most one level" property becomes "some ladder level" |
| more points | **not guaranteed**: it loses points in the issue's own case |

## Measurements

Setup: x64, Node v24.22.3,
`node --expose-gc --max-semi-space-size=64 dist-test/bench-lattice.js <mode>`
(`test/bench-lattice.ts`; the prototype switch is in
`grid-lattice-fill-prototype.patch` next to this file). The 64 MB semi-space
keeps a single request free of scavenges, so the heap delta of one request
approximates what it allocates. I had no ARM board, so all numbers are x64.
Expect several times slower on armv7, with the same ratios.

- `baseline`: current code (identical to `origin/main` in every number)
- `ladder`: the proposal as stated
- `ladder-guarded`: the proposal, falling back to plain level `k` when
  thinning gives no more points
- `quincunx`: the alternative below

### Budget use: coastal grid (150×150 @ 0.02°, 31 % land), 164 requests over a zoom/pan sweep

"Resolved share" counts only the budget-limited requests (the lattice is not
yet at stride 1): candidates resolved ÷ maxPoints. Theory for a log-uniform
zoom is 0.54 with 4x steps and 0.72 with 2x steps.

| sweep | baseline | ladder | ladder-guarded | quincunx |
|---|---|---|---|---|
| GRIB only, mp 400: resolved share / points share | 0.50 / 0.33 | 0.58 / 0.39 | 0.70 / 0.47 | 0.71 / 0.47 |
| GRIB only, mp 2000 | 0.51 / 0.34 | 0.52 / 0.38 | 0.63 / 0.46 | 0.69 / 0.46 |
| + 100 UTCEF winners, mp 400 | 0.49 / 0.36 | 0.55 / 0.44 | 0.66 / 0.52 | 0.68 / 0.50 |
| pan stability (¼-width shift) | 1.00 | 0.96 | 0.97 | 1.00 |

The issue's coastal example, whole grid at mp 400: baseline 255 GRIB points,
ladder 160, guarded 255, quincunx 255. With 100 winners on land:
255 GRIB + 96 UTCEF for all four variants. In this geometry `C(0) + W > maxPoints`,
so the lattice already sits on the level-0 floor, and I did not reproduce the
60 + 100 figure.

### Cost on the large fixture (global 0.25° + regional 0.02° 400×300 + 200k UTCEF stations)

Each cell: points / resolved / candidates / median ms / peak heap alloc MB / peak ArrayBuffer MB.

| view | baseline | ladder | ladder-guarded | quincunx |
|---|---|---|---|---|
| Europe mp 500 | 239 / 252 / 252 / 11.7 / 9.8 / 2.0 | 253 / 259 / 996 / 12.2 / 9.7 / 2.2 | 253 / 259 / 996 / 12.2 / 9.7 / 2.2 | **478** / 498 / 498 / 12.4 / 10.2 / 2.0 |
| Europe mp 5000 | 3974 / 4196 / 4196 / 16.4 / 15.8 / 2.1 | 3654 / 3769 / 16541 / 19.0 / 17.1 / 5.0 | 3974 / 4196 / 16541 / 20.3 / 22.0 / 5.0 | 3974 / 4196 / 4196 / 16.8 / 15.8 / 2.1 |
| North Sea mp 2000 | 892 / 1249 / 2525 / 4.6 / 4.0 / 1.1 | same | same | same |
| North Sea mp 5000 | 1634 / 2525 / 2525 / 5.0 / 4.7 / 0.3 | 3612 / 4849 / 8125 / 9.2 / 9.3 / 3.7 | 3612 / 4849 / 8125 / 9.3 / 9.2 / 3.7 | 3034 / 4375 / 4375 / 7.4 / 8.0 / 0.3 |
| Channel mp 5000 | 1651 / 2356 / 2356 / 3.3 / 3.8 / 0.0 | 1060 / 1501 / 9160 / 3.9 / 4.0 / 3.8 | 1651 / 2356 / 9160 / 4.4 / 7.0 / 3.8 | **3264** / 4624 / 4624 / 5.4 / 7.3 / 0.1 |
| harbour mp 2000 (stride 1) | 26 / 408 / 408 / 1.2 / 0.9 / 0.1 | same | same | same |
| RSS after run, post-GC | 469 MB | 522 MB | 512 MB | 474 MB |

The request time scales with the number of points resolved. That is the point
of the change, and it stays bounded by `maxPoints`. The ladder variants also
pay for the 4x candidate scan.

## Alternative (not implemented here): quincunx half-levels

Add a half level between `k` and `k + 1`. With `s` the stride of level `k`
and `h = s / 2`, its nodes are the grid's own `(i, j)` multiples of `h` with
`(i/h + j/h)` even: level `k` plus the cell centres, a 45°-rotated square
lattice at spacing `s·d/√2`. Properties:

- **Nested**: level `k` ⊂ `k + ½` ⊂ `k + 1`, and pan-stable (a pure function of
  the global index), so the overlap retention stays 1.00.
- **Geometry-only, no thinning, no extra arrays**: the count is index
  arithmetic (even/odd multiples per axis), exactly like `candidateCount`
  today. Candidates `<= maxPoints`, so the resolver work bound is unchanged.
- **Steps of 2x instead of 4x**: the budget-limited resolved share goes from
  ~0.50 to ~0.70 (theory 0.54 → 0.72), and points from ~0.33 to ~0.47 of the
  budget. Europe mp 500 doubles (239 → 478), Channel mp 5000 doubles
  (1651 → 3264).
- **Memory**: no new cache. The transient cost per request is unchanged
  except for what resolving more points allocates (it scales with points,
  bounded by `maxPoints`). Post-GC RSS stayed the same (469 vs 474 MB).
- **"Stations first"** keeps its shape. One winning station costs the lattice
  one HALF level (2x, e.g. 400 → 200 in the existing test) instead of a full
  4x level, so that test's expectation changes from 100 to ~200.

Open questions for the owner: is a staggered (quincunx) arrow layout
acceptable on the map? It reads as a regular diagonal pattern. And should
`baseStride` also move to half-steps? Today a level-0 overflow (two
overlapping grids, e.g. North Sea mp 2000: 2525 candidates) still falls back
to thinning positions. That fallback is unchanged by any variant here.
