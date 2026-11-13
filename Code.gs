// 3BarBros — Google Apps Script backend
// Tabs: Data (entries), Rates (config), LoginLog, MasterLog (append-only audit)
const SHEET_NAME = 'Data';
const SHEET_FALLBACKS = ['Sheet1', 'Entries'];
const LOG_SHEET_NAME = 'LoginLog';
const RATES_SHEET_NAME = 'Rates';
const MASTER_SHEET_NAME = 'MasterLog';

const RECEIPTS_FOLDER_NAME = '3BarBros Receipts';

const DATA_HEADER = ['Date', 'Timestamp', 'Data'];
const MASTER_HEADER = [
  'Date', 'Submitted', 'Entry ID', 'Site', 'Category',
  'Gross', 'Float req', 'Float taken', 'Net', 'MGD', 'Supplier', 'Site Share'
];
const ALLOWED_IMAGE_TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/heic': 1 };

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function round2(v) {
  return Math.round((parseFloat(v) || 0) * 100) / 100;
}

/**
 * Optional shared-secret check. Set a Script Property named API_TOKEN
 * (Project Settings → Script properties). When set, every request must carry
 * the same token (?token= on GET, "token" in the POST body). When unset the
 * endpoint behaves as before (open) so existing deployments keep working.
 */
function isAuthorised(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!expected) return true;
  return String(token || '') === expected;
}

const META_SHEETS = {};
META_SHEETS[LOG_SHEET_NAME] = true;
META_SHEETS[RATES_SHEET_NAME] = true;
META_SHEETS[MASTER_SHEET_NAME] = true;

function getSpreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function isMetaSheetName(name) {
  return !!META_SHEETS[name];
}

function getSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    for (let i = 0; i < SHEET_FALLBACKS.length; i++) {
      sheet = ss.getSheetByName(SHEET_FALLBACKS[i]);
      if (sheet) break;
    }
  }
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(DATA_HEADER);
  }
  return sheet;
}

function getLogSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'IP']);
  }
  return sheet;
}

function getRatesSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(RATES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(RATES_SHEET_NAME);
    sheet.appendRow(['ConfigJSON']);
  }
  return sheet;
}

function getMasterLogSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(MASTER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MASTER_SHEET_NAME);
    sheet.appendRow(MASTER_HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Append-only audit rows for one submission (written in one batch).
 * Never updated/deleted by clear/delete/merge.
 */
function appendMasterLog(entry) {
  if (!entry || !entry.locations) return 0;
  const date = normalizeDate(entry.date);
  const ts = entry.timestamp || new Date().toISOString();
  const entryId = entry.id || ts;
  const rows = [];

  for (let i = 0; i < entry.locations.length; i++) {
    const loc = entry.locations[i] || {};
    const site = loc.name || '';
    const cats = loc.categories || [];
    for (let c = 0; c < cats.length; c++) {
      const cat = cats[c] || {};
      const gross = cat.gross != null ? cat.gross : (cat.cash != null ? cat.cash : 0);
      const net = cat.net != null ? cat.net : (cat.total != null ? cat.total : gross);
      rows.push([
        date, ts, entryId, site, cat.name || '',
        round2(gross),
        round2(cat.floatRequired),
        round2(cat.floatTaken),
        round2(net),
        round2(cat.mgd),
        round2(cat.supplierShare),
        round2(cat.cashLeft)
      ]);
    }
    // Pool row: only when the entry actually carries pool takings or pool shares
    if (loc.poolGross != null && loc.poolGross !== '') {
      const pg = parseFloat(loc.poolGross) || 0;
      if (pg > 0 || loc.poolSS != null || loc.poolCL != null) {
        rows.push([
          date, ts, entryId, site, 'Pool',
          round2(pg), '', '', round2(pg), 0,
          round2(loc.poolSS), round2(loc.poolCL)
        ]);
      }
    }
  }
  if (!rows.length) return 0;
  const sheet = getMasterLogSheet();
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, MASTER_HEADER.length).setValues(rows);
  return rows.length;
}

/**
 * Optional: run once from Apps Script editor to copy existing Data entries into MasterLog.
 * Skips entries whose Entry ID is already in MasterLog, so it is safe to re-run.
 */
function backfillMasterLogFromData() {
  const entries = readEntries();
  const master = getMasterLogSheet();
  const seen = {};
  const last = master.getLastRow();
  if (last > 1) {
    const ids = master.getRange(2, 3, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) seen[String(ids[i][0])] = true;
  }
  let total = 0;
  let skipped = 0;
  for (let i = 0; i < entries.length; i++) {
    const id = String(entries[i].id || entries[i].timestamp || '');
    if (id && seen[id]) { skipped++; continue; }
    total += appendMasterLog(entries[i]);
  }
  Logger.log('MasterLog backfill wrote ' + total + ' row(s) from ' + entries.length + ' entr(y/ies); skipped ' + skipped);
  return { success: true, rows: total, entries: entries.length, skipped: skipped };
}

function readConfig() {
  const sheet = getRatesSheet();
  const data = sheet.getDataRange().getValues();
  if (data.length < 2 || !data[1][0]) return null;
  try {
    return JSON.parse(String(data[1][0]));
  } catch (e) {
    Logger.log('readConfig: stored config is not valid JSON: ' + e);
    return null;
  }
}

function writeConfig(config) {
  const sheet = getRatesSheet();
  // Overwrite in place (no clear-then-append window where the config is empty)
  sheet.getRange(1, 1).setValue('ConfigJSON');
  sheet.getRange(2, 1).setValue(JSON.stringify(config));
}

function normalizeDate(val) {
  if (val instanceof Date && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const s = String(val || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return s;
}

function tryParseEntry(cell) {
  if (cell === null || cell === undefined || cell === '') return null;
  if (typeof cell === 'object' && !(cell instanceof Date)) return cell;
  const s = String(cell).trim();
  if (!s || s.charAt(0) !== '{') return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

function readEntriesFromSheet(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  if (lastRow < 2) return { entries: [], parseErrors: 0, rows: 0 };

  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const display = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  const entries = [];
  let parseErrors = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    let entry = null;
    if (row.length > 2) {
      entry = tryParseEntry(row[2]) || tryParseEntry(display[i][2]);
    }
    if (!entry) {
      for (let c = 0; c < row.length; c++) {
        entry = tryParseEntry(row[c]) || tryParseEntry(display[i][c]);
        if (entry) break;
      }
    }
    if (!entry) {
      const nonempty = row.some(function (v) { return v !== '' && v !== null; });
      if (nonempty) parseErrors++;
      continue;
    }

    let d = null;
    if (row[0] !== '' && row[0] !== null) d = normalizeDate(row[0]);
    else if (display[i][0]) d = normalizeDate(display[i][0]);
    if (!d) d = normalizeDate(entry.date);
    entry.date = d;

    if (row.length > 1 && row[1] !== '' && row[1] !== null) {
      entry.timestamp = row[1] instanceof Date
        ? row[1].toISOString()
        : String(row[1]);
    } else if (!entry.timestamp) {
      entry.timestamp = new Date().toISOString();
    }

    if (entry.action) continue;
    if (!entry.locations || !entry.locations.length) {
      if (!entry.grandTotal && !entry.grandCL) continue;
    }
    if (!entry.id) entry.id = entry.timestamp || entry.date;

    entries.push(entry);
  }
  return { entries: entries, parseErrors: parseErrors, rows: lastRow - 1 };
}

function readEntries() {
  const ss = getSpreadsheet();
  const names = [SHEET_NAME].concat(SHEET_FALLBACKS);
  let best = [];
  for (let i = 0; i < names.length; i++) {
    const sheet = ss.getSheetByName(names[i]);
    if (!sheet) continue;
    const r = readEntriesFromSheet(sheet);
    if (r.entries.length > best.length) best = r.entries;
  }
  if (!best.length) {
    const sheets = ss.getSheets();
    for (let i = 0; i < sheets.length; i++) {
      const s = sheets[i];
      if (isMetaSheetName(s.getName())) continue;
      const r = readEntriesFromSheet(s);
      if (r.entries.length > best.length) best = r.entries;
    }
  }
  return best;
}

/**
 * Wipe this spreadsheet's app data for a clean 3BarBros slate.
 * Run ONLY from the Apps Script project bound to the 3BarBros sheet.
 * WARNING: This permanently deletes config + entries + logs on THIS sheet.
 * Do NOT run on the 3Lemons sheet.
 */
function resetAppForCleanSlate() {
  // Destructive: ask for confirmation in the sheet UI when one is available.
  try {
    const ui = SpreadsheetApp.getUi();
    const answer = ui.alert(
      'Wipe ALL 3BarBros data?',
      'This permanently deletes config, entries, login log and MasterLog on THIS spreadsheet.',
      ui.ButtonSet.YES_NO
    );
    if (answer !== ui.Button.YES) {
      Logger.log('Clean slate cancelled.');
      return { success: false, cancelled: true };
    }
  } catch (e) {
    // No UI context (editor run): refuse rather than wipe silently.
    Logger.log('Clean slate needs the spreadsheet UI to confirm; run it from the sheet menu or add a UI trigger.');
    return { success: false, error: 'No UI available to confirm' };
  }

  const rates = getRatesSheet();
  rates.clearContents();
  rates.appendRow(['ConfigJSON']);
  rates.appendRow([JSON.stringify({ locations: [] })]);

  const data = getSheet();
  data.clearContents();
  data.appendRow(DATA_HEADER);

  const log = getLogSheet();
  log.clearContents();
  log.appendRow(['Timestamp', 'IP']);

  const master = getMasterLogSheet();
  master.clearContents();
  master.appendRow(MASTER_HEADER);

  Logger.log('3BarBros clean slate applied.');
  return { success: true };
}

function doGet(e) {
  if (!isAuthorised(e && e.parameter && e.parameter.token)) {
    return json({ success: false, error: 'Unauthorized' });
  }
  // Ensure meta tabs exist (LoginLog, MasterLog) on every load
  try {
    getLogSheet();
    getMasterLogSheet();
  } catch (err) {
    Logger.log('doGet: could not ensure meta sheets: ' + err);
  }
  return json({
    entries: readEntries(),
    config: readConfig()
  });
}

/** Find the row entry on a sheet that matches the target id/timestamp. */
function findEntryRow(sheet, targetId, targetTs) {
  const data = sheet.getDataRange().getValues();
  const display = sheet.getDataRange().getDisplayValues();
  for (let i = data.length - 1; i >= 1; i--) {
    let rowEntry = null;
    if (data[i].length > 2) {
      rowEntry = tryParseEntry(data[i][2]) || tryParseEntry(display[i][2]);
    }
    if (!rowEntry) {
      for (let c = 0; c < data[i].length; c++) {
        rowEntry = tryParseEntry(data[i][c]) || tryParseEntry(display[i][c]);
        if (rowEntry) break;
      }
    }
    if (!rowEntry) continue;
    const rowId = rowEntry.id ? String(rowEntry.id) : '';
    const rowTs = rowEntry.timestamp ? String(rowEntry.timestamp) : String(data[i][1] || '');
    // Prefer id. Fall back to timestamp only when either side has no id.
    let match = false;
    if (targetId && rowId) match = rowId === targetId;
    else if (targetTs && rowTs) match = rowTs === targetTs;
    if (match) return { row: i + 1, entry: rowEntry };
  }
  return null;
}

function findEntryAcrossSheets(targetId, targetTs) {
  const sheets = getSpreadsheet().getSheets();
  for (let s = 0; s < sheets.length; s++) {
    const sheet = sheets[s];
    if (isMetaSheetName(sheet.getName())) continue;
    const hit = findEntryRow(sheet, targetId, targetTs);
    if (hit) { hit.sheet = sheet; return hit; }
  }
  return null;
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ success: false, error: 'Bad request' });
  }
  if (!isAuthorised(body && body.token)) {
    return json({ success: false, error: 'Unauthorized' });
  }

  // Serialise all writes so concurrent requests can't interleave rows.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return json({ success: false, error: 'Server busy, try again' });
  }
  try {
    return handlePost(body);
  } catch (err) {
    return json({ success: false, error: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

function handlePost(body) {
  const action = body.action;

  if (action === 'login') {
    getLogSheet().appendRow([new Date().toISOString(), '']);
    return json({ success: true });
  }

  if (action === 'saveConfig') {
    if (!body.config || !Array.isArray(body.config.locations)) {
      return json({ success: false, error: 'No config' });
    }
    writeConfig(body.config);
    return json({ success: true });
  }

  if (action === 'updateEntry') {
    const entry = body.entry;
    if (!entry) return json({ success: false, error: 'No entry' });
    const targetId = entry.id ? String(entry.id) : '';
    const targetTs = entry.timestamp ? String(entry.timestamp) : '';
    const hit = findEntryAcrossSheets(targetId, targetTs);
    if (!hit) return json({ success: false, error: 'Not found' });

    const rest = {};
    for (const k in entry) {
      if (k !== 'date') rest[k] = entry[k];
    }
    if (!rest.id) rest.id = targetId || targetTs;
    if (!rest.timestamp) rest.timestamp = targetTs || new Date().toISOString();
    // Single write for the whole row
    hit.sheet.getRange(hit.row, 1, 1, 3).setValues([[
      normalizeDate(entry.date), rest.timestamp, JSON.stringify(rest)
    ]]);
    // Do NOT write MasterLog on merge/update — audit is submit-only
    return json({ success: true });
  }

  if (action === 'uploadPhoto') {
    const siteName = String(body.siteName || 'Site');
    const filename = String(body.filename || 'receipt.jpg');
    const dataBase64 = String(body.dataBase64 || '');
    if (!dataBase64) return json({ success: false, error: 'No image data' });
    return json(saveReceiptPhoto(siteName, filename, dataBase64, body.mimeType));
  }

  if (action === 'deletePhoto') {
    const fileId = String(body.fileId || '');
    let ok = false;
    if (fileId) {
      try {
        const file = DriveApp.getFileById(fileId);
        // Only ever trash files that live inside the receipts folder tree.
        if (isInReceiptsFolder(file)) {
          file.setTrashed(true);
          ok = true;
        }
      } catch (err) {
        Logger.log('deletePhoto failed: ' + err);
      }
    }
    return json({ success: ok });
  }

  if (action === 'delete') {
    const targetId = body.id ? String(body.id) : '';
    const targetTs = body.timestamp ? String(body.timestamp) : '';
    // A delete must identify the entry by id or timestamp (never by date alone).
    if (!targetId && !targetTs) return json({ success: false, error: 'No id' });
    const hit = findEntryAcrossSheets(targetId, targetTs);
    if (!hit) return json({ success: false, error: 'Not found' });
    hit.sheet.deleteRow(hit.row);
    return json({ success: true });
  }

  if (action === 'clear') {
    // Guard against stray/accidental POSTs: caller must confirm explicitly.
    if (body.confirm !== 'CLEAR') return json({ success: false, error: 'Confirmation required' });
    const sheet = getSheet();
    sheet.clearContents();
    sheet.appendRow(DATA_HEADER);
    return json({ success: true });
  }

  // ---- Submit: always APPEND (multiple entries per date OK) ----
  const sheet = getSheet();
  if (sheet.getLastRow() === 0) sheet.appendRow(DATA_HEADER);

  const date = normalizeDate(body.date);
  const ts = body.timestamp || new Date().toISOString();
  const id = body.id || ts;

  // Idempotent: a retried POST with an id we already stored is a success, not a duplicate.
  if (findEntryRow(sheet, String(id), '')) {
    return json({ success: true, id: id, timestamp: ts, duplicate: true, masterLogRows: 0 });
  }

  const rest = {};
  for (const k in body) {
    if (k !== 'date' && k !== 'token') rest[k] = body[k];
  }
  rest.timestamp = ts;
  rest.id = id;
  rest.date = date;
  sheet.appendRow([date, ts, JSON.stringify(rest)]);

  // Permanent append-only audit log (survives delete/clear/merge)
  let masterRows = 0;
  try {
    masterRows = appendMasterLog(rest);
  } catch (logErr) {
    Logger.log('MasterLog write failed: ' + logErr);
    masterRows = -1; // don't fail the save if the audit log has an issue
  }

  return json({ success: true, id: id, timestamp: ts, masterLogRows: masterRows });
}

function getReceiptsRoot() {
  const it = DriveApp.getFoldersByName(RECEIPTS_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(RECEIPTS_FOLDER_NAME);
}

/** True when the file sits (at any depth) under the receipts root folder. */
function isInReceiptsFolder(file) {
  const rootId = getReceiptsRoot().getId();
  const queue = [];
  const parents = file.getParents();
  while (parents.hasNext()) queue.push(parents.next());
  let guard = 0;
  while (queue.length && guard++ < 50) {
    const f = queue.shift();
    if (f.getId() === rootId) return true;
    const up = f.getParents();
    while (up.hasNext()) queue.push(up.next());
  }
  return false;
}

/**
 * Saves a receipt snapshot to the script owner's Google Drive, private.
 * Returns { success, fileId, url, name }.
 */
function saveReceiptPhoto(siteName, filename, dataBase64, mimeType) {
  const type = String(mimeType || 'image/jpeg').toLowerCase();
  if (!ALLOWED_IMAGE_TYPES[type]) {
    return { success: false, error: 'Unsupported image type' };
  }
  const bytes = Utilities.base64Decode(dataBase64);
  if (bytes.length > 10 * 1024 * 1024) {
    return { success: false, error: 'Image too large' };
  }
  const safeName = (String(siteName) || 'Site').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Site';
  const root = getReceiptsRoot();
  const it = root.getFoldersByName(safeName);
  const siteFolder = it.hasNext() ? it.next() : root.createFolder(safeName);
  const safeFile = (String(filename) || 'receipt.jpg').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'receipt.jpg';
  const blob = Utilities.newBlob(bytes, type, safeFile);
  const file = siteFolder.createFile(blob);
  file.setDescription('3BarBros receipt snapshot');
  return {
    success: true,
    fileId: file.getId(),
    url: 'https://drive.google.com/file/d/' + file.getId() + '/view',
    name: safeFile
  };
}

/**
 * Run this once in the Apps Script editor to force authorisation of the
 * Drive + Sheets scopes. The consent screen MUST list Google Drive.
 * If it doesn't, the appsscript.json oauthScopes block is wrong — delete it
 * so Apps Script auto-detects from this code.
 */
function __authDrive() {
  const driveRoot = DriveApp.getRootFolder().getName();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getName();
  return 'Drive: ' + driveRoot + ' | Sheet: ' + sheet;
}
