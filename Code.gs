const SHEET_ID = '1rRAjgjopXY6_qnmmodC6-F5fFC6eEjECu5SNmLTNj_Q';
const ALLOWED_SHEETS = ['Saketh', 'Suneetha', 'Samhitha', 'Babu'];
const ID_COL = 8; // column H
const SCHEDULE_SHEET = 'Scheduled_SIPs';

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

    if (action === 'schedules') {
      if (!sheet || !ALLOWED_SHEETS.includes(sheet)) return respond(callback, { error: 'Invalid or missing sheet name' });
      return respond(callback, getSchedules(sheet));
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
      const id    = row[7] ? row[7].toString().trim() : '';
      if (!date || units === 0 || price === 0) continue;
      if (!txnsByIsin[isin]) {
        txnsByIsin[isin] = [];
        metaByIsin[isin] = { name: row[0].toString(), cat: (row[2] || 'Other').toString() };
      }
      txnsByIsin[isin].push({ d: date, n: price, u: units, a: round2(units * price), type, id });
    }

    const funds = Object.entries(txnsByIsin).map(([isin, txns]) => {
      txns.sort((a, b) => a.d.localeCompare(b.d));
      const buys  = txns.filter(t => t.type === 'buy');
      const sells = txns.filter(t => t.type === 'sell');
      const netUnits    = round3(buys.reduce((s,t) => s+t.u, 0) - sells.reduce((s,t) => s+t.u, 0));
      const totalInvest = round2(buys.reduce((s,t) => s+t.a, 0));
      const lastNav     = txns[txns.length - 1].n;
      const xirrTxns   = [
        ...buys.map(t  => ({ d: t.d, n: t.n, u: t.u, a:  t.a, id: t.id })),
        ...sells.map(t => ({ d: t.d, n: t.n, u: t.u, a: -t.a, id: t.id }))
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
    const schemeCode = resolveSchemeCode(isin);
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

/**
 * RUN THIS ONCE MANUALLY (function dropdown above the editor -> select it -> Run).
 * captureYearEndNAVs() only ever captures the single year that just ended — it has no
 * way to backfill older years. If your NAV_Snapshots sheet doesn't already have an entry
 * for every (fund, year) combination in your transaction history, the dashboard's
 * "End Value" for those years silently falls back to your last transaction's NAV that
 * year instead of the true Dec-31 NAV. This fills in every gap, going back to each
 * fund's earliest transaction, using one mfapi.in call per fund (not one per year).
 * Safe to re-run — it only fills gaps, never duplicates existing entries.
 */
function backfillAllYearEndNAVs() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const snapshotWs = ss.getSheetByName('NAV_Snapshots');
  if (!snapshotWs) { Logger.log('NAV_Snapshots sheet not found — create it first (columns: ISIN, Year, NAV, Date).'); return; }

  const currentYear = new Date().getFullYear();

  const isinEarliestYear = {};
  ALLOWED_SHEETS.forEach(sheetName => {
    const ws = ss.getSheetByName(sheetName);
    if (!ws) return;
    const data = ws.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const isin = data[i][1] ? data[i][1].toString().trim() : null;
      if (!isin || !data[i][3]) continue;
      const d = formatDate(data[i][3]);
      if (!d) continue;
      const yr = parseInt(d.slice(0, 4));
      if (!isinEarliestYear[isin] || yr < isinEarliestYear[isin]) isinEarliestYear[isin] = yr;
    }
  });

  const existing = new Set();
  const snapData = snapshotWs.getDataRange().getValues();
  for (let i = 1; i < snapData.length; i++) {
    if (snapData[i][0] && snapData[i][1]) existing.add(`${snapData[i][0].toString().trim()}_${snapData[i][1].toString().trim()}`);
  }

  let saved = 0, skippedFunds = 0;
  Object.keys(isinEarliestYear).forEach(isin => {
    const schemeCode = resolveSchemeCode(isin);
    if (!schemeCode) { Logger.log(`Could not resolve a scheme code for ${isin} (checked ISIN_SCHEME and AMFI's index) — skipping.`); skippedFunds++; return; }

    const yearsNeeded = [];
    for (let y = isinEarliestYear[isin]; y < currentYear; y++) {
      if (!existing.has(`${isin}_${y}`)) yearsNeeded.push(y);
    }
    if (!yearsNeeded.length) return;

    try {
      const response = UrlFetchApp.fetch(`https://api.mfapi.in/mf/${schemeCode}`, { muteHttpExceptions: true });
      if (response.getResponseCode() !== 200) { Logger.log(`mfapi fetch failed for ${isin}`); return; }
      const data = JSON.parse(response.getContentText());
      if (!data.data || !data.data.length) return;

      yearsNeeded.forEach(y => {
        const yearStr = y.toString();
        let yearEndNav = null, yearEndDate = null;
        for (const entry of data.data) {
          const parts = entry.date.split('-'); // dd-mm-yyyy, newest first
          if (parts.length !== 3) continue;
          if (parts[2] === yearStr) {
            yearEndNav = parseFloat(entry.nav);
            yearEndDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
            break;
          }
          if (parts[2] < yearStr) break;
        }
        if (yearEndNav && yearEndDate) {
          snapshotWs.appendRow([isin, yearStr, yearEndNav, yearEndDate]);
          saved++;
        } else {
          Logger.log(`No mfapi data for ${isin} in ${yearStr} (fund likely didn't exist yet that year — not an error).`);
        }
      });
    } catch (e) {
      Logger.log(`Error for ${isin}: ${e.message}`);
    }
    Utilities.sleep(200);
  });

  Logger.log(`Backfill complete — saved ${saved} year-end snapshots across ${Object.keys(isinEarliestYear).length - skippedFunds} funds (${skippedFunds} funds had no ISIN_SCHEME mapping).`);
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
 * RUN THIS ONCE MANUALLY (select it in the function dropdown above the editor, click Run).
 * Adds a "TxnID" column (H) to every sheet and assigns a unique ID to every existing row
 * that doesn't have one yet. Safe to re-run — it skips rows that already have an ID.
 */
function backfillTxnIDs() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  ALLOWED_SHEETS.forEach(sheetName => {
    const ws = ss.getSheetByName(sheetName);
    if (!ws) return;
    const header = ws.getRange(1, ID_COL);
    if (header.getValue() !== 'TxnID') header.setValue('TxnID');

    const lastRow = ws.getLastRow();
    if (lastRow < 2) return;
    const idRange = ws.getRange(2, ID_COL, lastRow - 1, 1);
    const ids = idRange.getValues();
    let changed = 0;
    for (let i = 0; i < ids.length; i++) {
      if (!ids[i][0]) { ids[i][0] = Utilities.getUuid(); changed++; }
    }
    if (changed) idRange.setValues(ids);
    Logger.log(`${sheetName}: assigned ${changed} new IDs (${ids.length - changed} already had one)`);
  });
  Logger.log('Backfill complete for all sheets.');
}

/**
 * Handles Add / Edit / Delete transaction calls from the dashboard.
 * body.action: 'add_txn' (default) | 'edit_txn' | 'delete_txn'
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || 'add_txn';
    if (action === 'edit_txn') return handleEditTxn(body);
    if (action === 'delete_txn') return handleDeleteTxn(body);
    if (action === 'create_schedule') return handleCreateSchedule(body);
    if (action === 'set_schedule_status') return handleSetScheduleStatus(body);
    if (action === 'trigger_refresh') { triggerGitHubActionRefresh(); return respond(null, { success: true }); }
    return handleAddTxn(body);
  } catch (err) {
    return respond(null, { error: err.message });
  }
}

function handleAddTxn(body) {
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

  let nav = parseFloat(body.nav);
  if (!nav || isNaN(nav)) {
    nav = fetchLiveNav(isin);
    if (!nav) return respond(null, { error: 'Could not auto-fetch NAV for this fund — please enter it manually.' });
  }

  let units = parseFloat(body.units);
  if (!units || isNaN(units)) units = amountAbs / nav;
  units = Math.abs(units);

  let name = (body.name || '').toString().trim();
  let cat  = (body.cat  || '').toString().trim();
  if (!name || !cat) {
    const existing = lookupExistingFund(ws, isin);
    if (existing) { name = name || existing.name; cat = cat || existing.cat; }
  }
  if (!name) return respond(null, { error: 'New fund needs a name — please fill in the "New fund" fields.' });
  cat = cat || 'Other';

  ws.appendRow([name, isin, cat, date, type, round3(units), round2(nav), Utilities.getUuid()]);
  triggerGitHubActionRefresh();

  return respond(null, { success: true, isin, name, cat, type, units: round3(units), nav: round2(nav) });
}

function handleEditTxn(body) {
  const sheet = body.sheet;
  if (!sheet || !ALLOWED_SHEETS.includes(sheet)) return respond(null, { error: 'Invalid or missing sheet name' });
  if (!body.id) return respond(null, { error: 'Missing transaction id' });

  const ws = SpreadsheetApp.openById(SHEET_ID).getSheetByName(sheet);
  if (!ws) return respond(null, { error: `Sheet "${sheet}" not found` });

  const row = findRowById(ws, body.id);
  if (row === -1) {
    return respond(null, { error: 'Transaction not found. If this was added before the ID column existed, run backfillTxnIDs() once from the Apps Script editor.' });
  }

  const date = (body.date || '').toString().trim();
  const amount = parseFloat(body.amount);
  if (!date || !amount) return respond(null, { error: 'date and amount are required' });

  const isin = ws.getRange(row, 2).getValue().toString().trim();
  const type = amount < 0 ? 'sell' : 'buy';
  const amountAbs = Math.abs(amount);

  let nav = parseFloat(body.nav);
  if (!nav || isNaN(nav)) {
    nav = fetchLiveNav(isin);
    if (!nav) return respond(null, { error: 'Could not auto-fetch NAV for this fund — please enter it manually.' });
  }
  let units = parseFloat(body.units);
  if (!units || isNaN(units)) units = amountAbs / nav;
  units = Math.abs(units);

  ws.getRange(row, 4).setValue(date);           // date
  ws.getRange(row, 5).setValue(type);            // type
  ws.getRange(row, 6).setValue(round3(units));   // units
  ws.getRange(row, 7).setValue(round2(nav));     // price/nav
  // columns 1-3 (name/isin/cat) and 8 (id) are left untouched — you can't move a
  // transaction to a different fund via edit; delete and re-add instead.
  triggerGitHubActionRefresh();

  return respond(null, { success: true, type, units: round3(units), nav: round2(nav) });
}

function handleDeleteTxn(body) {
  const sheet = body.sheet;
  if (!sheet || !ALLOWED_SHEETS.includes(sheet)) return respond(null, { error: 'Invalid or missing sheet name' });
  if (!body.id) return respond(null, { error: 'Missing transaction id' });

  const ws = SpreadsheetApp.openById(SHEET_ID).getSheetByName(sheet);
  if (!ws) return respond(null, { error: `Sheet "${sheet}" not found` });

  const row = findRowById(ws, body.id);
  if (row === -1) {
    return respond(null, { error: 'Transaction not found. If this was added before the ID column existed, run backfillTxnIDs() once from the Apps Script editor.' });
  }
  ws.deleteRow(row);
  triggerGitHubActionRefresh();
  return respond(null, { success: true });
}

function findRowById(ws, id) {
  const lastRow = ws.getLastRow();
  if (lastRow < 2) return -1;
  const ids = ws.getRange(2, ID_COL, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] && ids[i][0].toString().trim() === id.toString().trim()) return i + 2;
  }
  return -1;
}

/**
 * Resolves an ISIN to an mfapi.in scheme code. Checks the static ISIN_SCHEME map first
 * (fast, no network call), then a cached lookup from a previous resolution, then falls
 * back to AMFI's public scheme index (NAVAll.txt) to find the code for funds not yet
 * known. The actual NAV always comes from mfapi.in -- AMFI is only ever used here to
 * find the *code*, never as a source of NAV data itself.
 */
function resolveSchemeCode(isin) {
  if (ISIN_SCHEME[isin]) return ISIN_SCHEME[isin];
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty('scheme_' + isin);
  if (cached) return cached;
  const found = findSchemeCodeByISIN(isin);
  if (found) props.setProperty('scheme_' + isin, found);
  return found;
}

function findSchemeCodeByISIN(isin) {
  try {
    const res = UrlFetchApp.fetch('https://www.amfiindia.com/spages/NAVAll.txt', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const text = res.getContentText();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf(isin) === -1) continue; // quick pre-filter, avoids splitting every line
      const cols = line.split(';');
      if (cols.length < 4) continue;
      const code = (cols[0] || '').trim();
      const isinGrowth = (cols[1] || '').trim();
      const isinReinvest = (cols[2] || '').trim();
      if ((isinGrowth === isin || isinReinvest === isin) && /^\d+$/.test(code)) {
        return code;
      }
    }
    return null;
  } catch (e) {
    Logger.log(`AMFI lookup failed for ${isin}: ${e.message}`);
    return null;
  }
}

function fetchLiveNav(isin) {
  const schemeCode = resolveSchemeCode(isin);
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

/* ============================================================
   SIP / SWP SCHEDULING
   ============================================================
   How this handles NAV timing correctly:
   - A schedule's "due date" is just the calendar date it's meant to fire (e.g. every
     Tuesday). We never guess at a NAV -- we only ever write a transaction once we've
     confirmed a *real* NAV exists.
   - SIPs look FORWARD: confirmed NAV for the due date itself, or the next actual
     trading day after it if the due date was a holiday/weekend.
   - SWPs look BACKWARD: this deliberately matches how Zerodha Coin (and similar
     platforms) actually price scheduled withdrawals -- a Tuesday SWP uses Monday's
     NAV, not Tuesday's, since the redemption instruction is effectively processed
     against the prior day's cutoff. This means an SWP's due-date NAV is normally
     already published by the time its due date arrives, so it typically executes
     right away rather than waiting a day like a SIP does. The transaction is dated
     to match whichever day's NAV was actually used (so XIRR timing stays correct),
     not the nominal due date.
   - "Was it a holiday?" is never looked up from a calendar we'd have to maintain --
     if mfapi.in genuinely has no NAV entry for a date once we're checking a day or
     more after it (SIP) or before it (SWP), that date simply wasn't a trading day.
     This stays correct forever with zero maintenance.
   - processScheduledSIPs() is meant to be triggered several times a day (see
     setupScheduleTriggers below). Each run is a cheap no-op unless it finds a real,
     previously-unconfirmed NAV -- so it's safe to check early and often. Regular
     schemes typically resolve on the first morning run; Fund of Funds (which SEBI
     allows until 10am the *next* day) naturally resolve on a later run the same way,
     with no special-casing needed.
   ============================================================ */

function ensureScheduleSheet(ss) {
  let ws = ss.getSheetByName(SCHEDULE_SHEET);
  if (!ws) {
    ws = ss.insertSheet(SCHEDULE_SHEET);
    ws.appendRow(['ScheduleID', 'Sheet', 'ISIN', 'FundName', 'Category', 'Amount', 'Kind',
      'Frequency', 'DayValue', 'Status', 'NextDueDate', 'LastProcessedDate', 'CreatedAt']);
  }
  return ws;
}

/** RUN THIS ONCE MANUALLY (function dropdown -> select it -> Run) if the
    Scheduled_SIPs tab doesn't exist yet. Safe to re-run -- does nothing if it's
    already there. setupScheduleTriggers() alone does NOT create this sheet; it
    only sets up the timing triggers -- this is the explicit, no-argument way to
    force sheet creation without needing to create a schedule from the dashboard first. */
function createScheduleSheetNow() {
  const ws = ensureScheduleSheet(SpreadsheetApp.openById(SHEET_ID));
  Logger.log(`"${SCHEDULE_SHEET}" sheet is ready (${ws.getLastRow() - 1} existing schedules).`);
}


function toISO(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** dayValue: weekly = 1(Mon)..7(Sun) ISO weekday; monthly = 1..31 day-of-month. */
function computeFirstDueDate(frequency, dayValue, startDateStr) {
  let d = new Date(startDateStr + 'T00:00:00');
  if (frequency === 'weekly') {
    const jsDay = d.getDay();          // 0=Sun..6=Sat
    const wantJsDay = dayValue % 7;    // 1..7(Mon..Sun) -> 1..6,0
    const diff = (wantJsDay - jsDay + 7) % 7;
    d.setDate(d.getDate() + diff);
  } else {
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const targetDay = Math.min(dayValue, daysInMonth);
    if (d.getDate() > targetDay) {
      // Compute the target year/month BEFORE constructing the date -- setting the
      // month while the day-of-month still holds a large value (e.g. 31) silently
      // overflows past short months (Jan 31 -> "Feb 31" doesn't exist -> rolls to
      // March). Clamping the day only after landing on the right month avoids this.
      let y = d.getFullYear(), m = d.getMonth() + 1;
      if (m > 11) { m = 0; y += 1; }
      const dim2 = new Date(y, m + 1, 0).getDate();
      d = new Date(y, m, Math.min(dayValue, dim2));
    } else {
      d.setDate(targetDay);
    }
  }
  return toISO(d);
}

/** Advances to the next cycle from a fixed anchor -- always from the *scheduled* date,
    never from a holiday-shifted execution date, so a one-off shift never causes drift
    (e.g. a Diwali Tuesday shifting to Wednesday doesn't turn all future weeks into
    Wednesdays -- next week still targets Tuesday). */
function addPeriod(dateStr, frequency, dayValue) {
  const d = new Date(dateStr + 'T00:00:00');
  if (frequency === 'weekly') {
    d.setDate(d.getDate() + 7);
    return toISO(d);
  }
  let y = d.getFullYear(), m = d.getMonth() + 1;
  if (m > 11) { m = 0; y += 1; }
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  return toISO(new Date(y, m, Math.min(dayValue, daysInMonth)));
}

/** Finds the earliest confirmed NAV on or after targetDateStr. Returns null if nothing
    is confirmed yet (due date's NAV hasn't published, or -- indistinguishably, which is
    fine -- it's a holiday and the next trading day's NAV isn't out yet either). Safe to
    call repeatedly; it just means "not ready yet, try again on the next run." */
function findNextAvailableNAV(isin, targetDateStr) {
  const schemeCode = resolveSchemeCode(isin);
  if (!schemeCode) return null;
  try {
    const res = UrlFetchApp.fetch(`https://api.mfapi.in/mf/${schemeCode}`, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const j = JSON.parse(res.getContentText());
    const rows = j.data || [];
    let best = null;
    for (const row of rows) {
      const parts = row.date.split('-'); // dd-mm-yyyy
      if (parts.length !== 3) continue;
      const iso = `${parts[2]}-${parts[1]}-${parts[0]}`;
      if (iso >= targetDateStr && (!best || iso < best.date)) {
        best = { date: iso, nav: parseFloat(row.nav) };
      }
    }
    return best;
  } catch (e) {
    Logger.log(`NAV check failed for ${isin}: ${e.message}`);
    return null;
  }
}

/** SWP-specific: finds the most recent already-published NAV *before* beforeDateStr,
    matching how Coin/similar platforms actually price scheduled withdrawals (a Tuesday
    SWP uses Monday's NAV, not Tuesday's). Unlike SIPs, this never has to "wait" for
    anything -- the prior trading day's NAV is already published by the time the due
    date arrives, so an SWP can typically execute right on its due date, first check
    of the day. This also handles holidays automatically: if the due date itself was
    a holiday, "the most recent prior trading day" still resolves correctly with no
    extra logic needed. */
function findPreviousAvailableNAV(isin, beforeDateStr) {
  const schemeCode = resolveSchemeCode(isin);
  if (!schemeCode) return null;
  try {
    const res = UrlFetchApp.fetch(`https://api.mfapi.in/mf/${schemeCode}`, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const j = JSON.parse(res.getContentText());
    const rows = j.data || [];
    let best = null;
    for (const row of rows) {
      const parts = row.date.split('-'); // dd-mm-yyyy
      if (parts.length !== 3) continue;
      const iso = `${parts[2]}-${parts[1]}-${parts[0]}`;
      if (iso < beforeDateStr && (!best || iso > best.date)) {
        best = { date: iso, nav: parseFloat(row.nav) };
      }
    }
    return best;
  } catch (e) {
    Logger.log(`NAV check failed for ${isin}: ${e.message}`);
    return null;
  }
}

function getSchedules(sheetName) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const ws = ensureScheduleSheet(ss);
  const data = ws.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0] || row[1] !== sheetName) continue;
    out.push({
      id: row[0].toString(), sheet: row[1], isin: row[2], name: row[3], cat: row[4],
      amount: parseFloat(row[5]), kind: row[6], frequency: row[7], dayValue: parseInt(row[8]),
      status: row[9], nextDueDate: row[10] ? row[10].toString() : '',
      lastProcessedDate: row[11] ? row[11].toString() : '',
    });
  }
  return { schedules: out };
}

function handleCreateSchedule(body) {
  const sheet = body.sheet;
  if (!sheet || !ALLOWED_SHEETS.includes(sheet)) return respond(null, { error: 'Invalid or missing sheet name' });
  const isin = (body.isin || '').toString().trim();
  const amount = parseFloat(body.amount);
  const kind = body.kind === 'swp' ? 'swp' : 'sip';
  const frequency = body.frequency === 'monthly' ? 'monthly' : 'weekly';
  const dayValue = parseInt(body.dayValue);
  const startDate = (body.startDate || toISO(new Date())).toString();
  if (!isin || !amount || amount <= 0 || !dayValue) {
    return respond(null, { error: 'Fund, amount, and day are required' });
  }

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const targetWs = ss.getSheetByName(sheet);
  const existing = targetWs ? lookupExistingFund(targetWs, isin) : null;
  const name = (body.name || (existing ? existing.name : '')).toString().trim();
  const cat = (body.cat || (existing ? existing.cat : 'Other')).toString().trim() || 'Other';
  if (!name) return respond(null, { error: 'Fund name required for a new fund.' });
  if (kind === 'swp' && !existing) return respond(null, { error: 'Cannot create an SWP for a fund with no current holding.' });

  const nextDue = computeFirstDueDate(frequency, dayValue, startDate);
  const ws = ensureScheduleSheet(ss);
  const id = Utilities.getUuid();
  ws.appendRow([id, sheet, isin, name, cat, amount, kind, frequency, dayValue, 'active', nextDue, '', new Date().toISOString()]);
  return respond(null, { success: true, id, nextDueDate: nextDue });
}

function handleSetScheduleStatus(body) {
  const id = body.id, newStatus = body.status;
  if (!id || ['active', 'paused', 'stopped'].indexOf(newStatus) === -1) {
    return respond(null, { error: 'Invalid id or status' });
  }
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const ws = ensureScheduleSheet(ss);
  const data = ws.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString() === id) {
      ws.getRange(i + 1, 10).setValue(newStatus);
      return respond(null, { success: true });
    }
  }
  return respond(null, { error: 'Schedule not found' });
}

/**
 * The processor. Meant to run several times a day (see setupScheduleTriggers).
 * For every active, due schedule: checks whether a real NAV is confirmed for its due
 * date (or the next actual trading day, if the due date was a holiday); if so, writes
 * the transaction with that real date and NAV, then advances to the next cycle. If not
 * yet confirmed, leaves it untouched -- it'll be picked up on a later run once ready.
 */
function processScheduledSIPs() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const ws = ensureScheduleSheet(ss);
  const data = ws.getDataRange().getValues();
  const today = toISO(new Date());
  let processedAny = false;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[9] !== 'active') continue;
    const nextDue = row[10] ? row[10].toString() : '';
    if (!nextDue || nextDue > today) continue;

    const isin = row[2], kind = row[6];
    const found = kind === 'swp' ? findPreviousAvailableNAV(isin, nextDue) : findNextAvailableNAV(isin, nextDue);
    if (!found || found.date > today) continue; // not confirmed yet -- try again next run

    const sheetName = row[1], amount = parseFloat(row[5]);
    const frequency = row[7], dayValue = parseInt(row[8]);
    const targetWs = ss.getSheetByName(sheetName);
    if (!targetWs) continue;

    const type = kind === 'swp' ? 'sell' : 'buy';
    const units = amount / found.nav;
    targetWs.appendRow([row[3], isin, row[4], found.date, type, round3(units), round2(found.nav), Utilities.getUuid()]);
    processedAny = true;

    const newNextDue = addPeriod(nextDue, frequency, dayValue);
    ws.getRange(i + 1, 11).setValue(newNextDue);
    ws.getRange(i + 1, 12).setValue(found.date);
    Logger.log(`Processed ${kind.toUpperCase()} — ${row[3]} (${sheetName}): ${found.date} @ ₹${found.nav}, next due ${newNextDue}`);
  }

  if (processedAny) triggerGitHubActionRefresh();
}

/**
 * RUN THIS ONCE MANUALLY to enable SIP/SWP automation. Sets up daily checks at
 * 6am, 8am, 10am, 12pm and 8pm (script timezone -- verify it's set to Asia/Kolkata
 * under Project Settings, or these will fire at the wrong local time). Multiple
 * checks are cheap and safe (see the big comment above processScheduledSIPs) --
 * regular schemes typically resolve on the first morning run, Fund of Funds on a
 * later one, with no manual tuning needed either way.
 */
function setupScheduleTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'processScheduledSIPs') ScriptApp.deleteTrigger(t);
  });
  [6, 8, 10, 12, 20].forEach(hour => {
    ScriptApp.newTrigger('processScheduledSIPs').timeBased().everyDays(1).atHour(hour).create();
  });
  Logger.log('SIP/SWP triggers set: processScheduledSIPs will run daily at ~6am, 8am, 10am, 12pm, 8pm.');
}


/**
 * Best-effort trigger of the GitHub Actions data-refresh workflow, called after any
 * successful transaction write (add/edit/delete, or a processed SIP/SWP) so data.json
 * updates within moments instead of waiting for the next 6-hourly scheduled run.
 * Wrapped so a failure here (missing token, network issue, etc.) can NEVER break the
 * actual transaction save, which has already succeeded by the time this runs.
 *
 * One-time setup required (see setupGitHubTrigger below for the guided version):
 *   Script Properties (Project Settings -> Script Properties) needs:
 *     GITHUB_PAT    - a fine-grained Personal Access Token scoped to just this repo,
 *                     with "Actions: read and write" permission
 *     GITHUB_OWNER  - your GitHub username (defaults to 'sakethrachapudi' if unset)
 *     GITHUB_REPO   - the repo name (defaults to 'FolioLens-V2' if unset)
 */
function triggerGitHubActionRefresh() {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('GITHUB_PAT');
    if (!token) { Logger.log('GITHUB_PAT not set -- skipping auto-trigger (data.json will still update on the next scheduled 6h run).'); return; }
    const owner = props.getProperty('GITHUB_OWNER') || 'sakethrachapudi';
    const repo = props.getProperty('GITHUB_REPO') || 'FolioLens-V2';
    const workflowFile = props.getProperty('GITHUB_WORKFLOW') || 'refresh-data.yml';

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      payload: JSON.stringify({ ref: 'main' }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 204) {
      Logger.log('GitHub Action refresh triggered.');
    } else {
      Logger.log(`GitHub Action trigger failed (HTTP ${code}): ${res.getContentText()}`);
    }
  } catch (e) {
    Logger.log(`GitHub Action trigger error: ${e.message}`);
  }
}

/** RUN THIS ONCE to check your GitHub trigger setup without needing a real transaction.
    Confirms the token/owner/repo/workflow are all correctly configured. */
function testGitHubTrigger() {
  triggerGitHubActionRefresh();
  Logger.log("Check the log above -- 'triggered' means it worked; check your repo's Actions tab to confirm a new run started.");
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
