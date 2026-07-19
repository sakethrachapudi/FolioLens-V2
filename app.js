/* ============================================================
   FolioLens — Family Dashboard
   Reads pre-computed data.json (built every 6h by GitHub Actions
   running etl/build_data.py) for instant load. "Refresh Live"
   optionally re-fetches current NAVs client-side for a snappier
   in-session update of value/XIRR without waiting for the next
   scheduled run.
   ============================================================ */

const API_URL = 'https://script.google.com/macros/s/AKfycbzZrng_0FuzFdh-Iepf98O2FOTnesTCie9zlCfSXS_3DBc0w1-fRj41FARj9fupo5oM/exec';

const PORTFOLIOS = {
  s:  { sheet: 'Saketh',   label: 'Saketh',   accent: '#22d3ee', swp: false },
  su: { sheet: 'Suneetha', label: 'Suneetha', accent: '#f5c542', swp: true  },
  sa: { sheet: 'Samhitha', label: 'Samhitha', accent: '#d8b4fe', swp: false },
};
const TAB_ORDER = ['fam', 's', 'su', 'sa'];

const ISIN_SCHEME = {"INF090I01171":100471,"INF179K01608":101762,"INF789F01810":102394,"INF200K01370":102756,"INF174K01211":102875,"INF760K01167":102920,"INF789F01AG5":103098,"INF090I01841":103151,"INF204K01GE7":104637,"INF179K01CR2":105758,"INF090I01981":105817,"INF740K01037":105875,"INF109K01BL4":108466,"INF769K01101":112932,"INF846K01859":114564,"INF740K01LP6":117691,"INF754K01CE0":118624,"INF204K01XF9":118650,"INF204K01E54":118668,"INF179K01UT0":118955,"INF179K01XQ0":118989,"INF179K01XZ1":119062,"INF200K01RY0":119609,"INF174K01JP2":119750,"INF200K01UT4":119800,"INF109K01Y07":120251,"INF109K015K4":120334,"INF109K01S39":120616,"INF966L01689":120828,"INF879O01027":122639,"INF879O01019":122640,"INF179KA1RW5":130503,"INF200KA1473":133858,"INF277K01Z44":135797,"INF205K013T3":145137,"INF194KB1AL4":147946,"INF204KB19V4":148457,"INF109KC1O90":148653,"INF879O01175":148958,"INF109KC1R14":148990,"INF174KA1HV3":149185,"INF179KC1BV9":149366,"INF846K013E0":149383,"INF204KC1BL9":152034};

const PAL = ['#4ade80','#22d3ee','#f5c542','#d8b4fe','#f87171','#60a5fa','#fb923c','#a3e635','#e879f9','#38bdf8','#fbbf24','#34d399'];

// Category colors are assigned dynamically -- not from a hardcoded name list. Each
// distinct category (whatever text is already in your Sheet's Category column) gets
// the next unused color from the palette, in the order it's first encountered. This
// guarantees no two categories share a color (as long as you have fewer categories
// than palette entries), stays consistent across every tab, and needs no maintenance
// as you add new categories.
const CATEGORY_PALETTE = ['#4ade80','#22d3ee','#f5c542','#d8b4fe','#f87171','#60a5fa','#fb923c','#a3e635',
  '#e879f9','#38bdf8','#fbbf24','#34d399','#c084fc','#fb7185','#2dd4bf','#facc15','#818cf8','#f472b6',
  '#a78bfa','#fdba74'];
let categoryColorMap = {};
function catColor(cat) {
  const key = (cat || 'Other').trim() || 'Other';
  if (categoryColorMap[key]) return categoryColorMap[key];
  const used = new Set(Object.values(categoryColorMap));
  const free = CATEGORY_PALETTE.find(c => !used.has(c));
  const color = free || CATEGORY_PALETTE[Object.keys(categoryColorMap).length % CATEGORY_PALETTE.length];
  categoryColorMap[key] = color;
  return color;
}

/* ---------- utils ---------- */
const fmt   = n => '₹' + Math.round(n || 0).toLocaleString('en-IN');
const fmtK  = n => { const v = n||0; return Math.abs(v) >= 100000 ? '₹' + (v/100000).toFixed(1) + 'L' : '₹' + Math.round(v/1000) + 'k'; };
const pct   = n => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const posC  = n => (n == null || n >= 0) ? 'up' : 'down';
const posCol= n => (n == null || n >= 0) ? 'var(--ac)' : 'var(--rd)';
const td    = () => new Date().toISOString().slice(0,10);

// Must match .github/workflows/refresh-data.yml's cron times exactly (IST).
const SCHEDULE_TIMES_IST = [
  { h: 3, m: 20 }, { h: 5, m: 20 }, { h: 7, m: 50 }, { h: 10, m: 20 },
  { h: 12, m: 20 }, { h: 14, m: 20 }, { h: 18, m: 20 }, { h: 21, m: 20 },
];
function nextScheduledRefreshLabel() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const get = t => parseInt(parts.find(p => p.type === t).value, 10);
  const curMinutes = get('hour') * 60 + get('minute');

  let next = SCHEDULE_TIMES_IST.find(t => (t.h * 60 + t.m) > curMinutes);
  let tomorrow = false;
  if (!next) { next = SCHEDULE_TIMES_IST[0]; tomorrow = true; }

  const h12 = next.h % 12 === 0 ? 12 : next.h % 12;
  const ampm = next.h < 12 ? 'AM' : 'PM';
  return `${h12}:${String(next.m).padStart(2,'0')} ${ampm} IST${tomorrow ? ' tomorrow' : ''}`;
}
const esc   = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 2600);
}

/* client-side XIRR (mirrors etl/build_data.py's xirr()) — used only by "Refresh Live" */
function xirr(txns, fv, fDate) {
  const fl = txns.map(t => ({ t: new Date(t.d), a: -t.a }));
  fl.push({ t: new Date(fDate), a: fv });
  const t0 = fl[0].t, dy = fl.map(f => (f.t - t0) / 86400000);
  const npv = r => fl.reduce((s,f,i) => s + f.a / Math.pow(1+r, dy[i]/365), 0);
  const dnp = r => fl.reduce((s,f,i) => s - (dy[i]/365)*f.a / Math.pow(1+r, dy[i]/365+1), 0);
  let r = 0.12;
  for (let i = 0; i < 300; i++) {
    const n = npv(r), d = dnp(r);
    if (Math.abs(d) < 1e-14) break;
    const nr = r - n/d;
    if (Math.abs(nr - r) < 1e-10) { r = nr; break; }
    r = Math.max(nr, -0.9999);
  }
  return isFinite(r) ? r * 100 : null;
}

function fetchWithTimeout(url, ms) {
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(url).then(r => { clearTimeout(tid); resolve(r); }).catch(e => { clearTimeout(tid); reject(e); });
  });
}

async function fetchNAVLive(isin) {
  const schemeCode = ISIN_SCHEME[isin];
  if (schemeCode) {
    try {
      const url = `https://api.mfapi.in/mf/${schemeCode}`;
      const r = await fetchWithTimeout(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, 20000);
      if (r.ok) {
        const j = await r.json();
        if (j && j.data && j.data[0]) {
          const nav = parseFloat(j.data[0].nav);
          const prevNav = j.data[1] ? parseFloat(j.data[1].nav) : null;
          if (nav > 0) return { nav, prevNav: prevNav > 0 ? prevNav : null };
        }
      }
    } catch (e) { /* fall through */ }
  }
  try {
    const r = await fetchWithTimeout(`https://mf.captnemo.in/nav/${isin}`, 12000);
    if (r.ok) { const j = await r.json(); if (j.nav && parseFloat(j.nav) > 0) return { nav: parseFloat(j.nav), prevNav: null }; }
  } catch (e) { /* give up */ }
  return null;
}

/* JSONP fetch of the live Google Sheet — used by "Refresh Live" to pick up newly added transactions
   without waiting for the next scheduled GitHub Action run. */
function fetchSheetLive(sheetName) {
  return new Promise((resolve, reject) => {
    const cbName = 'cb_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    let done = false;
    window[cbName] = (data) => { done = true; delete window[cbName]; script.remove(); resolve(data); };
    script.onerror = () => { if (!done) { delete window[cbName]; script.remove(); reject(new Error('sheet fetch failed')); } };
    script.src = `${API_URL}?sheet=${encodeURIComponent(sheetName)}&callback=${cbName}`;
    document.body.appendChild(script);
    setTimeout(() => { if (!done) { delete window[cbName]; script.remove(); reject(new Error('timeout')); } }, 20000);
  });
}

let navSnapshotsCache = null;
function fetchNavSnapshotsLive() {
  if (navSnapshotsCache) return Promise.resolve(navSnapshotsCache);
  return new Promise((resolve) => {
    const cbName = 'cb_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    let done = false;
    window[cbName] = (data) => { done = true; delete window[cbName]; script.remove(); navSnapshotsCache = data.snapshots || {}; resolve(navSnapshotsCache); };
    script.onerror = () => { if (!done) { delete window[cbName]; script.remove(); navSnapshotsCache = {}; resolve({}); } };
    script.src = `${API_URL}?action=nav_snapshots&callback=${cbName}`;
    document.body.appendChild(script);
    setTimeout(() => { if (!done) { delete window[cbName]; script.remove(); navSnapshotsCache = {}; resolve({}); } }, 15000);
  });
}

function fetchSchedulesLive(sheetName) {
  return new Promise((resolve, reject) => {
    const cbName = 'cb_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    let done = false;
    window[cbName] = (data) => { done = true; delete window[cbName]; script.remove(); resolve(data); };
    script.onerror = () => { if (!done) { delete window[cbName]; script.remove(); reject(new Error('schedules fetch failed')); } };
    script.src = `${API_URL}?action=schedules&sheet=${encodeURIComponent(sheetName)}&callback=${cbName}`;
    document.body.appendChild(script);
    setTimeout(() => { if (!done) { delete window[cbName]; script.remove(); reject(new Error('timeout')); } }, 20000);
  });
}

/* client-side year-wise growth (mirrors etl/build_data.py's compute_year_wise()) */
function computeYearWiseJS(funds, navSnapshots, today) {
  const currentYear = String(new Date(today).getFullYear());
  const allYears = [...new Set(funds.flatMap(f => f.txns.map(t => t.d.slice(0,4))))].sort();

  const yearEndNav = (f, targetYr) => {
    if (targetYr === currentYear) return f.liveNav;
    const snap = navSnapshots[`${f.isin}_${targetYr}`];
    if (snap) return snap.nav;
    const yrTxns = f.txns.filter(t => t.d.slice(0,4) <= targetYr);
    return yrTxns.length ? yrTxns[yrTxns.length-1].n : null;
  };

  return allYears.map(yr => {
    const isPartial = yr === currentYear;
    let startVal = 0, endVal = 0;
    funds.forEach(f => {
      const prevYr = String(parseInt(yr) - 1);
      const startNav = yearEndNav(f, prevYr);
      const startUnits = f.txns.filter(t => t.d.slice(0,4) < yr && t.a > 0).reduce((s,t) => s+t.u, 0)
                        - f.txns.filter(t => t.d.slice(0,4) < yr && t.a < 0).reduce((s,t) => s+Math.abs(t.u), 0);
      if (startNav && startUnits > 0) startVal += startUnits * startNav;
      const endNav = yearEndNav(f, yr);
      const endUnits = f.txns.filter(t => t.d.slice(0,4) <= yr && t.a > 0).reduce((s,t) => s+t.u, 0)
                      - f.txns.filter(t => t.d.slice(0,4) <= yr && t.a < 0).reduce((s,t) => s+Math.abs(t.u), 0);
      if (endNav && endUnits > 0) endVal += endUnits * endNav;
    });
    const freshInvested = funds.flatMap(f => f.txns.filter(t => t.d.startsWith(yr) && t.a > 0)).reduce((s,t) => s+t.a, 0);
    const withdrawals = funds.flatMap(f => f.txns.filter(t => t.d.startsWith(yr) && t.a < 0)).reduce((s,t) => s+Math.abs(t.a), 0);
    const absGain = endVal - startVal - freshInvested + withdrawals;
    const gainPct = (startVal + freshInvested) > 0 ? absGain / (startVal + freshInvested) * 100 : 0;
    let yrXirr = null;
    try {
      const jan1 = `${yr}-01-01`, dec31 = isPartial ? today : `${yr}-12-31`;
      const yrCF = [];
      if (startVal > 0) yrCF.push({ d: jan1, a: startVal });
      funds.flatMap(f => f.txns.filter(t => t.d.startsWith(yr))).sort((a,b) => a.d.localeCompare(b.d)).forEach(t => {
        if (t.a !== 0) yrCF.push({ d: t.d, a: t.a });
      });
      if (yrCF.length && endVal > 0 && (new Date(dec31) - new Date(yrCF[0].d)) / 86400000 >= 30) {
        yrXirr = xirr(yrCF, endVal, dec31);
      }
    } catch (e) { /* ignore */ }
    return { yr, isPartial, startVal, endVal, freshInvested, withdrawals, absGain, gainPct, xirr: yrXirr };
  });
}

/* client-side nature-wise allocation (mirrors etl/build_data.py's nature grouping) */
function computeNatureJS(funds, today) {
  const natMap = {};
  funds.forEach(f => {
    const cat = f.cat || 'Other';
    const nm = natMap[cat] = natMap[cat] || { cat, value: 0, invested: 0, withdrawn: 0, fundCount: 0, txns: [] };
    nm.value += f.value;
    nm.invested += f.txns.reduce((s,t) => s+t.a, 0);
    nm.withdrawn += f.txns.filter(t=>t.a<0).reduce((s,t) => s+Math.abs(t.a), 0);
    nm.fundCount++;
    nm.txns.push(...f.txns);
  });
  return Object.values(natMap).map(n => ({
    cat: n.cat, value: n.value, invested: n.invested, withdrawn: n.withdrawn, fundCount: n.fundCount,
    xirr: xirr(n.txns, n.value, today),
  })).sort((a,b) => b.value - a.value);
}

/* ---------- state ---------- */
const cache = {};      // key -> portfolio object from data.json (mutated in place on live refresh)
const charts = {};     // key -> { growth, alloc }
const uiState = {};    // key -> { search, sort:{field,dir}, txnSearch, txnPage, allTxns, txnFiltered, lastRows }
let famData = null;    // data.json's "family" block
let dataMeta = null;   // { generatedAt }
let modalKey = null;

TAB_ORDER.forEach(k => { if (k !== 'fam') uiState[k] = { search: '', sort: { field: 'xirr', dir: 'desc' }, txnSearch: '', txnPage: 1 }; });

/* ============================================================
   DATA LOADING
   ============================================================ */
async function loadData() {
  const res = await fetch('./data.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('data.json not found (has the GitHub Action run yet?)');
  const json = await res.json();
  dataMeta = { generatedAt: json.generatedAt };
  Object.entries(PORTFOLIOS).forEach(([key, p]) => {
    const pdata = json.portfolios[p.sheet];
    if (pdata) cache[key] = pdata;
  });
  famData = json.family;
}

/* ============================================================
   RENDER: single portfolio tab
   ============================================================ */
function renderPortfolio(key) {
  const p = cache[key];
  if (!p) return;
  const cfg = PORTFOLIOS[key];
  const t = p.totals;

  document.getElementById(`${key}-dot`).className = 'dot';
  document.getElementById(`${key}-statusTxt`).textContent = 'Live';
  document.getElementById(`${key}-refreshBtn`).disabled = false;
  document.getElementById(`${key}-banner`).classList.remove('show');

  document.getElementById(`${key}-inv`).textContent = fmt(t.invested);
  document.getElementById(`${key}-invSub`).textContent = `${t.fundCount} funds`;
  document.getElementById(`${key}-val`).textContent = fmt(t.value);
  const withdrawn = t.withdrawn || 0;
  const gain = t.gain, gp = t.invested ? gain / t.invested * 100 : 0;
  document.getElementById(`${key}-gain`).innerHTML = `<span class="${posC(gain)}">${gain>=0?'+':''}${fmt(gain)} (${pct(gp)})</span>`
    + (withdrawn > 0 ? ` <span class="fund-cat">· ${fmt(withdrawn)} withdrawn</span>` : '');
  document.getElementById(`${key}-xirr`).innerHTML = `<span class="${posC(t.xirr)}">${t.xirr!=null?pct(t.xirr):'—'}</span>`;
  document.getElementById(`${key}-gainAbs`).innerHTML = `<span class="${posC(gain)}">${gain>=0?'+':'-'}${fmt(Math.abs(gain))}</span>`;
  document.getElementById(`${key}-mult`).textContent = t.invested ? `${((t.value+withdrawn)/t.invested).toFixed(2)}x invested (incl. withdrawn)` : '—';
  const dp = t.dayPnl || 0;
  document.getElementById(`${key}-dayPnl`).innerHTML = `<span class="${posC(dp)}">${dp>=0?'+':'-'}${fmt(Math.abs(dp))}</span>`;
  document.getElementById(`${key}-dayPnlSub`).textContent = t.dayPnlPct != null ? `${pct(t.dayPnlPct)} vs previous close` : 'no live NAVs to compare';

  const rows = p.funds.map((f, i) => ({ ...f, color: PAL[i % PAL.length] }));
  const EPS = 0.001;
  const activeRows = rows.filter(r => Math.abs(r.units) > EPS);
  const closedRows = rows.filter(r => Math.abs(r.units) <= EPS && r.invested > 0);
  uiState[key].allRows = activeRows;
  document.getElementById(`${key}-navDate`).textContent = `${activeRows.filter(r=>r.isLive).length}/${activeRows.length} live NAVs`;

  renderHoldingsTable(key);
  renderGainersLosers(key, activeRows);
  renderClosedPositions(key, closedRows);
  renderGrowthChart(key, p.yearWise, cfg.accent);
  renderAllocChart(key, p.nature);
  renderYearWise(key, p.yearWise);
  renderNature(key, p.nature, t.value);
  renderTxnLog(key, p.funds);
  if (cfg.swp && p.swp) renderSWP(key, p.swp);
}

function renderClosedPositions(key, closedRows) {
  const header = document.getElementById(`${key}-closedHeader`);
  if (!closedRows.length) { header.style.display = 'none'; return; }
  header.style.display = '';
  document.getElementById(`${key}-closedCount`).textContent = `${closedRows.length} fund${closedRows.length>1?'s':''}`;
  const tb = document.getElementById(`${key}-closedBody`);
  tb.innerHTML = closedRows.map(f => `<tr>
    <td><div class="fund-name-cell" onclick="openNavHistory('${key}','${f.isin}')">
      <span class="fund-dot" style="background:${f.color}"></span>
      <span><span class="fund-name-txt">${esc(f.name)}</span><br><span class="fund-cat">${esc(f.cat)}</span></span>
    </div></td>
    <td class="r mo">${fmt(f.invested)}</td>
    <td class="r mo">${fmt(f.withdrawn||0)}</td>
    <td class="r"><span class="mo ${posC(f.gain)}">${f.gain>=0?'+':'-'}${fmt(Math.abs(f.gain))}</span> <span class="bg ${f.gain>=0?'bgp':'bgn'}">${pct(f.gainPct)}</span></td>
    <td class="r mo ${posC(f.xirr)}">${f.xirr!=null?pct(f.xirr):'—'}</td>
    <td class="r"><button class="txn-act-btn" title="Reinvest" onclick="openAddTxn('${key}','${f.isin}','buy')">＋</button></td>
  </tr>`).join('');
}

function renderHoldingsTable(key) {
  const st = uiState[key];
  const rows = st.allRows || [];
  const q = st.search.trim().toLowerCase();
  let filtered = q ? rows.filter(r => r.name.toLowerCase().includes(q) || (r.cat||'').toLowerCase().includes(q) || r.isin.toLowerCase().includes(q)) : rows.slice();

  const dir = st.sort.dir === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    let av, bv;
    switch (st.sort.field) {
      case 'name': return dir * a.name.localeCompare(b.name);
      case 'invested': av = a.invested; bv = b.invested; break;
      case 'value': av = a.value; bv = b.value; break;
      case 'gain': av = a.gainPct; bv = b.gainPct; break;
      default: av = a.xirr ?? -Infinity; bv = b.xirr ?? -Infinity;
    }
    return (av - bv) * dir;
  });
  st.lastRows = filtered;

  const tb = document.getElementById(`${key}-tbody`);
  tb.innerHTML = filtered.map(f => {
    const bw = Math.min(Math.abs(f.xirr ?? 0) / 40 * 100, 100);
    return `<tr>
      <td><div class="fund-name-cell" onclick="openNavHistory('${key}','${f.isin}')">
        <span class="fund-dot" style="background:${f.color}"></span>
        <span><span class="fund-name-txt">${esc(f.name)}</span><br><span class="fund-cat">${esc(f.cat)}</span></span>
      </div></td>
      <td class="r mo">${f.units.toFixed(3)}</td>
      <td class="r mo">₹${(f.avgNav||0).toFixed(2)}</td>
      <td class="r mo">₹${(f.liveNav||0).toFixed(2)}${f.isLive?'':' <span class="fund-cat">(stmt)</span>'}</td>
      <td class="r mo">${fmt(f.invested)}</td>
      <td class="r mo">${fmt(f.value)}</td>
      <td class="r"><span class="mo ${posC(f.gain)}">${f.gain>=0?'+':'-'}${fmt(Math.abs(f.gain))}</span><br><span class="bg ${f.gain>=0?'bgp':'bgn'}">${pct(f.gainPct)}</span></td>
      <td class="r"><div class="xbar-wrap"><div class="xbar"><div class="xbar-fill" style="width:${bw}%;background:${posCol(f.xirr)}"></div></div><span class="mo ${posC(f.xirr)}" style="min-width:52px;display:inline-block;text-align:right">${f.xirr!=null?pct(f.xirr):'—'}</span></div></td>
      <td class="r"><div class="txn-actions">
        <button class="txn-act-btn" title="Buy more" onclick="openAddTxn('${key}','${f.isin}','buy')">＋</button>
        <button class="txn-act-btn danger" title="Sell" onclick="openAddTxn('${key}','${f.isin}','sell')">－</button>
      </div></td>
    </tr>`;
  }).join('');
  document.getElementById(`${key}-holdCount`).textContent = `${filtered.length} of ${rows.length} funds`;
}

function renderGainersLosers(key, rows) {
  const ranked = rows.filter(r => r.xirr != null).sort((a,b) => b.xirr - a.xirr);
  const chip = f => `<span class="chip" onclick="openNavHistory('${key}','${f.isin}')">${esc(f.name.split(' ').slice(0,3).join(' '))} <span class="x ${posC(f.xirr)}">${pct(f.xirr)}</span></span>`;
  document.getElementById(`${key}-gainers`).innerHTML = ranked.slice(0,3).map(chip).join('') || '<span class="fund-cat">—</span>';
  document.getElementById(`${key}-losers`).innerHTML = ranked.slice(-3).reverse().map(chip).join('') || '<span class="fund-cat">—</span>';
}

function renderYearWise(key, yearWise) {
  const el = document.getElementById(`${key}-yrGrid`);
  el.innerHTML = yearWise.slice().reverse().map(y => `
    <div class="yr-card">
      <div class="yr-card-hd"><span class="yr-label">${y.yr}${y.isPartial?' (YTD)':''}</span>
        <span class="bg ${posC(y.xirr)==='up'?'bgp':'bgn'}" title="Annualized XIRR">${y.xirr!=null?pct(y.xirr):'—'}</span></div>
      <div class="yr-row"><span>Start Value</span><span class="yr-val mo">${fmt(y.startVal)}</span></div>
      <div class="yr-row"><span>Fresh Invested</span><span class="yr-val mo">${fmt(y.freshInvested)}</span></div>
      ${y.withdrawals > 0 ? `<div class="yr-row"><span>Withdrawals</span><span class="yr-val mo" style="color:var(--rd)">-${fmt(y.withdrawals)}</span></div>` : ''}
      <div class="yr-row"><span>End Value</span><span class="yr-val mo">${fmt(y.endVal)}</span></div>
      <div class="yr-row"><span>Gain</span><span class="yr-val mo ${posC(y.absGain)}">${y.absGain>=0?'+':'-'}${fmt(Math.abs(y.absGain))}</span></div>
      <div class="yr-row"><span>Simple Return</span><span class="yr-val mo ${posC(y.gainPct)}">${pct(y.gainPct)}</span></div>
    </div>`).join('');
}

function renderNature(key, nature, totalVal) {
  const el = document.getElementById(`${key}-natureGrid`);
  el.innerHTML = nature.map(n => {
    const share = totalVal ? n.value / totalVal * 100 : 0;
    const gain = (n.value + (n.withdrawn||0)) - n.invested;
    return `<div class="nat-card">
      <div class="nat-hd"><span style="color:${catColor(n.cat)}">${esc(n.cat)}</span><span class="mo">${fmt(n.value)}</span></div>
      <div class="nat-bar"><div class="nat-bar-fill" style="width:${share}%;background:${catColor(n.cat)}"></div></div>
      <div class="nat-meta"><span>${share.toFixed(1)}% · ${n.fundCount} funds</span>
        <span class="${posC(n.xirr)}">${n.xirr!=null?pct(n.xirr):'—'} XIRR</span></div>
      <div class="nat-meta" style="margin-top:2px"><span>Invested ${fmt(n.invested)}</span>
        <span class="${posC(gain)}">${gain>=0?'+':'-'}${fmt(Math.abs(gain))}</span></div>
    </div>`;
  }).join('');
}

function renderSWP(key, swp) {
  document.getElementById(`${key}-swpWithdrawn`).textContent = fmt(swp.totalWithdrawn);
  document.getElementById(`${key}-swpCount`).textContent = `${swp.withdrawalCount} withdrawals (all-time)`;

  if (swp.avgMonthly > 0) {
    document.getElementById(`${key}-swpAvgMonthly`).textContent = fmt(swp.avgMonthly);
    document.getElementById(`${key}-swpAvgSub`).textContent = `${fmt(swp.yearWithdrawn)} over ${swp.monthsElapsed} mo in ${swp.currentYear}`;
    document.getElementById(`${key}-swpRunway`).textContent = swp.runwayMonths ? `${(swp.runwayMonths/12).toFixed(1)} yrs` : '—';
    document.getElementById(`${key}-swpSustain`).innerHTML = swp.sustainable
      ? `<span class="up">Sustainable</span>` : `<span class="down">Drawing principal</span>`;
    document.getElementById(`${key}-swpSustainSub`).textContent = `withdrawing ${swp.annualWithdrawalRatePct.toFixed(1)}%/yr vs XIRR`;
  } else {
    document.getElementById(`${key}-swpAvgMonthly`).textContent = '—';
    document.getElementById(`${key}-swpAvgSub`).textContent = `no withdrawals yet in ${swp.currentYear}`;
    document.getElementById(`${key}-swpRunway`).textContent = '—';
    document.getElementById(`${key}-swpSustain`).innerHTML = `<span class="fund-cat">Not enough data</span>`;
    document.getElementById(`${key}-swpSustainSub`).textContent = `waiting on ${swp.currentYear} withdrawals`;
  }
}

/* ============================================================
   SIP / SWP SCHEDULES
   ============================================================ */
async function loadSchedules(key) {
  try {
    const raw = await fetchSchedulesLive(PORTFOLIOS[key].sheet);
    renderSchedules(key, raw.schedules || []);
  } catch (e) {
    console.warn('Could not load schedules for', key, e);
  }
}

const DOW_LABEL = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function renderSchedules(key, schedules) {
  const header = document.getElementById(`${key}-schedHeader`);
  if (!schedules.length) { header.style.display = 'none'; return; }
  header.style.display = '';
  const activeCount = schedules.filter(s => s.status === 'active').length;
  document.getElementById(`${key}-schedCount`).textContent = `${activeCount} active · ${schedules.length} total`;

  document.getElementById(`${key}-schedBody`).innerHTML = schedules.map(s => {
    const dayLabel = s.frequency === 'weekly' ? DOW_LABEL[s.dayValue] || '' : `Day ${s.dayValue}`;
    const statusBadge = s.status === 'active' ? '<span class="bg bgp">Active</span>'
      : s.status === 'paused' ? '<span class="bg bgw">Paused</span>'
      : '<span class="bg bgo">Stopped</span>';
    const kindBadge = s.kind === 'swp' ? '<span class="bg bgn">SWP</span>' : '<span class="bg bgp">SIP</span>';
    let actions = '<span class="fund-cat">—</span>';
    if (s.status === 'active') {
      actions = `<div class="txn-actions">
        <button class="txn-act-btn" title="Pause" onclick="setScheduleStatus('${key}','${s.id}','paused')">⏸</button>
        <button class="txn-act-btn danger" title="Stop" onclick="setScheduleStatus('${key}','${s.id}','stopped')">■</button>
      </div>`;
    } else if (s.status === 'paused') {
      actions = `<div class="txn-actions">
        <button class="txn-act-btn" title="Resume" onclick="setScheduleStatus('${key}','${s.id}','active')">▶</button>
        <button class="txn-act-btn danger" title="Stop" onclick="setScheduleStatus('${key}','${s.id}','stopped')">■</button>
      </div>`;
    }
    return `<tr>
      <td>${esc(s.name)}<br><span class="fund-cat">${esc(s.cat)}</span></td>
      <td>${kindBadge}</td>
      <td class="r mo">${fmt(s.amount)}</td>
      <td class="mo">${s.frequency === 'weekly' ? 'Weekly · ' + dayLabel : 'Monthly · Day ' + s.dayValue}</td>
      <td class="mo">${s.nextDueDate || '—'}</td>
      <td>${statusBadge}</td>
      <td class="r">${actions}</td>
    </tr>`;
  }).join('');
}

async function setScheduleStatus(key, id, newStatus) {
  if (!checkPinUnlock()) return;
  if (newStatus === 'stopped' && !confirm('Stop this schedule permanently? It cannot be resumed later -- you would need to create a new one.')) return;
  try {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'set_schedule_status', id, status: newStatus }) });
    const j = await res.json().catch(() => ({}));
    if (j && j.error) throw new Error(j.error);
    toast(newStatus === 'active' ? 'Resumed' : newStatus === 'paused' ? 'Paused' : 'Stopped');
    loadSchedules(key);
  } catch (e) {
    toast('Could not update: ' + e.message);
  }
}

/* ---------- Create SIP/SWP modal ---------- */
let schModalKey = null, schModalKind = 'sip';

function openCreateSchedule(key, kind) {
  if (!checkPinUnlock()) return;
  schModalKey = key; schModalKind = kind;
  document.getElementById('schModalTitle').textContent = `${kind === 'swp' ? 'Create SWP' : 'Create SIP'} — ${PORTFOLIOS[key].label}`;

  const sel = document.getElementById('schFundSelect');
  const activeFunds = cache[key].funds.filter(f => Math.abs(f.units) > 0.001);
  let options = activeFunds.map(f => `<option value="${f.isin}">${esc(f.name)}</option>`).join('');
  if (kind === 'sip') options = '<option value="__new__">+ New fund…</option>' + options;
  sel.innerHTML = options || '<option value="">No active funds -- add one first</option>';

  document.getElementById('schNewFundBlock').style.display = 'none';
  document.getElementById('schAmount').value = '';
  document.getElementById('schFrequency').value = 'weekly';
  document.getElementById('schDayWeekly').value = '1';
  document.getElementById('schDayMonthly').value = '';
  document.getElementById('schStartDate').value = td();
  updateSchDayFields();
  updateSchNewFundVisibility();
  document.getElementById('schError').style.display = 'none';
  document.getElementById('schSubmitBtn').disabled = false;
  document.getElementById('schSubmitBtn').textContent = 'Create';
  document.getElementById('schModalOverlay').classList.add('show');
}

function closeSchModal() { document.getElementById('schModalOverlay').classList.remove('show'); }

function updateSchDayFields() {
  const freq = document.getElementById('schFrequency').value;
  document.getElementById('schDayWeeklyField').style.display = freq === 'weekly' ? 'block' : 'none';
  document.getElementById('schDayMonthlyField').style.display = freq === 'monthly' ? 'block' : 'none';
}

function updateSchNewFundVisibility() {
  const sel = document.getElementById('schFundSelect');
  document.getElementById('schNewFundBlock').style.display = sel.value === '__new__' ? 'block' : 'none';
}

async function submitSchedule() {
  const key = schModalKey;
  const sheet = PORTFOLIOS[key].sheet;
  const isinSel = document.getElementById('schFundSelect').value;
  const isNew = schModalKind === 'sip' && isinSel === '__new__';
  const amount = parseFloat(document.getElementById('schAmount').value);
  const frequency = document.getElementById('schFrequency').value;
  const dayValue = frequency === 'weekly'
    ? parseInt(document.getElementById('schDayWeekly').value)
    : parseInt(document.getElementById('schDayMonthly').value);
  const startDate = document.getElementById('schStartDate').value;
  const errBox = document.getElementById('schError');
  errBox.style.display = 'none';

  if (!isinSel) { errBox.textContent = 'No fund selected.'; errBox.style.display = 'block'; return; }
  if (!amount || amount <= 0) { errBox.textContent = 'A positive amount is required.'; errBox.style.display = 'block'; return; }
  if (!dayValue || (frequency === 'monthly' && (dayValue < 1 || dayValue > 31))) {
    errBox.textContent = 'Please pick a valid day.'; errBox.style.display = 'block'; return;
  }
  if (!startDate) { errBox.textContent = 'Start date is required.'; errBox.style.display = 'block'; return; }

  const payload = { action: 'create_schedule', sheet, kind: schModalKind, amount, frequency, dayValue, startDate };
  if (isNew) {
    payload.isin = document.getElementById('schNewIsin').value.trim();
    payload.name = document.getElementById('schNewName').value.trim();
    payload.cat = document.getElementById('schNewCat').value.trim();
    if (!payload.isin || !payload.name) { errBox.textContent = 'New fund needs at least ISIN and name.'; errBox.style.display = 'block'; return; }
  } else {
    payload.isin = isinSel;
  }

  const btn = document.getElementById('schSubmitBtn');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({}));
    if (j && j.error) throw new Error(j.error);
    btn.textContent = 'Created ✓';
    toast(`${schModalKind.toUpperCase()} scheduled — next due ${j.nextDueDate || ''}`);
    setTimeout(() => { closeSchModal(); btn.disabled = false; btn.textContent = 'Create'; loadSchedules(key); }, 700);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Create';
    errBox.textContent = 'Could not create — ' + e.message;
    errBox.style.display = 'block';
  }
}

/* ---------- transaction log (search + pagination) ---------- */
function renderTxnLog(key, funds) {
  const all = funds.flatMap(f => f.txns.map(t => ({ ...t, fundName: f.name, isin: f.isin, cat: f.cat })));
  all.sort((a,b) => b.d.localeCompare(a.d));
  uiState[key].allTxns = all;
  applyTxnFilter(key);
}
function applyTxnFilter(key) {
  const st = uiState[key];
  const q = (st.txnSearch||'').trim().toLowerCase();
  st.txnFiltered = q ? st.allTxns.filter(t => t.fundName.toLowerCase().includes(q) || (t.cat||'').toLowerCase().includes(q)) : st.allTxns;
  st.txnPage = 1;
  renderTxnPage(key);
}
function renderTxnPage(key) {
  const st = uiState[key];
  const pageSize = 50;
  const shown = st.txnFiltered.slice(0, st.txnPage * pageSize);
  document.getElementById(`${key}-txnBody`).innerHTML = shown.map(t => {
    const isBuy = t.a >= 0;
    const hasId = !!t.id;
    return `<tr><td class="mo">${t.d}</td><td>${esc(t.fundName)}</td>
      <td><span class="txn-type ${isBuy?'bgp':'bgn'}">${isBuy?'BUY':'SELL'}</span></td>
      <td class="r mo">${fmt(Math.abs(t.a))}</td><td class="r mo">${Math.abs(t.u).toFixed(3)}</td>
      <td class="r mo">₹${(t.n||0).toFixed(2)}</td>
      <td class="r"><div class="txn-actions">
        <button class="txn-act-btn" title="${hasId?'Edit':'Run backfillTxnIDs() in Apps Script to enable editing this older entry'}" ${hasId?'':'disabled'} onclick="openEditTxn('${key}','${t.id}')">✏️</button>
        <button class="txn-act-btn danger" title="${hasId?'Delete':'Run backfillTxnIDs() in Apps Script to enable deleting this older entry'}" ${hasId?'':'disabled'} onclick="deleteTxn('${key}','${t.id}')">🗑</button>
      </div></td></tr>`;
  }).join('');
  document.getElementById(`${key}-txnMore`).style.display = shown.length < st.txnFiltered.length ? 'block' : 'none';
  document.getElementById(`${key}-txnCount`).textContent = `${shown.length} of ${st.txnFiltered.length} transactions`;
}

/* ============================================================
   CHARTS
   ============================================================ */
const chartFont = { color: '#7a8aa0', font: { size: 10.5 } };
function renderGrowthChart(key, yearWise, accent) {
  const labels = yearWise.map(y => y.isPartial ? y.yr + ' (YTD)' : y.yr);
  const values = yearWise.map(y => Math.round(y.endVal));
  let cum = 0;
  const invested = yearWise.map(y => { cum += (y.freshInvested - y.withdrawals); return Math.round(cum); });
  const ctx = document.getElementById(`${key}-growthChart`);
  charts[key] = charts[key] || {};
  if (charts[key].growth) charts[key].growth.destroy();
  charts[key].growth = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Value', data: values, borderColor: accent, backgroundColor: accent+'33', fill: true, tension: .3, pointRadius: 3 },
      { label: 'Net Invested', data: invested, borderColor: '#7a8aa0', borderDash: [5,4], fill: false, tension: .2, pointRadius: 2 },
    ]},
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#e8edf5', font: { size: 11 } } } },
      scales: { x: { ticks: chartFont, grid: { color: '#2a3347' } },
                y: { ticks: { ...chartFont, callback: v => fmtK(v) }, grid: { color: '#2a3347' } } } }
  });
}
function renderAllocChart(key, nature) {
  const ctx = document.getElementById(`${key}-allocChart`);
  charts[key] = charts[key] || {};
  if (charts[key].alloc) charts[key].alloc.destroy();
  charts[key].alloc = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: nature.map(n => n.cat), datasets: [{ data: nature.map(n => Math.round(n.value)),
      backgroundColor: nature.map(n => catColor(n.cat)), borderColor: '#0e1117', borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { color: '#e8edf5', boxWidth: 11, font: { size: 10 } } } } }
  });
}

/* NAV history modal for a single fund */
function openNavHistory(key, isin) {
  const p = cache[key];
  const f = p.funds.find(x => x.isin === isin);
  if (!f) return;
  document.getElementById('navModalTitle').textContent = f.name;
  document.getElementById('navModalSub').textContent = `${f.cat} · ISIN ${f.isin}`;
  document.getElementById('navModalOverlay').classList.add('show');
  const ctx = document.getElementById('navHistChart');
  if (window._navChart) window._navChart.destroy();
  if (!f.navHistory || f.navHistory.length < 2) {
    document.getElementById('navHistEmpty').style.display = 'block';
    ctx.style.display = 'none';
    return;
  }
  document.getElementById('navHistEmpty').style.display = 'none';
  ctx.style.display = 'block';
  window._navChart = new Chart(ctx, {
    type: 'line',
    data: { labels: f.navHistory.map(h => h[0]), datasets: [{ data: f.navHistory.map(h => h[1]),
      borderColor: PORTFOLIOS[key].accent, backgroundColor: PORTFOLIOS[key].accent+'22', fill: true, tension: .15, pointRadius: 0, borderWidth: 1.5 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { ...chartFont, maxTicksLimit: 6 }, grid: { display: false } },
                y: { ticks: chartFont, grid: { color: '#2a3347' } } } }
  });
}
function closeNavHistory() { document.getElementById('navModalOverlay').classList.remove('show'); }

/* ============================================================
   FAMILY TAB
   ============================================================ */
function renderFamily() {
  const today = td();
  const t = famData.totals;
  const famWithdrawn = t.withdrawn || 0;
  document.getElementById('fam-inv').textContent = fmt(t.invested);
  document.getElementById('fam-val').textContent = fmt(t.value);
  document.getElementById('fam-gain').innerHTML = `<span class="${posC(t.gain)}">${t.gain>=0?'+':''}${fmt(t.gain)}</span>`
    + (famWithdrawn > 0 ? ` <span class="fund-cat">· ${fmt(famWithdrawn)} withdrawn</span>` : '');
  document.getElementById('fam-xirr').innerHTML = `<span class="${posC(t.xirr)}">${t.xirr!=null?pct(t.xirr):'—'}</span>`;
  document.getElementById('fam-gainAbs').innerHTML = `<span class="${posC(t.gain)}">${t.gain>=0?'+':'-'}${fmt(Math.abs(t.gain))}</span>`;
  document.getElementById('fam-mult').textContent = t.invested ? `${((t.value+famWithdrawn)/t.invested).toFixed(2)}x invested (incl. withdrawn)` : '—';
  const famDp = t.dayPnl || 0;
  document.getElementById('fam-dayPnl').innerHTML = `<span class="${posC(famDp)}">${famDp>=0?'+':'-'}${fmt(Math.abs(famDp))}</span>`;
  document.getElementById('fam-dayPnlSub').textContent = t.dayPnlPct != null ? `${pct(t.dayPnlPct)} vs previous close` : 'no live NAVs to compare';

  const cb = document.getElementById('fam-compareBody');
  cb.innerHTML = famData.compare.map(r => {
    const gain = (r.value + (r.withdrawn||0)) - r.invested, gp = r.invested ? gain/r.invested*100 : 0;
    const dp = r.dayPnl || 0;
    return `<tr><td><span class="compare-accent" style="color:${r.accent}"><span class="compare-dot" style="background:${r.accent}"></span>${esc(r.label)}</span></td>
      <td class="r mo">${fmt(r.invested)}</td><td class="r mo">${fmt(r.value)}</td>
      <td class="r mo ${posC(dp)}">${dp>=0?'+':'-'}${fmt(Math.abs(dp))}</td>
      <td class="r"><span class="mo ${posC(gain)}">${gain>=0?'+':'-'}${fmt(Math.abs(gain))}</span> <span class="bg ${gain>=0?'bgp':'bgn'}">${pct(gp)}</span></td>
      <td class="r mo ${posC(r.xirr)}">${r.xirr!=null?pct(r.xirr):'—'}</td></tr>`;
  }).join('');

  const ctx = document.getElementById('fam-growthChart');
  charts.fam = charts.fam || {};
  if (charts.fam.growth) charts.fam.growth.destroy();
  charts.fam.growth = new Chart(ctx, {
    type: 'line',
    data: { labels: famData.yearWise.map(y => y.isPartial ? y.yr+' (YTD)' : y.yr),
      datasets: famData.compare.map(r => {
        const yw = cache[Object.keys(PORTFOLIOS).find(k => PORTFOLIOS[k].sheet === r.sheet)]?.yearWise || [];
        const map = {}; yw.forEach(y => map[y.yr] = Math.round(y.endVal));
        return { label: r.label, data: famData.yearWise.map(y => map[y.yr] ?? null), spanGaps: true,
          borderColor: r.accent, backgroundColor: r.accent+'22', tension: .3, pointRadius: 3 };
      }) },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#e8edf5', font: { size: 11 } } } },
      scales: { x: { ticks: chartFont, grid: { color: '#2a3347' } },
                y: { ticks: { ...chartFont, callback: v => fmtK(v) }, grid: { color: '#2a3347' } } } }
  });

  renderYearWise('fam', famData.yearWise);

  // pooled allocation across all 3 portfolios — reuse computeNatureJS on the combined
  // funds list (with real txns) so category XIRR is actually computed, not stubbed.
  const allFunds = Object.values(cache).flatMap(p => p.funds);
  const famNature = computeNatureJS(allFunds, today);
  renderNature('fam', famNature, t.value);
  renderAllocChart('fam', famNature);
}

/* ============================================================
   LIVE REFRESH (manual button — client-side NAV re-fetch)
   ============================================================ */
/**
 * Family tab's single "Refresh All" button. Tries the proper path first (trigger the
 * GitHub Action, wait for data.json to actually update), and only falls back to a
 * direct Sheets+mfapi refresh if the workflow doesn't complete within a reasonable
 * window -- so under normal conditions everyone gets the same canonical data.json
 * everyone else will see too, not just a client-side-only view.
 */
async function refreshAllFromWorkflow() {
  const btn = document.getElementById('fam-refreshBtn');
  const banner = document.getElementById('fam-refreshBanner');
  const msg = document.getElementById('fam-refreshMsg');
  btn.disabled = true; btn.textContent = '↻ Refreshing…';
  banner.classList.add('show');
  msg.textContent = 'Triggering data refresh workflow…';

  const beforeGeneratedAt = dataMeta ? dataMeta.generatedAt : null;

  let triggerOk = false;
  try {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'trigger_refresh' }) });
    const j = await res.json().catch(() => ({}));
    triggerOk = !!(j && j.success);
  } catch (e) { triggerOk = false; }

  if (!triggerOk) {
    msg.textContent = 'Could not trigger the workflow — falling back to a direct refresh…';
    await fallbackDirectRefreshAll();
    return;
  }

  msg.textContent = 'Waiting for fresh data (this can take a minute or two)…';
  const maxAttempts = 12, intervalMs = 15000; // up to ~3 minutes
  let succeeded = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));
    msg.textContent = `Waiting for fresh data… (check ${attempt}/${maxAttempts})`;
    try {
      const res = await fetch(`./data.json?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (!beforeGeneratedAt || json.generatedAt !== beforeGeneratedAt) {
          dataMeta = { generatedAt: json.generatedAt };
          Object.entries(PORTFOLIOS).forEach(([key, p]) => {
            const pdata = json.portfolios[p.sheet];
            if (pdata) cache[key] = pdata;
          });
          famData = json.family;
          Object.keys(PORTFOLIOS).forEach(renderPortfolio);
          renderFamily();
          Object.keys(PORTFOLIOS).forEach(loadSchedules);
          const gen = new Date(dataMeta.generatedAt);
          document.getElementById('dataFreshness').textContent =
            `Data as of ${gen.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · next scheduled refresh ${nextScheduledRefreshLabel()}`;
          succeeded = true;
          break;
        }
      }
    } catch (e) { /* keep trying */ }
  }

  if (succeeded) {
    toast('Refreshed from the latest workflow run — all 4 pages updated');
    banner.classList.remove('show');
    btn.disabled = false; btn.textContent = '↻ Refresh All';
  } else {
    msg.textContent = 'Workflow is taking longer than expected — falling back to a direct refresh…';
    await fallbackDirectRefreshAll();
  }
}

async function fallbackDirectRefreshAll() {
  const banner = document.getElementById('fam-refreshBanner');
  const msg = document.getElementById('fam-refreshMsg');
  const btn = document.getElementById('fam-refreshBtn');
  for (const key of Object.keys(PORTFOLIOS)) {
    msg.textContent = `Refreshing ${PORTFOLIOS[key].label} directly from Sheets + mfapi…`;
    await refreshLive(key, true);
  }
  toast('Refreshed directly from Sheets + mfapi (workflow fallback) — all 4 pages updated');
  banner.classList.remove('show');
  btn.disabled = false; btn.textContent = '↻ Refresh All';
}

async function refreshLive(key, silent) {
  const p = cache[key];
  if (!p) return;
  const btn = document.getElementById(`${key}-refreshBtn`);
  if (!silent) { btn.disabled = true; btn.textContent = '↻ Syncing…'; }
  document.getElementById(`${key}-dot`).className = 'dot spin';
  document.getElementById(`${key}-statusTxt`).textContent = 'Syncing transactions…';

  const today = td();
  const oldNavHistory = {}; const oldPrevNav = {};
  p.funds.forEach(f => { oldNavHistory[f.isin] = f.navHistory; oldPrevNav[f.isin] = f.prevNav; });

  // 1) re-fetch the transaction list from the Sheet — this is what picks up new/edited entries
  let raw;
  try {
    raw = await fetchSheetLive(PORTFOLIOS[key].sheet);
    if (raw.error) throw new Error(raw.error);
  } catch (e) {
    toast('Could not sync transactions from Sheet: ' + e.message);
    if (!silent) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
    document.getElementById(`${key}-dot`).className = 'dot';
    document.getElementById(`${key}-statusTxt`).textContent = 'Live';
    return;
  }

  // 2) re-fetch live NAVs for every fund (including any brand-new ones)
  document.getElementById(`${key}-statusTxt`).textContent = 'Fetching live NAVs…';
  let updated = 0;
  const newFunds = [];
  for (const f of raw.funds) {
    const live = await fetchNAVLive(f.isin);
    const liveNav = live ? live.nav : f.statementNav;
    const isLive = !!live;
    if (isLive) updated++;
    const prevNav = (live && live.prevNav) || oldPrevNav[f.isin] || null;
    const value = f.units * liveNav;
    const fundWithdrawn = f.txns.filter(t=>t.a<0).reduce((s,t) => s+Math.abs(t.a), 0);
    const gain = (value + fundWithdrawn) - f.invested;
    const gainPct = f.invested ? gain / f.invested * 100 : 0;
    const dayPnl = (isLive && prevNav) ? (liveNav - prevNav) * f.units : 0;
    const dayPnlPct = (isLive && prevNav) ? ((liveNav / prevNav) - 1) * 100 : null;
    const finalDate = isLive ? today : (f.txns.length ? f.txns[f.txns.length-1].d : today);
    const totalBuyUnits = f.txns.filter(t => t.a > 0).reduce((s,t) => s+t.u, 0);
    newFunds.push({
      isin: f.isin, name: f.name, cat: f.cat, units: f.units, invested: f.invested,
      statementNav: f.statementNav, avgNav: totalBuyUnits ? f.invested/totalBuyUnits : 0,
      liveNav, navDate: isLive ? today : 'stmt', isLive, prevNav, dayPnl, dayPnlPct,
      value, withdrawn: fundWithdrawn, gain, gainPct,
      xirr: xirr(f.txns, value, finalDate), navHistory: oldNavHistory[f.isin] || [], txns: f.txns,
    });
  }
  p.funds = newFunds;

  // 3) recompute totals + portfolio xirr
  p.totals.invested = p.funds.reduce((s,f) => s+f.invested, 0);
  p.totals.value = p.funds.reduce((s,f) => s+f.value, 0);
  p.totals.fundCount = p.funds.length;
  const allTxnsCF = p.funds.flatMap(f => f.txns);
  p.totals.xirr = xirr(allTxnsCF, p.totals.value, today);
  p.totals.withdrawn = p.funds.reduce((s,f) => s + f.txns.filter(t=>t.a<0).reduce((s2,t)=>s2+Math.abs(t.a),0), 0);
  p.totals.gain = (p.totals.value + p.totals.withdrawn) - p.totals.invested;
  p.totals.dayPnl = p.funds.reduce((s,f) => s + f.dayPnl, 0);
  const dayPnlBase = p.funds.reduce((s,f) => s + ((f.isLive && f.prevNav) ? f.units * f.prevNav : 0), 0);
  p.totals.dayPnlPct = dayPnlBase ? (p.totals.dayPnl / dayPnlBase * 100) : null;
  const ranked = [...p.funds].filter(f=>f.xirr!=null).sort((a,b)=>b.xirr-a.xirr);
  p.gainers = ranked.slice(0,3).map(g=>({isin:g.isin,name:g.name,xirr:g.xirr}));
  p.losers = ranked.slice(-3).reverse().map(g=>({isin:g.isin,name:g.name,xirr:g.xirr}));

  // 4) recompute year-wise growth (Fresh Invested / Withdrawals) + nature-wise allocation
  document.getElementById(`${key}-statusTxt`).textContent = 'Recomputing analytics…';
  const navSnapshots = await fetchNavSnapshotsLive();
  p.yearWise = computeYearWiseJS(p.funds, navSnapshots, today);
  p.nature = computeNatureJS(p.funds, today);
  if (PORTFOLIOS[key].swp) {
    p.swp = recomputeSWP(p.funds, p.totals.value, p.totals.xirr, today);
  }

  renderPortfolio(key);
  if (!silent) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
  toast(`Synced · ${p.funds.length} funds, ${updated} live NAVs`);

  syncFamilyFromCache(navSnapshots, today);
  loadSchedules(key);
}

function recomputeSWP(funds, totalValue, portXirr, todayStr) {
  const today = new Date(todayStr);
  const allTxns = funds.flatMap(f => f.txns);
  const withdrawals = allTxns.filter(t => t.a < 0);
  const totalWithdrawn = withdrawals.reduce((s,t) => s+Math.abs(t.a), 0);

  const currentYear = String(today.getFullYear());
  const yrWithdrawals = withdrawals.filter(t => t.d.slice(0,4) === currentYear);
  const yearWithdrawn = yrWithdrawals.reduce((s,t) => s+Math.abs(t.a), 0);
  const monthsElapsed = today.getMonth() + 1; // Jan=1 ... Dec=12
  const avgMonthly = monthsElapsed > 0 ? yearWithdrawn / monthsElapsed : 0;

  const runwayMonths = avgMonthly > 0 ? totalValue / avgMonthly : null;
  const annualWithdrawalRatePct = totalValue > 0 ? avgMonthly * 12 / totalValue * 100 : 0;
  const sustainable = avgMonthly > 0 ? (portXirr != null && annualWithdrawalRatePct < portXirr) : null;
  return { totalWithdrawn, withdrawalCount: withdrawals.length, avgMonthly, runwayMonths,
    annualWithdrawalRatePct, sustainable, yearWithdrawn, monthsElapsed, currentYear };
}

/* keeps the Family tab consistent with whatever's freshest in `cache` after any live refresh */
function syncFamilyFromCache(navSnapshots, today) {
  if (!famData) return;
  const keys = Object.keys(PORTFOLIOS);
  famData.totals.invested = keys.reduce((s,k) => s + (cache[k]?.totals.invested || 0), 0);
  famData.totals.value = keys.reduce((s,k) => s + (cache[k]?.totals.value || 0), 0);
  famData.totals.withdrawn = keys.reduce((s,k) => s + (cache[k]?.totals.withdrawn || 0), 0);
  famData.totals.gain = (famData.totals.value + famData.totals.withdrawn) - famData.totals.invested;
  famData.totals.dayPnl = keys.reduce((s,k) => s + (cache[k]?.totals.dayPnl || 0), 0);
  const famDayPnlBase = keys.reduce((s,k) => s + (cache[k]?.funds || []).reduce((s2,f) => s2 + ((f.isLive && f.prevNav) ? f.units * f.prevNav : 0), 0), 0);
  famData.totals.dayPnlPct = famDayPnlBase ? (famData.totals.dayPnl / famDayPnlBase * 100) : null;
  const allTxnsCF = keys.flatMap(k => (cache[k]?.funds || []).flatMap(f => f.txns));
  famData.totals.xirr = xirr(allTxnsCF, famData.totals.value, today);
  famData.compare = keys.map(k => ({ sheet: PORTFOLIOS[k].sheet, label: PORTFOLIOS[k].label, accent: PORTFOLIOS[k].accent,
    invested: cache[k]?.totals.invested || 0, value: cache[k]?.totals.value || 0,
    withdrawn: cache[k]?.totals.withdrawn || 0, dayPnl: cache[k]?.totals.dayPnl || 0, xirr: cache[k]?.totals.xirr ?? null }));
  const allFunds = keys.flatMap(k => cache[k]?.funds || []);
  famData.yearWise = computeYearWiseJS(allFunds, navSnapshots, today);
  if (document.getElementById('panel-fam').classList.contains('active')) renderFamily();
}

/* ============================================================
   CSV EXPORT
   ============================================================ */
function downloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function exportHoldingsCSV(key) {
  const rows = [['Fund','ISIN','Category','Units','Invested','Current Value','Gain','XIRR%']];
  (uiState[key].lastRows || cache[key].funds).forEach(f => rows.push([f.name, f.isin, f.cat, f.units, f.invested, Math.round(f.value), Math.round(f.gain), f.xirr!=null?f.xirr.toFixed(2):'']));
  downloadCSV(`${PORTFOLIOS[key].label}_holdings_${td()}.csv`, rows);
}
function exportTxnCSV(key) {
  const rows = [['Date','Fund','ISIN','Type','Amount','Units','NAV']];
  uiState[key].allTxns.forEach(t => rows.push([t.d, t.fundName, t.isin, t.a>=0?'BUY':'SELL', Math.abs(t.a), Math.abs(t.u), t.n]));
  downloadCSV(`${PORTFOLIOS[key].label}_transactions_${td()}.csv`, rows);
}

/* ============================================================
   ADD / EDIT / DELETE TRANSACTION
   ============================================================ */
let modalMode = 'add';      // 'add' | 'edit'
let modalEditId = null;
let modalIsin = null;        // fund isin this modal is operating on (null only for New Fund flow)
let modalIsNewFund = false;  // true only for the top-level "+ New Fund" flow

/* ============================================================
   PIN GATE (soft guard against accidental taps, not real security --
   this is a public static site, so a determined person could always
   find the Apps Script URL directly. Change DASHBOARD_PIN to whatever
   you like; it's visible in this file's source, same as everything else here.)
   ============================================================ */
const DASHBOARD_PIN = '2026';
function checkPinUnlock() {
  if (sessionStorage.getItem('fl_unlocked') === '1') return true;
  const entered = prompt('Enter PIN to add/edit/delete transactions:');
  if (entered === null) return false;
  if (entered === DASHBOARD_PIN) { sessionStorage.setItem('fl_unlocked', '1'); return true; }
  toast('Incorrect PIN');
  return false;
}

/* isin omitted -> top-level "+ New Fund" flow. isin provided -> Buy/Sell button on a
   specific holdings or closed-position row, with presetType defaulting the Type field. */
function openAddTxn(key, isin, presetType) {
  if (!checkPinUnlock()) return;
  modalKey = key; modalMode = 'add'; modalEditId = null;
  modalIsin = isin || null;
  modalIsNewFund = !isin;

  if (modalIsNewFund) {
    document.getElementById('txnModalTitle').textContent = `Add New Fund — ${PORTFOLIOS[key].label}`;
    document.getElementById('txnFundField').style.display = 'none';
    document.getElementById('txnNewFundBlock').style.display = 'block';
  } else {
    const fund = cache[key].funds.find(f => f.isin === isin);
    document.getElementById('txnModalTitle').textContent = `${presetType === 'sell' ? 'Sell' : 'Buy'} — ${fund ? fund.name : isin}`;
    document.getElementById('txnFundDisplay').textContent = fund ? `${fund.name} · ${fund.cat}` : isin;
    document.getElementById('txnFundField').style.display = '';
    document.getElementById('txnNewFundBlock').style.display = 'none';
  }
  document.getElementById('txnType').value = presetType || 'buy';
  document.getElementById('txnDate').value = td();
  document.getElementById('txnAmount').value = '';
  document.getElementById('txnNav').value = '';
  document.getElementById('txnSellAll').checked = false;
  applySellAllState(false);
  updateSellAllVisibility();
  document.getElementById('txnError').style.display = 'none';
  document.getElementById('txnSubmitBtn').textContent = 'Save Transaction';
  document.getElementById('txnModalOverlay').classList.add('show');
}

function openEditTxn(key, id) {
  if (!checkPinUnlock()) return;
  const txn = (uiState[key].allTxns || []).find(t => t.id === id);
  if (!txn) { toast('Could not find that transaction'); return; }
  modalKey = key; modalMode = 'edit'; modalEditId = id;
  modalIsin = txn.isin; modalIsNewFund = false;
  document.getElementById('txnModalTitle').textContent = `Edit Transaction — ${txn.fundName}`;
  document.getElementById('txnFundField').style.display = '';
  document.getElementById('txnFundDisplay').textContent = `${txn.fundName}${txn.cat ? ' · ' + txn.cat : ''}`;
  document.getElementById('txnNewFundBlock').style.display = 'none';
  document.getElementById('txnType').value = txn.a >= 0 ? 'buy' : 'sell';
  document.getElementById('txnDate').value = txn.d;
  document.getElementById('txnAmount').value = Math.abs(txn.a);
  document.getElementById('txnNav').value = txn.n || '';
  applySellAllState(false);
  updateSellAllVisibility();
  document.getElementById('txnError').style.display = 'none';
  document.getElementById('txnSubmitBtn').textContent = 'Save Changes';
  document.getElementById('txnModalOverlay').classList.add('show');
}

function closeTxnModal() { document.getElementById('txnModalOverlay').classList.remove('show'); }
document.addEventListener('change', e => {
  if (!e.target) return;
  if (e.target.id === 'txnType') updateSellAllVisibility();
  if (e.target.id === 'txnSellAll') applySellAllState(e.target.checked);
  if (e.target.id === 'schFrequency') updateSchDayFields();
  if (e.target.id === 'schFundSelect') updateSchNewFundVisibility();
});

function updateSellAllVisibility() {
  const type = document.getElementById('txnType').value;
  const show = modalMode === 'add' && type === 'sell' && !modalIsNewFund && modalIsin;
  document.getElementById('txnSellAllBlock').style.display = show ? 'block' : 'none';
  if (!show) {
    document.getElementById('txnSellAll').checked = false;
    applySellAllState(false);
  }
}

function applySellAllState(checked) {
  const amountInput = document.getElementById('txnAmount');
  const amountLabel = document.getElementById('txnAmountLabel');
  const navLabel = document.getElementById('txnNavLabel');
  if (checked) {
    const fund = cache[modalKey]?.funds.find(f => f.isin === modalIsin);
    amountInput.value = '';
    amountInput.disabled = true;
    amountInput.placeholder = 'auto (all units × NAV)';
    amountLabel.textContent = 'Amount (auto)';
    navLabel.textContent = 'NAV (required)';
    const navInput = document.getElementById('txnNav');
    if (!navInput.value && fund?.liveNav) navInput.value = fund.liveNav;
  } else {
    amountInput.disabled = false;
    amountInput.placeholder = '10000';
    amountLabel.textContent = 'Amount (₹)';
    navLabel.textContent = 'NAV (optional)';
  }
}

async function submitTxn() {
  const key = modalKey;
  const sheet = PORTFOLIOS[key].sheet;
  const isNew = modalMode === 'add' && modalIsNewFund;
  const type = document.getElementById('txnType').value;
  const date = document.getElementById('txnDate').value;
  const sellAll = modalMode === 'add' && !modalIsNewFund && document.getElementById('txnSellAll').checked;
  const navInput = parseFloat(document.getElementById('txnNav').value);
  const errBox = document.getElementById('txnError');
  errBox.style.display = 'none';

  let amount, explicitUnits = null;
  if (sellAll) {
    const fund = cache[key]?.funds.find(f => f.isin === modalIsin);
    if (!fund || Math.abs(fund.units) < 0.001) { errBox.textContent = 'No units currently held in this fund to sell.'; errBox.style.display = 'block'; return; }
    if (!navInput || navInput <= 0) { errBox.textContent = 'NAV is required to sell all units (used to compute the amount).'; errBox.style.display = 'block'; return; }
    explicitUnits = fund.units;
    amount = fund.units * navInput;
  } else {
    amount = parseFloat(document.getElementById('txnAmount').value);
  }
  if (!date || !amount || amount <= 0) { errBox.textContent = 'Date and a positive amount are required.'; errBox.style.display = 'block'; return; }
  if (type === 'sell' && !sellAll && modalMode === 'add' && !isNew) {
    const fund = cache[key]?.funds.find(f => f.isin === modalIsin);
    if (fund && Math.abs(fund.units) < 0.001) {
      errBox.textContent = 'This fund has no units currently held — nothing to sell. Use "Sell all units" only if you\'re certain.';
      errBox.style.display = 'block';
      return;
    }
  }

  const payload = {
    action: modalMode === 'edit' ? 'edit_txn' : 'add_txn',
    sheet, date, amount: type === 'sell' ? -Math.abs(amount) : Math.abs(amount),
  };
  if (explicitUnits != null) { payload.units = explicitUnits; payload.nav = navInput; }
  else if (navInput) { payload.nav = navInput; payload.units = payload.amount / navInput; }
  if (modalMode === 'edit') {
    payload.id = modalEditId;
    payload.isin = modalIsin;
  } else if (isNew) {
    payload.isNewFund = true;
    payload.isin = document.getElementById('txnNewIsin').value.trim();
    payload.name = document.getElementById('txnNewName').value.trim();
    payload.cat = document.getElementById('txnNewCat').value.trim();
    if (!payload.isin || !payload.name) { errBox.textContent = 'New fund needs at least ISIN and name.'; errBox.style.display = 'block'; return; }
  } else {
    payload.isin = modalIsin;
  }

  const btn = document.getElementById('txnSubmitBtn');
  btn.disabled = true; btn.textContent = modalMode === 'edit' ? 'Saving…' : 'Saving…';
  try {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({}));
    if (j && j.error) throw new Error(j.error);
    btn.textContent = 'Saved ✓';
    toast(modalMode === 'edit' ? 'Transaction updated — syncing dashboard…' : 'Transaction saved — syncing dashboard…');
    setTimeout(() => { closeTxnModal(); btn.disabled = false; btn.textContent = 'Save Transaction'; refreshLive(key, true); }, 700);
  } catch (e) {
    btn.disabled = false; btn.textContent = modalMode === 'edit' ? 'Save Changes' : 'Save Transaction';
    errBox.textContent = 'Could not save — your Apps Script may not have this handler set up yet. See the setup note below.';
    errBox.style.display = 'block';
  }
}

async function deleteTxn(key, id) {
  if (!checkPinUnlock()) return;
  const txn = (uiState[key].allTxns || []).find(t => t.id === id);
  if (!txn) { toast('Could not find that transaction'); return; }
  const isBuy = txn.a >= 0;
  const confirmMsg = `Delete this transaction?\n\n${isBuy ? 'BUY' : 'SELL'} · ${txn.fundName}\n${txn.d} · ${fmt(Math.abs(txn.a))}\n\nThis removes the row from your Google Sheet and cannot be undone from the dashboard.`;
  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'delete_txn', sheet: PORTFOLIOS[key].sheet, id }) });
    const j = await res.json().catch(() => ({}));
    if (j && j.error) throw new Error(j.error);
    toast('Transaction deleted — syncing dashboard…');
    refreshLive(key, true);
  } catch (e) {
    toast('Could not delete: ' + e.message);
  }
}

function copySetupCode() {
  const code = document.getElementById('setupCode').textContent;
  navigator.clipboard?.writeText(code).then(() => toast('Copied to clipboard'));
}

/* ============================================================
   TABS + INIT
   ============================================================ */
function switchTab(key) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.key === key));
  document.querySelectorAll('.bn-btn').forEach(b => b.classList.toggle('active', b.dataset.key === key));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${key}`));
  history.replaceState(null, '', `#${key}`);
}

function wireEvents() {
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.key)));
  document.querySelectorAll('.bn-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.key)));
  document.getElementById('fam-refreshBtn').addEventListener('click', refreshAllFromWorkflow);

  Object.keys(PORTFOLIOS).forEach(key => {
    document.getElementById(`${key}-refreshBtn`).addEventListener('click', () => refreshLive(key));
    document.getElementById(`${key}-addTxnBtn`).addEventListener('click', () => openAddTxn(key));
    document.getElementById(`${key}-createSipBtn`).addEventListener('click', () => openCreateSchedule(key, 'sip'));
    document.getElementById(`${key}-createSwpBtn`).addEventListener('click', () => openCreateSchedule(key, 'swp'));
    document.getElementById(`${key}-exportHoldBtn`).addEventListener('click', () => exportHoldingsCSV(key));
    document.getElementById(`${key}-exportTxnBtn`).addEventListener('click', () => exportTxnCSV(key));
    document.getElementById(`${key}-printBtn`).addEventListener('click', () => window.print());
    document.getElementById(`${key}-search`).addEventListener('input', e => { uiState[key].search = e.target.value; renderHoldingsTable(key); });
    document.getElementById(`${key}-txnSearch`).addEventListener('input', e => { uiState[key].txnSearch = e.target.value; applyTxnFilter(key); });
    document.getElementById(`${key}-txnMore`).addEventListener('click', () => { uiState[key].txnPage++; renderTxnPage(key); });
    document.querySelectorAll(`#panel-${key} th.sortable`).forEach(th => th.addEventListener('click', () => {
      const st = uiState[key], field = th.dataset.sort;
      st.sort = st.sort.field === field ? { field, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'desc' };
      renderHoldingsTable(key);
    }));
  });

  document.getElementById('txnModalOverlay').addEventListener('click', e => { if (e.target.id === 'txnModalOverlay') closeTxnModal(); });
  document.getElementById('navModalOverlay').addEventListener('click', e => { if (e.target.id === 'navModalOverlay') closeNavHistory(); });
  document.getElementById('schModalOverlay').addEventListener('click', e => { if (e.target.id === 'schModalOverlay') closeSchModal(); });
}

async function init() {
  document.getElementById('s-panel-mount').outerHTML = window.PANEL_S;
  document.getElementById('su-panel-mount').outerHTML = window.PANEL_SU;
  document.getElementById('sa-panel-mount').outerHTML = window.PANEL_SA;
  wireEvents();

  try {
    await loadData();
    Object.keys(PORTFOLIOS).forEach(renderPortfolio);
    Object.keys(PORTFOLIOS).forEach(loadSchedules);
    renderFamily();
    const gen = new Date(dataMeta.generatedAt);
    document.getElementById('dataFreshness').textContent = `Data as of ${gen.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · next scheduled refresh ${nextScheduledRefreshLabel()}`;
  } catch (e) {
    document.getElementById('dataFreshness').textContent = 'Could not load data.json — ' + e.message;
    console.error(e);
  }

  const startKey = (location.hash || '#fam').replace('#', '');
  switchTab(TAB_ORDER.includes(startKey) ? startKey : 'fam');

  // swipe between tabs (mobile) — but not when the touch starts inside a horizontally
  // scrollable table (holdings/transactions/comparison), so scrolling those doesn't
  // accidentally change tabs.
  let touchX = null, touchStartedInScroll = false;
  document.querySelector('.page').addEventListener('touchstart', e => {
    touchX = e.touches[0].clientX;
    touchStartedInScroll = !!e.target.closest('.tw');
  }, { passive: true });
  document.querySelector('.page').addEventListener('touchend', e => {
    if (touchX == null || touchStartedInScroll) { touchX = null; touchStartedInScroll = false; return; }
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 70) {
      const cur = TAB_ORDER.indexOf((location.hash||'#fam').replace('#',''));
      const next = dx < 0 ? Math.min(cur+1, TAB_ORDER.length-1) : Math.max(cur-1, 0);
      switchTab(TAB_ORDER[next]);
    }
    touchX = null;
  }, { passive: true });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.addEventListener('DOMContentLoaded', init);
