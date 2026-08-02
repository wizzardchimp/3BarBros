// 3BarBros — Google Apps Script backend
// Tabs: Data (entries), Rates (config), LoginLog, MasterLog (append-only audit)
const SHEET_NAME = 'Data';
const SHEET_FALLBACKS = ['Sheet1', 'Entries'];
const LOG_SHEET_NAME = 'LoginLog';
const RATES_SHEET_NAME = 'Rates';
const MASTER_SHEET_NAME = 'MasterLog';

const RECEIPTS_FOLDER_NAME = '3BarBros Receipts';

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
    sheet.appendRow(['Date', 'Timestamp', 'Data']);
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
    sheet.appendRow([
      'Date',
      'Submitted',
      'Entry ID',
      'Site',
      'Category',
      'Gross',
      'Float req',
      'Float taken',
      'Net',
      'MGD',
      'Supplier',
      'Site Share'
    ]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Append-only audit rows for one submission.
 * Never updated/deleted by clear/delete/merge.
 */
function appendMasterLog(entry) {
  if (!entry || !entry.locations) return 0;
  const sheet = getMasterLogSheet();
  const date = normalizeDate(entry.date);
  const ts = entry.timestamp || new Date().toISOString();
  const entryId = entry.id || ts;
  let n = 0;

  for (let i = 0; i < entry.locations.length; i++) {
    const loc = entry.locations[i] || {};
    const site = loc.name || '';
    const cats = loc.categories || [];
    for (let c = 0; c < cats.length; c++) {
      const cat = cats[c] || {};
      const gross = cat.gross != null ? cat.gross : (cat.cash != null ? cat.cash : 0);
      const floatReq = cat.floatRequired != null ? cat.floatRequired : 0;
      const floatTaken = cat.floatTaken != null ? cat.floatTaken : 0;
      const net = cat.net != null ? cat.net : (cat.total != null ? cat.total : gross);
      sheet.appendRow([
        date,
        ts,
        entryId,
        site,
        cat.name || '',
        gross,
        floatReq,
        floatTaken,
        net,
        cat.mgd != null ? cat.mgd : 0,
        cat.supplierShare != null ? cat.supplierShare : 0,
        cat.cashLeft != null ? cat.cashLeft : 0
      ]);
      n++;
    }
    if (loc.poolGross != null && loc.poolGross !== '') {
      const pg = parseFloat(loc.poolGross) || 0;
      // Always log pool row when present (including 0) only if has explicit pool fields
      if (loc.poolSS != null || loc.poolCL != null || pg > 0) {
        sheet.appendRow([
          date,
          ts,
          entryId,
          site,
          'Pool',
          pg,
          '',
          '',
          pg,
          0,
          loc.poolSS != null ? loc.poolSS : 0,
          loc.poolCL != null ? loc.poolCL : 0
        ]);
        n++;
      }
    }
  }
  return n;
}

/**
 * Optional: run once from Apps Script editor to copy existing Data entries into MasterLog.
 * Safe to re-run only if MasterLog is empty — does not de-dupe.
 */
function backfillMasterLogFromData() {
  const entries = readEntries();
  let total = 0;
  for (let i = 0; i < entries.length; i++) {
    total += appendMasterLog(entries[i]);
  }
  Logger.log('MasterLog backfill wrote ' + total + ' row(s) from ' + entries.length + ' entr(y/ies)');
  return { success: true, rows: total, entries: entries.length };
}

function readConfig() {
  const sheet = getRatesSheet();
  const data = sheet.getDataRange().getValues();
  if (data.length < 2 || !data[1][0]) return null;
  try {
    return JSON.parse(String(data[1][0]));
  } catch (e) {
    return null;
  }
}

function writeConfig(config) {
  const sheet = getRatesSheet();
  sheet.clearContents();
  sheet.appendRow(['ConfigJSON']);
  sheet.appendRow([JSON.stringify(config)]);
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
  const rates = getRatesSheet();
  rates.clearContents();
  rates.appendRow(['ConfigJSON']);
  rates.appendRow([JSON.stringify({ locations: [] })]);

  const data = getSheet();
  data.clearContents();
  data.appendRow(['Date', 'Timestamp', 'Data']);

  const log = getLogSheet();
  log.clearContents();
  log.appendRow(['Timestamp', 'IP']);

  const master = getMasterLogSheet();
  master.clearContents();
  master.appendRow(['Date', 'Submitted', 'Entry ID', 'Site', 'Category', 'Gross', 'Float req', 'Float taken', 'Net', 'MGD', 'Supplier', 'Site Share']);

  Logger.log('3BarBros clean slate applied.');
  return { success: true };
}

function doGet(e) {
  // Ensure meta tabs exist (Rates, LoginLog, MasterLog) on every load
  try {
    getLogSheet();
    getMasterLogSheet();
  } catch (err) {}
  return ContentService.createTextOutput(JSON.stringify({
    entries: readEntries(),
    config: readConfig()
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.action === 'login') {
      const logSheet = getLogSheet();
      logSheet.appendRow([body.timestamp || new Date().toISOString(), '']);
      return ContentService.createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (body.action === 'saveConfig') {
      if (!body.config) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'No config' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      writeConfig(body.config);
      return ContentService.createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (body.action === 'updateEntry') {
      const entry = body.entry;
      if (!entry) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'No entry' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const targetId = entry.id ? String(entry.id) : '';
      const targetTs = entry.timestamp ? String(entry.timestamp) : '';
      const date = normalizeDate(entry.date);
      const ss = getSpreadsheet();
      const sheets = ss.getSheets();
      for (let s = 0; s < sheets.length; s++) {
        const sheet = sheets[s];
        if (isMetaSheetName(sheet.getName())) continue;
        const data = sheet.getDataRange().getValues();
        const display = sheet.getDataRange().getDisplayValues();
        for (let i = 1; i < data.length; i++) {
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
          let match = false;
          if (targetId && rowId && rowId === targetId) match = true;
          else if (targetTs && rowTs && rowTs === targetTs) match = true;
          if (match) {
            const rest = {};
            for (const k in entry) {
              if (k !== 'date') rest[k] = entry[k];
            }
            if (!rest.id) rest.id = targetId || targetTs;
            if (!rest.timestamp) rest.timestamp = targetTs || new Date().toISOString();
            sheet.getRange(i + 1, 1).setValue(date);
            sheet.getRange(i + 1, 2).setValue(rest.timestamp);
            sheet.getRange(i + 1, 3).setValue(JSON.stringify(rest));
            // Do NOT write MasterLog on merge/update — audit is submit-only
            return ContentService.createTextOutput(JSON.stringify({ success: true }))
              .setMimeType(ContentService.MimeType.JSON);
          }
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Not found' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (body.action === 'uploadPhoto') {
      const siteName = String(body.siteName || 'Site');
      const filename = String(body.filename || 'receipt.jpg');
      const dataBase64 = String(body.dataBase64 || '');
      if (!dataBase64) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'No image data' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const result = saveReceiptPhoto(siteName, filename, dataBase64);
      return ContentService.createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (body.action === 'deletePhoto') {
      const fileId = String(body.fileId || '');
      let ok = false;
      if (fileId) {
        try {
          const file = DriveApp.getFileById(fileId);
          file.setTrashed(true);
          ok = true;
        } catch (err) {}
      }
      return ContentService.createTextOutput(JSON.stringify({ success: ok }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (body.action === 'delete') {
      const targetId = body.id ? String(body.id) : '';
      const targetTs = body.timestamp ? String(body.timestamp) : '';
      const targetDate = body.date ? normalizeDate(body.date) : '';
      const ss = getSpreadsheet();
      const sheets = ss.getSheets();
      for (let s = 0; s < sheets.length; s++) {
        const sheet = sheets[s];
        if (isMetaSheetName(sheet.getName())) continue;
        const data = sheet.getDataRange().getValues();
        const display = sheet.getDataRange().getDisplayValues();
        for (let i = data.length - 1; i >= 1; i--) {
          let entry = null;
          if (data[i].length > 2) {
            entry = tryParseEntry(data[i][2]) || tryParseEntry(display[i][2]);
          }
          if (!entry) {
            for (let c = 0; c < data[i].length; c++) {
              entry = tryParseEntry(data[i][c]) || tryParseEntry(display[i][c]);
              if (entry) break;
            }
          }
          if (!entry) continue;

          const rowId = entry.id ? String(entry.id) : '';
          const rowTs = entry.timestamp ? String(entry.timestamp) : String(data[i][1] || '');
          const rowDate = normalizeDate(data[i][0] || entry.date);

          let match = false;
          if (targetId && rowId && rowId === targetId) match = true;
          else if (targetTs && rowTs && rowTs === targetTs) match = true;
          else if (!targetId && !targetTs && targetDate && rowDate === targetDate) match = true;

          if (match) {
            sheet.deleteRow(i + 1);
            return ContentService.createTextOutput(JSON.stringify({ success: true }))
              .setMimeType(ContentService.MimeType.JSON);
          }
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Not found' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (body.action === 'clear') {
      const sheet = getSheet();
      sheet.clearContents();
      sheet.appendRow(['Date', 'Timestamp', 'Data']);
      return ContentService.createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Always APPEND (multiple entries per date OK)
    const sheet = getSheet();
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Date', 'Timestamp', 'Data']);
    }
    const date = normalizeDate(body.date);
    const ts = body.timestamp || new Date().toISOString();
    const id = body.id || ts;
    const rest = {};
    for (const k in body) {
      if (k !== 'date') rest[k] = body[k];
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
      // Don't fail the save if audit log has an issue
      masterRows = -1;
    }

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      id: id,
      timestamp: ts,
      masterLogRows: masterRows
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Saves a receipt snapshot to the script owner's Google Drive, private.
 * Returns { success, fileId, url, name }.
 */
function saveReceiptPhoto(siteName, filename, dataBase64) {
  const bytes = Utilities.base64Decode(dataBase64);
  if (bytes.length > 10 * 1024 * 1024) {
    return { success: false, error: 'Image too large' };
  }
  const safeName = (String(siteName) || 'Site').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Site';
  let root = null;
  try {
    root = DriveApp.getFoldersByName(RECEIPTS_FOLDER_NAME).next();
  } catch (e) {
    root = DriveApp.createFolder(RECEIPTS_FOLDER_NAME);
  }
  let siteFolder = null;
  const it = root.getFoldersByName(safeName);
  if (it.hasNext()) {
    siteFolder = it.next();
  } else {
    siteFolder = root.createFolder(safeName);
  }
  const safeFile = (String(filename) || 'receipt.jpg').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'receipt.jpg';
  const blob = Utilities.newBlob(bytes, 'image/jpeg', safeFile);
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
