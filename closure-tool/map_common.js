// Single-page viewer engine: one tab bar switches between "historical"
// closures and "current" hospitals (the closure simulator), sharing one
// canvas/interaction engine. Expects globals set by the page before this
// file loads:
//   STATES_OUTLINE, HISTORICAL_DATA, CURRENT_DATA (data/*.js)
//
// Hand-rolled <canvas> renderer, no mapping library -- same approach as
// prj_hosp-open-close's event_map_interactive.html. All geometry is
// quantized-delta-encoded EA_CRS meters (see code/04_figures/_viewer_encode.R
// and _shared/geo.R's batch_shift_geometry()); decode() undoes that once per
// geometry, not per frame.

(function () {
  const QUANT = STATES_OUTLINE.quant;
  const POP_BINS = [0, 1000, 10000]; // people-affected color bins: 0 | 1-1,000 | 1,000-10,000 | 10,000+
  // yellow/orange/red chosen for max hue separation at small dot sizes, not
  // just lightness -- an earlier gold/orange pair read as near-identical at 3px.
  const BIN_COLORS = ['#8b8580', '#f4d03f', '#e0742a', '#a3221c'];
  const BIN_LABELS = ['0 (nobody loses access)', '1 - 1,000', '1,000 - 10,000', '10,000+'];

  let MODE = 'historical';
  let DATA = HISTORICAL_DATA;
  let items = DATA.events;

  // ---- geometry decode --------------------------------------------------

  function decodeRing(delta) {
    const n = delta.length / 2;
    const pts = new Float64Array(delta.length);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) {
      x += delta[i * 2]; y += delta[i * 2 + 1];
      pts[i * 2] = x * QUANT; pts[i * 2 + 1] = y * QUANT;
    }
    return pts;
  }
  function decodeGeom(geom) {
    if (!geom || !geom.length) return [];
    return geom.map(part => part.map(decodeRing));
  }
  const decodeCache = new Map();
  function decodeCached(key, geom) {
    if (decodeCache.has(key)) return decodeCache.get(key);
    const d = decodeGeom(geom);
    decodeCache.set(key, d);
    return d;
  }

  const STATE_GEOM = {};
  for (const st in STATES_OUTLINE.states) STATE_GEOM[st] = decodeGeom(STATES_OUTLINE.states[st]);

  // ---- active-hospital-by-year backdrop (historical tab, specific year only) --

  function decodeIdx(deltas) {
    let cum = 0; const out = new Array(deltas.length);
    for (let i = 0; i < deltas.length; i++) { cum += deltas[i]; out[i] = cum; }
    return out;
  }
  // Takes the SELECTED (closure) year and shows the network from the year
  // BEFORE it, matching what the impact computation actually compares each
  // closure against (see 10_historical_closure_impact.R's eval_year) --
  // falls back to the closure's own year if there's no prior-year data
  // (only possible at the very start of the panel), same fallback the R
  // side uses.
  const backdropIdxCache = new Map();
  function backdropForYear(closureYear) {
    let year = closureYear - 1;
    let raw = HISTORICAL_DATA.active && HISTORICAL_DATA.active[year];
    if (!raw) { year = closureYear; raw = HISTORICAL_DATA.active && HISTORICAL_DATA.active[year]; }
    if (!raw) return null;
    const key = String(year);
    if (backdropIdxCache.has(key)) return backdropIdxCache.get(key);
    const idx = decodeIdx(raw);
    backdropIdxCache.set(key, idx);
    return idx;
  }

  // ---- canvas / view state -----------------------------------------------

  const canvas = document.getElementById('cv');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  let view = { k: 1, tx: 0, ty: 0 };

  function boxSize() {
    const r = canvas.parentElement.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }
  function resizeCanvas() {
    const { w, h } = boxSize();
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  const sx = x => view.k * x + view.tx;
  const sy = y => -view.k * y + view.ty;
  const worldX = X => (X - view.tx) / view.k;
  const worldY = Y => (view.ty - Y) / view.k;

  function fitExtent(xmin, ymin, xmax, ymax, pad) {
    const { w, h } = boxSize();
    const k = Math.min(w / (xmax - xmin), h / (ymax - ymin)) * (pad || 0.92);
    view = { k, tx: w / 2 - k * (xmin + xmax) / 2, ty: h / 2 + k * (ymin + ymax) / 2 };
  }
  function fitView() {
    const [xmin, ymin, xmax, ymax] = STATES_OUTLINE.extent.map(v => v * QUANT);
    fitExtent(xmin, ymin, xmax, ymax, 0.92);
  }

  // Zoom/pan to frame a selected item's geometry, with padding so nearby
  // context (state lines, other points) stays visible -- otherwise a single
  // hospital's affected area (tens of km across) is imperceptible at the
  // national view a fresh page load or tab switch starts at. Historical
  // events pass their full isochrone (padMult 1.5 is enough since it's
  // already a sensible size); the closure simulator only has the access-loss
  // region itself (no isochrone -- see itemGeom()'s comment on why), which
  // can be a much smaller sliver, so it passes a larger padMult to keep the
  // same amount of surrounding context on screen.
  function zoomToGeom(parts, padMult) {
    if (!parts || !parts.length) return false;
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const part of parts) for (const ring of part) {
      for (let i = 0; i < ring.length; i += 2) {
        if (ring[i] < xmin) xmin = ring[i]; if (ring[i] > xmax) xmax = ring[i];
        if (ring[i + 1] < ymin) ymin = ring[i + 1]; if (ring[i + 1] > ymax) ymax = ring[i + 1];
      }
    }
    if (!isFinite(xmin)) return false;
    const m = padMult || 1.5;
    const padX = Math.max((xmax - xmin) * m, 20000), padY = Math.max((ymax - ymin) * m, 20000);
    fitExtent(xmin - padX, ymin - padY, xmax + padX, ymax + padY, 1);
    return true;
  }

  // ---- drawing ------------------------------------------------------------

  function tracePath(parts) {
    ctx.beginPath();
    for (const part of parts) for (const ring of part) {
      for (let i = 0; i < ring.length; i += 2) {
        const X = sx(ring[i]), Y = sy(ring[i + 1]);
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.closePath();
    }
  }
  function drawPolygon(parts, fill, stroke, lineWidth) {
    if (!parts || !parts.length) return;
    tracePath(parts);
    if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth || 1; ctx.stroke(); }
  }

  // ---- per-mode state -----------------------------------------------------

  let selected = null;
  let hovered = null;
  let driveTime = DATA.driveTimes.includes(30) ? 30 : DATA.driveTimes[0];
  let yearFilter = 'all';

  // current-mode (closure simulator) only: every currently-open hospital's
  // geometry is embedded inline as the global CURRENT_GEOM_ALL (see 23's
  // header), so this resolves synchronously with no network request.
  const fetchedGeom = new Map();
  function currentGeomKey(id, dt) { return id + '_' + dt; }
  function ensureCurrentGeom(id, dt) {
    const key = currentGeomKey(id, dt);
    if (fetchedGeom.has(key)) return fetchedGeom.get(key);
    const g = CURRENT_GEOM_ALL[key] || { rgn: [] };
    fetchedGeom.set(key, g);
    return g;
  }

  // Historical events carry `iso` (decoded, used only to frame the zoom --
  // never drawn, see render()'s comment) alongside `rgn`, the access-loss
  // region that IS drawn. Closure-simulator geometry does NOT include `iso`
  // at all (dropped at build time -- see 23's header: it was ~2.5x the size
  // of `rgn` for a value used only to pick a zoom level), so that branch
  // always reports iso as empty and zoomToGeom() falls back to framing on
  // `rgn` itself with extra padding -- see selectAndZoom().
  function itemGeom(item) {
    if (MODE === 'historical') {
      const g = item.geom && item.geom[driveTime];
      if (!g) return null;
      return { iso: decodeCached(item.ekey + '_' + driveTime + '_iso', g.iso),
              rgn: decodeCached(item.ekey + '_' + driveTime + '_rgn', g.rgn) };
    }
    const raw = ensureCurrentGeom(item.id, driveTime);
    return { iso: [], rgn: decodeCached(currentGeomKey(item.id, driveTime) + '_rgn', raw.rgn) };
  }

  function itemStats(item) { return item.stats[driveTime]; }
  function itemPopOnly(item) { const s = itemStats(item); return s ? s.popOnly : 0; }

  function popBin(pop) {
    if (!pop || pop <= 0) return 0;
    if (pop <= POP_BINS[1]) return 1;
    if (pop <= POP_BINS[2]) return 2;
    return 3;
  }
  function pointColor(pop) { return BIN_COLORS[popBin(pop)]; }

  function visibleItems() {
    let out = items;
    if (MODE === 'historical' && yearFilter !== 'all') out = out.filter(e => e.year === yearFilter);
    return out;
  }

  // Every hospital active in the selected year, drawn as small grey dots
  // beneath the colored closure points -- context for why an access-loss
  // region looks the way it does (a stranded area visibly corresponds to an
  // empty neighborhood rather than being taken on faith), same idea as
  // prj_hosp-open-close's own backdrop layer. Historical tab only, and only
  // once a specific year is selected (an "all years" backdrop would just be
  // every hospital ever, which isn't a meaningful single-year context).
  function drawBackdrop() {
    const idx = backdropForYear(yearFilter);
    if (!idx) return;
    const hosp = HISTORICAL_DATA.hosp;
    const { w, h } = boxSize();
    ctx.fillStyle = '#cac6c0';
    ctx.globalAlpha = 0.6;
    for (const i of idx) {
      const X = sx(hosp.x[i] * QUANT), Y = sy(hosp.y[i] * QUANT);
      if (X < -10 || X > w + 10 || Y < -10 || Y > h + 10) continue;
      ctx.beginPath();
      ctx.arc(X, Y, 1.2, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---- main render ---------------------------------------------------------

  function render() {
    resizeCanvas();
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const st in STATE_GEOM) drawPolygon(STATE_GEOM[st], '#faf8f6', '#d8d2c9', 1);

    if (MODE === 'historical' && yearFilter !== 'all') drawBackdrop();

    // Only the access-loss region is ever drawn -- not the full isochrone --
    // per the simplified design: this map answers "what area loses access,"
    // not "what's the hospital's whole catchment."
    if (selected) {
      const g = itemGeom(selected);
      if (g) drawPolygon(g.rgn, 'rgba(193,57,31,0.4)', '#a3221c', 1.4);
    }

    const vis = visibleItems();
    for (const item of vis) {
      const X = sx(item.x * QUANT), Y = sy(item.y * QUANT);
      const { w, h } = boxSize();
      if (X < -20 || X > w + 20 || Y < -20 || Y > h + 20) continue;
      const isSel = selected && selected === item;
      const isHov = hovered === item;
      ctx.beginPath();
      ctx.arc(X, Y, isSel ? 6 : (isHov ? 5 : 3.2), 0, 2 * Math.PI);
      ctx.fillStyle = pointColor(itemPopOnly(item));
      ctx.globalAlpha = isSel || isHov ? 1 : 0.85;
      ctx.fill();
      if (isSel) { ctx.lineWidth = 1.5; ctx.strokeStyle = '#222'; ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    updateSidePanel();
    updateTooltip();
  }

  // ---- picking -------------------------------------------------------------

  // <=, not <: two events can share the exact same coordinates (a hospital
  // that closed, reopened under a new name, then closed again). render()
  // draws visibleItems() in order, so the LAST one drawn is the one visually
  // on top; picking the first match on a tie meant a click could select a
  // different, fully-hidden point than the one you actually see, showing
  // stats/color that don't match what's on screen.
  function pick(mx, my) {
    const vis = visibleItems();
    let best = null, bestD = 12 * 12;
    for (const item of vis) {
      const X = sx(item.x * QUANT), Y = sy(item.y * QUANT);
      const d = (X - mx) * (X - mx) + (Y - my) * (Y - my);
      if (d <= bestD) { bestD = d; best = item; }
    }
    return best;
  }

  // ---- mouse / interaction --------------------------------------------------

  let dragging = false, dragMoved = false, lastX = 0, lastY = 0, lastMouse = { x: 0, y: 0 };
  canvas.addEventListener('mousedown', e => {
    dragging = true; dragMoved = false;
    lastX = e.offsetX; lastY = e.offsetY;
  });
  window.addEventListener('mouseup', e => {
    if (dragging && !dragMoved) {
      const hit = pick(e.offsetX ?? lastX, e.offsetY ?? lastY);
      if (hit) { selected = hit; selectAndZoom(hit); }
      render();
    }
    dragging = false;
  });

  // Zoom to the selection's isochrone as soon as it's available. Historical
  // geometry is embedded inline (available immediately); current-hospital
  // geometry is fetched on demand, so this also fires from
  // ensureCurrentGeom()'s resolved callback once it lands.
  function selectAndZoom(item) {
    const g = itemGeom(item);
    if (!g) return;
    if (g.iso.length) zoomToGeom(g.iso, 1.5);
    else if (g.rgn.length) zoomToGeom(g.rgn, 3.5); // no iso available -- frame on the (often much smaller) loss region itself, with more padding
  }
  canvas.addEventListener('mousemove', e => {
    if (dragging) {
      const dx = e.offsetX - lastX, dy = e.offsetY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
      view.tx += dx; view.ty += dy;
      lastX = e.offsetX; lastY = e.offsetY;
      render();
    } else {
      const hit = pick(e.offsetX, e.offsetY);
      if (hit !== hovered) { hovered = hit; render(); }
      lastMouse = { x: e.offsetX, y: e.offsetY };
    }
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0015);
    const wx = worldX(e.offsetX), wy = worldY(e.offsetY);
    view.k *= f;
    view.tx = e.offsetX - view.k * wx;
    view.ty = e.offsetY + view.k * wy;
    render();
  }, { passive: false });

  // ---- tooltip ---------------------------------------------------------

  const tip = document.getElementById('tip');
  function updateTooltip() {
    if (!hovered) { tip.style.display = 'none'; return; }
    const s = itemStats(hovered);
    tip.style.display = 'block';
    tip.style.left = (lastMouse.x + 14) + 'px';
    tip.style.top = (lastMouse.y + 10) + 'px';
    tip.innerHTML = `<b>${hovered.name}</b><br>${hovered.st}${MODE === 'historical' ? ' &middot; ' + hovered.year : ''}<br>` +
      (s ? `${fmt(s.popOnly)} people affected` : 'no data at this drive time');
  }

  // ---- side panel --------------------------------------------------------

  const side = document.getElementById('side');
  function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }

  function updateSidePanel() {
    if (!selected) {
      side.innerHTML = `<p class="muted">${MODE === 'historical'
        ? 'Click a closure on the map to see its impact.'
        : 'Click a hospital to simulate the impact of it closing today.'}</p>` + legendHtml();
      return;
    }
    const s = itemStats(selected) || { popCatchment: 0, popOnly: 0 };
    const sysLabel = selected.sys && String(selected.sys).trim() ? selected.sys : 'Independent';
    const subParts = [selected.st, sysLabel];
    if (MODE === 'historical') subParts.push('closed ' + selected.year);
    subParts.push((selected.beds || '?') + ' beds');
    subParts.push(fmt(s.popCatchment) + ' total people within ' + driveTime + ' min');

    const headlineTail = MODE === 'historical'
      ? `left without a hospital within a ${driveTime} minute drive in ${selected.year}`
      : `left without a hospital within a ${driveTime} minute drive if this hospital closed today`;

    side.innerHTML = `
      <div class="side-head">
        <h3>${selected.name}</h3>
        <button id="close-selection" title="Close">&times;</button>
      </div>
      <p class="muted">${subParts.join(' &middot; ')}</p>
      <div class="stat-block">
        <div class="stat-num">${fmt(s.popOnly)}</div>
        <div class="stat-label">people ${headlineTail}</div>
      </div>
      ${legendHtml()}
    `;
    document.getElementById('close-selection').addEventListener('click', () => { selected = null; render(); });
  }

  function legendHtml() {
    return `<div class="legend">
      ${BIN_COLORS.map((c, i) => `<span><i style="background:${c}"></i>${BIN_LABELS[i]}</span>`).join('')}
    </div>`;
  }

  // ---- tabs + controls ----------------------------------------------------

  function setMode(newMode) {
    if (newMode === MODE) return;
    MODE = newMode;
    DATA = MODE === 'historical' ? HISTORICAL_DATA : CURRENT_DATA;
    items = MODE === 'historical' ? DATA.events : DATA.hospitals;
    selected = null; hovered = null; yearFilter = 'all';
    if (!DATA.driveTimes.includes(driveTime)) driveTime = DATA.driveTimes[0];
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === MODE));
    document.getElementById('year-select-wrap').style.display = MODE === 'historical' ? '' : 'none';
    buildDriveTimeControls();
    fitView();
    render();
  }

  function buildDriveTimeControls() {
    const dtWrap = document.getElementById('drive-time-controls');
    dtWrap.innerHTML = DATA.driveTimes.map(dt =>
      `<button data-dt="${dt}" class="dt-btn ${dt === driveTime ? 'active' : ''}">${dt} min</button>`).join('');
    dtWrap.querySelectorAll('.dt-btn').forEach(btn => btn.addEventListener('click', () => {
      driveTime = Number(btn.dataset.dt);
      dtWrap.querySelectorAll('.dt-btn').forEach(b => b.classList.toggle('active', b === btn));
      render();
    }));
  }

  function buildControls() {
    document.querySelectorAll('.tab-btn').forEach(btn =>
      btn.addEventListener('click', () => setMode(btn.dataset.mode)));

    buildDriveTimeControls();

    const years = Array.from(new Set(HISTORICAL_DATA.events.map(e => e.year))).sort();
    const yearSel = document.getElementById('year-select');
    yearSel.innerHTML = '<option value="all">All years</option>' +
      years.map(y => `<option value="${y}">${y}</option>`).join('');
    yearSel.addEventListener('change', () => {
      yearFilter = yearSel.value === 'all' ? 'all' : Number(yearSel.value);
      render();
    });

    document.getElementById('reset-view').addEventListener('click', () => { fitView(); render(); });
  }

  window.addEventListener('resize', () => { render(); });

  buildControls();
  fitView();
  render();
})();
