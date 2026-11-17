// 3BarBros — Google Apps Script backend
// Tabs: Data (entries), Rates (config), LoginLog, MasterLog (append-only audit)
const SHEET_NAME = 'Data';
const SHEET_FALLBACKS = ['Sheet1', 'Entries'];
const LOG_SHEET_NAME = 'LoginLog';
const RATES_SHEET_NAME = 'Rates';
const MASTER_SHEET_NAME = 'MasterLog';
const ACTIVITY_SHEET_NAME = 'ActivityLog';

const RECEIPTS_FOLDER_NAME = '3BarBros Receipts';

const DATA_HEADER = ['Date', 'Timestamp', 'Data'];
const MASTER_HEADER = [
  'Date', 'Submitted', 'Entry ID', 'Site', 'Category',
  'Gross', 'Float req', 'Float taken', 'Net', 'MGD', 'Supplier', 'Site Share'
];
const ACTIVITY_HEADER = ['Time', 'Session', 'Who', 'Device', 'Action', 'Detail', 'Notified'];
const DIGEST_DELAY_MIN = 5;      // activity is summarised by email this many minutes after it starts
const MAX_EMAILS_PER_DAY = 25;   // safety cap (Gmail allows ~100/day for personal accounts)
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
META_SHEETS[ACTIVITY_SHEET_NAME] = true;

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

/* ================= Activity log + email notifications =================
 * Every write action is recorded in the ActivityLog sheet. The owner is emailed:
 *   - immediately when someone logs in, or does something drastic (Clear all)
 *   - a short digest of everything else about DIGEST_DELAY_MIN minutes after it starts
 * Email goes to the account that owns this script (or Script Property NOTIFY_EMAIL).
 * Set Script Property NOTIFY = off to stop emails (the log keeps recording).
 * Notification failures never block a save.
 */

function getActivitySheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(ACTIVITY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ACTIVITY_SHEET_NAME);
    sheet.appendRow(ACTIVITY_HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Stop spreadsheet formula injection from client-supplied text. */
function sanitizeCell(v) {
  const t = String(v == null ? '' : v);
  return /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
}

function escHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clientInfo(body) {
  return {
    session: String((body && body.session) || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12),
    who: String((body && body.who) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40),
    device: String((body && body.device) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60)
  };
}

function notifyEnabled() {
  return PropertiesService.getScriptProperties().getProperty('NOTIFY') !== 'off';
}

function notifyAddress() {
  const p = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  if (p) return p;
  try {
    return Session.getEffectiveUser().getEmail();
  } catch (err) {
    // Needs the userinfo.email scope in appsscript.json (or set the NOTIFY_EMAIL Script Property instead)
    Logger.log('notifyAddress: ' + err);
    return '';
  }
}

function maskEmail(addr) {
  const m = /^(.)(.*)(@.+)$/.exec(String(addr || ''));
  return m ? m[1] + '***' + m[3] : '';
}

/** Daily cap bookkeeping. Returns true when another email may be sent today. */
function takeEmailSlot() {
  const props = PropertiesService.getScriptProperties();
  const day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  let n = 0;
  if (props.getProperty('MAIL_DAY') === day) n = parseInt(props.getProperty('MAIL_N') || '0', 10);
  if (n >= MAX_EMAILS_PER_DAY) return false;
  props.setProperties({ MAIL_DAY: day, MAIL_N: String(n + 1) });
  return true;
}

/** Send one notification email to the owner. Never throws. Returns { sent, error }. */
function sendNotification(subject, text, html) {
  try {
    if (!notifyEnabled()) return { sent: false, error: 'Notifications are switched off (Script Property NOTIFY=off)' };
    const to = notifyAddress();
    if (!to) return { sent: false, error: 'No email address available: add the userinfo.email scope to appsscript.json, or set the NOTIFY_EMAIL Script Property' };
    if (!takeEmailSlot()) return { sent: false, error: 'Daily email limit reached' };
    MailApp.sendEmail({ to: to, subject: subject, body: text, htmlBody: html, name: '3BarBros' });
    return { sent: true, error: '' };
  } catch (err) {
    Logger.log('sendNotification failed: ' + err);
    return { sent: false, error: String(err && err.message || err) };
  }
}

function fmtWhen(d) {
  return Utilities.formatDate(d || new Date(), Session.getScriptTimeZone(), 'EEE d MMM, HH:mm');
}

function whoLabel(who) { return who || 'Someone (no name given)'; }

/** Short description of a collection for logs/emails. */
function describeEntryForLog(entry) {
  if (!entry) return '';
  const names = [];
  (entry.locations || []).forEach(function (l) {
    if (l && l.name && names.indexOf(l.name) < 0) names.push(l.name);
  });
  const net = parseFloat(entry.grandTotal);
  return (names.join(', ') || 'unknown site') + ' · ' + (entry.date || '') + (isNaN(net) ? '' : ' · net £' + net.toFixed(2));
}

/** What changed between two saved configs, read from the app's own change log. */
function diffChangeLog(oldCfg, newCfg) {
  const seen = {};
  ((oldCfg && oldCfg.changeLog) || []).forEach(function (x) { seen[x.ts + '|' + x.text] = true; });
  const added = ((newCfg && newCfg.changeLog) || []).filter(function (x) { return !seen[x.ts + '|' + x.text]; });
  return added.slice(0, 10).map(function (x) { return String(x.text); });
}

let PENDING_ACTIVITY = [];
/** Record something done during this request (flushed after the main work is saved). */
function note(action, detail, mode) {
  PENDING_ACTIVITY.push({ action: action, detail: String(detail || ''), mode: mode || '' });
}

function loginEmailBody(info, when) {
  const text = whoLabel(info.who) + ' logged in to 3BarBros\n\nWhen: ' + when + '\nDevice: ' + (info.device || 'unknown') +
    '\nSession: ' + (info.session || '-') + '\n\nIf they make changes you will get a summary within about ' + DIGEST_DELAY_MIN + ' minutes.\n\n— 3BarBros';
  const html = '<p><strong>' + escHtml(whoLabel(info.who)) + '</strong> logged in to 3BarBros</p>' +
    '<table cellpadding="4"><tr><td>When</td><td>' + escHtml(when) + '</td></tr><tr><td>Device</td><td>' + escHtml(info.device || 'unknown') +
    '</td></tr><tr><td>Session</td><td>' + escHtml(info.session || '-') + '</td></tr></table>' +
    '<p style="color:#666">If they make changes you will get a summary within about ' + DIGEST_DELAY_MIN + ' minutes.</p>';
  return { text: text, html: html };
}

/** Write pending activity to the log and send/queue emails. Called after the request's work is done. */
function flushActivity(body) {
  const items = PENDING_ACTIVITY;
  PENDING_ACTIVITY = [];
  if (!items.length) return;
  const info = clientInfo(body);
  const now = new Date();
  const sheet = getActivitySheet();
  const rows = items.map(function (it) {
    const immediate = it.mode === 'login' || it.mode === 'urgent';
    return [now, sanitizeCell(info.session), sanitizeCell(info.who), sanitizeCell(info.device), it.action, sanitizeCell(it.detail), immediate ? 'immediate' : ''];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ACTIVITY_HEADER.length).setValues(rows);

  let needDigest = false;
  items.forEach(function (it) {
    if (it.mode === 'login') {
      const b = loginEmailBody(info, fmtWhen(now));
      sendNotification('3BarBros: ' + whoLabel(info.who) + ' logged in' + (info.device ? ' (' + info.device + ')' : ''), b.text, b.html);
    } else if (it.mode === 'urgent') {
      const text = '⚠ ' + it.detail + '\n\nBy: ' + whoLabel(info.who) + ' (' + (info.device || 'unknown device') + ')\nWhen: ' + fmtWhen(now) + '\n\n— 3BarBros';
      sendNotification('⚠ 3BarBros: ' + it.detail, text, '<p>⚠ <strong>' + escHtml(it.detail) + '</strong></p><p>By: ' + escHtml(whoLabel(info.who)) +
        ' (' + escHtml(info.device || 'unknown device') + ')<br>When: ' + escHtml(fmtWhen(now)) + '</p>');
    } else {
      needDigest = true;
    }
  });
  if (needDigest && !scheduleDigest()) sendActivityDigest(); // no trigger permission: send straight away
}

/** Queue one digest email shortly. Returns false if a trigger could not be created. */
function scheduleDigest() {
  const props = PropertiesService.getScriptProperties();
  const at = parseInt(props.getProperty('DIGEST_AT') || '0', 10);
  if (at && Date.now() - at < 30 * 60 * 1000) return true; // one is already queued
  try {
    ScriptApp.newTrigger('sendActivityDigest').timeBased().after(DIGEST_DELAY_MIN * 60 * 1000).create();
    props.setProperty('DIGEST_AT', String(Date.now()));
    return true;
  } catch (err) {
    Logger.log('scheduleDigest failed (run __authMail once to grant permission): ' + err);
    return false;
  }
}

/** Group unsent log rows by session into an email. rows = [{time, session, who, device, action, detail}] */
function buildDigestMail(rows, tz) {
  const bySession = {};
  const order = [];
  rows.forEach(function (r) {
    const k = r.session || '-';
    if (!bySession[k]) { bySession[k] = { who: r.who, device: r.device, session: r.session, items: [] }; order.push(k); }
    if (!bySession[k].who && r.who) bySession[k].who = r.who;
    bySession[k].items.push(r);
  });
  let text = '', html = '';
  order.forEach(function (k) {
    const g = bySession[k];
    const head = whoLabel(g.who) + (g.device ? ' — ' + g.device : '');
    text += head + '\n';
    html += '<p style="margin:14px 0 4px"><strong>' + escHtml(head) + '</strong></p><ul style="margin:0;padding-left:18px">';
    // collapse repeated actions: show first 4 of each kind, then a count
    const byAction = {};
    const aOrder = [];
    g.items.forEach(function (r) {
      if (!byAction[r.action]) { byAction[r.action] = []; aOrder.push(r.action); }
      byAction[r.action].push(r);
    });
    aOrder.forEach(function (a) {
      const list = byAction[a];
      list.slice(0, 4).forEach(function (r) {
        const t = Utilities.formatDate(new Date(r.time), tz, 'HH:mm');
        text += '  ' + t + '  ' + r.detail + '\n';
        html += '<li>' + escHtml(t) + ' — ' + escHtml(r.detail) + '</li>';
      });
      if (list.length > 4) {
        text += '  …and ' + (list.length - 4) + ' more of the same\n';
        html += '<li style="color:#666">…and ' + (list.length - 4) + ' more of the same</li>';
      }
    });
    text += '\n';
    html += '</ul>';
  });
  const n = rows.length;
  const names = order.map(function (k) { return whoLabel(bySession[k].who); });
  const uniq = names.filter(function (x, i) { return names.indexOf(x) === i; });
  const subject = '3BarBros: ' + n + ' action' + (n === 1 ? '' : 's') + ' by ' + (uniq.length === 1 ? uniq[0] : uniq.length + ' people');
  return { subject: subject, text: text + '— 3BarBros', html: html + '<p style="color:#666">— 3BarBros</p>' };
}

/** Time-driven (and fallback) digest of activity not yet emailed. */
function sendActivityDigest() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return; }
  try {
    PropertiesService.getScriptProperties().deleteProperty('DIGEST_AT');
    const sheet = getActivitySheet();
    const last = sheet.getLastRow();
    if (last < 2) return;
    const first = Math.max(2, last - 499);
    const vals = sheet.getRange(first, 1, last - first + 1, ACTIVITY_HEADER.length).getValues();
    const pending = [];
    vals.forEach(function (v, i) {
      if (String(v[6] || '') === '') {
        pending.push({ rowIndex: first + i, time: v[0], session: v[1], who: v[2], device: v[3], action: v[4], detail: v[5] });
      }
    });
    if (!pending.length) return;
    const mail = buildDigestMail(pending, Session.getScriptTimeZone());
    const res = sendNotification(mail.subject, mail.text, mail.html);
    const mark = res.sent ? 'emailed ' + fmtWhen(new Date()) : 'not sent: ' + res.error;
    pending.forEach(function (p) { sheet.getRange(p.rowIndex, 7).setValue(mark); });
    // keep the log from growing forever
    if (last > 5000) sheet.deleteRows(2, 1000);
  } catch (err) {
    Logger.log('sendActivityDigest failed: ' + err);
  } finally {
    lock.releaseLock();
  }
}

/** Run once from the Apps Script editor to grant the Send-email and Triggers permissions. */
function __authMail() {
  const quota = MailApp.getRemainingDailyQuota();
  const triggers = ScriptApp.getProjectTriggers().length;
  return 'Mail quota left today: ' + quota + ' | project triggers: ' + triggers + ' | emails go to: ' + maskEmail(notifyAddress());
}

function doGet(e) {
  if (!isAuthorised(e && e.parameter && e.parameter.token)) {
    return json({ success: false, error: 'Unauthorized' });
  }
  // Ensure meta tabs exist (LoginLog, MasterLog) on every load
  try {
    getLogSheet();
    getMasterLogSheet();
    getActivitySheet();
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
  PENDING_ACTIVITY = [];
  let out;
  try {
    out = handlePost(body);
  } catch (err) {
    PENDING_ACTIVITY = [];
    out = json({ success: false, error: err.toString() });
  } finally {
    lock.releaseLock();
  }
  // Logging / email happen after the save and can never make it fail.
  try {
    flushActivity(body);
  } catch (err) {
    Logger.log('flushActivity failed: ' + err);
  }
  return out;
}

function handlePost(body) {
  const action = body.action;

  if (action === 'login') {
    getLogSheet().appendRow([new Date().toISOString(), '']);
    note('login', 'Logged in', 'login');
    return json({ success: true });
  }

  if (action === 'testNotify') {
    const info = clientInfo(body);
    const when = fmtWhen(new Date());
    const r = sendNotification('3BarBros: test notification',
      'This is a test notification from 3BarBros.\n\nSent: ' + when + '\nRequested by: ' + whoLabel(info.who) + (info.device ? ' (' + info.device + ')' : '') + '\n\nIf you can read this, login and activity emails are working.',
      '<p>This is a <strong>test notification</strong> from 3BarBros.</p><p>Sent: ' + escHtml(when) + '<br>Requested by: ' + escHtml(whoLabel(info.who)) + '</p><p>If you can read this, login and activity emails are working.</p>');
    return json({ success: true, sent: r.sent, error: r.error, to: maskEmail(notifyAddress()) });
  }

  if (action === 'saveConfig') {
    if (!body.config || !Array.isArray(body.config.locations)) {
      return json({ success: false, error: 'No config' });
    }
    const before = readConfig();
    const beforeJson = JSON.stringify(before || {});
    writeConfig(body.config);
    if (beforeJson !== JSON.stringify(body.config)) {
      const changes = diffChangeLog(before, body.config);
      note('settings', changes.length ? 'Settings changed: ' + changes.join('; ') : 'Settings saved');
    }
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
    note('edit', 'Collection edited — ' + describeEntryForLog(rest));
    // Do NOT write MasterLog on merge/update — audit is submit-only
    return json({ success: true });
  }

  if (action === 'uploadPhoto') {
    const siteName = String(body.siteName || 'Site');
    const filename = String(body.filename || 'receipt.jpg');
    const dataBase64 = String(body.dataBase64 || '');
    if (!dataBase64) return json({ success: false, error: 'No image data' });
    const saved = saveReceiptPhoto(siteName, filename, dataBase64, body.mimeType);
    if (saved && saved.success) note('photo', 'Receipt photo uploaded — ' + siteName);
    return json(saved);
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
          note('photo', 'Receipt photo removed');
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
    note('delete', 'Collection deleted — ' + describeEntryForLog(hit.entry));
    return json({ success: true });
  }

  if (action === 'clear') {
    // Guard against stray/accidental POSTs: caller must confirm explicitly.
    if (body.confirm !== 'CLEAR') return json({ success: false, error: 'Confirmation required' });
    const sheet = getSheet();
    sheet.clearContents();
    sheet.appendRow(DATA_HEADER);
    note('clear', 'ALL collections were cleared', 'urgent');
    return json({ success: true });
  }

  // A named action we don't recognise must never be saved as a collection
  if (action) return json({ success: false, error: 'Unknown action: ' + String(action).slice(0, 40) });

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
    if (k !== 'date' && k !== 'token' && k !== 'session' && k !== 'who' && k !== 'device') rest[k] = body[k];
  }
  rest.timestamp = ts;
  rest.id = id;
  rest.date = date;
  sheet.appendRow([date, ts, JSON.stringify(rest)]);
  note('submit', 'Collection submitted — ' + describeEntryForLog(rest));

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
