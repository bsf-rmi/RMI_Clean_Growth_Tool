// ============================================================================
// RMI Clean Growth Tool — dashboard.js
// ============================================================================
(function () {
  "use strict";

  let CFG = null;
  const CACHE = new Map();
  const STATE = {
    tab: "home",
    geo:    { level: "county", metric: "economic_complexity_percentile_score", selectedGeo: null },
    ind:    { level: "county", industry: null, metric: "industry_feasibility" },
    et:     { level: "county", techId: null,   metric: "complexity_weighted_feasibility" },
    space:  { level: "county", highlightGeo: null },
    peers:  { level: "county", anchorGeo: null, metric: "location_quotient" }
  };

  // --- column types: keep IDs as strings, cast known numerics ---
  const ID_COLUMNS = new Set([
    "county_geoid","peer_county_geoid","state_fips","peer_state_fips",
    "cbsa_geoid","peer_cbsa_geoid","csa_geoid","peer_csa_geoid",
    "commuting_zone_geoid","peer_commuting_zone_geoid",
    "industry_code","peer_industry_code","from","to",
    "energy_tech_id","energy_tech_category","energy_tech_subcategory","safe_id",
    "geo_aggregation_name","industry_description","peer_industry_description",
    "geography_name","peer_name",
    "county_name","state_name","cbsa_name","csa_name","commuting_zone_name",
    "state_abbreviation"
  ]);
  function castRow(row) {
    const out = {};
    for (const k in row) {
      const v = row[k];
      if (v === null || v === undefined || v === "") { out[k] = null; continue; }
      if (ID_COLUMNS.has(k)) { out[k] = String(v); continue; }
      if (typeof v === "number") { out[k] = v; continue; }
      const s = String(v);
      if (s === "TRUE" || s === "True" || s === "true")  { out[k] = 1; continue; }
      if (s === "FALSE"|| s === "False"|| s === "false") { out[k] = 0; continue; }
      const n = Number(s);
      out[k] = (s !== "" && !isNaN(n) && isFinite(n)) ? n : s;
    }
    return out;
  }
  function parseCsvText(text) {
    const r = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: false });
    return r.data.map(castRow);
  }

  // --- DOM helpers ---
  const $  = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  function showSpinner(on) { $("#spinner").classList.toggle("visible", !!on); }
  function showTooltip(html, x, y) {
    const t = $("#tooltip");
    t.innerHTML = html; t.style.display = "block";
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

  // --- fetchers ---
  async function fetchJson(url) {
    if (CACHE.has(url)) return CACHE.get(url);
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    const json = await r.json(); CACHE.set(url, json); return json;
  }
  async function fetchCsv(url) {
    if (CACHE.has(url)) return CACHE.get(url);
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    const text = await r.text();
    const rows = parseCsvText(text); CACHE.set(url, rows); return rows;
  }
  async function fetchCsvGz(url) {
    if (CACHE.has(url)) return CACHE.get(url);
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    const buf = await r.arrayBuffer();
    const text = pako.ungzip(new Uint8Array(buf), { to: "string" });
    const rows = parseCsvText(text); CACHE.set(url, rows); return rows;
  }
  async function fetchJsonGz(url) {
    if (CACHE.has(url)) return CACHE.get(url);
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    const buf = await r.arrayBuffer();
    const text = pako.ungzip(new Uint8Array(buf), { to: "string" });
    const json = JSON.parse(text); CACHE.set(url, json); return json;
  }

  // --- meta + geometry ---
  async function ensureGlobalMeta() {
    if (CACHE.has("__global__")) return CACHE.get("__global__");
    const base = CFG.data_base + "meta/";
    const etBase = CFG.data_base + "energy_tech/";
    const [industries, diagnostics, et_categories, et_id_map, et_crosswalk] = await Promise.all([
      fetchCsv(base + "industry_titles.csv"),
      fetchCsv(base + "complexity_diagnostics.csv"),
      fetchCsv(etBase + "energy_tech_categories.csv"),
      fetchCsv(etBase + "energy_tech_id_map.csv"),
      fetchCsv(etBase + "energy_tech_crosswalk_long.csv")
    ]);
    const meta = { industries, diagnostics, et_categories, et_id_map, et_crosswalk };
    CACHE.set("__global__", meta); return meta;
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
    CACHE.set(key, result); return result;
  }
  async function ensureGeometry(level) {
    const key = "__geom__" + level;
    if (CACHE.has(key)) return CACHE.get(key);
    const geo = await fetchJsonGz(CFG.data_base + "geo/" + level + ".geojson.gz");
    geo.features.forEach(f => {
      if (!f.properties) return;
      ID_COLUMNS.forEach(k => {
        if (f.properties[k] != null) f.properties[k] = String(f.properties[k]);
      });
    });
    CACHE.set(key, geo); return geo;
  }
  async function ensureStateOverlay() {
    if (CACHE.has("__state_overlay__")) return CACHE.get("__state_overlay__");
    const geo = await ensureGeometry("state");
    CACHE.set("__state_overlay__", geo); return geo;
  }
  async function fetchGeoSlice(level, geoid) {
    return fetchCsvGz(CFG.data_base + "by_geography/" + level + "/" + geoid + ".csv.gz");
  }
  async function fetchIndSlice(level, industry) {
    return fetchCsvGz(CFG.data_base + "by_industry/" + level + "/" + industry + ".csv.gz");
  }
  async function fetchEnergyTechSlice(level, safeId) {
    return fetchCsvGz(CFG.data_base + "by_energy_tech/" + level + "/" + safeId + ".csv.gz");
  }

  // --- metric option lists ---
  const GEO_METRICS = [
    { value: "economic_complexity_percentile_score", label: "Economic complexity percentile" },
    { value: "economic_complexity_index",            label: "Economic complexity (raw)" },
    { value: "industrial_diversity",                 label: "Industrial diversity (count of strong industries)" }
  ];
  const SCATTER_METRICS = [
    { value: "industry_feasibility",                  label: "Industry feasibility" },
    { value: "industry_feasibility_percentile_score", label: "Industry feasibility percentile" },
    { value: "industry_complexity",                   label: "Industry complexity" },
    { value: "industry_complexity_percentile",        label: "Industry complexity percentile" },
    { value: "location_quotient",                     label: "Location quotient" },
    { value: "industry_employment_share",             label: "Industry employment share" },
    { value: "industry_ubiquity",                     label: "Industry ubiquity" }
  ];
  const IND_METRIC_LABELS = {
    "industry_employment_share":              "Industry employment share",
    "location_quotient":                      "Location quotient",
    "industry_present":                       "Industry presence",
    "industry_comparative_advantage":         "Comparative advantage",
    "industry_feasibility":                   "Industry feasibility",
    "industry_feasibility_percentile_score":  "Industry feasibility percentile"
  };
  const ET_METRIC_LABELS = {
    "complexity_weighted_feasibility":            "Complexity-weighted feasibility",
    "complexity_weighted_feasibility_percentile": "Complexity-weighted feasibility percentile",
    "mean_feasibility":                           "Mean industry feasibility",
    "share_present":                              "Share of category industries present",
    "n_present":                                  "Count of category industries present",
    "max_location_quotient":                      "Maximum location quotient in category"
  };

  // --- color scales ---
  function makeQuantileScale(values, palette) {
    const valid = values.filter(v => v !== null && v !== undefined && isFinite(v));
    const stops = palette.length === 5 ? palette : [palette[0], palette[2], palette[4], palette[6], palette[8]];
    if (valid.length === 0) {
      return { scale: () => "#cccccc", quantiles: () => [], domain: () => [0,1], range: () => stops };
    }
    if (valid.length < 5) {
      const min = d3.min(valid), max = d3.max(valid);
      const lin = d3.scaleLinear().domain([min, max]).range([palette[0], palette[palette.length-1]]);
      return { scale: v => (v == null || !isFinite(v)) ? "#e0e0e0" : lin(v), quantiles: () => [], domain: () => [min,max], range: () => stops };
    }
    const sc = d3.scaleQuantile().domain(valid).range(stops);
    const wrap = v => (v == null || !isFinite(v)) ? "#e0e0e0" : sc(v);
    return { scale: wrap, quantiles: () => sc.quantiles(), domain: () => sc.domain(), range: () => sc.range() };
  }
  function buildLegendHtml(qs, label, fmt) {
    const stops = qs.range();
    if (stops.length < 2) return `<div class="muted small">${label}</div>`;
    const breaks = qs.quantiles();
    const dom = qs.domain();
    const lo = dom[0], hi = dom[dom.length - 1];
    let html = `<div style="font-weight:700;color:#003B63">${label}</div>`;
    html += `<div class="legend-bar">`;
    stops.forEach(c => html += `<div class="legend-bar-cell" style="background:${c}"></div>`);
    html += `</div><div class="legend-stops"><span>${(fmt||fmtNum)(lo, ",.2f")}</span>`;
    breaks.forEach(b => html += `<span>${(fmt||fmtNum)(b, ",.2f")}</span>`);
    html += `<span>${(fmt||fmtNum)(hi, ",.2f")}</span></div>`;
    return html;
  }

  // --- D3 Albers USA choropleth ---
  const MAP_W = 975, MAP_H = 610;
  function projection() { return d3.geoAlbersUsa().scale(1300).translate([MAP_W/2, MAP_H/2]); }
  function renderChoropleth(svgSelector, geom, stateOverlay, idCol, lookupMap, scale, opts) {
    const svg = d3.select(svgSelector);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${MAP_W} ${MAP_H}`).attr("preserveAspectRatio","xMidYMid meet");
    const path = d3.geoPath(projection());
    const g = svg.append("g").attr("class","map-g");
    g.selectAll("path.geo-shape")
     .data(geom.features.filter(f => !!f.geometry))
     .enter().append("path")
     .attr("class","geo-shape")
     .attr("d", path)
     .attr("fill", f => {
        const id = f.properties && f.properties[idCol];
        const v = (id != null && lookupMap.has(id)) ? lookupMap.get(id) : null;
        return scale(v);
     })
     .on("mousemove", (e, f) => opts.tooltip && showTooltip(opts.tooltip(f), e.clientX, e.clientY))
     .on("mouseleave", hideTooltip)
     .on("click", (e, f) => opts.click && opts.click(f));
    if (stateOverlay) {
      g.append("g").selectAll("path.state-overlay")
         .data(stateOverlay.features.filter(f => !!f.geometry))
         .enter().append("path")
         .attr("class","state-overlay")
         .attr("d", path);
    }
    const zoom = d3.zoom().scaleExtent([1, 12]).on("zoom", (ev) => g.attr("transform", ev.transform));
    svg.call(zoom);
  }

  // --- Scatter ---
  function renderScatter(svgSelector, points, xKey, yKey, xLabel, yLabel, opts) {
    opts = opts || {};
    const svg = d3.select(svgSelector);
    svg.selectAll("*").remove();
    const w = 880, h = 440, margin = { top: 18, right: 18, bottom: 50, left: 70 };
    svg.attr("viewBox", `0 0 ${w} ${h}`).attr("preserveAspectRatio","xMidYMid meet");
    const valid = points.filter(p => p && isFinite(p[xKey]) && isFinite(p[yKey]));
    if (!valid.length) {
      svg.append("text").attr("x", w/2).attr("y", h/2).attr("text-anchor","middle").attr("fill","#999").text("No data with both axes finite.");
      return;
    }
    const xExt = d3.extent(valid, p => p[xKey]);
    const yExt = d3.extent(valid, p => p[yKey]);
    const xs = (opts.xLog && xExt[0] > 0) ? d3.scaleLog() : d3.scaleLinear();
    const ys = (opts.yLog && yExt[0] > 0) ? d3.scaleLog() : d3.scaleLinear();
    xs.domain(xExt).nice().range([margin.left, w - margin.right]);
    ys.domain(yExt).nice().range([h - margin.bottom, margin.top]);
    const g = svg.append("g");
    g.append("g").attr("transform", `translate(0,${h - margin.bottom})`).call(d3.axisBottom(xs));
    g.append("g").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(ys));
    g.append("text").attr("x", w/2).attr("y", h - 8).attr("text-anchor","middle").attr("font-size",12).attr("fill","#444").text(xLabel);
    g.append("text").attr("transform","rotate(-90)").attr("x", -h/2).attr("y", 18).attr("text-anchor","middle").attr("font-size",12).attr("fill","#444").text(yLabel);
    g.selectAll("circle").data(valid).enter().append("circle")
      .attr("cx", p => xs(p[xKey]))
      .attr("cy", p => ys(p[yKey]))
      .attr("r", 3.5)
      .attr("fill", p => p.__color || (CFG.theme.energy))
      .attr("opacity", 0.75)
      .on("mousemove", (e, p) => opts.tooltip && showTooltip(opts.tooltip(p), e.clientX, e.clientY))
      .on("mouseleave", hideTooltip);
  }

  // --- Download helpers ---
  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }
  function downloadSvg(svgEl, filename) {
    const clone = svgEl.cloneNode(true);
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const xml = new XMLSerializer().serializeToString(clone);
    downloadBlob(new Blob([xml], { type: "image/svg+xml" }), filename + ".svg");
  }
  function downloadPng(svgEl, filename, scaleN) {
    scaleN = scaleN || 2;
    const xml = new XMLSerializer().serializeToString(svgEl);
    const img = new Image();
    const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    img.onload = function () {
      const w = (svgEl.viewBox.baseVal && svgEl.viewBox.baseVal.width) || svgEl.clientWidth || 800;
      const h = (svgEl.viewBox.baseVal && svgEl.viewBox.baseVal.height) || svgEl.clientHeight || 600;
      const canvas = document.createElement("canvas");
      canvas.width = w * scaleN; canvas.height = h * scaleN;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(b => { downloadBlob(b, filename + ".png"); URL.revokeObjectURL(url); }, "image/png");
    };
    img.onerror = function () { URL.revokeObjectURL(url); console.error("png export failed"); };
    img.src = url;
  }
  function downloadCsv(rows, filename) {
    if (!rows || !rows.length) { console.warn("no rows for CSV download"); return; }
    const csv = Papa.unparse(rows);
    downloadBlob(new Blob([csv], { type: "text/csv" }), filename + ".csv");
  }
  const LAST_DATA = {};
  function setLastData(key, rows) { LAST_DATA[key] = rows; }
  function wireDownloadButtons() {
    document.body.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-target][data-kind]");
      if (!b) return;
      const target = b.getAttribute("data-target");
      const kind = b.getAttribute("data-kind");
      if (kind === "csv") { downloadCsv(LAST_DATA[target] || [], target); return; }
      const svgEl = document.getElementById(target);
      if (!svgEl) return;
      if (kind === "svg") downloadSvg(svgEl, target);
      else if (kind === "png") downloadPng(svgEl, target);
    });
  }

  // ------ HOME ------
  async function renderHomeTab() {
    showSpinner(true);
    try {
      await ensureGlobalMeta();
      // load county-level dim_geography just to show top-line stats
      const meta = await ensureLevelMeta("county");
      const ecoVals = meta.dimGeo.map(r => r.economic_complexity_index).filter(v => isFinite(v));
      const cards = [
        ["Counties",          fmtInt(meta.dimGeo.length), "Lightcast 2024 employment"],
        ["Industries (NAICS6)", fmtInt(CACHE.get("__global__").industries.length), "947 nationally observed"],
        ["Energy Tech subcategories", fmtInt(CACHE.get("__global__").et_categories.length), "Illustrative"],
        ["Median county complexity (raw)", fmtNum(d3.median(ecoVals), ",.2f"), "ECI midpoint"]
      ];
      $("#home-cards").innerHTML = cards.map(c =>
        `<div class="card"><div class="card-label">${c[0]}</div><div class="card-value">${c[1]}</div><div class="card-sub">${c[2]}</div></div>`
      ).join("");
    } catch (err) {
      console.error("home boot failed:", err);
      $("#home-cards").innerHTML = `<div class="card"><div class="card-label">Loading data</div><div class="card-value">—</div><div class="card-sub">${err.message}</div></div>`;
    } finally { showSpinner(false); }
  }

  // ------ GEOGRAPHY ------
  async function renderGeographyTab() {
    showSpinner(true);
    try {
      await ensureGlobalMeta();
      const lvl  = STATE.geo.level;
      const meta = await ensureLevelMeta(lvl);
      const geom = await ensureGeometry(lvl);
      const stateGeom = await ensureStateOverlay();
      const idCol = CFG.levels[lvl].id_col;
      const nameCol = CFG.levels[lvl].name_col;

      // populate datalist for searching
      populateGeoSearch(meta.dimGeo, idCol, nameCol);

      // cards
      const ecoVals = meta.dimGeo.map(r => r.economic_complexity_index).filter(v => isFinite(v));
      const div = meta.dimGeo.map(r => r.industrial_diversity).filter(v => isFinite(v));
      $("#geo-cards").innerHTML = `
        <div class="card"><div class="card-label">Geography level</div><div class="card-value">${CFG.levels[lvl].label}</div></div>
        <div class="card"><div class="card-label">Geographies</div><div class="card-value">${fmtInt(meta.dimGeo.length)}</div></div>
        <div class="card"><div class="card-label">Median economic complexity</div><div class="card-value">${fmtNum(d3.median(ecoVals), ",.2f")}</div></div>
        <div class="card"><div class="card-label">Mean industrial diversity</div><div class="card-value">${fmtNum(d3.mean(div), ",.0f")}</div></div>
      `;

      const m = STATE.geo.metric;
      const mDef = GEO_METRICS.find(x => x.value === m) || GEO_METRICS[0];
      const lookupMap = new Map();
      meta.dimGeo.forEach(r => {
        const v = r[m];
        if (r[idCol] != null) lookupMap.set(r[idCol], (v != null && isFinite(v)) ? +v : null);
      });
      const allVals = Array.from(lookupMap.values());
      const qs = makeQuantileScale(allVals, CFG.theme.seq_palette);

      // build state-fips -> state-name map (always county fallback gets state name)
      const stateLookup = await stateNameLookup();

      const renderCsv = meta.dimGeo.map(r => {
        const out = { ...r };
        return out;
      });
      setLastData("geo-map-data", renderCsv);

      renderChoropleth("#geo-map", geom, stateGeom, idCol, lookupMap, qs.scale, {
        tooltip: (f) => {
          const id = f.properties[idCol];
          const name = f.properties[nameCol] || id;
          const vraw = lookupMap.has(id) ? lookupMap.get(id) : null;
          let stateLine = "";
          if (lvl === "county" && id) {
            const stFips = String(id).substring(0, 2);
            const sn = stateLookup.get(stFips) || stFips;
            stateLine = `<br><span class="muted small">${sn}</span>`;
          }
          return `<strong>${name}</strong><br><span class="muted small">${id}</span>${stateLine}<br>${mDef.label}: <strong>${fmtNum(vraw, ",.2f")}</strong>`;
        },
        click: (f) => onSelectGeography(f.properties[idCol])
      });
      $("#geo-map-legend").innerHTML = buildLegendHtml(qs, mDef.label);

      if (STATE.geo.selectedGeo) await onSelectGeography(STATE.geo.selectedGeo);
      else $("#geo-summary").innerHTML = `Click a region (or use the search box) to see its profile.`;
    } catch (err) {
      console.error("renderGeographyTab failed:", err);
      $("#geo-summary").innerHTML = `<div class="empty"><h2>Could not load data</h2><p class="muted small">${err.message}</p></div>`;
    } finally { showSpinner(false); }
  }

  async function stateNameLookup() {
    if (CACHE.has("__statemap__")) return CACHE.get("__statemap__");
    const meta = await ensureLevelMeta("state");
    const m = new Map();
    meta.dimGeo.forEach(r => { if (r.state_fips) m.set(String(r.state_fips), r.state_name || r.state_fips); });
    CACHE.set("__statemap__", m); return m;
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
      const stateLookup = await stateNameLookup();
      const stateLine = (lvl === "county" && geoid) ? (`<div class="muted small">${stateLookup.get(String(geoid).substring(0,2)) || ""}</div>`) : "";
      const ind_meta = meta.dimIndByLevel;
      const titleMap = new Map(ind_meta.map(r => [String(r.industry_code), r.industry_description || ""]));
      const present = slice.filter(r => +r.industry_present === 1);
      const topPresent = present.slice().sort((a,b) => (+b.location_quotient||0) - (+a.location_quotient||0)).slice(0, 25);
      const topFeas = slice.slice().filter(r => +r.industry_present !== 1)
                     .sort((a,b) => (+b.industry_feasibility||0) - (+a.industry_feasibility||0)).slice(0, 25);

      $("#geo-summary").innerHTML = `
        <div style="font-weight:800;font-size:18px;color:var(--blue-spruce)">${dim[nameCol] || geoid}</div>
        <div class="muted small">${geoid}</div>${stateLine}
        <div class="label">Economic complexity (raw)</div><div class="val">${fmtNum(dim.economic_complexity_index, ",.2f")}</div>
        <div class="label">Economic complexity percentile</div><div class="val">${fmtNum(dim.economic_complexity_percentile_score, ",.1f")}</div>
        <div class="label">Industrial diversity</div><div class="val">${fmtInt(dim.industrial_diversity)}</div>
        <div class="label">Industries with revealed comparative advantage</div><div class="val">${fmtInt(present.length)}</div>
      `;

      // Top current industries by location quotient
      let h = `<div class="section-title">Top current industries by location quotient</div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Industry code</th><th>Industry description</th><th class="num">Location quotient</th><th class="num">Industry employment share</th><th class="num">Industry feasibility</th></tr></thead><tbody>`;
      topPresent.forEach(r => {
        h += `<tr><td>${r.industry_code}</td><td>${titleMap.get(String(r.industry_code)) || ""}</td><td class="num">${fmtNum(r.location_quotient, ",.2f")}</td><td class="num">${fmtNum(r.industry_employment_share, ",.4f")}</td><td class="num">${fmtNum(r.industry_feasibility, ",.3f")}</td></tr>`;
      });
      h += "</tbody></table></div>";
      $("#geo-top-industries").innerHTML = h;
      setLastData("geo-top-industries-data", topPresent);

      // Top feasibility (absent) industries
      h = `<div class="section-title">Top feasibility industries that are not yet present</div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Industry code</th><th>Industry description</th><th class="num">Industry feasibility</th><th class="num">Industry feasibility percentile</th></tr></thead><tbody>`;
      topFeas.forEach(r => {
        h += `<tr><td>${r.industry_code}</td><td>${titleMap.get(String(r.industry_code)) || ""}</td><td class="num">${fmtNum(r.industry_feasibility, ",.3f")}</td><td class="num">${fmtNum(r.industry_feasibility_percentile_score, ",.1f")}</td></tr>`;
      });
      h += "</tbody></table></div>";
      $("#geo-target-industries").innerHTML = h;
      setLastData("geo-target-industries-data", topFeas);

      // scatter — defaults: feasibility (x) vs industry_complexity (y)
      const points = [];
      slice.forEach(r => {
        const ici = ind_meta.find(m => String(m.industry_code) === String(r.industry_code));
        if (!ici) return;
        points.push({
          ...r,
          industry_complexity:            ici.industry_complexity,
          industry_complexity_percentile: ici.industry_complexity_percentile,
          industry_ubiquity:              ici.industry_ubiquity,
          __color: (+r.industry_present === 1) ? CFG.theme.energy : CFG.theme.warm_gray
        });
      });
      setLastData("geo-scatter-data", points);

      const xKey = $("#geo-scatter-x").value;
      const yKey = $("#geo-scatter-y").value;
      const xLab = (SCATTER_METRICS.find(m => m.value === xKey) || {}).label || xKey;
      const yLab = (SCATTER_METRICS.find(m => m.value === yKey) || {}).label || yKey;
      renderScatter("#geo-scatter", points, xKey, yKey, xLab, yLab, {
        tooltip: p => `<b>${p.industry_code}</b><br>${titleMap.get(String(p.industry_code)) || ""}<br>${xLab}: ${fmtNum(p[xKey], ",.3f")}<br>${yLab}: ${fmtNum(p[yKey], ",.3f")}`
      });

      // history hash (without auto-routing on next load)
      window.history.replaceState({}, "", `#/regional/${lvl}/${encodeURIComponent(geoid)}`);
    } catch (err) {
      console.error(err);
      $("#geo-summary").innerHTML = `<div class="empty"><h2>Geo slice missing</h2><p class="muted small">${err.message}</p></div>`;
    } finally { showSpinner(false); }
  }

  // ------ INDUSTRY ------
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

      // populate industry datalist
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
        $("#industry-summary").innerHTML = `<div class="empty"><h2>Select an industry</h2><p class="muted small">Type or pick a code in the sidebar, then update the map.</p></div>`;
        return;
      }

      const slice = await fetchIndSlice(lvl, ind);
      const geom = await ensureGeometry(lvl);
      const stateGeom = await ensureStateOverlay();
      const lookupMap = new Map();
      slice.forEach(r => {
        if (r[idCol] == null) return;
        const v = r[metric];
        lookupMap.set(r[idCol], (v != null && isFinite(v)) ? +v : null);
      });
      const allVals = Array.from(lookupMap.values());
      const qs = makeQuantileScale(allVals, CFG.theme.seq_palette);
      setLastData("industry-map-data", slice);

      const stateLookup = await stateNameLookup();
      const indDesc = (indGlobal.find(r => String(r.industry_code) === String(ind))?.industry_description) || "";
      $("#industry-summary").innerHTML = `
        <div style="font-weight:800;font-size:18px;color:var(--blue-spruce)">${ind}</div>
        <div>${indDesc}</div>
        <div class="label">Map metric</div><div class="val">${IND_METRIC_LABELS[metric] || metric}</div>
        <div class="label">Geographies in slice</div><div class="val">${fmtInt(slice.length)}</div>
      `;

      renderChoropleth("#industry-map", geom, stateGeom, idCol, lookupMap, qs.scale, {
        tooltip: (f) => {
          const id = f.properties[idCol];
          const name = f.properties[nameCol] || id;
          const vraw = lookupMap.has(id) ? lookupMap.get(id) : null;
          let stateLine = "";
          if (lvl === "county" && id) {
            const stFips = String(id).substring(0, 2);
            stateLine = `<br><span class="muted small">${stateLookup.get(stFips) || stFips}</span>`;
          }
          return `<strong>${name}</strong><br><span class="muted small">${id}</span>${stateLine}<br>${IND_METRIC_LABELS[metric] || metric}: <strong>${fmtNum(vraw, ",.3f")}</strong>`;
        },
        click: (f) => {
          STATE.geo.level = lvl; STATE.geo.selectedGeo = f.properties[idCol];
          activateTab("geography"); renderGeographyTab();
        }
      });
      $("#industry-map-legend").innerHTML = buildLegendHtml(qs, IND_METRIC_LABELS[metric] || metric, v => fmtNum(v, ",.3f"));

      // top geographies by location quotient
      const topGeo = slice.slice().sort((a,b) => (+b.location_quotient||0) - (+a.location_quotient||0)).slice(0, 30);
      let h = `<div class="section-title">Top geographies for this industry by location quotient</div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>${CFG.levels[lvl].label}</th><th>Geo identifier</th><th class="num">Location quotient</th><th class="num">Industry employment share</th><th class="num">Industry feasibility</th></tr></thead><tbody>`;
      topGeo.forEach(r => {
        const dim = meta.dimGeo.find(d => d[idCol] === r[idCol]) || {};
        h += `<tr><td>${dim[nameCol] || ""}</td><td>${r[idCol]}</td><td class="num">${fmtNum(r.location_quotient, ",.2f")}</td><td class="num">${fmtNum(r.industry_employment_share, ",.4f")}</td><td class="num">${fmtNum(r.industry_feasibility, ",.3f")}</td></tr>`;
      });
      h += "</tbody></table></div>";
      $("#industry-top-geos").innerHTML = h;
      setLastData("industry-top-geos-data", topGeo);

      // industry scatter
      const points = slice.map(r => {
        const dim = meta.dimGeo.find(d => d[idCol] === r[idCol]) || {};
        return {
          ...r,
          name: dim[nameCol] || r[idCol],
          economic_complexity_index: dim.economic_complexity_index,
          economic_complexity_percentile_score: dim.economic_complexity_percentile_score,
          industrial_diversity: dim.industrial_diversity,
          __color: (+r.industry_present === 1) ? CFG.theme.energy : CFG.theme.warm_gray
        };
      });
      setLastData("industry-scatter-data", points);
      const xKey = $("#ind-scatter-x").value;
      const yKey = $("#ind-scatter-y").value;
      const xLab = (SCATTER_METRICS.find(m => m.value === xKey) || {label:xKey}).label;
      const yLab = (SCATTER_METRICS.find(m => m.value === yKey) || {label:yKey}).label;
      renderScatter("#industry-scatter", points, xKey, yKey, xLab, yLab, {
        tooltip: p => `<b>${p.name}</b><br>${p[idCol]}<br>${xLab}: ${fmtNum(p[xKey], ",.3f")}<br>${yLab}: ${fmtNum(p[yKey], ",.3f")}`
      });

      window.history.replaceState({}, "", `#/industry/${lvl}/${encodeURIComponent(ind)}`);
    } catch (err) {
      console.error("renderIndustryTab failed:", err);
      $("#industry-summary").innerHTML = `<div class="empty"><h2>Could not load data</h2><p class="muted small">${err.message}</p></div>`;
    } finally { showSpinner(false); }
  }

  // ------ ENERGY TECH ------
  async function renderEnergyTechTab() {
    showSpinner(true);
    try {
      await ensureGlobalMeta();
      const global = CACHE.get("__global__");
      const lvl = STATE.et.level;
      const meta = await ensureLevelMeta(lvl);
      const idCol = CFG.levels[lvl].id_col;
      const nameCol = CFG.levels[lvl].name_col;
      const techId = STATE.et.techId;
      const metric = STATE.et.metric || "complexity_weighted_feasibility";
      // populate selector
      const techSel = $("#et-tech");
      if (!techSel.dataset.populated) {
        techSel.innerHTML = global.et_categories.map(r => {
          const id = String(r.energy_tech_category) + " | " + String(r.energy_tech_subcategory);
          return `<option value="${id}">${id}</option>`;
        }).join("");
        techSel.dataset.populated = "1";
      }
      // default tech
      if (!techId) {
        STATE.et.techId = techSel.value || (global.et_categories[0].energy_tech_category + " | " + global.et_categories[0].energy_tech_subcategory);
        techSel.value = STATE.et.techId;
      }

      $("#et-cards").innerHTML = `
        <div class="card"><div class="card-label">Geography level</div><div class="card-value">${CFG.levels[lvl].label}</div></div>
        <div class="card"><div class="card-label">Energy technology</div><div class="card-value">${STATE.et.techId}</div><div class="card-sub">Illustrative crosswalk</div></div>
        <div class="card"><div class="card-label">Map metric</div><div class="card-value">${ET_METRIC_LABELS[metric] || metric}</div></div>
      `;

      // resolve safe id
      const idMap = global.et_id_map;
      const safeRow = idMap.find(r => r.energy_tech_id === STATE.et.techId);
      if (!safeRow) {
        $("#et-summary").innerHTML = `<div class="empty"><h2>Technology not found</h2><p class="muted small">${STATE.et.techId}</p></div>`;
        return;
      }
      const techRows = await fetchEnergyTechSlice(lvl, safeRow.safe_id);
      const geom = await ensureGeometry(lvl);
      const stateGeom = await ensureStateOverlay();
      const lookupMap = new Map();
      techRows.forEach(r => {
        if (r[idCol] == null) return;
        const v = r[metric];
        lookupMap.set(r[idCol], (v != null && isFinite(v)) ? +v : null);
      });
      const qs = makeQuantileScale(Array.from(lookupMap.values()), CFG.theme.seq_palette);
      setLastData("et-map-data", techRows);

      const stateLookup = await stateNameLookup();
      renderChoropleth("#et-map", geom, stateGeom, idCol, lookupMap, qs.scale, {
        tooltip: (f) => {
          const id = f.properties[idCol];
          const name = f.properties[nameCol] || id;
          const vraw = lookupMap.has(id) ? lookupMap.get(id) : null;
          let stateLine = "";
          if (lvl === "county" && id) stateLine = `<br><span class="muted small">${stateLookup.get(String(id).substring(0,2)) || ""}</span>`;
          return `<strong>${name}</strong><br><span class="muted small">${id}</span>${stateLine}<br>${ET_METRIC_LABELS[metric] || metric}: <strong>${fmtNum(vraw, ",.3f")}</strong>`;
        },
        click: (f) => {
          STATE.geo.level = lvl; STATE.geo.selectedGeo = f.properties[idCol];
          activateTab("geography"); renderGeographyTab();
        }
      });
      $("#et-map-legend").innerHTML = buildLegendHtml(qs, ET_METRIC_LABELS[metric] || metric, v => fmtNum(v, ",.3f"));

      // top geographies for this tech
      const topGeo = techRows.slice().sort((a,b) => (+b[metric]||0) - (+a[metric]||0)).slice(0, 30);
      let h = `<div class="section-title">Top ${CFG.levels[lvl].label.toLowerCase()}s for ${STATE.et.techId}</div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>${CFG.levels[lvl].label}</th><th>Geo identifier</th><th class="num">Complexity-weighted feasibility</th><th class="num">Mean industry feasibility</th><th class="num">Industries present</th><th class="num">Share present</th></tr></thead><tbody>`;
      topGeo.forEach(r => {
        const dim = meta.dimGeo.find(d => d[idCol] === r[idCol]) || {};
        h += `<tr><td>${dim[nameCol] || ""}</td><td>${r[idCol]}</td><td class="num">${fmtNum(r.complexity_weighted_feasibility, ",.3f")}</td><td class="num">${fmtNum(r.mean_feasibility, ",.3f")}</td><td class="num">${fmtInt(r.n_present)} / ${fmtInt(r.n_industries)}</td><td class="num">${fmtNum(100 * (r.share_present || 0), ",.1f")}%</td></tr>`;
      });
      h += "</tbody></table></div>";
      $("#et-top-geos").innerHTML = h;
      setLastData("et-top-geos-data", topGeo);

      // industries in this tech category
      const cwRows = global.et_crosswalk.filter(r => (r.energy_tech_category + " | " + r.energy_tech_subcategory) === STATE.et.techId);
      h = `<div class="section-title">Industries mapped to ${STATE.et.techId}</div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Industry code</th><th>Industry description</th></tr></thead><tbody>`;
      cwRows.forEach(r => h += `<tr><td>${r.industry_code}</td><td>${r.industry_description || ""}</td></tr>`);
      h += "</tbody></table></div>";
      $("#et-top-industries").innerHTML = h;

      window.history.replaceState({}, "", `#/energy-tech/${lvl}/${encodeURIComponent(STATE.et.techId)}`);
    } catch (err) {
      console.error("renderEnergyTechTab failed:", err);
      $("#et-summary").innerHTML = `<div class="empty"><h2>Could not load data</h2><p class="muted small">${err.message}</p></div>`;
    } finally { showSpinner(false); }
  }

  // ------ INDUSTRY SPACE ------
  async function renderIndustrySpaceTab() {
    showSpinner(true);
    try {
      await ensureGlobalMeta();
      const lvl = STATE.space.level;
      if (lvl === "state") {
        d3.select("#industry-space-network").selectAll("*").remove();
        $("#industry-space-table").innerHTML = `<div class="empty"><h2>Industry space not computed at the state level</h2><p class="muted small">Pick county, metro area, combined statistical area, or commuting zone.</p></div>`;
        $("#space-cards").innerHTML = "";
        return;
      }
      const meta = await ensureLevelMeta(lvl);
      const nodes = meta.nodes, edges = meta.edges;

      $("#space-cards").innerHTML = `
        <div class="card"><div class="card-label">Geography level</div><div class="card-value">${CFG.levels[lvl].label}</div></div>
        <div class="card"><div class="card-label">Nodes (industries)</div><div class="card-value">${fmtInt(nodes.length)}</div></div>
        <div class="card"><div class="card-label">Edges (top connections)</div><div class="card-value">${fmtInt(edges.length)}</div></div>
      `;

      let highlightSet = null;
      if (STATE.space.highlightGeo) {
        try {
          const slice = await fetchGeoSlice(lvl, STATE.space.highlightGeo);
          highlightSet = new Set(slice.filter(r => +r.industry_present === 1).map(r => String(r.industry_code)));
        } catch (e) { console.warn("highlight slice failed", e); }
      }

      const svg = d3.select("#industry-space-network");
      svg.selectAll("*").remove();
      const W = 1100, H = 720;
      svg.attr("viewBox", `0 0 ${W} ${H}`).attr("preserveAspectRatio","xMidYMid meet");
      const g = svg.append("g");

      const xVals = nodes.map(n => +n.x).filter(v => isFinite(v));
      const yVals = nodes.map(n => +n.y).filter(v => isFinite(v));
      const xs = d3.scaleLinear().domain(d3.extent(xVals)).nice().range([20, W - 20]);
      const ys = d3.scaleLinear().domain(d3.extent(yVals)).nice().range([H - 20, 20]);
      const ubExt = d3.extent(nodes.map(n => +n.ubiquity || 0));
      const sizeScale = d3.scaleLinear().domain(ubExt).range([8, 2.5]); // smaller node = more ubiquitous

      const compExt = d3.extent(nodes.map(n => +n.complexity).filter(v => isFinite(v)));
      const colorScale = d3.scaleSequential(d3.interpolateMagma).domain(compExt);

      // edges
      const wMax = d3.max(edges, e => +e.weight) || 1;
      g.append("g").selectAll("line.edge")
        .data(edges.filter(e => isFinite(+e.x0) && isFinite(+e.x1)))
        .enter().append("line")
        .attr("x1", e => xs(+e.x0)).attr("y1", e => ys(+e.y0))
        .attr("x2", e => xs(+e.x1)).attr("y2", e => ys(+e.y1))
        .attr("stroke", "#aaaaaa")
        .attr("stroke-opacity", 0.25)
        .attr("stroke-width", e => 0.4 + 1.2 * (+e.weight / wMax));

      // nodes
      g.append("g").selectAll("circle.node")
        .data(nodes.filter(n => isFinite(+n.x)))
        .enter().append("circle")
        .attr("class","node")
        .attr("cx", n => xs(+n.x))
        .attr("cy", n => ys(+n.y))
        .attr("r", n => Math.max(2.5, sizeScale(+n.ubiquity || 0)))
        .attr("fill", n => {
          if (highlightSet && highlightSet.size > 0)
            return highlightSet.has(String(n.industry_code)) ? CFG.theme.energy : "#dddddd";
          return isFinite(+n.complexity) ? colorScale(+n.complexity) : "#cccccc";
        })
        .attr("stroke", "#fff").attr("stroke-width", 0.6)
        .attr("opacity", n => (highlightSet && !highlightSet.has(String(n.industry_code))) ? 0.45 : 0.92)
        .on("mousemove", (e, n) => showTooltip(`<b>${n.industry_code}</b><br>${n.industry_description || ""}<br>Industry complexity: ${fmtNum(+n.complexity, ",.2f")}<br>Ubiquity: ${fmtInt(+n.ubiquity)}`, e.clientX, e.clientY))
        .on("mouseleave", hideTooltip);

      const zoom = d3.zoom().scaleExtent([1, 8]).on("zoom", (ev) => g.attr("transform", ev.transform));
      svg.call(zoom);

      // top complexity table
      const sorted = nodes.slice().filter(n => isFinite(+n.complexity)).sort((a,b) => +b.complexity - +a.complexity).slice(0, 30);
      let h = `<div class="section-title">Top-complexity industries</div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Industry code</th><th>Industry description</th><th class="num">Industry complexity</th><th class="num">Industry ubiquity</th></tr></thead><tbody>`;
      sorted.forEach(r => {
        h += `<tr><td>${r.industry_code}</td><td>${r.industry_description || ""}</td><td class="num">${fmtNum(+r.complexity, ",.2f")}</td><td class="num">${fmtInt(+r.ubiquity)}</td></tr>`;
      });
      h += "</tbody></table></div>";
      $("#industry-space-table").innerHTML = h;
      setLastData("industry-space-table-data", sorted);

      window.history.replaceState({}, "", `#/industry-space/${lvl}`);
    } catch (err) {
      console.error(err);
      $("#industry-space-table").innerHTML = `<div class="empty"><h2>Could not render network</h2><p class="muted small">${err.message}</p></div>`;
    } finally { showSpinner(false); }
  }

  // ------ PEERS & HEATMAPS ------
  async function renderPeersHeatmapTab() {
    showSpinner(true);
    try {
      await ensureGlobalMeta();
      const lvl = STATE.peers.level;
      if (lvl === "state") {
        $("#peers-list-table").innerHTML = `<div class="empty"><h2>Peer comparisons not computed at the state level</h2><p class="muted small">Pick county, metro area, combined statistical area, or commuting zone.</p></div>`;
        d3.select("#peers-heatmap").selectAll("*").remove();
        return;
      }
      const meta = await ensureLevelMeta(lvl);
      const idCol = CFG.levels[lvl].id_col;
      const peerCol = "peer_" + idCol;
      const nameCol = CFG.levels[lvl].name_col;
      const anchor = STATE.peers.anchorGeo;
      const metric = STATE.peers.metric;
      $("#peers-cards").innerHTML = `
        <div class="card"><div class="card-label">Geography level</div><div class="card-value">${CFG.levels[lvl].label}</div></div>
        <div class="card"><div class="card-label">Anchor</div><div class="card-value">${anchor || "—"}</div></div>
        <div class="card"><div class="card-label">Heatmap metric</div><div class="card-value">${IND_METRIC_LABELS[metric] || metric}</div></div>
      `;
      if (!anchor) {
        $("#peers-list-table").innerHTML = `<div class="empty"><h2>Pick an anchor geography</h2><p class="muted small">Type a name and pick from the list to see its top peers and an industry-concentration heatmap.</p></div>`;
        d3.select("#peers-heatmap").selectAll("*").remove();
        return;
      }
      const peers = meta.peers.filter(r => r[idCol] === anchor).slice(0, 8);
      let h = `<div class="table-wrap"><table class="data-table"><thead><tr><th>Rank</th><th>${CFG.levels[lvl].label}</th><th>Identifier</th><th class="num">Jaccard similarity</th></tr></thead><tbody>`;
      peers.forEach(p => h += `<tr><td>${p.peer_rank}</td><td>${p.peer_name || p[peerCol]}</td><td>${p[peerCol]}</td><td class="num">${fmtNum(p.jaccard_similarity, ",.3f")}</td></tr>`);
      h += "</tbody></table></div>";
      $("#peers-list-table").innerHTML = h;
      setLastData("peers-list-data", peers);

      // load slices for anchor + peers, take top union of industries
      const focus = [anchor].concat(peers.map(p => p[peerCol]));
      const sliceMap = new Map();
      for (const g of focus) {
        try { sliceMap.set(g, await fetchGeoSlice(lvl, g)); } catch (e) { sliceMap.set(g, []); }
      }
      // pick top industries by anchor location_quotient
      const anchorSlice = sliceMap.get(anchor) || [];
      const topInds = anchorSlice.slice().sort((a,b) => (+b.location_quotient||0) - (+a.location_quotient||0)).slice(0, 30);
      const indCodes = topInds.map(r => r.industry_code);
      const titleMap = new Map(meta.dimIndByLevel.map(r => [String(r.industry_code), r.industry_description || ""]));

      // build heatmap data
      const heatRows = [];
      focus.forEach(g => {
        const dim = meta.dimGeo.find(d => d[idCol] === g) || {};
        const slc = sliceMap.get(g) || [];
        indCodes.forEach(ic => {
          const cell = slc.find(r => String(r.industry_code) === String(ic));
          const v = cell ? +cell[metric] : null;
          heatRows.push({
            geo: g, geo_name: dim[nameCol] || g,
            industry_code: ic, industry_description: titleMap.get(String(ic)) || "",
            value: (v != null && isFinite(v)) ? v : null
          });
        });
      });
      setLastData("peers-heatmap-data", heatRows);

      // render heatmap
      const svg = d3.select("#peers-heatmap");
      svg.selectAll("*").remove();
      const cols = focus, rows = indCodes;
      const cellW = 70, cellH = 18;
      const margin = { top: 110, left: 280, right: 20, bottom: 20 };
      const W = margin.left + cols.length * cellW + margin.right;
      const H = margin.top + rows.length * cellH + margin.bottom;
      svg.attr("viewBox", `0 0 ${W} ${H}`).attr("preserveAspectRatio","xMinYMin meet").style("min-height", H + "px");
      const valid = heatRows.map(r => r.value).filter(v => v != null && isFinite(v));
      const qs = makeQuantileScale(valid, CFG.theme.seq_palette);
      // column labels
      cols.forEach((c, i) => {
        const dim = meta.dimGeo.find(d => d[idCol] === c) || {};
        const isAnchor = (c === anchor);
        svg.append("text")
          .attr("x", margin.left + i * cellW + cellW / 2).attr("y", margin.top - 8)
          .attr("text-anchor", "end").attr("font-size", 11).attr("font-weight", isAnchor ? 800 : 500)
          .attr("transform", `rotate(-50, ${margin.left + i * cellW + cellW / 2}, ${margin.top - 8})`)
          .text((dim[nameCol] || c) + (isAnchor ? " (anchor)" : ""));
      });
      // row labels
      rows.forEach((ic, j) => {
        svg.append("text")
          .attr("x", margin.left - 6).attr("y", margin.top + j * cellH + cellH * 0.7)
          .attr("text-anchor", "end").attr("font-size", 11)
          .text(ic + " — " + (titleMap.get(String(ic)) || "").substring(0, 32));
      });
      // cells
      svg.append("g").selectAll("rect.heatmap-cell")
        .data(heatRows).enter().append("rect").attr("class","heatmap-cell")
        .attr("x", d => margin.left + cols.indexOf(d.geo) * cellW)
        .attr("y", d => margin.top + rows.indexOf(d.industry_code) * cellH)
        .attr("width", cellW - 1).attr("height", cellH - 1)
        .attr("fill", d => d.value == null ? "#eeeeee" : qs.scale(d.value))
        .on("mousemove", (e, d) => showTooltip(`<b>${d.geo_name}</b><br>${d.industry_code} ${d.industry_description}<br>${IND_METRIC_LABELS[metric] || metric}: <strong>${fmtNum(d.value, ",.3f")}</strong>`, e.clientX, e.clientY))
        .on("mouseleave", hideTooltip);

      window.history.replaceState({}, "", `#/peers/${lvl}/${encodeURIComponent(anchor)}`);
    } catch (err) {
      console.error(err);
      $("#peers-list-table").innerHTML = `<div class="empty"><h2>Could not load peers</h2><p class="muted small">${err.message}</p></div>`;
    } finally { showSpinner(false); }
  }

  // ------ ABOUT ------
  async function renderAboutTab() {
    const meta = await ensureGlobalMeta();
    const cw = meta.et_crosswalk;
    const cats = meta.et_categories;
    // build crosswalk display: rows = NAICS + description, cols = (category | subcategory) ordered
    const sortedCats = cats.slice().sort((a,b) => (a.energy_tech_category + " | " + a.energy_tech_subcategory).localeCompare(b.energy_tech_category + " | " + b.energy_tech_subcategory));
    const naicsList = Array.from(new Set(cw.map(r => r.industry_code))).sort();
    const naicsDescMap = new Map(cw.map(r => [String(r.industry_code), r.industry_description || ""]));
    const cwSet = new Set(cw.map(r => r.industry_code + "||" + r.energy_tech_category + "||" + r.energy_tech_subcategory));

    let h = `
<div class="about-section">
  <h2>Methodology</h2>
  <p>The Clean Growth Tool follows the Daboin et al. economic-complexity workflow applied to county-by-NAICS6 employment from Lightcast (2024). The pipeline computes specialization patterns, an industry space, and feasibility for currently-absent industries, then aggregates the data to states, metro areas, combined statistical areas, and commuting zones.</p>
  <h3>Specialization (RCA / location quotient)</h3>
  <div class="formula">RCA(g, i) = (employment(g, i) / employment(g)) / (employment(*, i) / employment(*))</div>
  <p>A geography <em>g</em> is considered specialized in industry <em>i</em> when RCA ≥ 1.</p>
  <h3>Economic complexity</h3>
  <p>Building on the binary M_ci matrix (1 if RCA ≥ 1 and 0 otherwise), economic complexity index (ECI) for geographies and industry complexity index (ICI) for industries are derived from the second eigenvector of the row-normalized M_tilde matrices. We anchor sign so ECI correlates positively with the average ICI of present industries.</p>
  <h3>Industry space</h3>
  <p>The industry space network places industries close together when they tend to be co-located. The proximity between industries i and j is</p>
  <div class="formula">phi(i, j) = U(i, j) / max(U(i, i), U(j, j))</div>
  <p>where U is the co-occurrence matrix of pairs of industries each having RCA ≥ 1 in the same geography. Industry feasibility for a geography is the density of present industries among each industry’s neighbors in this network.</p>
  <h3>Peer geographies</h3>
  <p>Peer similarity is the Jaccard overlap of two geographies’ specialization vectors (the sets of industries with RCA ≥ 1).</p>
  <h3>Energy Technology aggregation</h3>
  <p>For each (geography, energy-technology subcategory) pair we compute a complexity-weighted average feasibility:</p>
  <div class="formula">CWF(g, t) = sum_i [ feasibility(g, i) · w_i · X(i, t) ] / sum_i [ w_i · X(i, t) ]</div>
  <p>where X(i, t) is the crosswalk indicator (1 if industry i is mapped to subcategory t, 0 otherwise) and w_i = ICI_i − min_i(ICI) + 1 is a positive weight derived from industry complexity. Higher complexity industries get more weight in the average.</p>
  <div class="callout"><strong>Important:</strong> The Energy Technology crosswalk shown below is illustrative and substantively under refinement. Mappings are draft and not authoritative.</div>
</div>
<div class="about-section">
  <h2>Energy Technology Industry Crosswalk (illustrative, draft)</h2>
  <p class="small muted">Each row is a six-digit NAICS industry; each column is an energy-technology subcategory. Filled cells indicate that the industry is mapped to that subcategory in this draft crosswalk.</p>
  <div style="overflow:auto;max-height:680px"><table class="crosswalk-table"><thead><tr><th class="row-head">NAICS / industry</th>`;
    sortedCats.forEach(c => {
      h += `<th title="${c.energy_tech_category} | ${c.energy_tech_subcategory}">${c.energy_tech_category} | ${c.energy_tech_subcategory}</th>`;
    });
    h += `</tr></thead><tbody>`;
    naicsList.forEach(nc => {
      h += `<tr><td class="first">${nc} — ${naicsDescMap.get(String(nc)) || ""}</td>`;
      sortedCats.forEach(c => {
        const key = String(nc) + "||" + c.energy_tech_category + "||" + c.energy_tech_subcategory;
        const cls = cwSet.has(key) ? ("true" + (c.energy_tech_subcategory === "deployment" ? " deployment" : "")) : "";
        h += `<td class="${cls}"></td>`;
      });
      h += `</tr>`;
    });
    h += `</tbody></table></div></div>
<div class="about-section">
  <h2>Pipeline diagnostics</h2>
  <div class="table-wrap"><table class="data-table"><thead><tr>`;
    if (meta.diagnostics.length) Object.keys(meta.diagnostics[0]).forEach(k => h += `<th>${k}</th>`);
    h += `</tr></thead><tbody>`;
    meta.diagnostics.forEach(row => {
      h += "<tr>";
      Object.keys(meta.diagnostics[0]).forEach(k => {
        const v = row[k];
        h += `<td class="${typeof v === "number" ? "num" : ""}">${typeof v === "number" ? fmtNum(v, ",.4f") : (v == null ? "" : v)}</td>`;
      });
      h += "</tr>";
    });
    h += "</tbody></table></div></div>";
    $("#about-content").innerHTML = h;
  }

  // ------ TAB ACTIVATION ------
  function activateTab(name) {
    STATE.tab = name;
    $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
    $$(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + name));
    ["home","geography","industry","energy-tech","industry-space","peers","about"].forEach(t => {
      const el = $("#sidebar-" + t);
      if (el) el.style.display = (t === name) ? "block" : "none";
    });
    if (name === "home")              renderHomeTab();
    else if (name === "geography")    renderGeographyTab();
    else if (name === "industry")     renderIndustryTab();
    else if (name === "energy-tech")  renderEnergyTechTab();
    else if (name === "industry-space") renderIndustrySpaceTab();
    else if (name === "peers")        renderPeersHeatmapTab();
    else if (name === "about")        renderAboutTab();
  }

  function populateLevelSelects() {
    const lvls = Object.keys(CFG.levels);
    const opts = (def) => lvls.map(l => `<option value="${l}" ${l===def?"selected":""}>${CFG.levels[l].label}</option>`).join("");
    $("#geo-level").innerHTML   = opts(STATE.geo.level);
    $("#ind-level").innerHTML   = opts(STATE.ind.level);
    $("#et-level").innerHTML    = opts(STATE.et.level);
    $("#space-level").innerHTML = opts(STATE.space.level);
    $("#peer-level").innerHTML  = opts(STATE.peers.level);
    $("#geo-metric").innerHTML  = GEO_METRICS.map(m => `<option value="${m.value}" ${m.value===STATE.geo.metric?"selected":""}>${m.label}</option>`).join("");
    populateScatterAxes();
  }
  function populateScatterAxes() {
    const opts = SCATTER_METRICS.map(m => `<option value="${m.value}">${m.label}</option>`).join("");
    ["#geo-scatter-x","#geo-scatter-y","#ind-scatter-x","#ind-scatter-y"].forEach(sel => {
      const el = $(sel); if (!el) return;
      el.innerHTML = opts;
    });
    $("#geo-scatter-x").value = "industry_feasibility";
    $("#geo-scatter-y").value = "industry_complexity";
    $("#ind-scatter-x").value = "industry_feasibility";
    $("#ind-scatter-y").value = "location_quotient";
  }
  function populateGeoSearch(dimGeo, idCol, nameCol) {
    const dl = $("#geo-search-list");
    if (dl.dataset.level === STATE.geo.level) return;
    dl.dataset.level = STATE.geo.level;
    dl.innerHTML = "";
    dimGeo.forEach(r => {
      if (!r || !r[idCol]) return;
      const opt = document.createElement("option");
      opt.value = (r[nameCol] || r[idCol]) + " — " + r[idCol];
      dl.appendChild(opt);
    });
  }
  function parseChoiceFront(v) { if (!v) return null; const d = v.indexOf("—"); return (d > 0) ? v.substring(0, d).trim() : v.trim(); }
  function parseChoiceBack(v)  { if (!v) return null; const d = v.lastIndexOf("—"); return (d > 0) ? v.substring(d + 1).trim() : v.trim(); }

  function wireUI() {
    $$(".tab-btn").forEach(b => b.addEventListener("click", () => activateTab(b.dataset.tab)));
    $$(".header-link").forEach(a => a.addEventListener("click", (e) => {
      const target = a.getAttribute("href");
      if (target === "#/") { e.preventDefault(); window.history.replaceState({},"","#/"); activateTab("home"); }
    }));

    // GEOGRAPHY
    $("#geo-level").addEventListener("change", e => { STATE.geo.level = e.target.value; STATE.geo.selectedGeo = null; renderGeographyTab(); });
    $("#geo-metric").addEventListener("change", e => { STATE.geo.metric = e.target.value; renderGeographyTab(); });
    $("#geo-search").addEventListener("change", e => {
      const id = parseChoiceBack(e.target.value);
      if (id) onSelectGeography(id);
    });
    $("#geo-refresh").addEventListener("click", () => renderGeographyTab());
    $("#geo-reset").addEventListener("click", () => { STATE.geo.selectedGeo = null; $("#geo-search").value = ""; renderGeographyTab(); });
    $("#geo-scatter-x").addEventListener("change", () => STATE.geo.selectedGeo && onSelectGeography(STATE.geo.selectedGeo));
    $("#geo-scatter-y").addEventListener("change", () => STATE.geo.selectedGeo && onSelectGeography(STATE.geo.selectedGeo));

    // INDUSTRY
    $("#ind-level").addEventListener("change", e => { STATE.ind.level = e.target.value; renderIndustryTab(); });
    $("#ind-code").addEventListener("change", e => { STATE.ind.industry = parseChoiceFront(e.target.value); renderIndustryTab(); });
    $("#ind-metric").addEventListener("change", e => { STATE.ind.metric = e.target.value; renderIndustryTab(); });
    $("#ind-refresh").addEventListener("click", () => renderIndustryTab());
    $("#ind-scatter-x").addEventListener("change", () => renderIndustryTab());
    $("#ind-scatter-y").addEventListener("change", () => renderIndustryTab());

    // ENERGY TECH
    $("#et-level").addEventListener("change", e => { STATE.et.level = e.target.value; renderEnergyTechTab(); });
    $("#et-tech").addEventListener("change", e => { STATE.et.techId = e.target.value; renderEnergyTechTab(); });
    $("#et-metric").addEventListener("change", e => { STATE.et.metric = e.target.value; renderEnergyTechTab(); });
    $("#et-refresh").addEventListener("click", () => renderEnergyTechTab());

    // INDUSTRY SPACE
    $("#space-level").addEventListener("change", e => { STATE.space.level = e.target.value; renderIndustrySpaceTab(); });
    $("#space-highlight").addEventListener("change", e => { STATE.space.highlightGeo = parseChoiceBack(e.target.value); });
    $("#space-refresh").addEventListener("click", () => renderIndustrySpaceTab());

    // PEERS
    $("#peer-level").addEventListener("change", e => { STATE.peers.level = e.target.value; STATE.peers.anchorGeo = null; renderPeersHeatmapTab(); });
    $("#peer-anchor").addEventListener("change", e => { STATE.peers.anchorGeo = parseChoiceBack(e.target.value); renderPeersHeatmapTab(); });
    $("#peer-metric").addEventListener("change", e => { STATE.peers.metric = e.target.value; renderPeersHeatmapTab(); });
    $("#peer-refresh").addEventListener("click", () => renderPeersHeatmapTab());

    window.addEventListener("hashchange", parseHash);
  }

  // Hash routing — only acts on EXPLICIT navigation (clicks). On initial boot,
  // if the URL has a hash we honor it; if not, we stay on Home and never auto-redirect.
  function parseHash() {
    const h = window.location.hash;
    if (!h || h === "#" || h === "#/") { activateTab("home"); return; }
    let h2 = h; if (h2.charAt(0) === "#") h2 = h2.substring(1); if (h2.charAt(0) === "/") h2 = h2.substring(1);
    const parts = h2.split("/").map(decodeURIComponent);
    if (parts[0] === "regional" && parts.length >= 3) {
      STATE.geo.level = parts[1]; STATE.geo.selectedGeo = parts[2]; activateTab("geography");
    } else if (parts[0] === "industry" && parts.length >= 3) {
      STATE.ind.level = parts[1]; STATE.ind.industry = parts[2]; activateTab("industry");
    } else if (parts[0] === "energy-tech" && parts.length >= 3) {
      STATE.et.level = parts[1]; STATE.et.techId = parts[2]; activateTab("energy-tech");
    } else if (parts[0] === "industry-space" && parts.length >= 2) {
      STATE.space.level = parts[1]; activateTab("industry-space");
    } else if (parts[0] === "peers" && parts.length >= 3) {
      STATE.peers.level = parts[1]; STATE.peers.anchorGeo = parts[2]; activateTab("peers");
    } else if (parts[0] === "about") {
      activateTab("about");
    } else {
      activateTab("home");
    }
  }

  async function boot() {
    try {
      CFG = await fetchJson("site-config.json");
      populateLevelSelects();
      wireUI();
      wireDownloadButtons();
      // Honor hash if present, else stay on home
      if (window.location.hash && window.location.hash !== "#" && window.location.hash !== "#/") parseHash();
      else activateTab("home");
    } catch (err) {
      console.error("boot failed:", err);
      document.body.innerHTML = `<div style="padding:40px;font-family:Arial,sans-serif"><h1 style="color:#003B63">Could not load site config</h1><p>${err.message}</p></div>`;
    }
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
