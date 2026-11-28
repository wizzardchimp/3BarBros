// Runs Code.gs against an in-memory mock of Apps Script (sheets, locks, properties, mail, triggers).
const vm = require('vm'); const fs = require('fs'); const assert = require('assert'); const path = require('path'); const nodeCrypto = require('crypto');
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
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet(n)), getSheets: () => Object.values(sheets), getName: () => 'Mock', getId: () => 'SSID' };
  const driveFolders = {}; const copies = [];
  const mkFolder = (name) => { const files = []; return { name, files, getFiles() { let i = 0; return { hasNext: () => i < files.length, next: () => files[i++] }; } }; };
  const fmt = (d, tz, f) => {
    const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach(x => (p[x.type] = x.value));
    const mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    if (f === 'yyyyMMdd') return d.getFullYear() + mm + dd;
    if (f === 'yyyy-MM-dd') return d.getFullYear() + '-' + mm + '-' + dd;
    if (f === 'EEE d MMM yyyy') return p.weekday + ' ' + p.day + ' ' + p.month + ' ' + p.year;
    if (f === 'HH:mm') return p.hour + ':' + p.minute;
    if (f === 'yyyy-MM-dd HHmm') return d.getFullYear() + '-' + mm + '-' + dd + ' ' + p.hour + p.minute;
    return p.weekday + ' ' + p.day + ' ' + p.month + ', ' + p.hour + ':' + p.minute;
  };
  const ctx = {
    Logger: { log: m => logs.push(String(m)) }, console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, setProperties: o => Object.assign(props, o), deleteProperty: k => { delete props[k]; } }) },
    Session: { getScriptTimeZone: () => 'Europe/London', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Utilities: { formatDate: fmt, base64Decode: s => Buffer.from(s, 'base64'), newBlob: () => ({}),
      computeDigest: (alg, str) => Array.from(nodeCrypto.createHash('sha256').update(String(str)).digest()).map(b => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'sha256' }, getUuid: () => nodeCrypto.randomUUID() },
    MailApp: { sendEmail: m => { if (opts.mailThrows) throw new Error('Authorization required'); mails.push(m); }, getRemainingDailyQuota: () => 100 },
    ScriptApp: { newTrigger: fn => ({ timeBased: () => ({
        after: ms => ({ create: () => { if (opts.triggerThrows) throw new Error('scope'); triggers.push({ fn, ms, getHandlerFunction: () => fn }); } }),
        everyDays: d => ({ atHour: h => ({ create: () => { triggers.push({ fn, daily: true, hour: h, getHandlerFunction: () => fn }); } }) }) }) }),
      getProjectTriggers: () => triggers.slice(), deleteTrigger: tr => { const i = triggers.indexOf(tr); if (i >= 0) triggers.splice(i, 1); } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return s; } }) },
    DriveApp: {
      getFoldersByName: n => ({ hasNext: () => !!driveFolders[n], next: () => driveFolders[n] }),
      createFolder: n => (driveFolders[n] = mkFolder(n)),
      getFileById: () => ({ makeCopy: (name, folder) => { const f = { getName: () => name, getDateCreated: () => new Date(Date.now() + copies.length * 1000), trashed: false, setTrashed() { this.trashed = true; } }; folder.files.push(f); copies.push(f); return f; } })
    }
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const post = body => JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify(body) } }).getContent());
  const get = () => JSON.parse(vm.runInContext('doGet', ctx)({ parameter: {} }).getContent());
  return { ctx, props, mails, triggers, logs, sheets, driveFolders, copies, post, get, digest: () => vm.runInContext('sendActivityDigest', ctx)(), run: s => vm.runInContext(s, ctx) };
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

t('submit: collection saved, identity NOT stored in the entry, each collection emailed straight away', () => {
  const e = makeEnv();
  const r = e.post(entry('2026-11-17T10:00:00.000Z'));
  assert.strictEqual(r.success, true);
  const saved = JSON.parse(e.sheets.Data.rows[1][2]);
  assert.ok(!('who' in saved) && !('session' in saved) && !('device' in saved) && !('token' in saved));
  assert.strictEqual(e.mails.length, 1);                                 // emailed straight away
  assert.strictEqual(e.triggers.length, 0);                              // no digest needed for a collection
  e.post(entry('2026-11-17T10:05:00.000Z'));
  assert.strictEqual(e.mails.length, 2);                                 // one email per collection
  const a = e.sheets.ActivityLog.rows;
  assert.ok(/Collection submitted — Alberto · 2026-11-17 · net £120.50/.test(a[1][5]));
  assert.ok(a.slice(1).every(r => r[6] === 'immediate'));               // already emailed: the digest will not repeat it
});

t('collection email: short summary with site, who, totals, each machine, float and receipts', () => {
  const e = makeEnv();
  const big = entry('C1', { date: '2026-11-17', grandTotal: 1234.5, grandCL: 740.7, grandSS: 493.8, grandMGD: 246.9, grandFloat: 25,
    locations: [{ id: 'a', name: 'Alberto', poolGross: 60, poolSS: 30, poolCL: 30, photos: [{ fileId: 'f1' }, { fileId: 'f2' }],
      categories: [{ id: 'r', name: 'Reels', gross: 800, net: 775, floatTaken: 25 }, { id: 'd', name: 'Inspire', gross: 399.5, net: 399.5, floatTaken: 0 }, { id: 'x', name: 'GM', gross: 0, net: 0 }] }] });
  e.post(big);
  const m = e.mails[0];
  assert.strictEqual(m.to, 'owner@example.com');
  assert.strictEqual(m.subject, '3BarBros: Alberto — £1,234.50 net (Sam)');
  ['New collection — Alberto', 'Entered by: Sam (iPhone · Safari)', 'Net £1,234.50', 'Site share £740.70', 'Supplier £493.80', 'MGD £246.90', 'Float taken £25.00',
   'Reels: £800.00 (float £25.00 taken)', 'Inspire: £399.50', 'Pool: £60.00', 'Receipts: 2 photos'].forEach(x => assert.ok(m.body.indexOf(x) >= 0, 'missing: ' + x));
  assert.ok(m.body.indexOf('GM:') < 0);                                 // machines with nothing entered are left out
  assert.ok(/<li>Reels: £800.00/.test(m.htmlBody) && /Net<\/strong>/.test(m.htmlBody));
});

t('collection email: site names are HTML-escaped, a retried submit does not email twice', () => {
  const e = makeEnv();
  const x = entry('E1'); x.locations[0].name = '<b>Evil</b> & Co';
  e.post(x); e.post(x);                                                  // second is a duplicate retry
  assert.strictEqual(e.mails.length, 1);
  assert.ok(!/<b>Evil<\/b>/.test(e.mails[0].htmlBody) && /&lt;b&gt;Evil/.test(e.mails[0].htmlBody));
});

t('collection emails can be switched off (they fall back to the digest) and edits/deletes stay in the digest', () => {
  const e = makeEnv(); e.props.NOTIFY_COLLECTIONS = 'off';
  e.post(entry('F1'));
  assert.strictEqual(e.mails.length, 0);
  assert.strictEqual(e.triggers.length, 1);                              // digest queued instead
  e.post(Object.assign({ action: 'updateEntry', entry: entry('F1', { grandTotal: 99 }) }, ident));
  e.digest();
  assert.strictEqual(e.mails.length, 1);
  assert.ok(/Collection submitted/.test(e.mails[0].body) && /Collection edited/.test(e.mails[0].body));
});

t('if the collection email cannot be sent, the digest still reports it (nothing is lost)', () => {
  const e = makeEnv({ mailThrows: true });
  assert.strictEqual(e.post(entry('G1')).success, true);                 // saving unaffected
  assert.strictEqual(e.sheets.ActivityLog.rows[1][6], '');               // left for the digest
  assert.strictEqual(e.triggers.length, 1);
  e.digest();
  assert.ok(/not sent/.test(e.sheets.ActivityLog.rows[1][6]));
});

t('digest: one email summarising edits and deletes, rows marked emailed, nothing sent twice', () => {
  const e = makeEnv();
  e.post(Object.assign({ action: 'login' }, ident));
  e.post(entry('2026-11-17T10:00:00.000Z')); e.post(entry('2026-11-17T10:05:00.000Z'));
  e.post(Object.assign({ action: 'delete', id: '2026-11-17T10:05:00.000Z' }, ident));
  e.post(Object.assign({ action: 'updateEntry', entry: entry('2026-11-17T10:00:00.000Z', { grandTotal: 5 }) }, ident));
  e.digest();
  assert.strictEqual(e.mails.length, 4);                                  // login + 2 collections + digest
  const d = e.mails[3];
  assert.ok(/2 actions by Sam/.test(d.subject), d.subject);
  assert.ok(/Collection deleted/.test(d.body) && /Collection edited/.test(d.body) && /iPhone/.test(d.body));
  assert.ok(!/Collection submitted/.test(d.body));                        // already emailed on its own
  assert.ok(e.sheets.ActivityLog.rows.slice(1).every(r => /immediate|emailed/.test(r[6])));
  e.digest(); assert.strictEqual(e.mails.length, 4);                      // nothing new -> no email
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
  e.post(entry('Z1'));                                                    // emailed on its own
  e.post(Object.assign({ action: 'delete', id: 'Z1' }, ident));           // digest item: no trigger permission -> sent at once
  assert.strictEqual(e.mails.length, 2);
  assert.ok(/1 action by Sam/.test(e.mails[1].subject));
});

t('daily email cap stops floods', () => {
  const e = makeEnv();
  for (let i = 0; i < 50; i++) e.post(Object.assign({ action: 'testNotify' }, ident));
  assert.strictEqual(e.mails.length, 40);
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

// ================= PIN sign-in =================
const addSam = (e) => e.run("setUserPin('Sam', '1234')");
const login = (e, name, pin, extra = {}) => e.post(Object.assign({ action: 'login', name, pin }, ident, extra));

t('no people added: the app behaves exactly as before (open + advisory identity)', () => {
  const e = makeEnv();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e.get().backup)), { last: '' });
  assert.strictEqual(e.run("usersExist()"), false);
  assert.strictEqual(e.post(entry('N1')).success, true);
  const info = JSON.parse(vm.runInContext('doGet', e.ctx)({ parameter: { action: 'authinfo' } }).getContent());
  assert.strictEqual(info.auth, false);
});

t('adding a person turns sign-in on for everything: reads and writes need a token', () => {
  const e = makeEnv(); addSam(e);
  assert.strictEqual(e.run("usersExist()"), true);
  const g = e.get(); assert.strictEqual(g.error, 'Unauthorized'); assert.strictEqual(g.needLogin, true);
  const p = e.post(entry('A1')); assert.strictEqual(p.success, false); assert.strictEqual(p.needLogin, true);
  assert.ok(!e.sheets.Data || e.sheets.Data.rows.length <= 1);
  const info = JSON.parse(vm.runInContext('doGet', e.ctx)({ parameter: { action: 'authinfo' } }).getContent());
  assert.strictEqual(info.auth, true);
});

t('correct PIN: token issued, reads/writes work, activity names the VERIFIED person (not what the client typed)', () => {
  const e = makeEnv(); addSam(e);
  const r = login(e, 'sam', '1234', { who: 'Mallory' });                       // name is case-insensitive
  assert.strictEqual(r.success, true); assert.strictEqual(r.name, 'Sam'); assert.ok(r.token && r.token.length >= 32);
  const g = JSON.parse(vm.runInContext('doGet', e.ctx)({ parameter: { auth: r.token } }).getContent());
  assert.ok(Array.isArray(g.entries));
  assert.strictEqual(e.post(Object.assign(entry('A2', { who: 'Mallory' }), { authToken: r.token })).success, true);
  const rows = e.sheets.ActivityLog.rows.slice(1);
  assert.ok(rows.length >= 2 && rows.every(x => x[2] === 'Sam'), JSON.stringify(rows.map(x => x[2])));
  assert.ok(e.mails.some(m => /Sam logged in/.test(m.subject)));
});

t('wrong PIN: generic error, no token; 5 wrong PINs lock the name and email an alert; correct PIN is refused while locked', () => {
  const e = makeEnv(); addSam(e);
  const r = login(e, 'Sam', '0000'); assert.strictEqual(r.success, false); assert.strictEqual(r.error, 'Wrong name or PIN'); assert.ok(!r.token);
  assert.strictEqual(login(e, 'Nobody', '1234').error, 'Wrong name or PIN');   // unknown names look the same
  for (let i = 0; i < 4; i++) login(e, 'Sam', '1111');
  assert.ok(e.mails.some(m => /repeated wrong PINs/.test(m.subject)));
  const locked = login(e, 'Sam', '1234'); assert.strictEqual(locked.success, false); assert.ok(/Too many wrong tries/.test(locked.error));
  // lock expires
  const f = JSON.parse(e.props.FAILS); f.sam.until = Date.now() - 1; e.props.FAILS = JSON.stringify(f);
  assert.strictEqual(login(e, 'Sam', '1234').success, true);
});

t('PINs are stored hashed, validated, and resettable; people can be removed', () => {
  const e = makeEnv(); addSam(e);
  const flat = JSON.stringify(e.sheets.Users.rows);
  assert.ok(!/1234/.test(flat) && e.sheets.Users.rows[1][2].length === 64);
  assert.strictEqual(e.run("setUserPin('Bad', '12')").ok, false);
  assert.strictEqual(e.run("setUserPin('', '1234')").ok, false);
  e.run("setUserPin('SAM', 'newpin9')");                                         // reset (same person, any case)
  assert.strictEqual(e.sheets.Users.rows.length, 2);
  assert.strictEqual(login(e, 'Sam', '1234').success, false);
  assert.strictEqual(login(e, 'Sam', 'newpin9').success, true);
  assert.strictEqual(e.run("removeUser('sam')"), true);
  assert.strictEqual(e.run("usersExist()"), false);
});

t('tokens expire and can be revoked by sign-out', () => {
  const e = makeEnv(); addSam(e);
  const { token } = login(e, 'Sam', '1234');
  assert.strictEqual(e.post(Object.assign({ action: 'logout', authToken: token }, ident)).success, true);
  assert.strictEqual(e.post(Object.assign(entry('X'), { authToken: token })).needLogin, true);
  const t2 = login(e, 'Sam', '1234').token;
  const toks = JSON.parse(e.props.TOKENS); toks[t2].exp = Date.now() - 1; e.props.TOKENS = JSON.stringify(toks);
  assert.strictEqual(e.post(Object.assign(entry('Y'), { authToken: t2 })).needLogin, true);
  assert.strictEqual(e.post(Object.assign(entry('Z'), { authToken: 'made-up-token' })).needLogin, true);
});

t('AUTH=off is an emergency switch; API_TOKEN and PINs are both required when both are set', () => {
  const e = makeEnv(); addSam(e);
  e.props.AUTH = 'off';
  assert.strictEqual(e.post(entry('O1')).success, true);                        // open again
  delete e.props.AUTH; e.props.API_TOKEN = 'secret';
  assert.strictEqual(login(e, 'Sam', '1234').error, 'Unauthorized');            // device secret missing
  const r = login(e, 'Sam', '1234', { token: 'secret' }); assert.strictEqual(r.success, true);
  assert.strictEqual(e.post(Object.assign(entry('O2'), { token: 'secret' })).needLogin, true);   // device ok, no sign-in
  assert.strictEqual(e.post(Object.assign(entry('O3'), { token: 'secret', authToken: r.token })).success, true);
});

// ================= backups =================
t('backupNow copies the sheet, keeps the newest 14, records the time; the action is rate-limited', () => {
  const e = makeEnv();
  for (let i = 0; i < 17; i++) { e.props.LAST_BACKUP_MS = '0'; e.post(Object.assign({ action: 'backupNow' }, ident)); }
  const folder = e.driveFolders['3BarBros Backups'];
  assert.strictEqual(folder.files.length, 17);
  assert.strictEqual(folder.files.filter(f => !f.trashed).length, 14);
  assert.ok(/^3BarBros backup \d{4}-\d{2}-\d{2} \d{4}$/.test(folder.files[0].getName()));
  assert.ok(e.get().backup.last.length > 10);
  const again = e.post(Object.assign({ action: 'backupNow' }, ident));
  assert.strictEqual(again.success, false); assert.ok(/moment ago/.test(again.error));
});

t('setupDailyBackup installs exactly one daily trigger (and replaces an old one)', () => {
  const e = makeEnv();
  e.run('setupDailyBackup()'); e.run('setupDailyBackup()');
  const tr = e.triggers.filter(x => x.fn === 'dailyBackup');
  assert.strictEqual(tr.length, 1); assert.strictEqual(tr[0].hour, 3);
});

t('dailyBackup failure emails the owner instead of failing silently', () => {
  const e = makeEnv();
  e.ctx.DriveApp.getFileById = () => { throw new Error('Drive unavailable'); };
  e.run('dailyBackup()');
  assert.ok(e.mails.some(m => /daily backup failed/.test(m.subject)));
});

t('onOpen builds the owner menu when a sheet UI exists and is harmless without one', () => {
  const e = makeEnv();
  e.run('onOpen()');                                                              // no getUi in the mock: must not throw
  const items = [];
  e.ctx.SpreadsheetApp.getUi = () => ({ createMenu: () => { const m = { addItem: (l) => { items.push(l); return m; }, addSeparator: () => m, addToUi: () => {} }; return m; } });
  e.run('onOpen()');
  assert.ok(items.includes('Add person / reset PIN') && items.includes('Back up now'));
});
console.log(n + ' backend tests passed');
