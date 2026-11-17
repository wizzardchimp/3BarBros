// Runs Code.gs against an in-memory mock of Apps Script (sheets, locks, properties, mail, triggers).
const vm = require('vm'); const fs = require('fs'); const assert = require('assert'); const path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function makeEnv(opts = {}) {
  const props = {}; const mails = []; const triggers = []; const logs = [];
  class Sheet {
    constructor(name) { this.name = name; this.rows = []; }
    getName() { return this.name; }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
    appendRow(r) { this.rows.push(r.slice()); }
    setFrozenRows() {}
    clearContents() { this.rows = []; }
    deleteRow(i) { this.rows.splice(i - 1, 1); }
    deleteRows(i, n) { this.rows.splice(i - 1, n); }
    getDataRange() { return this.getRange(1, 1, Math.max(this.rows.length, 1), Math.max(this.getLastColumn(), 1)); }
    getRange(r, c, nr = 1, nc = 1) {
      const sh = this;
      return {
        getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (sh.rows[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } o.push(row); } return o; },
        getDisplayValues() { return this.getValues().map(x => x.map(String)); },
        setValues(vals) { vals.forEach((vr, i) => vr.forEach((v, j) => { while (sh.rows.length < r + i) sh.rows.push([]); const row = sh.rows[r - 1 + i - 0]; row[c - 1 + j] = v; })); },
        setValue(v) { while (sh.rows.length < r) sh.rows.push([]); sh.rows[r - 1][c - 1] = v; }
      };
    }
  }
  const sheets = {};
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet(n)), getSheets: () => Object.values(sheets), getName: () => 'Mock' };
  const fmt = (d, tz, f) => {
    const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach(x => (p[x.type] = x.value));
    const mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    if (f === 'yyyyMMdd') return d.getFullYear() + mm + dd;
    if (f === 'yyyy-MM-dd') return d.getFullYear() + '-' + mm + '-' + dd;
    if (f === 'HH:mm') return p.hour + ':' + p.minute;
    return p.weekday + ' ' + p.day + ' ' + p.month + ', ' + p.hour + ':' + p.minute;
  };
  const ctx = {
    Logger: { log: m => logs.push(String(m)) }, console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, setProperties: o => Object.assign(props, o), deleteProperty: k => { delete props[k]; } }) },
    Session: { getScriptTimeZone: () => 'Europe/London', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Utilities: { formatDate: fmt, base64Decode: s => Buffer.from(s, 'base64'), newBlob: () => ({}) },
    MailApp: { sendEmail: m => { if (opts.mailThrows) throw new Error('Authorization required'); mails.push(m); }, getRemainingDailyQuota: () => 100 },
    ScriptApp: { newTrigger: fn => ({ timeBased: () => ({ after: ms => ({ create: () => { if (opts.triggerThrows) throw new Error('scope'); triggers.push({ fn, ms }); } }) }) }), getProjectTriggers: () => triggers },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return s; } }) },
    DriveApp: {}
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const post = body => JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify(body) } }).getContent());
  const get = () => JSON.parse(vm.runInContext('doGet', ctx)({ parameter: {} }).getContent());
  return { ctx, props, mails, triggers, logs, sheets, post, get, digest: () => vm.runInContext('sendActivityDigest', ctx)(), run: s => vm.runInContext(s, ctx) };
}
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const ident = { session: 'abc123def', who: 'Sam', device: 'iPhone · Safari' };
const entry = (id, extra = {}) => Object.assign({ id, timestamp: id, date: '2026-11-17', grandTotal: 120.5, locations: [{ id: 'a', name: 'Alberto', categories: [{ id: 'r', name: 'Reels', gross: 150, net: 120.5, mgd: 24.1, cashLeft: 60, supplierShare: 60.5 }] }] }, ident, extra);

t('login: logged, emailed immediately with who and device, saves unaffected', () => {
  const e = makeEnv();
  assert.strictEqual(e.post(Object.assign({ action: 'login' }, ident)).success, true);
  const log = e.sheets.ActivityLog.rows;
  assert.strictEqual(log.length, 2);                                    // header + 1
  assert.deepStrictEqual([log[1][1], log[1][2], log[1][3], log[1][4], log[1][6]], ['abc123def', 'Sam', 'iPhone · Safari', 'login', 'immediate']);
  assert.strictEqual(e.mails.length, 1);
  assert.ok(/Sam logged in/.test(e.mails[0].subject) && /iPhone/.test(e.mails[0].subject));
  assert.strictEqual(e.mails[0].to, 'owner@example.com');
  assert.ok(/Sam/.test(e.mails[0].body) && /Device: iPhone/.test(e.mails[0].body));
});

t('submit: collection saved, identity NOT stored in the entry, activity queued with one digest trigger', () => {
  const e = makeEnv();
  const r = e.post(entry('2026-11-17T10:00:00.000Z'));
  assert.strictEqual(r.success, true);
  const saved = JSON.parse(e.sheets.Data.rows[1][2]);
  assert.ok(!('who' in saved) && !('session' in saved) && !('device' in saved) && !('token' in saved));
  assert.strictEqual(e.mails.length, 0);                                 // not emailed straight away
  assert.strictEqual(e.triggers.length, 1);
  assert.strictEqual(e.triggers[0].ms, 5 * 60 * 1000);
  e.post(entry('2026-11-17T10:05:00.000Z'));
  assert.strictEqual(e.triggers.length, 1);                              // one digest queued, not one per action
  const a = e.sheets.ActivityLog.rows;
  assert.ok(/Collection submitted — Alberto · 2026-11-17 · net £120.50/.test(a[1][5]));
});

t('digest: one email summarising what they did, rows marked emailed, nothing sent twice', () => {
  const e = makeEnv();
  e.post(Object.assign({ action: 'login' }, ident));
  e.post(entry('2026-11-17T10:00:00.000Z')); e.post(entry('2026-11-17T10:05:00.000Z'));
  e.post(Object.assign({ action: 'delete', id: '2026-11-17T10:05:00.000Z' }, ident));
  e.digest();
  assert.strictEqual(e.mails.length, 2);                                  // login + digest
  const d = e.mails[1];
  assert.ok(/3 actions by Sam/.test(d.subject), d.subject);
  assert.ok(/Collection submitted/.test(d.body) && /Collection deleted/.test(d.body) && /iPhone/.test(d.body));
  assert.ok(e.sheets.ActivityLog.rows.slice(1).every(r => /immediate|emailed/.test(r[6])));
  e.digest(); assert.strictEqual(e.mails.length, 2);                      // nothing new -> no email
});

t('clear all is urgent: emailed immediately, and refused without confirm', () => {
  const e = makeEnv();
  assert.strictEqual(e.post(Object.assign({ action: 'clear' }, ident)).success, false);
  assert.strictEqual(e.mails.length, 0);
  assert.strictEqual(e.post(Object.assign({ action: 'clear', confirm: 'CLEAR' }, ident)).success, true);
  assert.strictEqual(e.mails.length, 1);
  assert.ok(/ALL collections were cleared/.test(e.mails[0].subject));
});

t('settings changes are described from the change log; unchanged re-saves are silent', () => {
  const e = makeEnv();
  const cfg1 = { locations: [{ name: 'A' }], changeLog: [{ ts: '2026-11-17T09:00:00Z', text: 'Site "A" added' }] };
  e.post(Object.assign({ action: 'saveConfig', config: cfg1 }, ident));
  const cfg2 = { locations: [{ name: 'A' }], changeLog: [{ ts: '2026-11-17T10:00:00Z', text: 'MGD set to 25% from 2027-10' }, ...cfg1.changeLog] };
  e.post(Object.assign({ action: 'saveConfig', config: cfg2 }, ident));
  e.post(Object.assign({ action: 'saveConfig', config: cfg2 }, ident));  // identical: no new row
  const rows = e.sheets.ActivityLog.rows.slice(1).map(r => r[5]);
  assert.strictEqual(rows.length, 2);
  assert.ok(/Site "A" added/.test(rows[0]) && /MGD set to 25% from 2027-10/.test(rows[1]) && !/Site "A" added/.test(rows[1]));
});

t('edit, delete, photo notes; duplicate submit adds no activity', () => {
  const e = makeEnv();
  e.post(entry('X1'));
  const before = e.sheets.ActivityLog.rows.length;
  assert.strictEqual(e.post(entry('X1')).duplicate, true);
  assert.strictEqual(e.sheets.ActivityLog.rows.length, before);
  e.post(Object.assign({ action: 'updateEntry', entry: entry('X1', { grandTotal: 99 }) }, ident));
  const kinds = e.sheets.ActivityLog.rows.slice(1).map(r => r[4]);
  assert.deepStrictEqual(kinds, ['submit', 'edit']);
});

t('testNotify reports success and masks the address; NOTIFY=off keeps logging but sends nothing', () => {
  const e = makeEnv();
  const r = e.post(Object.assign({ action: 'testNotify' }, ident));
  assert.deepStrictEqual([r.success, r.sent, r.to], [true, true, 'o***@example.com']);
  e.props.NOTIFY = 'off';
  const r2 = e.post(Object.assign({ action: 'testNotify' }, ident));
  assert.strictEqual(r2.sent, false); assert.ok(/off/.test(r2.error));
  e.post(Object.assign({ action: 'login' }, ident));
  assert.strictEqual(e.mails.length, 1);                                   // only the first test
  assert.ok(e.sheets.ActivityLog.rows.some(r => r[4] === 'login'));         // still logged
});

t('mail permission missing: saves still succeed, testNotify says why, digest marks rows not sent', () => {
  const e = makeEnv({ mailThrows: true });
  assert.strictEqual(e.post(Object.assign({ action: 'login' }, ident)).success, true);
  assert.strictEqual(e.post(entry('Y1')).success, true);
  assert.strictEqual(e.sheets.Data.rows.length, 2);
  const r = e.post(Object.assign({ action: 'testNotify' }, ident));
  assert.strictEqual(r.sent, false); assert.ok(/Authorization/.test(r.error));
  e.digest();
  assert.ok(/not sent/.test(e.sheets.ActivityLog.rows[e.sheets.ActivityLog.rows.length - 1][6]));
});

t('no trigger permission: digest is sent straight away instead of being lost', () => {
  const e = makeEnv({ triggerThrows: true });
  e.post(entry('Z1'));
  assert.strictEqual(e.mails.length, 1);
  assert.ok(/1 action by Sam/.test(e.mails[0].subject));
});

t('daily email cap stops floods', () => {
  const e = makeEnv();
  for (let i = 0; i < 30; i++) e.post(Object.assign({ action: 'testNotify' }, ident));
  assert.strictEqual(e.mails.length, 25);
});

t('client text cannot inject sheet formulas or HTML into emails', () => {
  const e = makeEnv();
  e.post({ action: 'login', session: 'a1', who: '=HYPERLINK("http://x","y")', device: '<b>evil</b>' });
  assert.strictEqual(e.sheets.ActivityLog.rows[1][2][0], "'");
  assert.ok(!/<b>evil<\/b>/.test(e.mails[0].htmlBody) && /&lt;b&gt;evil/.test(e.mails[0].htmlBody));
});

t('unauthorised requests are rejected before anything is logged', () => {
  const e = makeEnv(); e.props.API_TOKEN = 'secret';
  assert.strictEqual(e.post(Object.assign({ action: 'login' }, ident)).error, 'Unauthorized');
  assert.strictEqual(e.mails.length, 0);
  assert.strictEqual(e.post(Object.assign({ action: 'login', token: 'secret' }, ident)).success, true);
});

t('reads (doGet) are not logged and still create the ActivityLog sheet', () => {
  const e = makeEnv(); e.get();
  assert.strictEqual(e.sheets.ActivityLog.rows.length, 1);
  assert.strictEqual(e.mails.length, 0);
});
t('unknown actions are rejected instead of being saved as collections', () => {
  const e = makeEnv();
  const r = e.post(Object.assign({ action: 'definitelyNotReal' }, ident));
  assert.strictEqual(r.success, false); assert.ok(/Unknown action/.test(r.error));
  assert.ok(!e.sheets.Data || e.sheets.Data.rows.length <= 1);
});
t('address lookup blocked by a missing scope: clear message, NOTIFY_EMAIL works as a workaround', () => {
  const e = makeEnv();
  e.ctx.Session.getEffectiveUser = () => { throw new Error('Specified permissions are not sufficient to call Session.getEffectiveUser'); };
  const r = e.post(Object.assign({ action: 'testNotify' }, ident));
  assert.strictEqual(r.success, true); assert.strictEqual(r.sent, false);
  assert.ok(/userinfo\.email/.test(r.error) && /NOTIFY_EMAIL/.test(r.error));
  assert.strictEqual(e.post(Object.assign({ action: 'login' }, ident)).success, true);   // saving/logging unaffected
  e.props.NOTIFY_EMAIL = 'me@example.com';
  const r2 = e.post(Object.assign({ action: 'testNotify' }, ident));
  assert.strictEqual(r2.sent, true); assert.strictEqual(e.mails[0].to, 'me@example.com');
});
t('diagnose never throws and reports each blocked piece', () => {
  const e = makeEnv();
  e.ctx.Session.getEffectiveUser = () => { throw new Error('blocked'); };
  e.ctx.MailApp.getRemainingDailyQuota = () => { throw new Error('blocked'); };
  const txt = e.run('__diagnoseNotify()');
  assert.ok(/NOT SET/.test(txt) && /Own address lookup: BLOCKED/.test(txt) && /Send email permission: BLOCKED/.test(txt) && /NOWHERE/.test(txt));
  e.props.NOTIFY_EMAIL = 'me@example.com';
  assert.ok(/SET \(m\*\*\*@example\.com\)/.test(e.run('__diagnoseNotify()')) && /Emails will go to: m\*\*\*@example\.com/.test(e.run('__diagnoseNotify()')));
});
console.log(n + ' backend tests passed');
