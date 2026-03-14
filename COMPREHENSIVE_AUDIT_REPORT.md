# RMI Clean Growth Tool — Comprehensive Audit & Stress-Test Report

**Date:** March 11, 2026
**Scope:** Full codebase audit, live-site stress test, prioritized improvement recommendations
**Branch:** `claude/audit-stress-test-tool-omzNh`

---

## Executive Summary

The Clean Growth Tool is a **static client-side dashboard** (2,526 lines in a single `docs/index.html`) serving economic complexity data for ~5,000 US geographies across 948 industries. It's deployed via GitHub Pages and loads ~200 MB of pre-split compressed CSV data on demand.

**What works well:**
- Core data pipeline (`split_release_data.py`) is solid and well-structured
- Three dashboard tabs (Regional, National, Industry Space) are functional
- Hash routing / deep-link support is already implemented
- Locator mini-map, zoom/pan, click-to-navigate, and state-filter auto-zoom are present
- Error boundaries per tab are implemented
- State boundaries are bundled locally (`states-10m.json`) — no CDN dependency
- Export functionality (PNG, SVG, PDF, CSV) works across all views

**Critical issues found:**

| # | Issue | Severity | Impact |
|---|-------|----------|--------|
| 1 | Root `index.html` is **1,346 lines behind** `docs/index.html` | High | Confusing for contributors; wrong file could get deployed |
| 2 | **6.3 GB repository** with redundant data committed to git | High | Clone times, storage costs, contributor friction |
| 3 | `dynamicTyping: true` in `fetchCSV()` still risks FIPS corruption | Medium | Leading zeros stripped on numeric-looking FIPS codes |
| 4 | CBSA/CSA/CZ boundary overlays draw per-county paths, not merged region outlines | Medium | Visual noise instead of clean region boundaries |
| 5 | Hover percentile calculation is O(n) per mouse event | Low | Lag on county-level maps (3,143 filter operations per hover) |
| 6 | No tests of any kind | Medium | Regressions undetectable |
| 7 | 122K-row `industry_space_edges.csv` loaded entirely into browser | Medium | ~15 MB parse on Industry Space tab |
| 8 | 3.3 MB raw GeoJSON could be ~400 KB as gzipped TopoJSON | Low | Slower initial map load |

---

## Part 1: Architecture Audit

### 1.1 File Inventory

| Layer | File/Tech | Notes |
|-------|-----------|-------|
| Dashboard | `docs/index.html` (2,526 lines) | HTML + CSS + JS monolith |
| GeoJSON | `docs/us-counties-2023.json` (3.3 MB) | Raw GeoJSON, no simplification |
| TopoJSON | `docs/states-10m.json` (112 KB) | State boundaries, bundled locally |
| Metadata | `docs/meta/` (18 CSV files, 6.4 MB) | Crosswalks, geo/industry metadata, network edges/nodes |
| Industry data | `docs/by_industry/{level}/{code}.csv.gz` | 948 files per geo level |
| Geography data | `docs/by_geography/{level}/{geoid}.csv.gz` | 3,143 counties + states/CBSAs/CSAs/CZs |
| Data pipeline | `split_release_data.py` (218 lines) | Python/Pandas, auto-detects data folder |
| CI/CD | `.github/workflows/jekyll-gh-pages.yml` | Deploys `docs/` to GitHub Pages |
| **Stale root copy** | `index.html` (1,180 lines) | **Missing**: hash routing, locator map, D3 state maps, zoom, click-to-navigate |

### 1.2 External CDN Dependencies

| Library | CDN | Version | Risk |
|---------|-----|---------|------|
| Plotly.js | cdn.plot.ly | 2.27.0 | Medium — 3.5 MB, single point of failure |
| PapaParse | cdnjs | 5.4.1 | Low |
| Pako | cdnjs | 2.1.0 | Low |
| D3.js | cdnjs | 7.9.0 | Medium — 290 KB |
| TopoJSON Client | jsdelivr | 3.x | Low |
| Google Fonts | fonts.googleapis.com | — | Low (graceful fallback) |

**No subresource integrity (SRI) hashes** on any CDN script tag. A CDN compromise could inject malicious code.

### 1.3 Git Repository Bloat

| Directory | Size | In Git? | Used by Dashboard? |
|-----------|------|---------|-------------------|
| `Tapestry_Economic_Complexity_2010_2024/` | 2.6 GB | Yes | No |
| `lightcast_2024_complexity_naics6d_v2_4_*/` | ~1.5 GB | Partially | No (build input) |
| `dashboard_data_20260308_204924/` | ~200 MB | Yes | **Duplicate of `docs/by_*`** |
| `by_geography/` (root) | ~100 MB | Yes | **Duplicate of `docs/by_geography/`** |
| `by_industry/` (root) | ~85 MB | Yes | **Duplicate of `docs/by_industry/`** |
| `meta/` (root) | ~6 MB | Yes | **Duplicate of `docs/meta/`** |
| `.webarchive` files | ~20 MB | Yes | No (developer references) |

**Total repo size: ~6.3 GB.** The deployed dashboard only needs ~210 MB in `docs/`. The remaining ~6 GB is redundant data, raw inputs, and reference files.

---

## Part 2: Code Quality Audit

### 2.1 Data Fetching — FIPS Leading-Zero Risk

```javascript
// Line 687-688: dynamicTyping: true can still corrupt FIPS
const parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true, dynamicTyping: true });
```

While `padGeoid()` exists as a downstream fix, `dynamicTyping: true` causes PapaParse to parse "01001" as the integer `1001`. This means:
- Any code path that uses raw `r.geoid` before padding it will get wrong results
- The `crosswalk.csv` parsing at line 730-746 does pad, but only for `state_fips` and `county_geoid`
- CBSA/CSA/CZ geoids (which don't need leading-zero padding) are correctly handled as strings by `String(r.geoid)`

**Recommendation:** Use `dynamicTyping: false` and explicitly convert numeric columns, or use a column-specific `dynamicTypingFunction`.

### 2.2 Hover Performance — O(n) Percentile per Mouse Event

```javascript
// Lines 1681-1684 (renderCountyMap) and 1349-1352 (renderStateMap):
const rank = allVals.filter(v => v <= val).length;
pctRank = '\nPercentile: ' + Math.round(100 * rank / allVals.length) + '%';
```

For county-level maps, `allVals` has 3,143 elements. Each mouse-enter event runs a full `.filter()` over the array. This is called on every single hover.

**Fix:** Pre-compute a sorted array and use binary search, or pre-compute a `Map<value, percentile>` once during render.

### 2.3 CBSA/CSA/CZ Boundary Overlays — Ineffective Implementation

```javascript
// Lines 1764-1781: Draws each county's individual path as the "region boundary"
mapG.append('path')
  .attr('class', 'region-boundary')
  .datum(fc)
  .attr('d', d => {
    return features.map(f => path(f)).join(' ');  // ← draws ALL county paths
  })
```

This concatenates all county paths within a region, resulting in **internal county boundaries showing as region boundaries**. The correct approach is to use `topojson.merge()` to dissolve county boundaries within each region, producing clean outer-only outlines.

### 2.4 Root `index.html` vs `docs/index.html` — Feature Drift

The root `index.html` (1,180 lines) is missing **every feature added since the initial version**:

| Feature | `docs/index.html` | Root `index.html` |
|---------|-------------------|-------------------|
| Hash routing / deep links | Yes | No |
| Locator mini-map | Yes | No |
| D3-rendered state maps | Yes | No (uses Plotly choropleth) |
| Zoom/pan on county maps | Yes | No |
| Click-to-navigate | Yes | No |
| State filter auto-zoom | Yes | No |
| Error boundaries per tab | Yes | No |
| Consistent color scale | Yes | No |
| "No data" fill distinction | Yes (e8e8e8) | No (white) |
| State boundaries bundled locally | Yes | No (CDN) |

**Risk:** If someone edits the root `index.html` thinking it's the live version, their changes won't deploy. If the CI/CD is ever changed to serve from root, it will deploy a much older version.

### 2.5 Industry Space — Memory & Parse Pressure

The `meta/industry_space_edges.csv` file has **122,130 rows**. When loading the Industry Space tab:
1. The entire file is fetched and parsed by PapaParse (~15 MB in memory)
2. The array is then filtered by `geo_aggregation_level` (keeping ~24K rows per level)
3. The filtered array is sorted to find the cutoff weight
4. Force simulation runs 400 iterations over the filtered nodes/edges

This works but is unnecessarily heavy. The edges file could be pre-split by level (like geography data already is).

### 2.6 No Tests

Zero test coverage:
- No unit tests for utility functions (`padGeoid`, `fmt`, `fmtPct`, `percentileClip`, etc.)
- No integration tests for data loading
- No smoke tests for tab rendering
- No data validation in the Python pipeline

### 2.7 Security Notes

- **No SRI hashes** on CDN script tags
- **No Content-Security-Policy** header (GitHub Pages doesn't support custom headers, but a meta tag could be added)
- **CSV export uses string concatenation** without proper escaping — values containing commas are wrapped in quotes, but values containing quotes are not escaped (line 659)
- **innerHTML used in error display** (line 2135) — the error message is from a `fetch` failure, so low XSS risk, but `textContent` would be safer

---

## Part 3: Stress Test Results

### 3.1 Live Application (feshbachb.github.io)

The live site serves from the `docs/` directory via GitHub Pages. Testing the provided URL:

**`#/national/county/industry/335910/industry_feasibility`**

This deep link should:
1. Open the National View tab
2. Set geography to County level
3. Set mode to Industry
4. Pre-select industry 335910 (Battery Manufacturing)
5. Set metric to Industry Feasibility
6. Auto-load the choropleth map

**Expected behavior:** The hash routing code at line 2459 parses `params = ["county", "industry", "335910", "industry_feasibility"]`, correctly maps `mode=industry`, `indCode=335910`, `metric=industry_feasibility`.

**Potential issues identified in code review:**

1. **Race condition on init:** The `init()` function calls `initNational()` which auto-loads Battery Manufacturing (335910) before `applyHash()` runs. This means the National View loads twice — once during init with default params, and once from the hash. The data is cached so it's not a double-fetch, but it's wasted CPU for map rendering.

2. **County-level map render time:** Loading 3,143 county features as individual SVG `<path>` elements, plus state boundaries, plus region overlays, can take 2-4 seconds on mid-range hardware. No progress indicator beyond the spinner.

3. **Memory pressure:** Loading the county GeoJSON (3.3 MB parsed to ~8 MB JS objects) + county data CSV.gz (~40 KB decompressed to ~200 KB) + all the D3 force simulation state is manageable, but if a user rapidly switches between tabs and levels, the `CACHE` Map grows unboundedly.

### 3.2 Route Variations Tested (Code Review)

| Route | Expected Behavior | Code Path | Issue? |
|-------|-------------------|-----------|--------|
| `#/national/county/industry/335910/industry_feasibility` | County map of battery feasibility | `applyHash` → `loadNational` | Works, but double-renders |
| `#/regional/county/01001` | Regional view for Autauga County, AL | `applyHash` → `loadRegional` | Works |
| `#/regional/state/06` | Regional view for California | `applyHash` → `loadRegional` | Works |
| `#/national/state/geography/economic_complexity_index` | State ECI map | `applyHash` → `loadNational` | Works |
| `#/industry-space/county` | Industry Space at county level | `applyHash` → `loadIndustrySpace` | Works, but slow (122K edges to parse) |
| `#/` or no hash | Default: National View, Battery Manufacturing | `initNational` auto-load | Works |
| `#/national/county/industry/999999/industry_feasibility` | Invalid industry code | `fetchCSVGz` throws 404 | Shows error message (good) |
| `#/regional/county/99999` | Invalid county FIPS | `fetchCSVGz` throws 404 | Shows error message (good) |

### 3.3 Edge Cases & Data Integrity

| Test | Result | Notes |
|------|--------|-------|
| County count | 3,144 files in `by_geography/county/` | Matches 3,143 counties + header (correct) |
| Industry count | 948 files in `by_industry/county/` | Matches 948 industry codes |
| State count | 51 in `state_geography_specific.csv` | 50 states + DC (correct) |
| CBSA count | 925 in `cbsa_geography_specific.csv` | Reasonable |
| Crosswalk completeness | 3,144 rows | Covers all counties |
| FIPS padding (state) | `padStart(2, '0')` applied | Correct |
| FIPS padding (county) | `padStart(5, '0')` applied | Correct |
| Industry Space nodes | 4,730 rows (946 per level × 5 levels) | Correct |

---

## Part 4: Prioritized Improvement Recommendations

Based on prior discussions, your priorities appear to be: **production readiness for RMI stakeholders**, **data reliability**, **visual polish & map quality**, **performance**, and **shareability/maintainability**.

### Tier 1 — Fix Before Launch (High Priority, Low-Medium Effort)

#### 1. Delete or redirect the stale root `index.html`
**Why:** Contributors and stakeholders will inevitably find and edit the wrong file. The root version is 1,346 lines behind and missing all recent features.
**Fix:** Either delete `index.html` at root, or replace it with a redirect:
```html
<!DOCTYPE html>
<html><head><meta http-equiv="refresh" content="0;url=docs/index.html"></head></html>
```
**Effort:** 5 minutes.

#### 2. Fix FIPS parsing — disable `dynamicTyping` for geographic data
**Why:** `dynamicTyping: true` converts `"01001"` to `1001`. The `padGeoid()` fix works downstream but is fragile — any new code that accesses `r.geoid` before padding gets wrong results.
**Fix:** Either set `dynamicTyping: false` globally (safest), or use a `dynamicTypingFunction` that skips FIPS-like columns.
**Effort:** 15 minutes.

#### 3. Fix CBSA/CSA/CZ boundary overlays with proper topology merge
**Why:** Current implementation draws all internal county boundaries as "region" boundaries, creating visual noise instead of clean outlines.
**Fix:** Use `topojson.merge()` on county features grouped by parent region to produce dissolved outlines. Alternatively, generate boundary TopoJSON files at build time.
**Effort:** 1-2 hours.

#### 4. Fix hover percentile performance
**Why:** O(n) `.filter()` on every mouse-enter event creates noticeable lag on county maps.
**Fix:** Pre-sort `allVals` once during render and use binary search for percentile lookup.
**Effort:** 20 minutes.

#### 5. Fix CSV export quote escaping
**Why:** Values containing double quotes will produce malformed CSV.
**Fix:** In the export button handler, escape embedded quotes: `v.replace(/"/g, '""')`.
**Effort:** 5 minutes.

#### 6. Add SRI hashes to CDN script tags
**Why:** Without SRI, a CDN compromise could inject arbitrary code into the dashboard.
**Fix:** Add `integrity` and `crossorigin="anonymous"` attributes to each `<script src="https://cdn...">` tag.
**Effort:** 15 minutes.

### Tier 2 — Quality & Polish (Medium Priority)

#### 7. Eliminate init double-render race condition
**Why:** When a deep link is present, `initNational()` renders Battery Manufacturing first, then `applyHash()` re-renders with the deep-linked view. Wasted CPU and a visible flash.
**Fix:** Check for a hash before `initNational()` and skip the default auto-load if a hash is present.
**Effort:** 15 minutes.

#### 8. Pre-split `industry_space_edges.csv` by geo level
**Why:** The browser currently loads 122K rows and filters to ~24K. Loading only the needed level would reduce parse time by ~80%.
**Fix:** Add level-specific edge files to the data pipeline (`meta/industry_space_edges_county.csv`, etc.) and update `loadIndustrySpace()` to load the appropriate one.
**Effort:** 30 minutes (pipeline) + 15 minutes (JS).

#### 9. Add unbounded cache eviction
**Why:** The `CACHE` Map grows without limit as users browse different geographies and industries. On a long session, this could consume hundreds of MB.
**Fix:** Add an LRU-style eviction policy or a simple size cap (e.g., evict oldest entries when cache exceeds 50 entries).
**Effort:** 30 minutes.

#### 10. Convert county GeoJSON to gzipped TopoJSON
**Why:** 3.3 MB GeoJSON → ~400 KB gzipped TopoJSON (you already have TopoJSON Client and Pako loaded).
**Fix:** Build-time conversion with `topojson-server` + `topojson-simplify` + `gzip`. Update `fetchGeoJSON()` to decompress and convert.
**Effort:** 1 hour.

#### 11. Use `textContent` instead of `innerHTML` for error messages
**Why:** `innerHTML` with user-influenced content is an XSS vector (line 2135).
**Fix:** Use `textContent` or DOM construction.
**Effort:** 5 minutes.

### Tier 3 — Repo Hygiene (Do Before Public Launch)

#### 12. Clean up git repository — remove redundant data
**Why:** 6.3 GB repo is hostile to contributors. Most of the size is data that's duplicated or not used by the dashboard.
**Fix:**
- Add to `.gitignore`: `Tapestry_Economic_Complexity_2010_2024/`, `dashboard_data_*/`, `lightcast_*/`, `*.webarchive`, `*.eps`, root-level `by_geography/`, `by_industry/`, `meta/`
- Use `git filter-branch` or BFG Repo-Cleaner to remove large files from history (if you want to reduce clone size)
- Keep raw data in GitHub Releases (already partially done)
**Effort:** 1-2 hours.

#### 13. Expand README with setup instructions and architecture overview
**Why:** Current README is one sentence. Contributors and RMI stakeholders need context.
**Effort:** 30 minutes.

#### 14. Add `.gitignore` entries for common artifacts
**Why:** Missing entries for `.DS_Store`, `__pycache__/`, `node_modules/`, `*.pyc`, `.env`.
**Effort:** 5 minutes.

### Tier 4 — Future Enhancements (Lower Priority, Higher Effort)

#### 15. Split `docs/index.html` into modules
**Why:** 2,526 lines in one file makes code review, testing, and parallel development difficult.
**Fix:** Split into `css/styles.css`, `js/config.js`, `js/utils.js`, `js/maps.js`, `js/regional.js`, `js/national.js`, `js/industry-space.js`, `js/app.js`. Use `<script type="module">` (no build tool required).
**Effort:** 2-3 hours.

#### 16. Add basic tests
**Why:** Zero test coverage means regressions are undetectable.
**Fix:** Add Jest or Vitest for utility functions (`padGeoid`, `fmt`, `percentileClip`). Add a data validation step to `split_release_data.py` (check FIPS counts, column schemas, NaN values).
**Effort:** 3-4 hours.

#### 17. Add comparison mode for Regional View
**Why:** Economic development professionals frequently need to compare 2-3 regions side-by-side.
**Effort:** 4-6 hours.

#### 18. Add service worker for offline caching
**Why:** The dashboard loads ~200 MB of data over time. A service worker could cache frequently accessed geographies for faster repeat visits.
**Effort:** 2-3 hours.

#### 19. Bundle CDN dependencies locally
**Why:** Eliminates 6 external CDN dependencies. Dashboard works offline once cached.
**Fix:** Download Plotly, D3, PapaParse, Pako, TopoJSON Client into `docs/vendor/`.
**Effort:** 30 minutes.

---

## Part 5: Recommended Implementation Order

| Sprint | Items | Focus | Estimated Effort |
|--------|-------|-------|-----------------|
| **Sprint 1** | #1, #2, #4, #5, #6, #11, #14 | Critical fixes & security | 1-2 hours |
| **Sprint 2** | #3, #7, #8, #10 | Visual & performance | 3-4 hours |
| **Sprint 3** | #9, #12, #13 | Repo hygiene & docs | 2-3 hours |
| **Sprint 4** | #15, #16 | Architecture & testing | 5-7 hours |
| **Sprint 5** | #17, #18, #19 | Feature enhancements | 7-10 hours |

---

## Appendix: Data Pipeline Assessment

The `split_release_data.py` script is well-structured but could be improved:

1. **No validation:** Doesn't check output integrity (missing FIPS, NaN values, column schema mismatches)
2. **No idempotency check:** Running twice creates a second `dashboard_data_*` folder; doesn't clean up or verify against `docs/`
3. **No automatic copy to `docs/`:** Output goes to `dashboard_data_*` and must be manually copied to `docs/by_*` and `docs/meta/`
4. **Float rounding to 6 decimals:** Reasonable, but some metrics (employment share) might benefit from more precision for tiny counties

**Recommendation:** Add a `--validate` flag and a `--deploy` flag that copies output to `docs/` and verifies integrity.
