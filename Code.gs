const SHEET_ID = '1rRAjgjopXY6_qnmmodC6-F5fFC6eEjECu5SNmLTNj_Q';
const ALLOWED_SHEETS = ['Saketh', 'Suneetha', 'Samhitha', 'Babu'];

// Hoisted to top-level so both captureYearEndNAVs() and the new doPost()/fetchLiveNav()
// can share the same map instead of keeping two copies in sync.
const ISIN_SCHEME = {
  "INF090I01171":100471,"INF179K01608":101762,"INF789F01810":102394,
  "INF200K01370":102756,"INF174K01211":102875,"INF760K01167":102920,
  "INF789F01AG5":103098,"INF090I01841":103151,"INF204K01GE7":104637,
  "INF179K01CR2":105758,"INF090I01981":105817,"INF740K01037":105875,
  "INF109K01BL4":108466,"INF769K01101":112932,"INF846K01859":114564,
  "INF740K01LP6":117691,"INF754K01CE0":118624,"INF204K01XF9":118650,
  "INF204K01E54":118668,"INF179K01UT0":118955,"INF179K01XQ0":118989,
  "INF179K01XZ1":119062,"INF200K01RY0":119609,"INF174K01JP2":119750,
  "INF200K01UT4":119800,"INF109K01Y07":120251,"INF109K015K4":120334,
  "INF109K01S39":120616,"INF966L01689":120828,"INF879O01027":122639,
  "INF879O01019":122640,"INF179KA1RW5":130503,"INF200KA1473":133858,
  "INF277K01Z44":135797,"INF205K013T3":145137,"INF194KB1AL4":147946,
  "INF204KB19V4":148457,"INF109KC1O90":148653,"INF879O01175":148958,
  "INF109KC1R14":148990,"INF174KA1HV3":149185,"INF179KC1BV9":149366,
  "INF846K013E0":149383,"INF204KC1BL9":152034
};

function doGet(e) {
  const callback = e.parameter.callback;
  try {
    const sheet = e.parameter.sheet;
    const action = e.parameter.action || 'get';

    if (action === 'nav_snapshots') {
      return respond(callback, getNavSnapshots());
    }

    if (!sheet || !ALLOWED_SHEETS.includes(sheet)) {
      return respond(callback, { error: 'Invalid or missing sheet name' });
    }
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const ws = ss.getSheetByName(sheet);
    if (!ws) return respond(callback, { error: `Sheet "${sheet}" not found` });
    const data = ws.getDataRange().getValues();
    if (data.length <= 1) return respond(callback, { sheet, funds: [] });

    const txnsByIsin = {}, metaByIsin = {};
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[0] || !row[1]) continue;
      const isin  = row[1].toString().trim();
      const date  = formatDate(row[3]);
      const type  = (row[4] || 'buy').toString().toLowerCase().trim();
      const units = parseFloat(row[5]) || 0;
      const price = parseFloat(row[6]) || 0;
      if (!date || units === 0 || price === 0) continue;
      if (!txnsByIsin[isin]) {
        txnsByIsin[isin] = [];
        metaByIsin[isin] = { name: row[0].toString(), cat: (row[2] || 'Other').toString() };
      }
      txnsByIsin[isin].push({ d: date, n: price, u: units, a: round2(units * price), type });
    }

    const funds = Object.entries(txnsByIsin).map(([isin, txns]) => {
      txns.sort((a, b) => a.d.localeCompare(b.d));
      const buys  = txns.filter(t => t.type === 'buy');
      const sells = txns.filter(t => t.type === 'sell');
      const netUnits    = round3(buys.reduce((s,t) => s+t.u, 0) - sells.reduce((s,t) => s+t.u, 0));
      const totalInvest = round2(buys.reduce((s,t) => s+t.a, 0));
      const lastNav     = txns[txns.length - 1].n;
      const xirrTxns   = [
        ...buys.map(t  => ({ d: t.d, n: t.n, u: t.u, a:  t.a })),
        ...sells.map(t => ({ d: t.d, n: t.n, u: t.u, a: -t.a }))
      ].sort((a, b) => a.d.localeCompare(b.d));
      return {
        name: metaByIsin[isin].name,
        isin, cat: metaByIsin[isin].cat || 'Other',
        units: netUnits, invested: totalInvest,
        statementNav: lastNav, txns: xirrTxns
      };
    });

    funds.sort((a, b) => b.invested - a.invested);
    return respond(callback, { sheet, funds, updatedAt: new Date().toISOString() });
  } catch (err) {
    return respond(callback, { error: err.message });
  }
}

function getNavSnapshots() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const ws = ss.getSheetByName('NAV_Snapshots');
  if (!ws) return { snapshots: {} };
  const data = ws.getDataRange().getValues();
  const snapshots = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0] || !row[1]) continue;
    const isin = row[0].toString().trim();
    const year = row[1].toString().trim();
    const nav  = parseFloat(row[2]) || 0;
    const date = formatDate(row[3]) || '';
    if (nav > 0) snapshots[`${isin}_${year}`] = { nav, date };
  }
  return { snapshots };
}

function captureYearEndNAVs() {
  const prevYear = (new Date().getFullYear() - 1).toString();
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const snapshotWs = ss.getSheetByName('NAV_Snapshots');
  if (!snapshotWs) return;

  const isins = new Set();
  ALLOWED_SHEETS.forEach(sheetName => {
    const ws = ss.getSheetByName(sheetName);
    if (!ws) return;
    const data = ws.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][1]) isins.add(data[i][1].toString().trim());
    }
  });

  const existing = new Set();
  const snapData = snapshotWs.getDataRange().getValues();
  for (let i = 1; i < snapData.length; i++) {
    if (snapData[i][0] && snapData[i][1] && snapData[i][1].toString() === prevYear) {
      existing.add(snapData[i][0].toString().trim());
    }
  }

  isins.forEach(isin => {
    if (existing.has(isin)) return;
    const schemeCode = ISIN_SCHEME[isin];
    if (!schemeCode) return;
    try {
      const url = `https://api.mfapi.in/mf/${schemeCode}`;
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (response.getResponseCode() !== 200) return;
      const data = JSON.parse(response.getContentText());
      if (!data.data || !data.data.length) return;

      let yearEndNav = null, yearEndDate = null;
      for (const entry of data.data) {
        const parts = entry.date.split('-');
        if (parts.length !== 3) continue;
        const entryYear = parts[2];
        if (entryYear === prevYear) {
          yearEndNav  = parseFloat(entry.nav);
          yearEndDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
          break;
        }
        if (entryYear < prevYear) break;
      }

      if (yearEndNav && yearEndDate) {
        snapshotWs.appendRow([isin, prevYear, yearEndNav, yearEndDate]);
        Logger.log(`Saved: ${isin} | ${prevYear} | ${yearEndNav} | ${yearEndDate}`);
      }
    } catch(e) {
      Logger.log(`Error for ${isin}: ${e.message}`);
    }
    Utilities.sleep(200);
  });

  Logger.log('Year-end NAV capture complete for ' + prevYear);
}

function setupYearEndTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'captureYearEndNAVs') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('captureYearEndNAVs')
    .timeBased()
    .atDate(new Date().getFullYear() + 1, 1, 1)
    .create();
  Logger.log('Trigger set: captureYearEndNAVs will run every Jan 1 at 1 AM');
}

/**
 * Handles "Add Transaction" from the dashboard.
 * Expects JSON body: { sheet, isin, date, amount, nav?, units?, name?, cat?, isNewFund? }
 *   - amount: positive = buy, negative = sell/withdrawal
 *   - nav: optional — if omitted, fetched live from mfapi.in using ISIN_SCHEME
 *   - units: optional — if omitted, computed as amount / nav
 *   - name/cat: required only for a brand-new fund (isNewFund: true); otherwise
 *               looked up automatically from the fund's existing rows in the sheet.
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const sheet = body.sheet;
    if (!sheet || !ALLOWED_SHEETS.includes(sheet)) {
      return respond(null, { error: 'Invalid or missing sheet name' });
    }
    const isin = (body.isin || '').toString().trim();
    const date = (body.date || '').toString().trim();
    const amount = parseFloat(body.amount);
    if (!isin || !date || !amount) {
      return respond(null, { error: 'isin, date and amount are required' });
    }

    const ws = SpreadsheetApp.openById(SHEET_ID).getSheetByName(sheet);
    if (!ws) return respond(null, { error: `Sheet "${sheet}" not found` });

    const type = amount < 0 ? 'sell' : 'buy';
    const amountAbs = Math.abs(amount);

    // NAV: use what was sent, else fetch live from mfapi.in
    let nav = parseFloat(body.nav);
    if (!nav || isNaN(nav)) {
      nav = fetchLiveNav(isin);
      if (!nav) {
        return respond(null, { error: 'Could not auto-fetch NAV for this fund — please enter it manually.' });
      }
    }

    // Units: use what was sent, else derive from amount / nav
    let units = parseFloat(body.units);
    if (!units || isNaN(units)) units = amountAbs / nav;
    units = Math.abs(units);

    // Name/category: use what was sent (new fund), else look up from existing rows
    let name = (body.name || '').toString().trim();
    let cat  = (body.cat  || '').toString().trim();
    if (!name || !cat) {
      const existing = lookupExistingFund(ws, isin);
      if (existing) {
        name = name || existing.name;
        cat  = cat  || existing.cat;
      }
    }
    if (!name) {
      return respond(null, { error: 'New fund needs a name — please fill in the "New fund" fields.' });
    }
    cat = cat || 'Other';

    ws.appendRow([name, isin, cat, date, type, round3(units), round2(nav)]);

    return respond(null, { success: true, isin, name, cat, type, units: round3(units), nav: round2(nav) });
  } catch (err) {
    return respond(null, { error: err.message });
  }
}

function fetchLiveNav(isin) {
  const schemeCode = ISIN_SCHEME[isin];
  if (!schemeCode) return null;
  try {
    const res = UrlFetchApp.fetch(`https://api.mfapi.in/mf/${schemeCode}`, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const j = JSON.parse(res.getContentText());
    if (j.data && j.data.length) {
      const nav = parseFloat(j.data[0].nav);
      return nav > 0 ? nav : null;
    }
  } catch (e) { /* fall through */ }
  return null;
}

function lookupExistingFund(ws, isin) {
  const data = ws.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] && data[i][1].toString().trim() === isin) {
      return { name: data[i][0].toString(), cat: (data[i][2] || 'Other').toString() };
    }
  }
  return null;
}

function respond(callback, data) {
  const json = JSON.stringify(data);
  if (callback) {
    return ContentService.createTextOutput(`${callback}(${json})`).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function formatDate(val) {
  if (!val) return null;
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = val.toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(s)) {
    const [d, m, y] = s.split(/[\/\-]/);
    return `${y}-${m}-${d}`;
  }
  return null;
}
function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
