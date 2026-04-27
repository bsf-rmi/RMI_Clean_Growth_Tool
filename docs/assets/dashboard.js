/* RMI Clean Growth Tool — dashboard.js
 * Single-file dashboard for static GitHub Pages deployment.
 * Sections: globals, cache, fetchers, state/routing, color, dom helpers,
 *           tooltip, exports, charts, pages, boot.
 */
'use strict';

/* ============================ GLOBALS ============================ */
const App = {
  config: null,
  data: {
    geographies: {},        // dim_geography per level (loaded on demand)
    industriesByLevel: {},  // dim_industry_by_level per level
    industryTitles: null,
    crosswalk: null,
    energyTechCrosswalk: null,
    energyTechCategories: null,
    geometries: {},         // GeoJSON FeatureCollection per level
    peers: {},              // peer_geography per level
    industrySpace: {},      // {nodes, edges} per non-state level
    colocation: {},         // proximity tables per non-state level
    factSlices: {},         // by_geography/<level>/<id> -> rows
    industrySlices: {},     // by_industry/<level>/<industry_code> -> rows
  },
};
const DATA_BASE = 'data/';
const LEVELS_WITH_INDUSTRY_SPACE = ['county', 'cbsa', 'csa', 'cz'];
const FORMAT = {
  num: (v, digits) => (v == null || isNaN(v)) ? '\u2014' :
    Number(v).toLocaleString(undefined, { maximumFractionDigits: digits ?? 2 }),
  int: (v) => (v == null || isNaN(v)) ? '\u2014' : Math.round(Number(v)).toLocaleString(),
  pct: (v) => (v == null || isNaN(v)) ? '\u2014' : Number(v).toFixed(1) + '%',
};
const LEVEL_DISPLAY = {
  county: 'County', state: 'State',
  cbsa: 'Core-Based Statistical Area',
  csa: 'Combined Statistical Area',
  cz: 'Commuting Zone',
};
const METRIC_DISPLAY = {
  economic_complexity: 'Economic Complexity Score',
  industry_feasibility: 'Industry Feasibility',
  existing_concentration: 'Existing Industry Concentration',
};
const SUBMETRIC_DISPLAY = {
  raw: 'Raw',
  percentile: 'Percentile',
  location_quotient: 'Location Quotient',
  presence: 'Industry Presence',
  comparative_advantage: 'Revealed Comparative Advantage',
};
function getGeoidColumn(level) {
  return ({county:'county_geoid', state:'state_fips', cbsa:'cbsa_geoid',
           csa:'csa_geoid', cz:'commuting_zone_geoid'})[level];
}
function getNameColumn(level) {
  return ({county:'name', state:'name', cbsa:'name', csa:'name', cz:'name'})[level];
}

/* ============================ INDEXEDDB CACHE ============================ */
const Cache = {
  db: null,
  STORE: 'kv',
  DBNAME: 'rmi_clean_growth_tool',
  VERSION: 1,
  async open() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DBNAME, this.VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.STORE))
          db.createObjectStore(this.STORE);
      };
      req.onsuccess = e => { this.db = e.target.result; resolve(this.db); };
      req.onerror = e => reject(e.target.error);
    });
  },
  async get(key) {
    try {
      await this.open();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(this.STORE, 'readonly');
        const req = tx.objectStore(this.STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) { return undefined; }
  },
  async set(key, value) {
    try {
      await this.open();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(this.STORE, 'readwrite');
        const req = tx.objectStore(this.STORE).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) { /* swallow */ }
  },
  async clear() {
    try {
      await this.open();
      return new Promise((resolve) => {
        const tx = this.db.transaction(this.STORE, 'readwrite');
        tx.objectStore(this.STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (e) {}
  },
};

/* ============================ FETCHERS ============================ */
async function fetchData(path, opts) {
  opts = opts || {};
  const url = DATA_BASE + path;
  const cacheKey = 'v1::' + url;
  if (!opts.bypassCache) {
    const cached = await Cache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const ext = path.split('.').slice(-2).join('.').toLowerCase();
  let result;
  try {
    if (ext === 'csv.gz' || ext === 'geojson.gz') {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      const text = pako.ungzip(new Uint8Array(buf), { to: 'string' });
      if (ext === 'csv.gz') result = d3.csvParse(text, autoTyper);
      else result = JSON.parse(text);
    } else if (path.endsWith('.csv')) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      result = d3.csvParse(text, autoTyper);
    } else if (path.endsWith('.json')) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      result = await resp.json();
    } else {
      throw new Error('Unknown file extension: ' + path);
    }
    Cache.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error('fetchData failed for ' + url, e);
    throw e;
  }
}
function autoTyper(row, _i, columns) {
  // Convert numeric-looking strings to numbers, keep zero-padded codes as strings.
  const out = {};
  for (const k of columns) {
    const v = row[k];
    if (v === '' || v == null) { out[k] = null; continue; }
    if (k === 'industry_code' || k === 'peer_industry_code' ||
        k.endsWith('_geoid') || k === 'state_fips' || k === 'county_fips' ||
        k === 'state_abbreviation' || k === 'industry_description' ||
        k === 'peer_industry_description' || k === 'name' ||
        k.endsWith('_name') || k === 'energy_tech_category' ||
        k === 'energy_tech_subcategory' || k === 'from' || k === 'to' ||
        k === 'constituent_county_geoids' || k === 'constituent_state_fips' ||
        k === 'constituent_state_names' || k === 'peer_name' ||
        k === 'geography_name') {
      out[k] = v;
    } else {
      const n = +v;
      out[k] = isNaN(n) ? v : n;
    }
  }
  return out;
}
async function ensureLevelLoaded(level) {
  // Loads dim_geography, dim_industry_by_level, geometry for a given level.
  if (App.data.geographies[level]) return;
  showLoading(true);
  try {
    const [geos, inds, geom] = await Promise.all([
      fetchData('meta/dim_geography_' + level + '.csv'),
      fetchData('meta/dim_industry_by_level_' + level + '.csv'),
      fetchData('geo/' + level + '.geojson.gz'),
    ]);
    App.data.geographies[level] = geos;
    App.data.industriesByLevel[level] = inds;
    App.data.geometries[level] = geom;
  } finally {
    showLoading(false);
  }
}
async function ensurePeersLoaded(level) {
  if (App.data.peers[level] || level === 'state') return;
  App.data.peers[level] = await fetchData('meta/peer_geography_' + level + '.csv.gz');
}
async function ensureIndustrySpaceLoaded(level) {
  if (App.data.industrySpace[level] || level === 'state') return;
  const [nodes, edges] = await Promise.all([
    fetchData('meta/industry_space_nodes_' + level + '.csv.gz'),
    fetchData('meta/industry_space_edges_' + level + '.csv.gz'),
  ]);
  App.data.industrySpace[level] = { nodes, edges };
}
async function ensureColocationLoaded(level) {
  if (App.data.colocation[level] || level === 'state') return;
  App.data.colocation[level] = await fetchData('meta/colocation/' + level + '.csv.gz');
}
async function fetchFactSlice(level, geoid) {
  const key = level + '/' + geoid;
  if (App.data.factSlices[key]) return App.data.factSlices[key];
  const rows = await fetchData('by_geography/' + level + '/' + geoid + '.csv.gz');
  App.data.factSlices[key] = rows;
  return rows;
}
async function fetchIndustrySlice(level, industryCode) {
  const key = level + '/' + industryCode;
  if (App.data.industrySlices[key]) return App.data.industrySlices[key];
  const rows = await fetchData('by_industry/' + level + '/' + industryCode + '.csv.gz');
  App.data.industrySlices[key] = rows;
  return rows;
}

/* ============================ STATE / ROUTING ============================ */
function parseHash() {
  const hash = (location.hash || '#/').replace(/^#/, '');
  const [pathPart, queryPart] = hash.split('?');
  const path = pathPart.replace(/\/+$/, '') || '/';
  const params = {};
  if (queryPart) {
    for (const part of queryPart.split('&')) {
      if (!part) continue;
      const [k, v] = part.split('=');
      params[decodeURIComponent(k)] = v == null ? '' : decodeURIComponent(v);
    }
  }
  return { path, params };
}
function buildHash(path, params) {
  const qs = params ? Object.keys(params).filter(k => params[k] != null && params[k] !== '')
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&') : '';
  return '#' + path + (qs ? '?' + qs : '');
}
function navigate(path, params) {
  const newHash = buildHash(path, params);
  if (location.hash !== newHash) location.hash = newHash;
  else applyRoute();
}
async function applyRoute() {
  const { path, params } = parseHash();
  highlightNav(path);
  const app = document.getElementById('app');
  app.innerHTML = '';
  try {
    if (path === '/' || path === '') await renderHomepage(app, params);
    else if (path === '/national') await renderNationalView(app, params);
    else if (path === '/regional') await renderRegionalEmpty(app, params);
    else if (path.startsWith('/regional/')) {
      const parts = path.split('/').filter(Boolean);
      // /regional/<level>/<id>
      await renderRegionalView(app, parts[1], parts[2], params);
    }
    else if (path === '/about') await renderAbout(app, params);
    else app.innerHTML = '<p class="empty-state">Page not found.</p>';
  } catch (e) {
    console.error(e);
    app.innerHTML = '<div class="error-state">Could not load this page: ' +
      escapeHtml(String(e.message || e)) + '</div>';
  }
}
function highlightNav(path) {
  document.querySelectorAll('.site-nav a').forEach(a => {
    const route = a.getAttribute('data-route');
    let active = false;
    if (route === 'home' && (path === '/' || path === '')) active = true;
    if (route === 'national' && path.startsWith('/national')) active = true;
    if (route === 'regional' && path.startsWith('/regional')) active = true;
    if (route === 'about' && path.startsWith('/about')) active = true;
    if (active) a.classList.add('active'); else a.classList.remove('active');
  });
}

/* ============================ COLOR / BINS ============================ */
const PALETTE_7 = ['#ffffd9','#edf8b1','#c7e9b4','#7fcdbb','#41b6c4','#1d91c0','#225ea8'];
const PALETTE_5 = ['#ffffd9','#c7e9b4','#7fcdbb','#41b6c4','#1d91c0'];
function quantileBins(values, n) {
  n = n || 5;
  const v = values.filter(x => x != null && !isNaN(x)).slice().sort((a, b) => a - b);
  if (!v.length) return { thresholds: [], min: 0, max: 0 };
  const thresholds = [];
  for (let i = 1; i < n; i++) {
    const idx = Math.floor((i / n) * v.length);
    thresholds.push(v[Math.min(idx, v.length - 1)]);
  }
  // Deduplicate thresholds (handles ties)
  const uniq = [];
  for (const t of thresholds) if (!uniq.length || t > uniq[uniq.length - 1]) uniq.push(t);
  return { thresholds: uniq, min: v[0], max: v[v.length - 1] };
}
function colorForValue(value, bins, palette) {
  palette = palette || PALETTE_5;
  if (value == null || isNaN(value)) return '#e0e3e8';
  let idx = 0;
  for (const t of bins.thresholds) { if (value > t) idx++; }
  return palette[Math.min(idx, palette.length - 1)];
}
function tierColor(lq) {
  if (lq == null || lq === 0) return 'var(--tier-not-present)';
  if (lq < 1) return 'var(--tier-nascent)';
  return 'var(--tier-specialized)';
}
function tierLabel(lq) {
  if (lq == null || lq === 0) return 'Not Present';
  if (lq < 1) return 'Nascent Presence';
  return 'Specialized';
}

/* ============================ DOM HELPERS ============================ */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'style' && typeof attrs[k] === 'object')
        Object.assign(node.style, attrs[k]);
      else if (k.startsWith('on') && typeof attrs[k] === 'function')
        node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
    else if (Array.isArray(c)) c.forEach(x => x && node.appendChild(typeof x === 'string' ? document.createTextNode(x) : x));
    else node.appendChild(c);
  }
  return node;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'
  }[c]));
}
function showLoading(on) {
  const node = document.getElementById('loading-indicator');
  if (on) node.removeAttribute('hidden');
  else node.setAttribute('hidden', '');
}
function makeSelect(items, opts) {
  opts = opts || {};
  const sel = document.createElement('select');
  if (opts.placeholder !== false)
    sel.appendChild(new Option(opts.placeholder || '\u2014 Select \u2014', ''));
  for (const it of items) {
    const o = new Option(it.label, it.value);
    sel.appendChild(o);
  }
  if (opts.value != null) sel.value = opts.value;
  if (opts.onchange) sel.addEventListener('change', opts.onchange);
  return sel;
}

/* ============================ TOOLTIP ============================ */
const Tooltip = {
  node: null,
  init() { this.node = document.getElementById('tooltip'); },
  show(html, x, y) {
    if (!this.node) this.init();
    this.node.innerHTML = html;
    this.node.removeAttribute('hidden');
    const pad = 14;
    const rect = this.node.getBoundingClientRect();
    let left = x + pad, top = y + pad;
    if (left + rect.width > window.innerWidth - 4) left = x - rect.width - pad;
    if (top + rect.height > window.innerHeight - 4) top = y - rect.height - pad;
    this.node.style.left = Math.max(4, left) + 'px';
    this.node.style.top = Math.max(4, top) + 'px';
  },
  hide() { if (this.node) this.node.setAttribute('hidden', ''); },
};

/* ============================ EXPORT HELPERS ============================ */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}
function exportSVG(svgEl, metadata, filename) {
  const clone = svgEl.cloneNode(true);
  // Add a footer text element with provenance so the downloaded SVG is more standalone.
  const ns = 'http://www.w3.org/2000/svg';
  const meta = document.createElementNS(ns, 'g');
  const t1 = document.createElementNS(ns, 'text');
  t1.setAttribute('x', 8);
  t1.setAttribute('y', svgEl.viewBox.baseVal.height || svgEl.clientHeight || 600);
  t1.setAttribute('font-size', '10');
  t1.setAttribute('fill', '#666');
  t1.textContent = (metadata && metadata.source) || ('RMI Clean Growth Tool — ' +
    (App.config && App.config.pipeline_id ? App.config.pipeline_id : ''));
  meta.appendChild(t1);
  clone.appendChild(meta);
  const svgStr = new XMLSerializer().serializeToString(clone);
  const blob = new Blob(['<?xml version="1.0" standalone="no"?>\n' + svgStr],
    { type: 'image/svg+xml' });
  downloadBlob(blob, filename || 'rmi_chart.svg');
}
function exportPNG(svgEl, metadata, filename) {
  const svgStr = new XMLSerializer().serializeToString(svgEl);
  const img = new Image();
  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  img.onload = function () {
    const w = svgEl.viewBox.baseVal.width || svgEl.clientWidth || 800;
    const h = svgEl.viewBox.baseVal.height || svgEl.clientHeight || 600;
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale; canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob(b => { downloadBlob(b, filename || 'rmi_chart.png'); URL.revokeObjectURL(url); });
  };
  img.src = url;
}
function exportCSV(rows, columns, metadata, filename) {
  const header = columns.join(',');
  const body = rows.map(r => columns.map(c => {
    const v = r[c]; if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? '"' + s + '"' : s;
  }).join(',')).join('\n');
  const meta = (metadata ? '# ' + (metadata.title || '') + '\n# Source: ' +
    (metadata.source || ('RMI Clean Growth Tool — ' + (App.config && App.config.pipeline_id))) + '\n' : '');
  const blob = new Blob([meta + header + '\n' + body], { type: 'text/csv' });
  downloadBlob(blob, filename || 'rmi_data.csv');
}
function attachExportButtons(container, getSvg, getRows, getColumns, baseName, metadata) {
  const tb = el('div', { class: 'toolbar' });
  tb.appendChild(el('button', { class: 'btn btn-secondary btn-small',
    onclick: () => exportSVG(getSvg(), metadata, baseName + '.svg') }, 'Download SVG'));
  tb.appendChild(el('button', { class: 'btn btn-secondary btn-small',
    onclick: () => exportPNG(getSvg(), metadata, baseName + '.png') }, 'Download PNG'));
  if (getRows) {
    tb.appendChild(el('button', { class: 'btn btn-secondary btn-small',
      onclick: () => exportCSV(getRows(), getColumns(), metadata, baseName + '.csv') }, 'Download CSV'));
  }
  container.appendChild(tb);
}

/* ============================ CHOROPLETH ============================ */
function renderChoropleth(container, level, valueByGeoid, opts) {
  opts = opts || {};
  const W = 920, H = 540;
  const svg = d3.create('svg')
    .attr('viewBox', '0 0 ' + W + ' ' + H)
    .attr('xmlns', 'http://www.w3.org/2000/svg')
    .attr('aria-label', opts.title || 'Map');
  const geom = App.data.geometries[level];
  const projection = d3.geoAlbersUsa().fitSize([W, H - 60], geom);
  const path = d3.geoPath(projection);
  const values = Object.values(valueByGeoid).filter(v => v != null && !isNaN(v));
  const bins = quantileBins(values, 5);
  const palette = PALETTE_5;
  const geoidProp = getGeoidColumn(level);
  const g = svg.append('g').attr('transform', 'translate(0, 50)');
  // Title
  svg.append('text').attr('x', W / 2).attr('y', 24)
    .attr('text-anchor', 'middle').attr('font-size', 16)
    .attr('font-weight', 600).attr('fill', '#0E314C')
    .text(opts.title || 'Map');
  if (opts.subtitle) {
    svg.append('text').attr('x', W / 2).attr('y', 42)
      .attr('text-anchor', 'middle').attr('font-size', 12)
      .attr('fill', '#555').text(opts.subtitle);
  }
  g.selectAll('path.choropleth-region')
    .data(geom.features)
    .join('path')
    .attr('class', 'choropleth-region')
    .attr('d', path)
    .attr('fill', d => {
      const id = d.properties[geoidProp];
      const v = valueByGeoid[id];
      return colorForValue(v, bins, palette);
    })
    .on('mousemove', (e, d) => {
      const id = d.properties[geoidProp];
      const v = valueByGeoid[id];
      const nm = d.properties[getNameColumn(level)] || d.properties.name || id;
      Tooltip.show(
        '<strong>' + escapeHtml(nm) + '</strong><br>' +
        escapeHtml(opts.metricLabel || 'Value') + ': ' +
        (v == null ? 'No data' : FORMAT.num(v, 3)),
        e.clientX, e.clientY);
    })
    .on('mouseleave', () => Tooltip.hide())
    .on('click', (_e, d) => {
      const id = d.properties[geoidProp];
      navigate('/regional/' + level + '/' + id, opts.regionalParams || {});
    });
  // Legend
  const legendG = svg.append('g').attr('transform', 'translate(' + (W - 240) + ', ' + (H - 26) + ')');
  const sw = 36;
  bins.thresholds.forEach((t, i) => {
    legendG.append('rect').attr('x', i * sw).attr('y', 0)
      .attr('width', sw).attr('height', 10).attr('fill', palette[i]);
  });
  legendG.append('rect').attr('x', bins.thresholds.length * sw).attr('y', 0)
    .attr('width', sw).attr('height', 10).attr('fill', palette[palette.length - 1]);
  legendG.append('text').attr('x', 0).attr('y', -4).attr('font-size', 10)
    .attr('fill', '#555').text('Lower');
  legendG.append('text').attr('x', sw * palette.length).attr('y', -4)
    .attr('text-anchor', 'end').attr('font-size', 10)
    .attr('fill', '#555').text('Higher');
  // Mount
  const wrap = el('div', { class: 'chart-wrap' });
  wrap.appendChild(svg.node());
  // Legend captions (HTML)
  const lg = el('div', { class: 'legend' });
  if (bins.thresholds.length) {
    const labels = ['below ' + FORMAT.num(bins.thresholds[0], 3)];
    for (let i = 1; i < bins.thresholds.length; i++)
      labels.push(FORMAT.num(bins.thresholds[i - 1], 3) + ' to ' + FORMAT.num(bins.thresholds[i], 3));
    labels.push(FORMAT.num(bins.thresholds[bins.thresholds.length - 1], 3) + ' or higher');
    labels.forEach((lab, i) =>
      lg.appendChild(el('span', { class: 'legend-bin' },
        el('span', { class: 'legend-swatch', style: { background: palette[Math.min(i, palette.length - 1)] } }),
        lab)));
  }
  wrap.appendChild(lg);
  container.appendChild(wrap);
  return { svg: svg.node(), bins };
}

/* ============================ NETWORK / INDUSTRY SPACE ============================ */
function renderIndustrySpace(container, level, opts) {
  opts = opts || {};
  const sp = App.data.industrySpace[level];
  if (!sp) {
    container.appendChild(el('div', { class: 'empty-state' },
      'Industry Space network is not computed at this geographic level.'));
    return;
  }
  const W = 720, H = 480;
  const svg = d3.create('svg').attr('viewBox', '0 0 ' + W + ' ' + H);
  const xS = d3.scaleLinear().domain([0, 1000]).range([20, W - 20]);
  const yS = d3.scaleLinear().domain([0, 1000]).range([H - 20, 20]);
  const nodesByCode = {};
  for (const n of sp.nodes) nodesByCode[n.industry_code] = n;
  // Edges
  svg.append('g').selectAll('line.network-edge')
    .data(sp.edges)
    .join('line')
    .attr('class', 'network-edge')
    .attr('x1', e => { const n = nodesByCode[e.from]; return n ? xS(n.layout_x) : 0; })
    .attr('y1', e => { const n = nodesByCode[e.from]; return n ? yS(n.layout_y) : 0; })
    .attr('x2', e => { const n = nodesByCode[e.to]; return n ? xS(n.layout_x) : 0; })
    .attr('y2', e => { const n = nodesByCode[e.to]; return n ? yS(n.layout_y) : 0; })
    .attr('stroke-width', 0.6);
  // Nodes
  const techSet = opts.techSet || new Set();
  const selectedCode = opts.selectedIndustry;
  // Color by complexity
  const complexValues = sp.nodes.map(n => +n.industry_complexity || 0);
  const complexBins = quantileBins(complexValues, 5);
  svg.append('g').selectAll('circle.network-node')
    .data(sp.nodes)
    .join('circle')
    .attr('class', n =>
      'network-node' +
      (techSet.has(n.industry_code) ? ' in-tech' : '') +
      (n.industry_code === selectedCode ? ' selected' : ''))
    .attr('cx', n => xS(n.layout_x))
    .attr('cy', n => yS(n.layout_y))
    .attr('r', n => Math.max(3, Math.min(8, 2 + Math.log10((+n.industry_ubiquity || 1)) * 2)))
    .attr('fill', n => colorForValue(+n.industry_complexity, complexBins, PALETTE_5))
    .on('mousemove', (e, n) => {
      Tooltip.show('<strong>' + escapeHtml(n.industry_description || '') +
        '</strong><br>' + escapeHtml(n.industry_code) +
        '<br>Industry Complexity Score: ' + FORMAT.num(n.industry_complexity, 2) +
        '<br>Industry Ubiquity: ' + FORMAT.int(n.industry_ubiquity), e.clientX, e.clientY);
    })
    .on('mouseleave', () => Tooltip.hide())
    .on('click', (_e, n) => {
      // Switch national view to this industry's feasibility
      navigate('/national', {
        level, aggregation: 'naics6',
        metric: 'industry_feasibility', sub: 'raw',
        industry: n.industry_code,
      });
    });
  // Title
  svg.append('text').attr('x', W / 2).attr('y', 18).attr('text-anchor', 'middle')
    .attr('font-size', 14).attr('font-weight', 600).attr('fill', '#0E314C')
    .text(opts.title || 'Industry Space network');
  const wrap = el('div', { class: 'chart-wrap' });
  wrap.appendChild(svg.node());
  container.appendChild(wrap);
  return { svg: svg.node() };
}

/* ============================ SCATTER ============================ */
function renderScatter(container, points, opts) {
  opts = opts || {};
  const W = 700, H = 460, MR = 30, ML = 60, MT = 40, MB = 50;
  const svg = d3.create('svg').attr('viewBox', '0 0 ' + W + ' ' + H);
  const xExt = d3.extent(points, p => p.x);
  const yExt = d3.extent(points, p => p.y);
  const xS = d3.scaleLinear().domain([Math.min(0, xExt[0]), xExt[1]]).nice().range([ML, W - MR]);
  const yS = d3.scaleLinear().domain(yExt).nice().range([H - MB, MT]);
  // Axes
  const xAxis = d3.axisBottom(xS).ticks(6);
  const yAxis = d3.axisLeft(yS).ticks(6);
  svg.append('g').attr('class', 'scatter-axis')
    .attr('transform', 'translate(0, ' + (H - MB) + ')').call(xAxis);
  svg.append('g').attr('class', 'scatter-axis')
    .attr('transform', 'translate(' + ML + ', 0)').call(yAxis);
  svg.append('text').attr('class', 'scatter-axis-label')
    .attr('x', W / 2).attr('y', H - 10)
    .attr('text-anchor', 'middle').text(opts.xLabel || 'X');
  svg.append('text').attr('class', 'scatter-axis-label')
    .attr('transform', 'rotate(-90)')
    .attr('x', -(H - MB + MT) / 2).attr('y', 16).attr('text-anchor', 'middle')
    .text(opts.yLabel || 'Y');
  if (opts.title) {
    svg.append('text').attr('x', W / 2).attr('y', 22)
      .attr('text-anchor', 'middle').attr('font-size', 14).attr('font-weight', 600)
      .attr('fill', '#0E314C').text(opts.title);
  }
  // Points
  svg.append('g').selectAll('circle')
    .data(points)
    .join('circle')
    .attr('cx', p => xS(p.x))
    .attr('cy', p => yS(p.y))
    .attr('r', p => p.r || 5)
    .attr('fill', p => p.color || '#3FB6BC')
    .attr('fill-opacity', 0.8)
    .attr('stroke', '#fff').attr('stroke-width', 0.6)
    .on('mousemove', (e, p) => {
      Tooltip.show(p.tooltip || ('<strong>' + escapeHtml(p.label || '') + '</strong>'),
        e.clientX, e.clientY);
    })
    .on('mouseleave', () => Tooltip.hide())
    .on('click', (_e, p) => p.onClick && p.onClick(p));
  const wrap = el('div', { class: 'chart-wrap' });
  wrap.appendChild(svg.node());
  // Tier legend
  if (opts.tierLegend) {
    const lg = el('div', { class: 'tier-legend' },
      el('span', null, el('span', { class: 'tier-dot', style: { background: 'var(--tier-not-present)' } }), 'Not Present'),
      el('span', null, el('span', { class: 'tier-dot', style: { background: 'var(--tier-nascent)' } }), 'Nascent Presence'),
      el('span', null, el('span', { class: 'tier-dot', style: { background: 'var(--tier-specialized)' } }), 'Specialized'));
    wrap.appendChild(lg);
  }
  container.appendChild(wrap);
  return { svg: svg.node() };
}

/* ============================ HEATMAP ============================ */
function renderHeatmap(container, rows, columns, getValue, opts) {
  opts = opts || {};
  const cellW = 72, cellH = 17, ML = 220, MT = 90;
  const W = ML + cellW * columns.length + 24;
  const H = MT + cellH * rows.length + 24;
  const svg = d3.create('svg').attr('viewBox', '0 0 ' + W + ' ' + H);
  // Per-column bins (each metric has its own scale)
  const colBins = columns.map(c => {
    const vals = rows.map(r => +getValue(r, c)).filter(v => !isNaN(v));
    return quantileBins(vals, 5);
  });
  // Title
  if (opts.title)
    svg.append('text').attr('x', ML).attr('y', 24).attr('font-size', 14)
      .attr('font-weight', 600).attr('fill', '#0E314C').text(opts.title);
  // Column labels (rotated)
  columns.forEach((c, i) => {
    svg.append('text').attr('class', 'heatmap-col-label')
      .attr('transform', 'translate(' + (ML + i * cellW + cellW / 2) + ',' + (MT - 8) + ') rotate(-30)')
      .attr('text-anchor', 'start').text(c.label);
  });
  // Rows + cells
  const rowG = svg.append('g');
  rows.forEach((r, ri) => {
    const y = MT + ri * cellH;
    rowG.append('text').attr('class', 'heatmap-row-label')
      .attr('x', ML - 6).attr('y', y + cellH * 0.7)
      .attr('text-anchor', 'end').text(r.label);
    columns.forEach((c, ci) => {
      const v = +getValue(r, c);
      rowG.append('rect').attr('class', 'heatmap-cell')
        .attr('x', ML + ci * cellW).attr('y', y)
        .attr('width', cellW).attr('height', cellH)
        .attr('fill', isNaN(v) ? '#f0f0f0' : colorForValue(v, colBins[ci], PALETTE_5))
        .on('mousemove', (e) => {
          Tooltip.show('<strong>' + escapeHtml(r.label) + '</strong><br>' +
            escapeHtml(c.label) + ': ' + (isNaN(v) ? '\u2014' : FORMAT.num(v, 3)),
            e.clientX, e.clientY);
        })
        .on('mouseleave', () => Tooltip.hide());
    });
  });
  const wrap = el('div', { class: 'chart-wrap', style: { overflowX: 'auto' } });
  wrap.appendChild(svg.node());
  container.appendChild(wrap);
  return { svg: svg.node() };
}

/* ============================ TABLE ============================ */
function renderTable(container, rows, columns, opts) {
  opts = opts || {};
  const tbl = el('table', { class: 'data-table' });
  const thead = el('thead'); const tr = el('tr');
  let sortKey = opts.sortKey || null, sortDir = opts.sortDir || 'desc';
  for (const c of columns) {
    const th = el('th', { 'data-key': c.key }, c.label);
    if (c.sortable !== false) {
      th.addEventListener('click', () => {
        if (sortKey === c.key) sortDir = (sortDir === 'desc' ? 'asc' : 'desc');
        else { sortKey = c.key; sortDir = 'desc'; }
        sortAndRender();
      });
    }
    if (c.numeric) th.classList.add('num');
    tr.appendChild(th);
  }
  thead.appendChild(tr); tbl.appendChild(thead);
  const tbody = el('tbody'); tbl.appendChild(tbody);
  function sortAndRender() {
    let r = rows.slice();
    if (sortKey) {
      r.sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        const an = (av == null || av === '') ? -Infinity : (typeof av === 'number' ? av : String(av));
        const bn = (bv == null || bv === '') ? -Infinity : (typeof bv === 'number' ? bv : String(bv));
        if (an < bn) return sortDir === 'asc' ? -1 : 1;
        if (an > bn) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    tbody.innerHTML = '';
    for (const row of r) {
      const tr2 = el('tr');
      for (const c of columns) {
        const td = el('td');
        if (c.numeric) td.classList.add('num');
        const raw = row[c.key];
        if (c.render) {
          const out = c.render(row, raw);
          if (typeof out === 'string') td.innerHTML = out;
          else if (out instanceof Node) td.appendChild(out);
        } else {
          td.textContent = (raw == null) ? '\u2014' : (c.format ? c.format(raw) : String(raw));
        }
        tr2.appendChild(td);
      }
      if (opts.onRowClick) {
        tr2.style.cursor = 'pointer';
        tr2.addEventListener('click', () => opts.onRowClick(row));
      }
      tbody.appendChild(tr2);
    }
  }
  sortAndRender();
  container.appendChild(tbl);
  return tbl;
}

/* ============================ HOMEPAGE ============================ */
async function renderHomepage(app, _params) {
  app.appendChild(el('h1', { class: 'h1' }, 'RMI Clean Growth Tool'));
  app.appendChild(el('p', { class: 'lead' },
    'Explore industrial complexity, industry feasibility, and energy ' +
    'technology readiness across United States regions. Pick a region to ' +
    'see its profile, or pick an industry to see how it is distributed nationally.'));
  app.appendChild(el('div', { class: 'warn-banner' },
    'The energy technology crosswalk is illustrative and under refinement. ' +
    'Treat tech-tagged metrics as preliminary.'));
  // Two dropdown trios
  const defaultLevel = App.config.default_geographic_level || 'cz';
  await ensureLevelLoaded(defaultLevel);
  const geoTrio = el('div', { class: 'controls-row' });
  const industryTrio = el('div', { class: 'controls-row' });
  const levelSel = makeSelect(
    App.config.geographic_levels.map(l => ({ label: l.display_name, value: l.key })),
    { placeholder: false, value: defaultLevel });
  let regionSel;
  function rebuildRegionSelect(level) {
    const geos = App.data.geographies[level];
    const items = geos.map(g => ({
      label: g[getNameColumn(level)] + ' (' + g[getGeoidColumn(level)] + ')',
      value: g[getGeoidColumn(level)],
    })).sort((a, b) => a.label.localeCompare(b.label));
    if (regionSel) regionSel.replaceWith(makeSelect(items, { placeholder: 'Select a region' }));
    else regionSel = makeSelect(items, { placeholder: 'Select a region' });
  }
  rebuildRegionSelect(defaultLevel);
  levelSel.addEventListener('change', async () => {
    await ensureLevelLoaded(levelSel.value);
    const old = regionSel;
    rebuildRegionSelect(levelSel.value);
    old.replaceWith(regionSel);
  });
  geoTrio.appendChild(el('div', { class: 'control' },
    el('label', null, 'Geographic level'), levelSel));
  geoTrio.appendChild(el('div', { class: 'control' },
    el('label', null, 'Region'), regionSel));
  geoTrio.appendChild(el('button', { class: 'btn',
    onclick: () => {
      if (!regionSel.value) return;
      navigate('/regional/' + levelSel.value + '/' + regionSel.value);
    } }, 'Go to region'));
  app.appendChild(el('h2', { class: 'h2' }, 'Find a region'));
  app.appendChild(geoTrio);
  // Industry trio
  if (!App.data.industryTitles) App.data.industryTitles = await fetchData('meta/industry_titles.csv');
  const aggSel = makeSelect(
    App.config.industry_aggregations.map(a => ({ label: a.display_name, value: a.key })),
    { placeholder: false, value: 'naics6' });
  let industrySel;
  function rebuildIndustrySelect(agg) {
    let items;
    if (agg === 'naics6') {
      items = App.data.industryTitles.map(i => ({
        label: i.industry_description + ' (' + i.industry_code + ')',
        value: i.industry_code,
      })).sort((a, b) => a.label.localeCompare(b.label));
    } else {
      const seen = new Set();
      items = [];
      for (const r of (App.data.energyTechCategories || [])) {
        const k = r.energy_tech_category + ' | ' + r.energy_tech_subcategory;
        if (!seen.has(k)) { seen.add(k); items.push({ label: k, value: k }); }
      }
      items.sort((a, b) => a.label.localeCompare(b.label));
    }
    const newSel = makeSelect(items, { placeholder: 'Select an industry' });
    if (industrySel) industrySel.replaceWith(newSel);
    industrySel = newSel;
  }
  if (!App.data.energyTechCategories)
    App.data.energyTechCategories = await fetchData('energy_tech/categories.csv');
  rebuildIndustrySelect('naics6');
  aggSel.addEventListener('change', () => rebuildIndustrySelect(aggSel.value));
  industryTrio.appendChild(el('div', { class: 'control' },
    el('label', null, 'Industry aggregation'), aggSel));
  industryTrio.appendChild(el('div', { class: 'control' },
    el('label', null, 'Industry'), industrySel));
  industryTrio.appendChild(el('button', { class: 'btn',
    onclick: () => {
      if (!industrySel.value) return;
      const params = { level: defaultLevel, aggregation: aggSel.value, sub: 'raw',
        metric: aggSel.value === 'naics6' ? 'industry_feasibility' : 'industry_feasibility' };
      if (aggSel.value === 'naics6') params.industry = industrySel.value;
      else params.tech = industrySel.value;
      navigate('/national', params);
    } }, 'Show on national map'));
  app.appendChild(el('h2', { class: 'h2' }, 'Pick an industry'));
  app.appendChild(industryTrio);
  // Card row
  app.appendChild(el('div', { class: 'hero-cta' },
    el('div', { class: 'card' },
      el('h3', null, 'National view'),
      el('p', null, 'Explore choropleth maps of complexity, industry feasibility, and concentration across the United States.'),
      el('a', { class: 'btn', href: '#/national' }, 'Open national view')),
    el('div', { class: 'card' },
      el('h3', null, 'Regional view'),
      el('p', null, 'Pick a county, metropolitan or micropolitan area, combined statistical area, commuting zone, or state and explore its industrial profile.'),
      el('a', { class: 'btn', href: '#/regional' }, 'Open regional view')),
    el('div', { class: 'card' },
      el('h3', null, 'About this tool'),
      el('p', null, 'Methodology, energy technology crosswalk, and provenance information.'),
      el('a', { class: 'btn btn-secondary', href: '#/about' }, 'Read about'))));
}

/* ============================ NATIONAL VIEW ============================ */
async function renderNationalView(app, params) {
  const level = params.level || App.config.default_geographic_level || 'cz';
  const aggregation = params.aggregation || 'naics6';
  const metric = params.metric || 'economic_complexity';
  const sub = params.sub || 'raw';
  const industry = params.industry || '';
  const tech = params.tech || '';
  await ensureLevelLoaded(level);
  if (!App.data.energyTechCrosswalk)
    App.data.energyTechCrosswalk = await fetchData('energy_tech/crosswalk.csv');
  if (!App.data.energyTechCategories)
    App.data.energyTechCategories = await fetchData('energy_tech/categories.csv');
  if (!App.data.industryTitles)
    App.data.industryTitles = await fetchData('meta/industry_titles.csv');

  app.appendChild(el('h1', { class: 'h1' }, 'National view'));
  // Controls
  const controls = el('div', { class: 'controls-row' });
  const levelSel = makeSelect(
    App.config.geographic_levels.map(l => ({ label: l.display_name, value: l.key })),
    { placeholder: false, value: level });
  controls.appendChild(el('div', { class: 'control' },
    el('label', null, 'Geographic level'), levelSel));
  const aggSel = makeSelect([
    { label: 'Six-Digit Industry Code', value: 'naics6' },
    { label: 'Energy Technology', value: 'energy_tech' },
  ], { placeholder: false, value: aggregation });
  controls.appendChild(el('div', { class: 'control' },
    el('label', null, 'Industry aggregation'), aggSel));
  const metricSel = makeSelect([
    { label: 'Economic Complexity Score', value: 'economic_complexity' },
    { label: 'Industry Feasibility', value: 'industry_feasibility' },
    { label: 'Existing Industry Concentration', value: 'existing_concentration' },
  ], { placeholder: false, value: metric });
  controls.appendChild(el('div', { class: 'control' },
    el('label', null, 'Metric'), metricSel));
  // Sub-metric depends on metric
  let subSel = makeSubmetricSelect(metric, sub);
  controls.appendChild(el('div', { class: 'control' },
    el('label', null, 'Sub-metric'), subSel));
  // Industry/tech selector (shown when relevant)
  const indWrap = el('div', { class: 'control' });
  controls.appendChild(indWrap);
  function rebuildIndustryTechSelector() {
    indWrap.innerHTML = '';
    if (metricSel.value === 'economic_complexity') return;
    if (aggSel.value === 'naics6') {
      indWrap.appendChild(el('label', null, 'Industry'));
      const items = App.data.industryTitles.map(i => ({
        label: i.industry_description + ' (' + i.industry_code + ')',
        value: i.industry_code,
      })).sort((a, b) => a.label.localeCompare(b.label));
      indWrap.appendChild(makeSelect(items,
        { placeholder: 'Select an industry', value: industry, onchange: applyControls }));
    } else {
      indWrap.appendChild(el('label', null, 'Energy technology'));
      const seen = new Set();
      const items = [];
      for (const r of App.data.energyTechCategories) {
        const k = r.energy_tech_category + ' | ' + r.energy_tech_subcategory;
        if (!seen.has(k)) { seen.add(k); items.push({ label: k, value: k }); }
      }
      items.sort((a, b) => a.label.localeCompare(b.label));
      indWrap.appendChild(makeSelect(items,
        { placeholder: 'Select a technology', value: tech, onchange: applyControls }));
    }
  }
  rebuildIndustryTechSelector();
  function makeSubmetricSelect(m, value) {
    let items;
    if (m === 'economic_complexity' || m === 'industry_feasibility')
      items = [{ label: 'Raw', value: 'raw' }, { label: 'Percentile', value: 'percentile' }];
    else
      items = [
        { label: 'Location Quotient', value: 'location_quotient' },
        { label: 'Industry Presence', value: 'presence' },
        { label: 'Revealed Comparative Advantage', value: 'comparative_advantage' },
      ];
    return makeSelect(items, { placeholder: false, value, onchange: applyControls });
  }
  function applyControls() {
    // When metric or aggregation changes, sub-metric and industry/tech need rebuilds.
    if (metricSel.value === 'economic_complexity' && aggSel.value === 'energy_tech') {
      // ECI is a region property; force naics6 aggregation for ECI
      aggSel.value = 'naics6';
    }
    // Refresh sub-metric options
    const newSub = makeSubmetricSelect(metricSel.value,
      (subSel.value && (subSel.value === 'raw' || subSel.value === 'percentile' ||
        subSel.value === 'location_quotient' || subSel.value === 'presence' ||
        subSel.value === 'comparative_advantage')) ? subSel.value : null);
    subSel.replaceWith(newSub); subSel = newSub;
    rebuildIndustryTechSelector();
    const indSel = indWrap.querySelector('select');
    const ind = indSel ? indSel.value : '';
    const newParams = {
      level: levelSel.value, aggregation: aggSel.value,
      metric: metricSel.value, sub: subSel.value };
    if (aggSel.value === 'naics6' && ind) newParams.industry = ind;
    if (aggSel.value === 'energy_tech' && ind) newParams.tech = ind;
    navigate('/national', newParams);
  }
  levelSel.addEventListener('change', applyControls);
  aggSel.addEventListener('change', applyControls);
  metricSel.addEventListener('change', applyControls);
  subSel.addEventListener('change', applyControls);
  app.appendChild(controls);

  const dimInfo = el('p', { class: 'dim-info' });
  dimInfo.innerHTML = '<strong>' + escapeHtml(LEVEL_DISPLAY[level]) + '</strong> &middot; ' +
    'Click any region on the map to open its regional view.';
  app.appendChild(dimInfo);

  // Compute valueByGeoid based on selection
  const mapBox = el('div', { class: 'section' });
  app.appendChild(mapBox);
  await renderNationalMap(mapBox, level, aggregation, metric, sub, industry, tech);

  // Below-map row: industry space + co-location
  if (level !== 'state') {
    const row = el('div', { style: { display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '18px' } });
    app.appendChild(el('h2', { class: 'h2' }, 'Industry Space and co-location'));
    app.appendChild(row);
    const leftBox = el('div'); const rightBox = el('div');
    row.appendChild(leftBox); row.appendChild(rightBox);
    await ensureIndustrySpaceLoaded(level);
    await ensureColocationLoaded(level);
    const techSet = new Set();
    if (aggregation === 'energy_tech' && tech) {
      const [cat, sub2] = tech.split(' | ');
      for (const r of App.data.energyTechCrosswalk) {
        if (r.energy_tech_category === cat && r.energy_tech_subcategory === sub2) techSet.add(r.industry_code);
      }
    }
    renderIndustrySpace(leftBox, level, {
      title: 'Industry Space at the ' + LEVEL_DISPLAY[level] + ' level',
      techSet,
      selectedIndustry: industry,
    });
    // Co-location table
    if (industry) {
      const coloc = App.data.colocation[level]
        .filter(r => r.industry_code === industry)
        .sort((a, b) => (a.proximity_rank || 99999) - (b.proximity_rank || 99999))
        .slice(0, 10);
      const techByInd = buildTechByIndustryMap();
      rightBox.appendChild(el('h3', { class: 'h3' }, 'Top 10 co-locating industries'));
      const cols = [
        { key: 'proximity_rank', label: 'Rank', numeric: true },
        { key: 'peer_industry_code', label: 'Industry code', numeric: false },
        { key: 'peer_industry_description', label: 'Industry description' },
        { key: 'proximity', label: 'Proximity', numeric: true,
          format: v => FORMAT.num(v, 3) },
        { key: 'shares', label: 'Shares energy technology with focal', numeric: false,
          render: (row) => {
            const a = techByInd[industry] || new Set();
            const b = techByInd[row.peer_industry_code] || new Set();
            for (const t of a) if (b.has(t)) return 'Yes';
            return 'No';
          } },
      ];
      renderTable(rightBox, coloc, cols);
    } else {
      rightBox.appendChild(el('div', { class: 'empty-state' },
        'Select a Six-Digit Industry Code to see its top co-locating industries.'));
    }
  }
}
function buildTechByIndustryMap() {
  const m = {};
  for (const r of (App.data.energyTechCrosswalk || [])) {
    const k = r.energy_tech_category + ' | ' + r.energy_tech_subcategory;
    if (!m[r.industry_code]) m[r.industry_code] = new Set();
    m[r.industry_code].add(k);
  }
  return m;
}
async function renderNationalMap(box, level, aggregation, metric, sub, industry, tech) {
  let valueByGeoid = {};
  let title = '';
  let metricLabel = '';
  const geoidProp = getGeoidColumn(level);
  if (metric === 'economic_complexity') {
    const dimGeo = App.data.geographies[level];
    for (const g of dimGeo) {
      valueByGeoid[g[geoidProp]] = sub === 'percentile'
        ? g.economic_complexity_percentile_score
        : g.economic_complexity_index;
    }
    title = (sub === 'percentile' ? 'Economic Complexity Percentile' : 'Economic Complexity Score') +
      ' \u2014 ' + LEVEL_DISPLAY[level];
    metricLabel = sub === 'percentile' ? 'Economic Complexity Percentile' : 'Economic Complexity Score';
  } else if (metric === 'industry_feasibility') {
    if (aggregation === 'naics6') {
      if (!industry) {
        box.appendChild(el('div', { class: 'empty-state' },
          'Select an industry from the controls above to see its feasibility map.'));
        return;
      }
      const rows = await fetchIndustrySlice(level, industry);
      for (const r of rows) {
        valueByGeoid[r[geoidProp] || r.geoid] =
          sub === 'percentile' ? r.industry_feasibility_percentile_score : r.industry_feasibility;
      }
      const tt = (App.data.industryTitles.find(i => i.industry_code === industry) || {});
      title = (sub === 'percentile' ? 'Industry Feasibility Percentile' : 'Industry Feasibility') +
        ' for ' + (tt.industry_description || industry) + ' (' + industry + ') \u2014 ' + LEVEL_DISPLAY[level];
      metricLabel = sub === 'percentile' ? 'Industry Feasibility Percentile' : 'Industry Feasibility';
    } else {
      // Energy technology composite — mean feasibility across constituent industries.
      if (!tech) {
        box.appendChild(el('div', { class: 'empty-state' },
          'Select an Energy Technology from the controls above.'));
        return;
      }
      const [cat, sub2] = tech.split(' | ');
      const inds = App.data.energyTechCrosswalk
        .filter(r => r.energy_tech_category === cat && r.energy_tech_subcategory === sub2)
        .map(r => r.industry_code);
      if (!inds.length) {
        box.appendChild(el('div', { class: 'empty-state' }, 'No industries are tagged in this technology.'));
        return;
      }
      // Fetch all industry slices in parallel (capped concurrency)
      showLoading(true);
      try {
        const sums = {}; const counts = {};
        await Promise.all(inds.map(async (ic) => {
          try {
            const rows = await fetchIndustrySlice(level, ic);
            for (const r of rows) {
              const id = r[geoidProp] || r.geoid;
              const v = sub === 'percentile' ? r.industry_feasibility_percentile_score : r.industry_feasibility;
              if (v == null || isNaN(v)) continue;
              sums[id] = (sums[id] || 0) + Number(v);
              counts[id] = (counts[id] || 0) + 1;
            }
          } catch (e) { /* skip */ }
        }));
        for (const id in sums) valueByGeoid[id] = counts[id] ? sums[id] / counts[id] : null;
      } finally { showLoading(false); }
      title = 'Mean Industry Feasibility \u2014 ' + tech + ' \u2014 ' + LEVEL_DISPLAY[level];
      metricLabel = 'Mean Industry Feasibility';
    }
  } else if (metric === 'existing_concentration') {
    if (aggregation === 'naics6') {
      if (!industry) {
        box.appendChild(el('div', { class: 'empty-state' },
          'Select an industry from the controls above.'));
        return;
      }
      const rows = await fetchIndustrySlice(level, industry);
      for (const r of rows) {
        const id = r[geoidProp] || r.geoid;
        if (sub === 'location_quotient') valueByGeoid[id] = r.location_quotient;
        else if (sub === 'presence') valueByGeoid[id] = r.industry_present;
        else valueByGeoid[id] = r.industry_comparative_advantage;
      }
      const tt = (App.data.industryTitles.find(i => i.industry_code === industry) || {});
      title = SUBMETRIC_DISPLAY[sub] + ' for ' + (tt.industry_description || industry) +
        ' (' + industry + ') \u2014 ' + LEVEL_DISPLAY[level];
      metricLabel = SUBMETRIC_DISPLAY[sub];
    } else {
      // Energy tech composite: count specialized
      if (!tech) {
        box.appendChild(el('div', { class: 'empty-state' },
          'Select an Energy Technology from the controls above.'));
        return;
      }
      const [cat, sub2] = tech.split(' | ');
      const inds = App.data.energyTechCrosswalk
        .filter(r => r.energy_tech_category === cat && r.energy_tech_subcategory === sub2)
        .map(r => r.industry_code);
      showLoading(true);
      try {
        const counts = {};
        await Promise.all(inds.map(async (ic) => {
          try {
            const rows = await fetchIndustrySlice(level, ic);
            for (const r of rows) {
              const id = r[geoidProp] || r.geoid;
              if ((sub === 'location_quotient' && (r.location_quotient || 0) >= 1) ||
                  (sub === 'presence' && (r.industry_present || 0) === 1) ||
                  (sub === 'comparative_advantage' && (r.industry_comparative_advantage || 0) === 1) ||
                  (sub === 'location_quotient' && r.location_quotient >= 1)) {
                counts[id] = (counts[id] || 0) + 1;
              }
            }
          } catch (e) { /* skip */ }
        }));
        for (const id in counts) valueByGeoid[id] = counts[id];
      } finally { showLoading(false); }
      title = 'Specialized industries (count) for ' + tech + ' \u2014 ' + LEVEL_DISPLAY[level];
      metricLabel = 'Specialized industries (count)';
    }
  }
  const wrap = el('div');
  box.appendChild(wrap);
  const result = renderChoropleth(wrap, level, valueByGeoid, {
    title, subtitle: 'Source: Lightcast 2024, RMI Clean Growth Tool',
    metricLabel,
    regionalParams: {},
  });
  // Export buttons
  const exportRows = Object.keys(valueByGeoid).map(id => ({ geoid: id, value: valueByGeoid[id] }));
  attachExportButtons(wrap, () => result.svg,
    () => exportRows, () => ['geoid', 'value'],
    'rmi_national_map', { title, source: 'RMI Clean Growth Tool — ' + App.config.pipeline_id });
}

/* ============================ REGIONAL EMPTY STATE ============================ */
async function renderRegionalEmpty(app, _params) {
  app.appendChild(el('h1', { class: 'h1' }, 'Regional view'));
  app.appendChild(el('p', { class: 'lead' },
    'Pick a geographic level and a region from below to see its industrial profile, ' +
    'energy technology readiness, and peer geographies.'));
  const defaultLevel = App.config.default_geographic_level || 'cz';
  await ensureLevelLoaded(defaultLevel);
  const ctrl = el('div', { class: 'controls-row' });
  const levelSel = makeSelect(
    App.config.geographic_levels.map(l => ({ label: l.display_name, value: l.key })),
    { placeholder: false, value: defaultLevel });
  let regionSel;
  function rebuildRegionSelect(level) {
    const geos = App.data.geographies[level];
    const items = geos.map(g => ({
      label: (g[getNameColumn(level)] || g[getGeoidColumn(level)]) +
        (level === 'county' && g.state_abbreviation ? ', ' + g.state_abbreviation : '') +
        ' (' + g[getGeoidColumn(level)] + ')',
      value: g[getGeoidColumn(level)],
    })).sort((a, b) => a.label.localeCompare(b.label));
    const ns = makeSelect(items, { placeholder: 'Select a region' });
    if (regionSel) regionSel.replaceWith(ns);
    regionSel = ns;
  }
  rebuildRegionSelect(defaultLevel);
  levelSel.addEventListener('change', async () => {
    await ensureLevelLoaded(levelSel.value);
    rebuildRegionSelect(levelSel.value);
  });
  ctrl.appendChild(el('div', { class: 'control' },
    el('label', null, 'Geographic level'), levelSel));
  ctrl.appendChild(el('div', { class: 'control' },
    el('label', null, 'Region'), regionSel));
  ctrl.appendChild(el('button', { class: 'btn',
    onclick: () => {
      if (!regionSel.value) return;
      navigate('/regional/' + levelSel.value + '/' + regionSel.value);
    } }, 'Open region'));
  app.appendChild(ctrl);
}

/* ============================ REGIONAL VIEW ============================ */
async function renderRegionalView(app, level, geoid, _params) {
  if (!level || !geoid) return renderRegionalEmpty(app, {});
  await ensureLevelLoaded(level);
  if (!App.data.industryTitles)
    App.data.industryTitles = await fetchData('meta/industry_titles.csv');
  if (!App.data.energyTechCrosswalk)
    App.data.energyTechCrosswalk = await fetchData('energy_tech/crosswalk.csv');

  const geoidProp = getGeoidColumn(level);
  const region = (App.data.geographies[level] || []).find(g => g[geoidProp] === geoid);
  if (!region) {
    app.appendChild(el('div', { class: 'error-state' },
      'Region not found at level ' + LEVEL_DISPLAY[level] + ': ' + geoid));
    return renderRegionalEmpty(app, {});
  }
  const regionName = region[getNameColumn(level)] || region.name || geoid;

  // Header
  app.appendChild(el('h1', { class: 'h1' }, regionName));
  const sub = el('p', { class: 'dim-info' });
  let subParts = [LEVEL_DISPLAY[level], 'identifier ' + geoid];
  if (level === 'county' && region.state_name) subParts.push(region.state_name);
  if (['cbsa', 'csa', 'cz'].includes(level) && region.constituent_state_names)
    subParts.push('States: ' + String(region.constituent_state_names).split('|').join(', '));
  if (['cbsa', 'csa', 'cz'].includes(level) && region.n_constituent_counties)
    subParts.push(region.n_constituent_counties + ' constituent counties');
  sub.innerHTML = subParts.join(' &middot; ');
  app.appendChild(sub);
  // Region picker controls
  const ctrl = el('div', { class: 'controls-row' });
  const levelSel = makeSelect(
    App.config.geographic_levels.map(l => ({ label: l.display_name, value: l.key })),
    { placeholder: false, value: level });
  ctrl.appendChild(el('div', { class: 'control' },
    el('label', null, 'Geographic level'), levelSel));
  const regionSel = makeSelect(
    App.data.geographies[level].map(g => ({
      label: (g[getNameColumn(level)] || g[getGeoidColumn(level)]) + ' (' + g[getGeoidColumn(level)] + ')',
      value: g[getGeoidColumn(level)],
    })).sort((a, b) => a.label.localeCompare(b.label)),
    { placeholder: 'Select a region', value: geoid });
  ctrl.appendChild(el('div', { class: 'control' },
    el('label', null, 'Region'), regionSel));
  levelSel.addEventListener('change', async () => {
    await ensureLevelLoaded(levelSel.value);
    location.hash = '#/regional/' + levelSel.value;
  });
  regionSel.addEventListener('change', () => {
    if (regionSel.value) navigate('/regional/' + levelSel.value + '/' + regionSel.value);
  });
  ctrl.appendChild(el('button', { class: 'btn btn-secondary',
    onclick: () => exportRegionalProfilePDF(level, geoid, region) },
    'Download regional profile (PDF)'));
  app.appendChild(ctrl);

  // Stats cards
  const cards = el('div', { class: 'cards-row' });
  cards.appendChild(statCard('Economic Complexity Score',
    FORMAT.num(region.economic_complexity_index, 2),
    'Percentile: ' + FORMAT.num(region.economic_complexity_percentile_score, 1)));
  cards.appendChild(statCard('Industrial Diversity',
    FORMAT.int(region.industrial_diversity),
    'Industries with Revealed Comparative Advantage'));
  // Compute count specialized + presence from fact slice
  let factRows;
  try { factRows = await fetchFactSlice(level, geoid); }
  catch (e) { factRows = []; }
  const nSpec = factRows.filter(r => (r.location_quotient || 0) >= 1).length;
  const nPresent = factRows.filter(r => (r.location_quotient || 0) > 0).length;
  cards.appendChild(statCard('Specialized industries (count)',
    FORMAT.int(nSpec), 'Location Quotient at or above 1.0'));
  cards.appendChild(statCard('Industries present',
    FORMAT.int(nPresent), 'Of ' + (App.data.industriesByLevel[level] || []).length + ' total'));
  app.appendChild(cards);

  // Section: Top concentration industries
  app.appendChild(el('div', { class: 'section-header' },
    el('h2', { class: 'h2' }, 'Top concentration industries'),
    (function () {
      const sel = makeSelect([
        { label: 'Top 10', value: 10 }, { label: 'Top 25', value: 25 }, { label: 'Top 50', value: 50 }
      ], { placeholder: false, value: 10 });
      sel.addEventListener('change', () => renderTopIndustries(topBox, factRows, +sel.value));
      return el('div', { class: 'control' }, el('label', null, 'Show'), sel);
    })()));
  const topBox = el('div'); app.appendChild(topBox);
  renderTopIndustries(topBox, factRows, 10);

  // Section: Energy tech scatter
  app.appendChild(el('h2', { class: 'h2' }, 'Energy technology profile'));
  const scatterBox = el('div'); app.appendChild(scatterBox);
  renderRegionalEnergyTechScatter(scatterBox, level, factRows);

  // Section: Energy tech heatmap
  app.appendChild(el('h2', { class: 'h2' }, 'Energy technology relevance heatmap'));
  const heatBox = el('div'); app.appendChild(heatBox);
  renderRegionalEnergyTechHeatmap(heatBox, level, factRows);

  // Section: Peer geographies
  app.appendChild(el('h2', { class: 'h2' }, 'Peer geographies'));
  if (level === 'state') {
    app.appendChild(el('div', { class: 'empty-state' },
      'Peer geography is not computed at the state level.'));
  } else {
    await ensurePeersLoaded(level);
    const peerBox = el('div'); app.appendChild(peerBox);
    renderRegionalPeers(peerBox, level, geoid, region);
  }
}
function statCard(label, value, sub) {
  return el('div', { class: 'card' },
    el('p', { class: 'stat-label' }, label),
    el('p', { class: 'stat-value' }, value),
    sub ? el('p', { class: 'stat-sub' }, sub) : null);
}
function renderTopIndustries(box, factRows, n) {
  box.innerHTML = '';
  if (!factRows || !factRows.length) {
    box.appendChild(el('div', { class: 'empty-state' }, 'No industry data for this region.'));
    return;
  }
  const indByCode = {};
  for (const i of App.data.industryTitles) indByCode[i.industry_code] = i;
  const techByInd = buildTechByIndustryMap();
  const rows = factRows.slice()
    .sort((a, b) => (b.location_quotient || 0) - (a.location_quotient || 0))
    .slice(0, n)
    .map(r => ({
      industry_code: r.industry_code,
      industry_description: (indByCode[r.industry_code] || {}).industry_description || '',
      location_quotient: r.location_quotient,
      industry_employment_share: r.industry_employment_share,
      industry_feasibility: r.industry_feasibility,
      tech_tag: techByInd[r.industry_code] ? Array.from(techByInd[r.industry_code]).join('; ') : '',
    }));
  renderTable(box, rows, [
    { key: 'industry_code', label: 'Industry code' },
    { key: 'industry_description', label: 'Description' },
    { key: 'location_quotient', label: 'Location Quotient', numeric: true,
      format: v => FORMAT.num(v, 2) },
    { key: 'industry_employment_share', label: 'Employment share', numeric: true,
      format: v => FORMAT.num(v * 100, 2) + '%' },
    { key: 'industry_feasibility', label: 'Industry Feasibility', numeric: true,
      format: v => FORMAT.num(v, 3) },
    { key: 'tech_tag', label: 'Energy technologies' },
  ]);
}
function renderRegionalEnergyTechScatter(box, level, factRows) {
  if (!factRows || !factRows.length) {
    box.appendChild(el('div', { class: 'empty-state' }, 'No data to plot.'));
    return;
  }
  const inds = (App.data.industriesByLevel[level] || []);
  const indComplex = {};
  for (const i of inds) indComplex[i.industry_code] = i.industry_complexity;
  const techByInd = buildTechByIndustryMap();
  const techIndustryCodes = new Set(Object.keys(techByInd));
  const points = factRows
    .filter(r => techIndustryCodes.has(r.industry_code))
    .map(r => {
      const lq = r.location_quotient || 0;
      const techs = Array.from(techByInd[r.industry_code] || []).join('; ');
      const desc = (App.data.industryTitles.find(i => i.industry_code === r.industry_code) || {}).industry_description || r.industry_code;
      return {
        x: r.industry_feasibility, y: indComplex[r.industry_code] || 0,
        color: lq === 0 ? '#edf8b1' : (lq < 1 ? '#7fcdbb' : '#2c7fb8'),
        r: 5,
        label: desc,
        tooltip: '<strong>' + escapeHtml(desc) + '</strong><br>' +
          escapeHtml(r.industry_code) + '<br>' +
          'Industry Feasibility: ' + FORMAT.num(r.industry_feasibility, 3) + '<br>' +
          'Industry Complexity: ' + FORMAT.num(indComplex[r.industry_code], 2) + '<br>' +
          'Location Quotient: ' + FORMAT.num(lq, 2) + '<br>' +
          'Tier: ' + tierLabel(lq) + '<br>' +
          'Energy Technologies: ' + escapeHtml(techs),
        onClick: () => navigate('/national', {
          level, aggregation: 'naics6',
          metric: 'industry_feasibility', sub: 'raw', industry: r.industry_code }),
      };
    });
  renderScatter(box, points, {
    title: 'Industries tagged in any Energy Technology — feasibility vs. complexity',
    xLabel: 'Industry Feasibility',
    yLabel: 'Industry Complexity Score',
    tierLegend: true,
  });
}
function renderRegionalEnergyTechHeatmap(box, level, factRows) {
  if (!factRows || !factRows.length) {
    box.appendChild(el('div', { class: 'empty-state' }, 'No data for the heatmap.'));
    return;
  }
  const techByInd = buildTechByIndustryMap();
  const factByCode = {};
  for (const r of factRows) factByCode[r.industry_code] = r;
  const inds = Object.keys(techByInd)
    .filter(c => factByCode[c])
    .sort((a, b) => {
      const ta = Array.from(techByInd[a] || []).sort()[0] || '';
      const tb = Array.from(techByInd[b] || []).sort()[0] || '';
      if (ta !== tb) return ta.localeCompare(tb);
      return a.localeCompare(b);
    });
  if (!inds.length) {
    box.appendChild(el('div', { class: 'empty-state' }, 'No tagged industries with data here.'));
    return;
  }
  const indByCode = {};
  for (const i of App.data.industryTitles) indByCode[i.industry_code] = i;
  const rows = inds.map(c => ({
    label: (indByCode[c] && indByCode[c].industry_description ?
      indByCode[c].industry_description.slice(0, 38) : '') + ' (' + c + ')',
    industry_code: c }));
  const columns = [
    { label: 'Location Quotient', key: 'location_quotient' },
    { label: 'Industry Feasibility', key: 'industry_feasibility' },
    { label: 'Feasibility Percentile', key: 'industry_feasibility_percentile_score' },
    { label: 'Industry Presence', key: 'industry_present' },
    { label: 'Comparative Advantage', key: 'industry_comparative_advantage' },
  ];
  renderHeatmap(box, rows, columns,
    (r, c) => factByCode[r.industry_code] ? factByCode[r.industry_code][c.key] : null,
    { title: 'Energy-tech industries in this region (sorted by tech category)' });
}
function renderRegionalPeers(box, level, geoid, _region) {
  const peers = (App.data.peers[level] || []).filter(r => r[getGeoidColumn(level)] === geoid);
  if (!peers.length) {
    box.appendChild(el('div', { class: 'empty-state' },
      'No peer geographies precomputed for this region.'));
    return;
  }
  const showCount = level === 'county' ? 10 : 10;
  const sameStateBox = el('div'); box.appendChild(sameStateBox);
  let sameStateOnly = false;
  let n = showCount;
  function renderTable_() {
    sameStateBox.innerHTML = '';
    let rows = peers.slice().sort((a, b) => (a.peer_rank || 99999) - (b.peer_rank || 99999));
    if (sameStateOnly && level === 'county') {
      // Filter peers to same state
      const dimGeo = App.data.geographies.county;
      const meRow = dimGeo.find(g => g.county_geoid === geoid);
      if (meRow) {
        const myState = meRow.state_fips;
        rows = rows.filter(r => {
          const peerRow = dimGeo.find(g => g.county_geoid === r.peer_county_geoid);
          return peerRow && peerRow.state_fips === myState;
        });
      }
    }
    rows = rows.slice(0, n);
    const peerCol = 'peer_' + getGeoidColumn(level);
    const cols = [
      { key: 'peer_rank', label: 'Rank', numeric: true },
      { key: 'peer_name', label: 'Peer region' },
      { key: 'jaccard_similarity', label: 'Jaccard similarity', numeric: true,
        format: v => FORMAT.num(v, 3) },
      { key: 'industries_in_common', label: 'Industries in common', numeric: true,
        format: v => FORMAT.int(v) },
    ];
    renderTable(sameStateBox, rows, cols, {
      onRowClick: row => navigate('/regional/' + level + '/' + row[peerCol]),
    });
  }
  // Controls
  const ctl = el('div', { class: 'toolbar' });
  if (level === 'county') {
    const lab = el('label', null,
      el('input', { type: 'checkbox', onchange: e => { sameStateOnly = e.target.checked; renderTable_(); } }),
      ' Same state only');
    ctl.appendChild(lab);
  }
  const sel = makeSelect([5,10,15,20,25].map(v => ({ label: 'Show top ' + v, value: v })),
    { placeholder: false, value: showCount,
      onchange: () => { n = +sel.value; renderTable_(); } });
  ctl.appendChild(sel);
  box.insertBefore(ctl, box.firstChild);
  renderTable_();
}

/* ============================ ABOUT ============================ */
async function renderAbout(app, _params) {
  if (!App.data.energyTechCrosswalk)
    App.data.energyTechCrosswalk = await fetchData('energy_tech/crosswalk.csv');
  if (!App.data.energyTechCategories)
    App.data.energyTechCategories = await fetchData('energy_tech/categories.csv');
  const diag = await fetchData('meta/complexity_diagnostics.csv');
  app.appendChild(el('h1', { class: 'h1' }, 'About this tool'));
  app.appendChild(el('p', { class: 'lead' },
    'The RMI Clean Growth Tool surfaces industrial complexity, industry feasibility, ' +
    'and energy-technology readiness across United States regions, using ' +
    'employment data from Lightcast 2024 and the economic complexity methodology ' +
    'pioneered by Hidalgo and Hausmann.'));
  app.appendChild(el('h2', { class: 'h2' }, 'Methodology'));
  app.appendChild(el('p', null,
    'For each geographic level (county, state, metro/micro area, combined statistical area, ' +
    'and commuting zone), we compute the Location Quotient of every Six-Digit Industry Code ' +
    'in every region, then derive a binary specialization matrix where a region is "specialized" ' +
    'in an industry when its Location Quotient is at or above 1. From this matrix we calculate ' +
    'the Economic Complexity Score and Industry Complexity Score using the eigenvector method, ' +
    'industry proximity from co-occurrence of specializations, and industry feasibility (a ' +
    'region\'s density of present industries among the focal industry\'s nearby neighbors in the ' +
    'industry-space network).'));
  app.appendChild(el('p', null,
    'Energy technologies are not scored independently. They are tags applied to ' +
    'Six-Digit Industry Codes via the Energy Technology crosswalk, which is currently ' +
    'illustrative and under refinement. When a user picks a technology on the National view, ' +
    'the displayed metric is computed on the fly across the constituent industries — for example, ' +
    '"Specialized industries (count)" counts how many of the technology\'s constituent industries ' +
    'have Revealed Comparative Advantage at or above 1 in each region.'));
  app.appendChild(el('h2', { class: 'h2' }, 'Validation diagnostics'));
  renderTable(app, diag, [
    { key: 'geo_aggregation_name', label: 'Geographic level' },
    { key: 'n_geographies', label: 'Geographies', numeric: true },
    { key: 'n_industries', label: 'Industries', numeric: true },
    { key: 'fill_rate_pct', label: 'Specialization fill rate (%)', numeric: true,
      format: v => FORMAT.num(v, 2) },
    { key: 'first_eigenvalue', label: 'First eigenvalue', numeric: true,
      format: v => FORMAT.num(v, 4) },
    { key: 'second_eigenvalue', label: 'Second eigenvalue', numeric: true,
      format: v => FORMAT.num(v, 4) },
    { key: 'ici_ubiquity_correlation', label: 'Industry Complexity vs Ubiquity correlation',
      numeric: true, format: v => FORMAT.num(v, 3) },
    { key: 'eci_diversity_correlation', label: 'Economic Complexity vs Diversity correlation',
      numeric: true, format: v => FORMAT.num(v, 3) },
  ]);
  app.appendChild(el('h2', { class: 'h2' }, 'Energy Technology crosswalk'));
  app.appendChild(el('p', { class: 'muted' },
    'Listing of the energy technology categories and subcategories currently in the crosswalk.'));
  const cats = App.data.energyTechCategories.slice().sort((a, b) =>
    (a.energy_tech_category + a.energy_tech_subcategory)
      .localeCompare(b.energy_tech_category + b.energy_tech_subcategory));
  renderTable(app, cats, [
    { key: 'energy_tech_category', label: 'Category' },
    { key: 'energy_tech_subcategory', label: 'Subcategory' },
  ]);
  app.appendChild(el('h2', { class: 'h2' }, 'Provenance'));
  const p = App.config.provenance || {};
  const provRows = [
    ['Pipeline ID', App.config.pipeline_id],
    ['Build time', App.config.build_time],
    ['Lightcast file', p.lightcast_file],
    ['Lightcast modified', p.lightcast_modified],
    ['Lightcast vintage', p.lightcast_vintage],
    ['Tigris year', p.tigris_year],
    ['Commuting Zones source', p.commuting_zones_source],
    ['Commuting Zones vintage', p.commuting_zones_vintage],
    ['Energy Technology crosswalk file', p.energy_tech_crosswalk_file],
    ['Energy Technology crosswalk modified', p.energy_tech_crosswalk_modified],
    ['Energy Technology crosswalk SHA-256', p.energy_tech_crosswalk_sha256],
    ['Patches added (effective)', p.energy_tech_crosswalk_patches && p.energy_tech_crosswalk_patches.added_effective],
    ['Patches removed', p.energy_tech_crosswalk_patches && p.energy_tech_crosswalk_patches.removed],
  ];
  const tbl = el('table', { class: 'data-table' });
  const tb = el('tbody');
  for (const [k, v] of provRows) {
    tb.appendChild(el('tr', null,
      el('td', { style: { width: '38%', fontWeight: '600', color: 'var(--rmi-text-muted)' } }, k),
      el('td', null, String(v == null ? '' : v))));
  }
  tbl.appendChild(tb); app.appendChild(tbl);
  app.appendChild(el('h2', { class: 'h2' }, 'Bulk downloads'));
  const bulkUL = el('ul');
  const bulkPaths = [
    'bulk/fact_county.parquet', 'bulk/fact_state.parquet', 'bulk/fact_cbsa.parquet',
    'bulk/fact_csa.parquet', 'bulk/fact_cz.parquet',
    'bulk/peers_county.parquet', 'bulk/peers_cbsa.parquet', 'bulk/peers_csa.parquet', 'bulk/peers_cz.parquet',
    'bulk/colocation_county.parquet', 'bulk/colocation_cbsa.parquet',
    'bulk/colocation_csa.parquet', 'bulk/colocation_cz.parquet',
    'bulk/M_matrix_county.parquet', 'bulk/M_matrix_cbsa.parquet',
    'bulk/M_matrix_csa.parquet', 'bulk/M_matrix_cz.parquet',
    'bulk/energy_tech_crosswalk.parquet'
  ];
  for (const path of bulkPaths) {
    bulkUL.appendChild(el('li', null,
      el('a', { href: DATA_BASE + path, download: '' }, path)));
  }
  app.appendChild(bulkUL);
  app.appendChild(el('h2', { class: 'h2' }, 'Report a problem'));
  app.appendChild(el('p', null,
    'Found a bug, an industry that\'s tagged incorrectly, or a region that doesn\'t look right? ',
    el('a', { href: (App.config.github && App.config.github.issues_url) || '#', target: '_blank' },
      'Open an issue on GitHub'),
    '.'));
}

/* ============================ PDF EXPORT ============================ */
function exportRegionalProfilePDF(level, geoid, region) {
  try {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) { alert('PDF library not available.'); return; }
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const W = doc.internal.pageSize.getWidth();
    let y = 50;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(20);
    doc.text(region[getNameColumn(level)] || geoid, 40, y); y += 26;
    doc.setFontSize(11); doc.setFont('helvetica', 'normal');
    doc.text(LEVEL_DISPLAY[level] + ' \u00B7 identifier ' + geoid, 40, y); y += 14;
    if (region.constituent_state_names)
      doc.text('States: ' + String(region.constituent_state_names).split('|').join(', '), 40, y), y += 14;
    if (region.n_constituent_counties)
      doc.text(region.n_constituent_counties + ' constituent counties', 40, y), y += 14;
    y += 12;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text('Headline statistics', 40, y); y += 18;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    doc.text('Economic Complexity Score: ' + FORMAT.num(region.economic_complexity_index, 2), 40, y); y += 14;
    doc.text('Economic Complexity Percentile: ' + FORMAT.num(region.economic_complexity_percentile_score, 1), 40, y); y += 14;
    doc.text('Industrial Diversity (count of industries with Revealed Comparative Advantage): ' +
      FORMAT.int(region.industrial_diversity), 40, y); y += 24;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text('Provenance', 40, y); y += 18;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text('Pipeline: ' + (App.config && App.config.pipeline_id), 40, y); y += 12;
    doc.text('Build time: ' + (App.config && App.config.build_time), 40, y); y += 12;
    doc.text('Source: Lightcast 2024 employment data', 40, y); y += 12;
    doc.text('The Energy Technology crosswalk is illustrative and under refinement.', 40, y); y += 12;
    doc.save('rmi_regional_profile_' + level + '_' + geoid + '.pdf');
  } catch (e) {
    console.error(e);
    alert('Could not generate PDF: ' + e.message);
  }
}

/* ============================ BOOT ============================ */
async function boot() {
  showLoading(true);
  try {
    // Load config first
    const config = await fetchData('site-config.json', { bypassCache: true });
    App.config = config;
    document.getElementById('footer-pipeline').textContent =
      'Pipeline: ' + config.pipeline_id;
    if (config.github && config.github.issues_url) {
      document.getElementById('footer-issues').href = config.github.issues_url;
    }
    // Pipeline-id-keyed cache: clear if pipeline changed
    const lastPid = await Cache.get('pipeline_id');
    if (lastPid !== config.pipeline_id) {
      await Cache.clear();
      await Cache.set('pipeline_id', config.pipeline_id);
    }
  } catch (e) {
    console.error('Boot failed', e);
    document.getElementById('app').innerHTML =
      '<div class="error-state">Failed to load site configuration: ' + escapeHtml(e.message) + '</div>';
    showLoading(false);
    return;
  }
  Tooltip.init();
  window.addEventListener('hashchange', applyRoute);
  showLoading(false);
  applyRoute();
}
document.addEventListener('DOMContentLoaded', boot);

