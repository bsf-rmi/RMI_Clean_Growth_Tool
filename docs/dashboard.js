// ============================================================================
// RMI Clean Growth Tool — dashboard.js
// Loads compressed CSV/GeoJSON, renders MapLibre choropleths, Plotly charts,
// and an interactive industry-space network. All data fetched on-demand.
// ============================================================================
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // CONFIG + STATE
  // -------------------------------------------------------------------------
  let CFG = null;
  const CACHE = new Map();
  const STATE = {
    tab: "geography",
    geo: { level: "county", metricMode: "geography", metric: "economic_complexity_percentile_score", industry: null, selectedGeo: null },
    ind: { level: "county", industry: null, metric: "industry_feasibility" },
    space: { level: "county", highlightGeo: null }
  };

  // -------------------------------------------------------------------------
  // DOM HELPERS
  // -------------------------------------------------------------------------
  const $  = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function showSpinner(on) { $("#spinner").classList.toggle("visible", !!on); }

  function showTooltip(html, x, y) {
    const t = $("#tooltip");
    t.innerHTML = html;
    t.style.display = "block";
    const rect = t.getBoundingClientRect();
    const w = window.innerWidth, h = window.innerHeight;
    let lx = x + 14, ly = y + 14;
    if (lx + rect.width  > w - 8) lx = x - rect.width  - 14;
    if (ly + rect.height > h - 8) ly = y - rect.height - 14;
    t.style.left = lx + "px"; t.style.top = ly + "px";
  }
  function hideTooltip() { $("#tooltip").style.display = "none"; }

  function fmtNum(v, d) {
    if (v === null || v === undefined || (typeof v === "number" && !isFinite(v))) return "—";
    if (typeof v !== "number") return String(v);
    return d3.format(d || ",.3f")(v);
  }
  function fmtInt(v) { return (v == null || !isFinite(v)) ? "—" : d3.format(",")(v); }
  function fmtPct(v) { return (v == null || !isFinite(v)) ? "—" : d3.format(".1f")(v) + "%"; }

  // -------------------------------------------------------------------------
  // FETCHERS
  // -------------------------------------------------------------------------
  async function fetchJson(url) {
    if (CACHE.has(url)) return CACHE.get(url);
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    const json = await r.json();
    CACHE.set(url, json);
    return json;
  }

  async function fetchCsv(url) {
    if (CACHE.has(url)) return CACHE.get(url);
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    const text = await r.text();
    const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
    CACHE.set(url, parsed.data);
    return parsed.data;
  }

  async function fetchCsvGz(url) {
    if (CACHE.has(url)) return CACHE.get(url);
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    const buf = await r.arrayBuffer();
    const text = pako.ungzip(new Uint8Array(buf), { to: "string" });
    const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
    CACHE.set(url, parsed.data);
    return parsed.data;
  }

  async function fetchJsonGz(url) {
    if (CACHE.has(url)) return CACHE.get(url);
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    const buf = await r.arrayBuffer();
    const text = pako.ungzip(new Uint8Array(buf), { to: "string" });
    const json = JSON.parse(text);
    CACHE.set(url, json);
    return json;
  }

  // -------------------------------------------------------------------------
  // META LOADERS
  // -------------------------------------------------------------------------
  async function ensureGlobalMeta() {
    if (CACHE.has("__global__")) return CACHE.get("__global__");
    const base = CFG.data_base + "meta/";
    const [industries, diagnostics] = await Promise.all([
      fetchCsv(base + "industry_titles.csv"),
      fetchCsv(base + "complexity_diagnostics.csv")
    ]);
    const meta = { industries, diagnostics };
    CACHE.set("__global__", meta);
    return meta;
  }

  async function ensureLevelMeta(level) {
    const key = "__level__" + level;
    if (CACHE.has(key)) return CACHE.get(key);
    const base = CFG.data_base + "meta/";
    const dimGeoUrl = base + "dim_geography_" + level + ".csv";
    const dimIndByLvl = base + "dim_industry_by_level_" + level + ".csv";
    const peers = (level !== "state") ? base + "peer_geography_" + level + ".csv.gz" : null;
    const nodes = (level !== "state") ? base + "industry_space_nodes_" + level + ".csv.gz" : null;
    const edges = (level !== "state") ? base + "industry_space_edges_" + level + ".csv.gz" : null;
    const tasks = [fetchCsv(dimGeoUrl), fetchCsv(dimIndByLvl)];
    if (peers) tasks.push(fetchCsvGz(peers));
    if (nodes) tasks.push(fetchCsvGz(nodes));
    if (edges) tasks.push(fetchCsvGz(edges));
    const out = await Promise.all(tasks);
    const result = {
      dimGeo: out[0] || [], dimIndByLevel: out[1] || [],
      peers:  peers ? (out[2] || []) : [],
      nodes:  nodes ? (out[3] || []) : [],
      edges:  edges ? (out[4] || []) : []
    };
    CACHE.set(key, result);
    return result;
  }

  async function ensureGeometry(level) {
    const key = "__geom__" + level;
    if (CACHE.has(key)) return CACHE.get(key);
    const base = CFG.data_base + "geo/";
    const geo = await fetchJsonGz(base + level + ".geojson.gz");
    CACHE.set(key, geo);
    return geo;
  }

  async function fetchGeoSlice(level, geoid) {
    return fetchCsvGz(CFG.data_base + "by_geography/" + level + "/" + geoid + ".csv.gz");
  }
  async function fetchIndSlice(level, industry) {
    return fetchCsvGz(CFG.data_base + "by_industry/" + level + "/" + industry + ".csv.gz");
  }

  // -------------------------------------------------------------------------
  // METRIC OPTIONS
  // -------------------------------------------------------------------------
  const GEO_METRICS = [
    { value: "economic_complexity_percentile_score", label: "Economic complexity (pctile)", invert: false },
    { value: "economic_complexity_index",            label: "Economic complexity (raw)",    invert: false },
    { value: "strategic_index",                      label: "Strategic index",              invert: false },
    { value: "strategic_index_percentile",           label: "Strategic index (pctile)",     invert: false },
    { value: "industrial_diversity",                 label: "Industrial diversity",         invert: false }
  ];
  const IND_METRIC_LABELS = {
    "industry_employment_share":              "Employment share",
    "location_quotient":                      "Location quotient",
    "industry_present":                       "Presence (binary)",
    "industry_comparative_advantage":         "Comparative advantage (binary)",
    "industry_feasibility":                   "Industry feasibility",
    "industry_feasibility_percentile_score":  "Feasibility percentile",
    "strategic_gain_possible":                "Strategic gain possible (binary)",
    "strategic_gain":                         "Strategic gain",
    "strategic_gain_percentile_score":        "Strategic gain percentile"
  };

  // -------------------------------------------------------------------------
  // COLOR SCALES
  // -------------------------------------------------------------------------
  function makeQuantileScale(values, palette) {
    const valid = values.filter(v => v !== null && v !== undefined && isFinite(v));
    if (valid.length === 0) return () => "#cccccc";
    if (valid.length < 5) {
      const min = d3.min(valid), max = d3.max(valid);
      const lin = d3.scaleLinear().domain([min, max]).range([palette[0], palette[palette.length-1]]);
      return v => (v == null || !isFinite(v)) ? "#e0e0e0" : lin(v);
    }
    const stops = palette.length === 5 ? palette : [palette[0], palette[2], palette[4], palette[6], palette[8]];
    const sc = d3.scaleQuantile().domain(valid).range(stops);
    return v => (v == null || !isFinite(v)) ? "#e0e0e0" : sc(v);
  }

  function buildLegend(scale, label, format) {
    if (!scale.quantiles) {
      return `<div class="legend-title">${label}</div><div class="muted">No variation</div>`;
    }
    const qs = scale.quantiles();
    const range = scale.range();
    const fmt = format || ((v) => fmtNum(v, ",.2f"));
    let html = `<div class="legend-title">${label}</div>`;
    for (let i = 0; i < range.length; i++) {
      const lo = i === 0 ? scale.domain()[0] : qs[i-1];
      const hi = i === range.length - 1 ? scale.domain()[scale.domain().length - 1] : qs[i];
      html += `<div class="legend-row"><span style="display:inline-block;width:18px;height:14px;background:${range[i]};border-radius:3px;vertical-align:middle"></span><span>${fmt(lo)} &ndash; ${fmt(hi)}</span></div>`;
    }
    return html;
  }

  // -------------------------------------------------------------------------
  // MAPLIBRE BUILDERS
  // -------------------------------------------------------------------------
  function blankStyle() {
    return {
      version: 8,
      sources: {},
      layers: [{ id: "bg", type: "background", paint: { "background-color": "#eef2f5" } }],
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf"
    };
  }

  function createMap(containerId) {
    const map = new maplibregl.Map({
      container: containerId,
      style: blankStyle(),
      center: [-96, 38],
      zoom: 3.2,
      attributionControl: false
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    return map;
  }

  function fitBoundsFromGeoJSON(map, geojson) {
    const bounds = new maplibregl.LngLatBounds();
    let any = false;
    geojson.features.forEach(f => {
      if (!f.geometry) return;
      const coordsList = (f.geometry.type === "MultiPolygon") ? f.geometry.coordinates.flat() : [f.geometry.coordinates];
      coordsList.forEach(poly => poly.forEach(ring => ring.forEach(c => { bounds.extend(c); any = true; })));
    });
    if (any) map.fitBounds(bounds, { padding: 30, duration: 0, maxZoom: 7 });
  }

  function colorizeFeatures(geojson, idCol, lookupMap, scale) {
    geojson.features.forEach(f => {
      const id = f.properties && f.properties[idCol];
      const v = (id != null && lookupMap.has(id)) ? lookupMap.get(id) : null;
      f.properties.__metric_value = (v == null || !isFinite(v)) ? null : v;
      f.properties.__fill = scale(v);
    });
    return geojson;
  }

  function ensureLayer(map, sourceId, layerId, geojson) {
    const src = map.getSource(sourceId);
    if (src) {
      src.setData(geojson);
      return;
    }
    map.addSource(sourceId, { type: "geojson", data: geojson, generateId: true });
    map.addLayer({
      id: layerId, type: "fill", source: sourceId,
      paint: { "fill-color": ["coalesce", ["get", "__fill"], "#cccccc"], "fill-opacity": 0.92 }
    });
    map.addLayer({
      id: layerId + "-line", type: "line", source: sourceId,
      paint: { "line-color": "#ffffff", "line-width": 0.4 }
    });
  }

  function attachHover(map, layerId, opts) {
    map.on("mousemove", layerId, e => {
      if (!e.features || !e.features.length) return;
      const f = e.features[0];
      map.getCanvas().style.cursor = "pointer";
      const html = opts.tooltip(f);
      showTooltip(html, e.originalEvent.clientX, e.originalEvent.clientY);
    });
    map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; hideTooltip(); });
    map.on("click", layerId, e => {
      if (e.features && e.features.length) opts.click(e.features[0]);
    });
  }

  // -------------------------------------------------------------------------
  // GEOGRAPHY EXPLORER TAB
  // -------------------------------------------------------------------------
  let GEO_MAP = null, IND_MAP = null;

  async function renderGeographyTab() {
    showSpinner(true);
    try {
      await ensureGlobalMeta();
      const lvl  = STATE.geo.level;
      const meta = await ensureLevelMeta(lvl);
      const geom = await ensureGeometry(lvl);
      const idCol = CFG.levels[lvl].id_col;
      const nameCol = CFG.levels[lvl].name_col;

      // Populate geography search list
      const dl = $("#geo-search-list");
      dl.innerHTML = "";
      meta.dimGeo.forEach(r => {
        if (!r || !r[idCol]) return;
        const opt = document.createElement("option");
        opt.value = (r[nameCol] || r[idCol]) + " — " + r[idCol];
        dl.appendChild(opt);
      });

      // Cards (level-wide stats)
      const ecoVals = meta.dimGeo.map(r => r.economic_complexity_index).filter(v => isFinite(v));
      const div = meta.dimGeo.map(r => r.industrial_diversity).filter(v => isFinite(v));
      $("#geo-cards").innerHTML = `
        <div class="card"><div class="card-label">Geographies</div><div class="card-value">${fmtInt(meta.dimGeo.length)}</div><div class="card-sub">${CFG.levels[lvl].label}</div></div>
        <div class="card"><div class="card-label">Median ECI</div><div class="card-value">${fmtNum(d3.median(ecoVals), ",.2f")}</div></div>
        <div class="card"><div class="card-label">Mean diversity</div><div class="card-value">${fmtNum(d3.mean(div), ",.0f")}</div></div>
        <div class="card"><div class="card-label">Industries</div><div class="card-value">${fmtInt(meta.dimIndByLevel.length)}</div></div>
      `;

      let lookupMap, metricLabel, palette = CFG.theme.seq_palette, fmt;
      if (STATE.geo.metricMode === "geography") {
        const m = STATE.geo.metric;
        const meta_def = GEO_METRICS.find(x => x.value === m) || GEO_METRICS[0];
        metricLabel = meta_def.label;
        lookupMap = new Map();
        meta.dimGeo.forEach(r => {
          const v = r[m];
          if (r[idCol] != null) lookupMap.set(r[idCol], (v != null && isFinite(v)) ? +v : null);
        });
        fmt = (v) => fmtNum(v, ",.2f");
      } else {
        // industry metric: load slice for selected industry
        const ind = STATE.geo.industry;
        if (!ind) {
          $("#geo-map-legend").innerHTML = `<div class="legend-title">Pick an industry</div><div class="muted small">Choose an industry from the sidebar.</div>`;
          showSpinner(false);
          return;
        }
        try {
          const slice = await fetchIndSlice(lvl, ind);
          lookupMap = new Map();
          slice.forEach(r => { if (r[idCol] != null) lookupMap.set(r[idCol], +r["industry_feasibility"]); });
          metricLabel = "Industry feasibility — " + ind;
          fmt = (v) => fmtNum(v, ",.3f");
        } catch (err) {
          console.warn("ind slice load failed", err);
          $("#geo-map-legend").innerHTML = `<div class="legend-title">Slice not found</div><div class="muted small">No data for industry ${ind} at ${lvl}.</div>`;
          showSpinner(false);
          return;
        }
      }

      const allVals = Array.from(lookupMap.values());
      const scale = makeQuantileScale(allVals, palette);
      const colored = colorizeFeatures(geom, idCol, lookupMap, scale);

      if (!GEO_MAP) {
        GEO_MAP = createMap("geo-map");
        GEO_MAP.on("load", () => {
          ensureLayer(GEO_MAP, "geo-src", "geo-fill", colored);
          attachHover(GEO_MAP, "geo-fill", {
            tooltip: (f) => {
              const id = f.properties[idCol];
              const dim = meta.dimGeo.find(r => r[idCol] === id) || {};
              const name = dim[nameCol] || id;
              return `<strong>${name}</strong><br><span class="muted small">${id}</span><br>${metricLabel}: <strong>${fmt(f.properties.__metric_value)}</strong>`;
            },
            click: (f) => onSelectGeography(f.properties[idCol])
          });
          fitBoundsFromGeoJSON(GEO_MAP, colored);
        });
      } else if (GEO_MAP.isStyleLoaded()) {
        ensureLayer(GEO_MAP, "geo-src", "geo-fill", colored);
        fitBoundsFromGeoJSON(GEO_MAP, colored);
      } else {
        GEO_MAP.once("load", () => {
          ensureLayer(GEO_MAP, "geo-src", "geo-fill", colored);
          fitBoundsFromGeoJSON(GEO_MAP, colored);
        });
      }

      $("#geo-map-legend").innerHTML = buildLegend(scale, metricLabel, fmt);

      if (STATE.geo.selectedGeo) await onSelectGeography(STATE.geo.selectedGeo);
    } catch (err) {
      console.error("renderGeographyTab failed:", err);
      $("#geo-summary").innerHTML = `<div class="empty"><h2>Could not load data</h2><p class="muted small">${err.message}</p></div>`;
    } finally {
      showSpinner(false);
    }
  }

  async function onSelectGeography(geoid) {
    if (!geoid) return;
    STATE.geo.selectedGeo = geoid;
    const lvl = STATE.geo.level;
    const meta = await ensureLevelMeta(lvl);
    const idCol = CFG.levels[lvl].id_col;
    const nameCol = CFG.levels[lvl].name_col;
    const dim = meta.dimGeo.find(r => r[idCol] === geoid);
    if (!dim) { $("#geo-summary").innerHTML = `<div class="muted">${geoid} not found.</div>`; return; }
    showSpinner(true);
    try {
      const slice = await fetchGeoSlice(lvl, geoid);
      const present = slice.filter(r => r.industry_present === 1 || r.industry_present === true);
      const targets = slice.filter(r => (r.industry_present === 0 || r.industry_present === false) && (r.strategic_gain > 0))
                            .sort((a, b) => (b.industry_feasibility || 0) - (a.industry_feasibility || 0))
                            .slice(0, 25);
      const topPresent = present.slice().sort((a,b) => (b.location_quotient || 0) - (a.location_quotient || 0)).slice(0, 25);
      const ind_meta = meta.dimIndByLevel;
      const titleMap = new Map(ind_meta.map(r => [String(r.industry_code), r.industry_description || ""]));
      const peers = (lvl === "state") ? [] : meta.peers.filter(r => r[idCol] === geoid).slice(0, 10);

      $("#geo-summary").innerHTML = `
        <div style="font-weight:800;font-size:18px;color:var(--blue-spruce);margin-bottom:6px">${dim[nameCol] || geoid}</div>
        <div class="muted small">${geoid}</div>
        <div class="label">Economic complexity (raw)</div><div class="val">${fmtNum(dim.economic_complexity_index, ",.2f")}</div>
        <div class="label">Economic complexity (pctile)</div><div class="val">${fmtNum(dim.economic_complexity_percentile_score, ",.1f")}</div>
        <div class="label">Strategic index</div><div class="val">${fmtNum(dim.strategic_index, ",.2f")}</div>
        <div class="label">Industrial diversity</div><div class="val">${fmtInt(dim.industrial_diversity)}</div>
        <div class="label">Industries with RCA</div><div class="val">${fmtInt(present.length)}</div>
      `;

      // top present industries table
      let h = `<div class="section-title">Top current industries by location quotient</div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Industry</th><th class="num">LQ</th><th class="num">Emp share</th><th class="num">Feasibility</th><th class="num">Strategic gain</th></tr></thead><tbody>`;
      topPresent.forEach(r => {
        h += `<tr><td>${r.industry_code}</td><td>${titleMap.get(String(r.industry_code)) || ""}</td><td class="num">${fmtNum(r.location_quotient, ",.2f")}</td><td class="num">${fmtNum(r.industry_employment_share, ",.4f")}</td><td class="num">${fmtNum(r.industry_feasibility, ",.3f")}</td><td class="num">${fmtNum(r.strategic_gain, ",.3f")}</td></tr>`;
      });
      h += "</tbody></table></div>";
      $("#geo-top-industries").innerHTML = h;

      // strategic targets
      h = `<div class="section-title">Top strategic targets (absent industries with positive strategic gain)</div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Industry</th><th class="num">Feasibility</th><th class="num">Strategic gain</th><th class="num">SG percentile</th></tr></thead><tbody>`;
      targets.forEach(r => {
        h += `<tr><td>${r.industry_code}</td><td>${titleMap.get(String(r.industry_code)) || ""}</td><td class="num">${fmtNum(r.industry_feasibility, ",.3f")}</td><td class="num">${fmtNum(r.strategic_gain, ",.3f")}</td><td class="num">${fmtNum(r.strategic_gain_percentile_score, ",.1f")}</td></tr>`;
      });
      h += "</tbody></table></div>";
      $("#geo-target-industries").innerHTML = h;

      // peers
      if (peers.length) {
        const peerCol = "peer_" + idCol;
        h = `<div class="section-title">Most similar peer geographies (Jaccard)</div>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>Rank</th><th>${CFG.levels[lvl].label}</th><th class="num">Jaccard</th></tr></thead><tbody>`;
        peers.forEach(r => {
          h += `<tr><td>${r.peer_rank}</td><td>${r.peer_name || r[peerCol]}</td><td class="num">${fmtNum(r.jaccard_similarity, ",.3f")}</td></tr>`;
        });
        h += "</tbody></table></div>";
        $("#geo-peers").innerHTML = h;
      } else { $("#geo-peers").innerHTML = ""; }

      // scatter: feasibility vs ICI
      const xs = [], ys = [], ts = [], cs = [];
      slice.forEach(r => {
        const ici = ind_meta.find(m => String(m.industry_code) === String(r.industry_code));
        if (!ici) return;
        if (!isFinite(r.industry_feasibility) || !isFinite(ici.industry_complexity)) return;
        xs.push(r.industry_feasibility);
        ys.push(ici.industry_complexity);
        ts.push(`<b>${r.industry_code}</b><br>${ici.industry_description || ""}<br>Feas: ${fmtNum(r.industry_feasibility, ",.3f")} · ICI: ${fmtNum(ici.industry_complexity, ",.2f")}<br>Present: ${r.industry_present ? "yes" : "no"}`);
        cs.push(r.industry_present ? CFG.theme.energy : CFG.theme.warm_gray);
      });
      Plotly.newPlot("geo-scatter", [{
        x: xs, y: ys, mode: "markers", type: "scattergl", text: ts, hoverinfo: "text",
        marker: { color: cs, size: 6, opacity: 0.75, line: { width: 0 } }
      }], {
        margin: { l: 60, r: 16, t: 8, b: 50 }, showlegend: false, hovermode: "closest",
        xaxis: { title: "Industry feasibility (density)", zeroline: false, gridcolor: "#eee" },
        yaxis: { title: "Industry complexity (ICI)", zeroline: false, gridcolor: "#eee" },
        plot_bgcolor: "white", paper_bgcolor: "white"
      }, { responsive: true, displayModeBar: false });

      window.location.hash = `#/regional/${lvl}/${encodeURIComponent(geoid)}`;
    } catch (err) {
      console.error(err);
      $("#geo-summary").innerHTML = `<div class="empty"><h2>Geo slice missing</h2><p class="muted small">${err.message}</p></div>`;
    } finally {
      showSpinner(false);
    }
  }

  // -------------------------------------------------------------------------
  // INDUSTRY EXPLORER TAB
  // -------------------------------------------------------------------------
  async function renderIndustryTab() {
    showSpinner(true);
    try {
      await ensureGlobalMeta();
      const lvl = STATE.ind.level;
      const meta = await ensureLevelMeta(lvl);
      const idCol = CFG.levels[lvl].id_col;
      const nameCol = CFG.levels[lvl].name_col;
      const ind = STATE.ind.industry;
      const metric = STATE.ind.metric || "industry_feasibility";

      // Populate industry datalist
      const indGlobal = CACHE.get("__global__").industries;
      const idl = $("#industry-search-list");
      idl.innerHTML = "";
      indGlobal.forEach(r => {
        if (!r || r.industry_code == null) return;
        const opt = document.createElement("option");
        opt.value = String(r.industry_code) + " — " + (r.industry_description || "");
        idl.appendChild(opt);
      });

      $("#industry-cards").innerHTML = `
        <div class="card"><div class="card-label">Geography level</div><div class="card-value">${CFG.levels[lvl].label}</div></div>
        <div class="card"><div class="card-label">Industries available</div><div class="card-value">${fmtInt(meta.dimIndByLevel.length)}</div></div>
        <div class="card"><div class="card-label">Selected industry</div><div class="card-value">${ind || "—"}</div><div class="card-sub">${ind ? (indGlobal.find(r => String(r.industry_code) === String(ind))?.industry_description || "") : ""}</div></div>
      `;

      if (!ind) {
        $("#industry-summary").innerHTML = `<div class="empty"><h2>Select an industry</h2><p class="muted small">Type or pick a code in the sidebar.</p></div>`;
        showSpinner(false);
        return;
      }

      const slice = await fetchIndSlice(lvl, ind);
      const geom = await ensureGeometry(lvl);
      const lookupMap = new Map();
      slice.forEach(r => {
        if (r[idCol] == null) return;
        const v = r[metric];
        lookupMap.set(r[idCol], (v != null && isFinite(v)) ? +v : null);
      });
      const allVals = Array.from(lookupMap.values());
      const scale = makeQuantileScale(allVals, CFG.theme.seq_palette);
      const colored = colorizeFeatures(geom, idCol, lookupMap, scale);

      if (!IND_MAP) {
        IND_MAP = createMap("industry-map");
        IND_MAP.on("load", () => {
          ensureLayer(IND_MAP, "ind-src", "ind-fill", colored);
          attachHover(IND_MAP, "ind-fill", {
            tooltip: (f) => {
              const id = f.properties[idCol];
              const dim = meta.dimGeo.find(r => r[idCol] === id) || {};
              const name = dim[nameCol] || id;
              return `<strong>${name}</strong><br><span class="muted small">${id}</span><br>${IND_METRIC_LABELS[metric] || metric}: <strong>${fmtNum(f.properties.__metric_value, ",.3f")}</strong>`;
            },
            click: (f) => {
              STATE.geo.level = lvl; STATE.geo.selectedGeo = f.properties[idCol];
              activateTab("geography"); renderGeographyTab();
            }
          });
          fitBoundsFromGeoJSON(IND_MAP, colored);
        });
      } else if (IND_MAP.isStyleLoaded()) {
        ensureLayer(IND_MAP, "ind-src", "ind-fill", colored);
        fitBoundsFromGeoJSON(IND_MAP, colored);
      } else {
        IND_MAP.once("load", () => {
          ensureLayer(IND_MAP, "ind-src", "ind-fill", colored);
          fitBoundsFromGeoJSON(IND_MAP, colored);
        });
      }
      $("#industry-map-legend").innerHTML = buildLegend(scale, IND_METRIC_LABELS[metric] || metric, v => fmtNum(v, ",.3f"));

      // top geographies for this industry
      const topGeo = slice.slice().sort((a,b) => (b.location_quotient || 0) - (a.location_quotient || 0)).slice(0, 30);
      let h = `<div class="section-title">Top geographies for this industry (by LQ)</div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>${CFG.levels[lvl].label}</th><th>GeoID</th><th class="num">LQ</th><th class="num">Emp share</th><th class="num">Feasibility</th><th class="num">Strategic gain</th></tr></thead><tbody>`;
      topGeo.forEach(r => {
        const dim = meta.dimGeo.find(d => d[idCol] === r[idCol]) || {};
        h += `<tr><td>${dim[nameCol] || ""}</td><td>${r[idCol]}</td><td class="num">${fmtNum(r.location_quotient, ",.2f")}</td><td class="num">${fmtNum(r.industry_employment_share, ",.4f")}</td><td class="num">${fmtNum(r.industry_feasibility, ",.3f")}</td><td class="num">${fmtNum(r.strategic_gain, ",.3f")}</td></tr>`;
      });
      h += "</tbody></table></div>";
      $("#industry-top-geos").innerHTML = h;

      // scatter: LQ vs feasibility across all geos for this industry
      const xs = [], ys = [], ts = [], cs = [];
      slice.forEach(r => {
        if (!isFinite(r.location_quotient) || !isFinite(r.industry_feasibility)) return;
        xs.push(r.industry_feasibility);
        ys.push(r.location_quotient);
        const dim = meta.dimGeo.find(d => d[idCol] === r[idCol]) || {};
        ts.push(`<b>${dim[nameCol] || r[idCol]}</b><br>LQ: ${fmtNum(r.location_quotient, ",.2f")} · Feas: ${fmtNum(r.industry_feasibility, ",.3f")}`);
        cs.push(r.industry_present ? CFG.theme.energy : CFG.theme.warm_gray);
      });
      Plotly.newPlot("industry-scatter", [{
        x: xs, y: ys, mode: "markers", type: "scattergl", text: ts, hoverinfo: "text",
        marker: { color: cs, size: 6, opacity: 0.75, line: { width: 0 } }
      }], {
        margin: { l: 60, r: 16, t: 8, b: 50 }, hovermode: "closest", showlegend: false,
        xaxis: { title: "Industry feasibility (density)", zeroline: false, gridcolor: "#eee" },
        yaxis: { title: "Location quotient", zeroline: false, gridcolor: "#eee", type: "log" },
        plot_bgcolor: "white", paper_bgcolor: "white"
      }, { responsive: true, displayModeBar: false });

      window.location.hash = `#/industry/${lvl}/${encodeURIComponent(ind)}`;
    } catch (err) {
      console.error("renderIndustryTab failed:", err);
      $("#industry-summary").innerHTML = `<div class="empty"><h2>Could not load data</h2><p class="muted small">${err.message}</p></div>`;
    } finally {
      showSpinner(false);
    }
  }

  // -------------------------------------------------------------------------
  // INDUSTRY SPACE TAB
  // -------------------------------------------------------------------------
  async function renderIndustrySpaceTab() {
    showSpinner(true);
    try {
      await ensureGlobalMeta();
      const lvl = STATE.space.level;
      if (lvl === "state") {
        $("#industry-space-network").innerHTML = `<div class="empty"><h2>Industry space not computed at the state level</h2><p class="muted small">Pick county, CBSA, CSA, or commuting zone.</p></div>`;
        showSpinner(false); return;
      }
      const meta = await ensureLevelMeta(lvl);
      const nodes = meta.nodes, edges = meta.edges;

      $("#space-cards").innerHTML = `
        <div class="card"><div class="card-label">Level</div><div class="card-value">${CFG.levels[lvl].label}</div></div>
        <div class="card"><div class="card-label">Nodes</div><div class="card-value">${fmtInt(nodes.length)}</div></div>
        <div class="card"><div class="card-label">Edges (top)</div><div class="card-value">${fmtInt(edges.length)}</div></div>
      `;

      let highlightSet = null;
      if (STATE.space.highlightGeo) {
        try {
          const slice = await fetchGeoSlice(lvl, STATE.space.highlightGeo);
          highlightSet = new Set(slice.filter(r => r.industry_present === 1 || r.industry_present === true).map(r => String(r.industry_code)));
        } catch (e) { console.warn("highlight slice failed", e); }
      }

      const edgeShapes = [];
      const wMax = d3.max(edges, e => e.weight) || 1;
      edges.forEach(e => {
        if (!isFinite(e.x0) || !isFinite(e.x1)) return;
        edgeShapes.push({
          type: "line", x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1,
          line: { color: "rgba(150,150,150,0.18)", width: 0.5 + 1.5 * (e.weight / wMax) },
          layer: "below"
        });
      });

      const ubMax = d3.max(nodes, n => n.ubiquity) || 1;
      const xs = nodes.map(n => n.x);
      const ys = nodes.map(n => n.y);
      const sizes = nodes.map(n => 6 + 18 * (1 - (n.ubiquity || 0) / ubMax));
      const text = nodes.map(n => `<b>${n.industry_code}</b><br>${n.industry_description || ""}<br>ICI: ${fmtNum(n.complexity, ",.2f")}<br>Ubiq: ${fmtInt(n.ubiquity)}`);

      let colors;
      if (highlightSet && highlightSet.size > 0) {
         colors = nodes.map(n => highlightSet.has(String(n.industry_code)) ? CFG.theme.energy : "#d6d6d6");
      } else {
        const cs = d3.scaleLinear().domain(d3.extent(nodes, n => n.complexity)).range([CFG.theme.seq_palette[1], CFG.theme.seq_palette[7]]);
        colors = nodes.map(n => isFinite(n.complexity) ? cs(n.complexity) : "#cccccc");
      }

      Plotly.newPlot("industry-space-network", [{
        x: xs, y: ys, mode: "markers", type: "scattergl", text, hoverinfo: "text",
        marker: { color: colors, size: sizes, line: { color: "white", width: 0.5 } }
      }], {
        margin: { l: 10, r: 10, t: 10, b: 10 },
        xaxis: { visible: false, scaleanchor: "y" },
        yaxis: { visible: false },
        shapes: edgeShapes, hovermode: "closest", showlegend: false,
        plot_bgcolor: "white", paper_bgcolor: "white"
      }, { responsive: true, displayModeBar: false });

      // Top-complexity industry table
      const sorted = nodes.slice().filter(n => isFinite(n.complexity)).sort((a,b) => b.complexity - a.complexity).slice(0, 30);
      let h = `<div class="section-title">Top-complexity industries</div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Industry</th><th class="num">ICI</th><th class="num">Ubiquity</th><th class="num">Centrality</th></tr></thead><tbody>`;
      sorted.forEach(r => {
        h += `<tr><td>${r.industry_code}</td><td>${r.industry_description || ""}</td><td class="num">${fmtNum(r.complexity, ",.2f")}</td><td class="num">${fmtInt(r.ubiquity)}</td><td class="num">${fmtNum(r.centrality, ",.4f")}</td></tr>`;
      });
      h += "</tbody></table></div>";
      $("#industry-space-table").innerHTML = h;

      window.location.hash = `#/industry-space/${lvl}`;
    } catch (err) {
      console.error(err);
      $("#industry-space-network").innerHTML = `<div class="empty"><h2>Could not render network</h2><p class="muted small">${err.message}</p></div>`;
    } finally {
      showSpinner(false);
    }
  }

  // -------------------------------------------------------------------------
  // ABOUT TAB
  // -------------------------------------------------------------------------
  async function renderAboutTab() {
    const meta = await ensureGlobalMeta();
    const d = meta.diagnostics;
    let h = `<p><strong>Pipeline ID:</strong> ${CFG.pipeline_id}</p>`;
    h += `<p><strong>Build time:</strong> ${CFG.build_time}</p>`;
    h += `<p><strong>Repo:</strong> ${CFG.owner}/${CFG.repo} (${CFG.branch})</p>`;
    h += `<p><strong>Pages URL:</strong> <a href="${CFG.pages_url}" target="_blank" rel="noopener">${CFG.pages_url}</a></p>`;
    h += `<div class="section-title">Complexity diagnostics</div>`;
    h += `<div class="table-wrap"><table class="data-table"><thead><tr>`;
    if (d.length) Object.keys(d[0]).forEach(k => h += `<th>${k}</th>`);
    h += "</tr></thead><tbody>";
    d.forEach(row => {
      h += "<tr>";
      Object.keys(d[0]).forEach(k => {
        const v = row[k];
        h += `<td class="${typeof v === "number" ? "num" : ""}">${typeof v === "number" ? fmtNum(v, ",.4f") : (v == null ? "" : v)}</td>`;
      });
      h += "</tr>";
    });
    h += "</tbody></table></div>";
    h += `<p class="small muted" style="margin-top:18px">Methods follow Daboin et al. economic complexity / industry-space construction. ECI/ICI from second eigenvector of M_tilde matrices, density-based feasibility, peer geography by Jaccard similarity over RCA vectors.</p>`;
    $("#about-content").innerHTML = h;
  }

  // -------------------------------------------------------------------------
  // SIDEBAR / TAB WIRING
  // -------------------------------------------------------------------------
  function activateTab(name) {
    STATE.tab = name;
    $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
    $$(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + name));
    ["geography", "industry", "industry-space", "about"].forEach(t => {
      const el = $("#sidebar-" + t);
      if (el) el.style.display = (t === name) ? "block" : "none";
    });
    if (name === "geography")        renderGeographyTab();
    else if (name === "industry")    renderIndustryTab();
    else if (name === "industry-space") renderIndustrySpaceTab();
    else if (name === "about")       renderAboutTab();
  }

  function populateLevelSelects() {
    const lvls = Object.keys(CFG.levels);
    [["#geo-level", STATE.geo.level], ["#ind-level", STATE.ind.level], ["#space-level", STATE.space.level]].forEach(([sel, def]) => {
      const el = $(sel);
      el.innerHTML = lvls.map(l => `<option value="${l}" ${l===def?"selected":""}>${CFG.levels[l].label}</option>`).join("");
    });
    const gm = $("#geo-metric");
    gm.innerHTML = GEO_METRICS.map(m => `<option value="${m.value}" ${m.value===STATE.geo.metric?"selected":""}>${m.label}</option>`).join("");
  }

  function parseChoice(v) {
    if (!v) return null;
    const dash = v.indexOf("—");
    return (dash > 0) ? v.substring(dash + 1).trim() : v.trim();
  }
  function parseChoiceFront(v) {
    if (!v) return null;
    const dash = v.indexOf("—");
    return (dash > 0) ? v.substring(0, dash).trim() : v.trim();
  }

  function wireUI() {
    $$(".tab-btn").forEach(b => b.addEventListener("click", () => activateTab(b.dataset.tab)));

    $("#geo-level").addEventListener("change", e => { STATE.geo.level = e.target.value; STATE.geo.selectedGeo = null; renderGeographyTab(); });
    $("#geo-metric-mode").addEventListener("change", e => {
      STATE.geo.metricMode = e.target.value;
      $("#geo-industry-controls").style.display = (e.target.value === "industry") ? "block" : "none";
    });
    $("#geo-metric").addEventListener("change", e => { STATE.geo.metric = e.target.value; });
    $("#geo-industry-code").addEventListener("change", e => { STATE.geo.industry = parseChoiceFront(e.target.value); });
    $("#geo-search").addEventListener("change", e => {
      const txt = e.target.value;
      const dash = txt.lastIndexOf("—");
      const id = (dash > 0) ? txt.substring(dash + 1).trim() : txt.trim();
      if (id) onSelectGeography(id);
    });
    $("#geo-refresh").addEventListener("click", () => renderGeographyTab());
    $("#geo-reset").addEventListener("click", () => { STATE.geo.selectedGeo = null; renderGeographyTab(); });
    $("#geo-map-reset").addEventListener("click", () => { if (GEO_MAP) GEO_MAP.flyTo({ center: [-96, 38], zoom: 3.2 }); });

    $("#ind-level").addEventListener("change", e => { STATE.ind.level = e.target.value; renderIndustryTab(); });
    $("#ind-code").addEventListener("change", e => { STATE.ind.industry = parseChoiceFront(e.target.value); });
    $("#ind-metric").addEventListener("change", e => { STATE.ind.metric = e.target.value; });
    $("#ind-refresh").addEventListener("click", () => renderIndustryTab());
    $("#ind-map-reset").addEventListener("click", () => { if (IND_MAP) IND_MAP.flyTo({ center: [-96, 38], zoom: 3.2 }); });

    $("#space-level").addEventListener("change", e => { STATE.space.level = e.target.value; renderIndustrySpaceTab(); });
    $("#space-highlight").addEventListener("change", e => {
      const txt = e.target.value;
      const dash = txt.lastIndexOf("—");
      STATE.space.highlightGeo = (dash > 0) ? txt.substring(dash + 1).trim() : txt.trim();
    });
    $("#space-refresh").addEventListener("click", () => renderIndustrySpaceTab());

    window.addEventListener("hashchange", parseHash);
  }

  function parseHash() {
    const h = window.location.hash;
    if (!h) return;
    const parts = h.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    if (parts[0] === "regional" && parts.length >= 3) {
      STATE.geo.level = parts[1]; STATE.geo.selectedGeo = parts[2]; activateTab("geography");
    } else if (parts[0] === "industry" && parts.length >= 3) {
      STATE.ind.level = parts[1]; STATE.ind.industry = parts[2]; activateTab("industry");
    } else if (parts[0] === "industry-space" && parts.length >= 2) {
      STATE.space.level = parts[1]; activateTab("industry-space");
    } else if (parts[0] === "about") activateTab("about");
  }

  // -------------------------------------------------------------------------
  // BOOT
  // -------------------------------------------------------------------------
  async function boot() {
    try {
      CFG = await fetchJson("site-config.json");
      $("#build-meta").innerHTML = `<div><strong>${CFG.pipeline_id}</strong></div><div>${CFG.build_time}</div>`;
      populateLevelSelects();
      wireUI();
      parseHash();
      if (!window.location.hash) activateTab("geography");
    } catch (err) {
      console.error("boot failed:", err);
      document.body.innerHTML = `<div style="padding:40px;font-family:Arial,sans-serif"><h1 style="color:#003B63">Could not load site config</h1><p>${err.message}</p></div>`;
    }
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
