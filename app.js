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
const NAT_PAL = { 'Large Cap':'#4ade80','Mid Cap':'#22d3ee','Small Cap':'#f5c542','Flexi Cap':'#d8b4fe',
  'Multi Cap':'#f87171','ELSS':'#60a5fa','Debt':'#fb923c','Hybrid':'#a3e635','Index':'#e879f9',
  'International':'#38bdf8','Gold':'#fbbf24','Other':'#4a5568' };
const catColor = c => NAT_PAL[c] || NAT_PAL.Other;

/* ---------- utils ---------- */
const fmt   = n => '₹' + Math.round(n || 0).toLocaleString('en-IN');
const fmtK  = n => { const v = n||0; return Math.abs(v) >= 100000 ? '₹' + (v/100000).toFixed(1) + 'L' : '₹' + Math.round(v/1000) + 'k'; };
const pct   = n => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const posC  = n => (n == null || n >= 0) ? 'up' : 'down';
const posCol= n => (n == null || n >= 0) ? 'var(--ac)' : 'var(--rd)';
const td    = () => new Date().toISOString().slice(0,10);
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
          if (nav > 0) return { nav };
        }
      }
    } catch (e) { /* fall through */ }
  }
  try {
    const r = await fetchWithTimeout(`https://mf.captnemo.in/nav/${isin}`, 12000);
    if (r.ok) { const j = await r.json(); if (j.nav && parseFloat(j.nav) > 0) return { nav: parseFloat(j.nav) }; }
  } catch (e) { /* give up */ }
  return null;
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
  const gain = t.gain, gp = t.invested ? gain / t.invested * 100 : 0;
  document.getElementById(`${key}-gain`).innerHTML = `<span class="${posC(gain)}">${gain>=0?'+':''}${fmt(gain)} (${pct(gp)})</span>`;
  document.getElementById(`${key}-xirr`).innerHTML = `<span class="${posC(t.xirr)}">${t.xirr!=null?pct(t.xirr):'—'}</span>`;
  document.getElementById(`${key}-gainAbs`).innerHTML = `<span class="${posC(gain)}">${gain>=0?'+':'-'}${fmt(Math.abs(gain))}</span>`;
  document.getElementById(`${key}-mult`).textContent = t.invested ? `${(t.value/t.invested).toFixed(2)}x invested` : '—';

  const rows = p.funds.map((f, i) => ({ ...f, color: PAL[i % PAL.length] }));
  uiState[key].allRows = rows;
  document.getElementById(`${key}-navDate`).textContent = `${rows.filter(r=>r.isLive).length}/${rows.length} live NAVs`;

  renderHoldingsTable(key);
  renderGainersLosers(key, rows);
  renderGrowthChart(key, p.yearWise, cfg.accent);
  renderAllocChart(key, p.nature);
  renderYearWise(key, p.yearWise);
  renderNature(key, p.nature, t.value);
  renderTxnLog(key, p.funds);
  if (cfg.swp && p.swp) renderSWP(key, p.swp);
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
        <span class="bg ${y.absGain>=0?'bgp':'bgn'}">${pct(y.gainPct)}</span></div>
      <div class="yr-row"><span>Start Value</span><span class="yr-val mo">${fmt(y.startVal)}</span></div>
      <div class="yr-row"><span>Fresh Invested</span><span class="yr-val mo">${fmt(y.freshInvested)}</span></div>
      ${y.withdrawals > 0 ? `<div class="yr-row"><span>Withdrawals</span><span class="yr-val mo" style="color:var(--rd)">-${fmt(y.withdrawals)}</span></div>` : ''}
      <div class="yr-row"><span>End Value</span><span class="yr-val mo">${fmt(y.endVal)}</span></div>
      <div class="yr-row"><span>Gain</span><span class="yr-val mo ${posC(y.absGain)}">${y.absGain>=0?'+':'-'}${fmt(Math.abs(y.absGain))}</span></div>
      <div class="yr-row"><span>Year XIRR</span><span class="yr-val mo ${posC(y.xirr)}">${y.xirr!=null?pct(y.xirr):'—'}</span></div>
    </div>`).join('');
}

function renderNature(key, nature, totalVal) {
  const el = document.getElementById(`${key}-natureGrid`);
  el.innerHTML = nature.map(n => {
    const share = totalVal ? n.value / totalVal * 100 : 0;
    const gain = n.value - n.invested;
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
  document.getElementById(`${key}-swpCount`).textContent = `${swp.withdrawalCount} withdrawals`;
  document.getElementById(`${key}-swpAvgMonthly`).textContent = fmt(swp.avgMonthly);
  document.getElementById(`${key}-swpRunway`).textContent = swp.runwayMonths ? `${(swp.runwayMonths/12).toFixed(1)} yrs` : '—';
  document.getElementById(`${key}-swpSustain`).innerHTML = swp.sustainable
    ? `<span class="up">Sustainable</span>` : `<span class="down">Drawing principal</span>`;
  document.getElementById(`${key}-swpSustainSub`).textContent = `withdrawing ${swp.annualWithdrawalRatePct.toFixed(1)}%/yr`;
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
    return `<tr><td class="mo">${t.d}</td><td>${esc(t.fundName)}</td>
      <td><span class="txn-type ${isBuy?'bgp':'bgn'}">${isBuy?'BUY':'SELL'}</span></td>
      <td class="r mo">${fmt(Math.abs(t.a))}</td><td class="r mo">${Math.abs(t.u).toFixed(3)}</td>
      <td class="r mo">₹${(t.n||0).toFixed(2)}</td></tr>`;
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
  const t = famData.totals;
  document.getElementById('fam-inv').textContent = fmt(t.invested);
  document.getElementById('fam-val').textContent = fmt(t.value);
  document.getElementById('fam-gain').innerHTML = `<span class="${posC(t.gain)}">${t.gain>=0?'+':''}${fmt(t.gain)}</span>`;
  document.getElementById('fam-xirr').innerHTML = `<span class="${posC(t.xirr)}">${t.xirr!=null?pct(t.xirr):'—'}</span>`;
  document.getElementById('fam-gainAbs').innerHTML = `<span class="${posC(t.gain)}">${t.gain>=0?'+':'-'}${fmt(Math.abs(t.gain))}</span>`;
  document.getElementById('fam-mult').textContent = t.invested ? `${(t.value/t.invested).toFixed(2)}x invested` : '—';

  const cb = document.getElementById('fam-compareBody');
  cb.innerHTML = famData.compare.map(r => {
    const gain = r.value - r.invested, gp = r.invested ? gain/r.invested*100 : 0;
    return `<tr><td><span class="compare-accent" style="color:${r.accent}"><span class="compare-dot" style="background:${r.accent}"></span>${esc(r.label)}</span></td>
      <td class="r mo">${fmt(r.invested)}</td><td class="r mo">${fmt(r.value)}</td>
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

  // pooled allocation across all 3 portfolios
  const natMap = {};
  Object.values(cache).forEach(p => p.nature.forEach(n => {
    const nm = natMap[n.cat] = natMap[n.cat] || { cat: n.cat, value: 0, invested: 0, fundCount: 0, cf: [] };
    nm.value += n.value; nm.invested += n.invested; nm.fundCount += n.fundCount;
  }));
  const famNature = Object.values(natMap).sort((a,b) => b.value - a.value)
    .map(n => ({ ...n, xirr: null }));
  renderNature('fam', famNature, t.value);
  renderAllocChart('fam', famNature);
}

/* ============================================================
   LIVE REFRESH (manual button — client-side NAV re-fetch)
   ============================================================ */
async function refreshLive(key) {
  const p = cache[key];
  if (!p) return;
  const btn = document.getElementById(`${key}-refreshBtn`);
  btn.disabled = true; btn.textContent = '↻ Refreshing…';
  document.getElementById(`${key}-dot`).className = 'dot spin';
  document.getElementById(`${key}-statusTxt`).textContent = 'Fetching live NAVs…';

  const today = td();
  let updated = 0;
  for (const f of p.funds) {
    const live = await fetchNAVLive(f.isin);
    if (live) {
      f.liveNav = live.nav; f.navDate = today; f.isLive = true;
      f.value = f.units * live.nav;
      f.gain = f.value - f.invested;
      f.gainPct = f.invested ? f.gain / f.invested * 100 : 0;
      f.xirr = xirr(f.txns, f.value, today);
      updated++;
    }
  }
  // recompute totals + portfolio xirr
  p.totals.invested = p.funds.reduce((s,f) => s+f.invested, 0);
  p.totals.value = p.funds.reduce((s,f) => s+f.value, 0);
  const allTxns = p.funds.flatMap(f => f.txns);
  p.totals.xirr = xirr(allTxns, p.totals.value, today);
  p.totals.gain = p.totals.value - p.totals.invested;
  const ranked = [...p.funds].filter(f=>f.xirr!=null).sort((a,b)=>b.xirr-a.xirr);
  p.gainers = ranked.slice(0,3).map(g=>({isin:g.isin,name:g.name,xirr:g.xirr}));
  p.losers = ranked.slice(-3).reverse().map(g=>({isin:g.isin,name:g.name,xirr:g.xirr}));

  renderPortfolio(key);
  btn.disabled = false; btn.textContent = '↻ Refresh';
  toast(`${updated}/${p.funds.length} NAVs updated live · other analytics update on the next 6h auto-refresh`);
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
   ADD TRANSACTION MODAL
   ============================================================ */
function openAddTxn(key) {
  modalKey = key;
  document.getElementById('txnModalTitle').textContent = `Add Transaction — ${PORTFOLIOS[key].label}`;
  const sel = document.getElementById('txnFundSelect');
  sel.innerHTML = '<option value="__new__">+ New fund…</option>' +
    cache[key].funds.map(f => `<option value="${f.isin}">${esc(f.name)}</option>`).join('');
  document.getElementById('txnNewFundBlock').style.display = 'none';
  document.getElementById('txnDate').value = td();
  document.getElementById('txnAmount').value = '';
  document.getElementById('txnNav').value = '';
  document.getElementById('txnError').style.display = 'none';
  document.getElementById('txnSubmitBtn').textContent = 'Save Transaction';
  document.getElementById('txnModalOverlay').classList.add('show');
}
function closeTxnModal() { document.getElementById('txnModalOverlay').classList.remove('show'); }
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'txnFundSelect') {
    document.getElementById('txnNewFundBlock').style.display = e.target.value === '__new__' ? 'block' : 'none';
  }
});

async function submitTxn() {
  const key = modalKey;
  const sheet = PORTFOLIOS[key].sheet;
  const isinSel = document.getElementById('txnFundSelect').value;
  const isNew = isinSel === '__new__';
  const type = document.getElementById('txnType').value;
  const date = document.getElementById('txnDate').value;
  const amount = parseFloat(document.getElementById('txnAmount').value);
  const navInput = parseFloat(document.getElementById('txnNav').value);
  const errBox = document.getElementById('txnError');
  errBox.style.display = 'none';

  if (!date || !amount || amount <= 0) { errBox.textContent = 'Date and a positive amount are required.'; errBox.style.display = 'block'; return; }

  const payload = { action: 'add_txn', sheet, date, amount: type === 'sell' ? -Math.abs(amount) : Math.abs(amount) };
  if (navInput) { payload.nav = navInput; payload.units = payload.amount / navInput; }
  if (isNew) {
    payload.isNewFund = true;
    payload.isin = document.getElementById('txnNewIsin').value.trim();
    payload.name = document.getElementById('txnNewName').value.trim();
    payload.cat = document.getElementById('txnNewCat').value.trim();
    if (!payload.isin || !payload.name) { errBox.textContent = 'New fund needs at least ISIN and name.'; errBox.style.display = 'block'; return; }
  } else {
    payload.isin = isinSel;
  }

  const btn = document.getElementById('txnSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({}));
    if (j && j.error) throw new Error(j.error);
    btn.textContent = 'Saved ✓';
    toast('Transaction saved to Google Sheets');
    setTimeout(() => { closeTxnModal(); btn.disabled = false; btn.textContent = 'Save Transaction'; }, 700);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Save Transaction';
    errBox.textContent = 'Could not save — your Apps Script may not have the doPost handler set up yet. See the setup note below.';
    errBox.style.display = 'block';
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

  Object.keys(PORTFOLIOS).forEach(key => {
    document.getElementById(`${key}-refreshBtn`).addEventListener('click', () => refreshLive(key));
    document.getElementById(`${key}-addTxnBtn`).addEventListener('click', () => openAddTxn(key));
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
}

async function init() {
  document.getElementById('s-panel-mount').outerHTML = window.PANEL_S;
  document.getElementById('su-panel-mount').outerHTML = window.PANEL_SU;
  document.getElementById('sa-panel-mount').outerHTML = window.PANEL_SA;
  wireEvents();

  try {
    await loadData();
    Object.keys(PORTFOLIOS).forEach(renderPortfolio);
    renderFamily();
    const gen = new Date(dataMeta.generatedAt);
    document.getElementById('dataFreshness').textContent = `Data as of ${gen.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · auto-refreshes every 6h`;
  } catch (e) {
    document.getElementById('dataFreshness').textContent = 'Could not load data.json — ' + e.message;
    console.error(e);
  }

  const startKey = (location.hash || '#fam').replace('#', '');
  switchTab(TAB_ORDER.includes(startKey) ? startKey : 'fam');

  // swipe between tabs (mobile)
  let touchX = null;
  document.querySelector('.page').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
  document.querySelector('.page').addEventListener('touchend', e => {
    if (touchX == null) return;
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
