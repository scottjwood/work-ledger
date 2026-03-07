// =============================================
// LEDGER — Google Apps Script Backend
// Code.gs
//
// SETUP INSTRUCTIONS:
//   1. Open your Google Sheet
//   2. Extensions → Apps Script
//   3. Paste this entire file into Code.gs
//   4. Click "Save"
//   5. Click "Deploy" → "New deployment"
//      - Type: Web App
//      - Execute as: Me
//      - Who has access: Anyone
//   6. Click "Deploy", authorize when prompted
//   7. Copy the Web App URL — paste it into
//      work_ledger.html as SCRIPT_URL
//
// SHEET STRUCTURE (auto-created on first run):
//   Tab "Pending":  id | client | date | startMin | endMin | lunchMin | desc
//   Tab "History":  id | client | date_invoiced | entries_json | total
//   Tab "Settings": key | value
// =============================================

const SHEET_NAME_PENDING  = 'Pending';
const SHEET_NAME_HISTORY  = 'History';
const SHEET_NAME_SETTINGS = 'Settings';

// ─── CORS helper ──────────────────────────────
function cors(output) {
  return output
    .setMimeType(ContentService.MimeType.JSON)
    .addHeader('Access-Control-Allow-Origin', '*')
    .addHeader('Access-Control-Allow-Methods', 'GET,POST')
    .addHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function ok(data) {
  return cors(ContentService.createTextOutput(JSON.stringify({ ok: true, data })));
}

function err(msg) {
  return cors(ContentService.createTextOutput(JSON.stringify({ ok: false, error: msg })));
}

// ─── Sheet bootstrap ──────────────────────────
function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#1e2229')
      .setFontColor('#e8c547');
    sh.setFrozenRows(1);
  }
  return sh;
}

function getSheets() {
  return {
    pending:  getOrCreateSheet(SHEET_NAME_PENDING,  ['id','client','date','startMin','endMin','lunchMin','desc']),
    history:  getOrCreateSheet(SHEET_NAME_HISTORY,  ['id','client','date_invoiced','entries_json','total','rate_used']),
    settings: getOrCreateSheet(SHEET_NAME_SETTINGS, ['key','value'])
  };
}

// ─── GET handler (initial load) ───────────────
function doGet(e) {
  try {
    return ok(loadAll());
  } catch(ex) {
    return err(ex.message);
  }
}

// ─── POST handler (all mutations) ─────────────
function doPost(e) {
  try {
    const body    = JSON.parse(e.postData.contents);
    const action  = body.action;
    const payload = body.payload || {};

    switch(action) {
      case 'loadAll':       return ok(loadAll());
      case 'addEntry':      return ok(addEntry(payload));
      case 'deleteEntry':   return ok(deleteEntry(payload.id));
      case 'markInvoiced':  return ok(markInvoiced(payload.client, payload.rate_used));
      case 'saveSettings':  return ok(saveSettings(payload));
      default:              return err('Unknown action: ' + action);
    }
  } catch(ex) {
    return err(ex.message);
  }
}

// ─── loadAll ──────────────────────────────────
// Returns the full state object the frontend expects
function loadAll() {
  const { pending, history, settings } = getSheets();

  // --- Pending ---
  const pendingData = sheetToObjects(pending);

  // --- History ---
  const historyRaw = sheetToObjects(history);
  const historyData = historyRaw.map(row => ({
    id:            row.id,
    client:        row.client,
    date_invoiced: row.date_invoiced,
    entries:       JSON.parse(row.entries_json || '[]'),
    total:         parseFloat(row.total) || 0,
    rate_used:     parseFloat(row.rate_used) || null
  }));

  // --- Settings ---
  const settingsData = sheetToObjects(settings);
  const settingsMap  = {};
  settingsData.forEach(r => { settingsMap[r.key] = r.value; });

  const rate    = parseFloat(settingsMap['rate'])    || 75;
  const pin     = settingsMap['pin']                 || '1234';
  const clients = settingsMap['clients']
    ? JSON.parse(settingsMap['clients'])
    : [];

  return { pending: pendingData, history: historyData, rate, pin, clients };
}

// ─── addEntry ─────────────────────────────────
function addEntry(entry) {
  const { pending } = getSheets();
  pending.appendRow([
    entry.id,
    entry.client,
    entry.date,
    entry.startMin,
    entry.endMin,
    entry.lunchMin,
    entry.desc
  ]);
  autoResizeSheet(pending);
  return { added: entry.id };
}

// ─── deleteEntry ──────────────────────────────
function deleteEntry(id) {
  const { pending } = getSheets();
  const rowIndex = findRowById(pending, id);
  if (rowIndex < 0) throw new Error('Entry not found: ' + id);
  pending.deleteRow(rowIndex);
  return { deleted: id };
}

// ─── markInvoiced ─────────────────────────────
// Moves all pending rows for a client → History, atomically
function markInvoiced(client, rate_used) {
  const { pending, history } = getSheets();

  // Collect matching rows (scan bottom-up so deletion indices stay valid)
  const allRows  = pending.getDataRange().getValues();
  const headers  = allRows[0];
  const colMap   = {};
  headers.forEach((h, i) => { colMap[h] = i; });

  const toDelete = [];
  const entries  = [];

  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    if (row[colMap['client']] === client) {
      toDelete.push(i + 1); // 1-indexed sheet row
      entries.push({
        id:       row[colMap['id']],
        client:   row[colMap['client']],
        date:     row[colMap['date']],
        startMin: parseInt(row[colMap['startMin']]),
        endMin:   parseInt(row[colMap['endMin']]),
        lunchMin: parseInt(row[colMap['lunchMin']]),
        desc:     row[colMap['desc']]
      });
    }
  }

  if (!entries.length) throw new Error('No pending entries for client: ' + client);

  // Calc total — use provided rate_used (client-specific), fall back to settings default
  const rate    = parseFloat(rate_used) || parseFloat(getSettingValue('rate')) || 75;
  const total   = entries.reduce((sum, e) => {
    return sum + ((e.endMin - e.startMin - e.lunchMin) / 60) * rate;
  }, 0);

  // Write to History
  const invId = 'inv_' + Date.now().toString(36);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  history.appendRow([invId, client, today, JSON.stringify(entries), total.toFixed(2), rate.toFixed(2)]);
  autoResizeSheet(history);

  // Delete pending rows bottom-up
  toDelete.reverse().forEach(r => pending.deleteRow(r));

  return { invoiced: invId, count: entries.length, total: total.toFixed(2) };
}

// ─── saveSettings ─────────────────────────────
// payload: { rate?, pin?, clients? }
function saveSettings(payload) {
  const { settings } = getSheets();
  const data = sheetToObjects(settings);
  const map  = {};
  data.forEach((r, i) => { map[r.key] = i + 2; }); // 1-indexed, skip header

  function upsert(key, value) {
    const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (map[key]) {
      settings.getRange(map[key], 2).setValue(strVal);
    } else {
      settings.appendRow([key, strVal]);
    }
  }

  if (payload.rate    !== undefined) upsert('rate',    payload.rate);
  if (payload.pin     !== undefined) upsert('pin',     payload.pin);
  if (payload.clients !== undefined) upsert('clients', payload.clients);

  return { saved: Object.keys(payload) };
}

// ─── Helpers ──────────────────────────────────
function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function findRowById(sheet, id) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) return i + 1; // 1-indexed
  }
  return -1;
}

function getSettingValue(key) {
  const { settings } = getSheets();
  const data = sheetToObjects(settings);
  const row  = data.find(r => r.key === key);
  return row ? row.value : null;
}

function autoResizeSheet(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol > 0) sheet.autoResizeColumns(1, lastCol);
}
