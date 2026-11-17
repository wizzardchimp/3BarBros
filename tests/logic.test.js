const assert = require('assert');
const L = require('../logic.js');
let n = 0;
function t(name, fn) { fn(); n++; console.log('ok -', name); }

t('business month: your example (29/30 Sep, 2/4 Oct -> Sept; 6 Oct -> Oct)', () => {
  ['2026-09-29', '2026-09-30', '2026-10-02', '2026-10-04', '2026-10-05'].forEach(d =>
    assert.strictEqual(L.businessMonthKey(d), '2026-09', d));
  ['2026-10-06', '2026-10-31'].forEach(d => assert.strictEqual(L.businessMonthKey(d), '2026-10', d));
  assert.strictEqual(L.businessMonthKey('2027-01-03'), '2026-12'); // year rollover
});

t('MGD 20% -> 25% effective Oct 2027: history stays 20%', () => {
  const cfg = { mgd: [{ from: L.EPOCH, value: 0.2 }, { from: '2027-10', value: 0.25 }] };
  assert.strictEqual(L.mgdAt(cfg, '2026-03-15'), 0.2);
  assert.strictEqual(L.mgdAt(cfg, '2027-10-04'), 0.2);   // 4 Oct = September business month
  assert.strictEqual(L.mgdAt(cfg, '2027-10-05'), 0.2);
  assert.strictEqual(L.mgdAt(cfg, '2027-10-06'), 0.25);
  assert.strictEqual(L.mgdAt(cfg, '2028-02-01'), 0.25);
  assert.strictEqual(L.mgdAt({}, '2027-10-06'), 0.2);    // no schedule -> default
});

t('MGD applied to calc uses the dated rate', () => {
  assert.strictEqual(L.calcCategory(100, 0.5, true, 0, 0, 0, 0.2).mgd, 20);
  assert.strictEqual(L.calcCategory(100, 0.5, true, 0, 0, 0, 0.25).mgd, 25);
  assert.strictEqual(L.calcCategory(100, 0.5, true, 0, 0, 20, 0.25).mgd, 0); // flat fee: no MGD
});

const site = () => ({
  id: 's1', name: 'A', hasPool: true, poolMode: 'rent', poolRent: 100, poolPercent: 50,
  categories: [{ id: 'c1', name: 'Reels', rate: 0.6, flatFee: 0 }]
});

t('site share change is dated; earlier months keep old split', () => {
  const prev = L.applyTermChanges(null, site(), '');
  const draft = JSON.parse(JSON.stringify(prev)); draft.categories[0].rate = 0.5;
  const next = L.applyTermChanges(prev, draft, '2027-01');
  assert.strictEqual(L.resolveLoc(next, '2026-12-20').categories[0].rate, 0.6);
  assert.strictEqual(L.resolveLoc(next, '2027-01-03').categories[0].rate, 0.6); // 3 Jan = Dec
  assert.strictEqual(L.resolveLoc(next, '2027-01-06').categories[0].rate, 0.5);
  assert.strictEqual(next.categories[0].rate, 0.5); // mirror = latest
});

t('rent change is dated', () => {
  const prev = L.applyTermChanges(null, site(), '');
  const draft = JSON.parse(JSON.stringify(prev)); draft.poolRent = 150;
  const next = L.applyTermChanges(prev, draft, '2027-04');
  assert.strictEqual(L.calcPool(500, L.resolveLoc(next, '2027-03-20')).poolSS, 100);
  assert.strictEqual(L.calcPool(500, L.resolveLoc(next, '2027-04-20')).poolSS, 150);
});

t('blank effective month corrects latest row in place (no new row)', () => {
  const prev = L.applyTermChanges(null, site(), '');
  const draft = JSON.parse(JSON.stringify(prev)); draft.categories[0].rate = 0.55;
  const next = L.applyTermChanges(prev, draft, '');
  assert.strictEqual(next.categories[0].terms.length, 1);
  assert.strictEqual(L.resolveLoc(next, '2020-01-01').categories[0].rate, 0.55);
});

t('retroactive insert and unchanged edits add no rows', () => {
  let prev = L.applyTermChanges(null, site(), '');
  let d = JSON.parse(JSON.stringify(prev)); d.categories[0].rate = 0.5;
  prev = L.applyTermChanges(prev, d, '2027-06');
  const same = JSON.parse(JSON.stringify(prev));
  const n2 = L.applyTermChanges(prev, same, '2028-01');
  assert.strictEqual(n2.categories[0].terms.length, 2);
  assert.strictEqual(n2.poolTerms.length, 1);
});

t('legacy site with no terms resolves to its current values', () => {
  const legacy = site();
  assert.strictEqual(L.resolveLoc(legacy, '2026-05-05').categories[0].rate, 0.6);
  assert.strictEqual(L.resolveLoc(legacy, '2026-05-05').poolRent, 100);
});

t('float rules unchanged', () => {
  const r = L.calcCategory(100, 0.5, true, 30, 10, 0);
  assert.deepStrictEqual([r.floatTaken, r.net, r.mgd], [40, 60, 12]);
  const s = L.calcCategory(20, 0.5, true, 30, 0, 0);
  assert.deepStrictEqual([s.floatTaken, s.floatOwedAfter, s.net], [20, 10, 0]);
});

const mkEntry = (date, gross, site = 's1', cat = 'Reels') => ({
  id: date + gross, timestamp: date + 'T10:00:00Z', date,
  locations: [{ id: site, name: site, categories: [{ name: cat, gross, net: gross, mgd: gross * 0.2, supplierShare: gross * 0.2, cashLeft: gross * 0.6, floatTaken: 0 }] }]
});
const info = loc => ({ key: loc.id, label: loc.name });
const keyFn = e => e.id;

t('shiftMonth and period filters (business months)', () => {
  assert.strictEqual(L.shiftMonth('2026-01', -1), '2025-12');
  assert.strictEqual(L.shiftMonth('2026-11', 3), '2027-02');
  const rows = L.buildRows([mkEntry('2026-09-30', 10), mkEntry('2026-10-04', 20), mkEntry('2026-10-06', 30)], info, keyFn);
  const sep = rows.filter(L.periodTest('2026-09', '2026-10-20'));
  assert.deepStrictEqual(sep.map(r => r.gross), [10, 20]);          // 4 Oct is September
  assert.deepStrictEqual(rows.filter(L.periodTest('m0', '2026-10-20')).map(r => r.gross), [30]);
  assert.deepStrictEqual(rows.filter(L.periodTest('m1', '2026-10-20')).map(r => r.gross), [10, 20]);
  assert.strictEqual(rows.filter(L.periodTest('all', '2026-10-20')).length, 3);
  assert.strictEqual(L.periodMonth('m1', '2026-10-20'), '2026-09');
  assert.strictEqual(L.periodMonth('3m', '2026-10-20'), '');
});

t('21 day window and N-month window', () => {
  const rows = L.buildRows([mkEntry('2026-09-30', 1), mkEntry('2026-10-10', 2), mkEntry('2026-06-01', 4)], info, keyFn);
  assert.deepStrictEqual(rows.filter(L.periodTest('21d', '2026-10-20')).map(r => r.gross), [1, 2]);
  assert.deepStrictEqual(rows.filter(L.periodTest('3m', '2026-10-20')).map(r => r.gross), [1, 2]);
});

t('sums, grouping and month series', () => {
  const rows = L.buildRows([mkEntry('2026-09-10', 100, 'a'), mkEntry('2026-10-10', 50, 'b'), mkEntry('2026-10-12', 25, 'a', 'Digital')], info, keyFn);
  const s = L.sumRows(rows);
  assert.deepStrictEqual([s.net, s.collections], [175, 3]);
  const g = L.groupRows(rows, 'siteKey', 'siteName');
  assert.deepStrictEqual(g.map(x => [x.key, x.net]), [['a', 125], ['b', 50]]);
  const ms = L.monthSeries(rows, '2026-10', 3);
  assert.deepStrictEqual(ms.map(m => [m.key, m.net]), [['2026-08', 0], ['2026-09', 100], ['2026-10', 75]]);
});

t('low-collection flag needs history and is relative to that site+category', () => {
  const es = [100, 110, 90, 100, 105, 60, 40, 100].map((g, i) => mkEntry('2026-0' + (i + 1) + '-10', g));
  const rows = L.markLow(L.buildRows(es, info, keyFn));
  assert.deepStrictEqual(rows.map(r => r.low !== null), [false, false, false, false, false, false, true, false]); // 60 is normal variation, 40 is under half
  const few = L.markLow(L.buildRows([mkEntry('2026-01-10', 100), mkEntry('2026-02-10', 1)], info, keyFn));
  assert.ok(few.every(r => r.low === null));   // not enough history
});
t('float outstanding = latest owed per site+machine, only if > 0', () => {
  const e = (date, owed, cat = 'Reels') => ({ id: date, timestamp: date, date, locations: [{ id: 's1', name: 's1', categories: [{ name: cat, floatOwedAfter: owed }] }] });
  const out = L.floatOutstanding([e('2026-03-01', 50), e('2026-04-01', 20), e('2026-04-01', 0, 'Digital'), e('2026-02-01', 99, 'Digital')], info, keyFn);
  assert.deepStrictEqual(out.map(x => [x.cat, x.owed]), [['Reels', 20]]);
});

// ---- float recalculation ----
function chain(grosses, floatReq = 50) {
  let owed = 0;
  return grosses.map((g, i) => {
    const date = '2026-0' + (i + 1) + '-10';
    const r = L.calcCategory(g, 0.5, true, floatReq, owed, 0, 0.2);
    owed = r.floatOwedAfter;
    return { id: date, timestamp: date + 'T10:00:00Z', date, grandTotal: r.net,
      locations: [{ id: 's1', name: 's1', categories: [{ id: 'c1', name: 'Reels', rate: 0.5, flatFee: 0, floatRequired: floatReq, gross: r.gross, cash: r.gross,
        floatOwedIn: r.floatOwedIn, floatTaken: r.floatTaken, floatOwedAfter: r.floatOwedAfter, net: r.net, total: r.net, mgd: r.mgd, cashLeft: r.cashLeft, supplierShare: r.supplierShare }] }] };
  });
}
const mgd20 = () => 0.2;

t('recalc on consistent data changes nothing', () => {
  const es = chain([30, 40, 200, 150, 120]);   // first two collections do not cover the float
  const res = L.recalcFloat(es, info, '2026-01-01', mgd20, {});
  assert.strictEqual(res.changed.length, 0);
});

t('deleting a middle entry breaks the chain; recalc repairs everything after it, from the date forward', () => {
  const es = chain([30, 40, 200, 150, 120]);
  const broken = es.filter((_, i) => i !== 1);                 // delete Feb: Mar..May carry is now wrong
  const res = L.recalcFloat(broken, info, '2026-03-01', mgd20, {});
  assert.ok(res.changed.length >= 1);
  assert.ok(res.changed.every(c => c.date >= '2026-03-01'));    // nothing before the chosen date is touched
  // the repaired chain equals a clean chain built without Feb
  const clean = chain([30, 200, 150, 120]);
  const byDate = {}; res.changed.forEach(c => { byDate[c.date] = c.entry.locations[0].categories[0]; });
  broken.forEach(e => { if (!byDate[e.date]) byDate[e.date] = e.locations[0].categories[0]; });
  assert.strictEqual(byDate['2026-03-10'].floatOwedIn, 20);     // 50-30 owed from Jan; Mar covers it: owedIn must be 20 not the old 30
  // idempotent: applying the repaired entries and recalculating again yields no further changes
  const applied = broken.map(e => { const r = res.changed.find(c => c.date === e.date && c.original === e); return r ? r.entry : e; });
  assert.strictEqual(L.recalcFloat(applied, info, '2026-03-01', mgd20, {}).changed.length, 0);
});

t('recalc never changes gross, originals are untouched, and grand totals follow', () => {
  const es = chain([30, 40, 200]);
  es[1].locations[0].categories[0].floatOwedIn = 999;            // corrupt carry
  const snapshot = JSON.stringify(es);
  const res = L.recalcFloat(es, info, '2026-02-01', mgd20, {});
  assert.strictEqual(JSON.stringify(es), snapshot);              // originals not mutated
  res.changed.forEach(c => {
    const cat = c.entry.locations[0].categories[0];
    assert.strictEqual(cat.gross, c.original.locations[0].categories[0].gross);
    assert.strictEqual(c.entry.grandTotal, cat.net);
  });
});

t('recalc respects the site scope and keeps each entry\'s own share rate', () => {
  const a = chain([30, 40, 200]); const b = chain([30, 40, 200]);
  b.forEach(e => { e.locations[0].id = 's2'; e.locations[0].name = 's2'; e.id += 'b'; e.timestamp += 'b'; e.locations[0].categories[0].rate = 0.3; });
  b[0].locations[0].categories[0].floatOwedAfter = 5;            // corrupt site 2 only
  const res = L.recalcFloat(a.concat(b), info, '2026-01-01', mgd20, { siteKey: 's1' });
  assert.strictEqual(res.changed.length, 0);                     // site 2 problem ignored when scoped to site 1
  const all = L.recalcFloat(a.concat(b), info, '2026-01-01', mgd20, {});
  assert.ok(all.changed.length > 0 && all.changed.every(c => c.entry.locations[0].id === 's2'));
  all.changed.forEach(c => assert.strictEqual(c.entry.locations[0].categories[0].rate, 0.3));
});

t('uses the dated MGD rate for the entry date', () => {
  const es = chain([200]); es[0].locations[0].categories[0].mgd = 0;   // wrong stored MGD
  const res = L.recalcFloat(es, info, '2026-01-01', d => 0.25, {});
  assert.strictEqual(res.changed[0].entry.locations[0].categories[0].mgd, 37.5); // net 150 * 25%
});
t('machine type: Digital covers Digital, Inspire and GM; Reels and Pool stay separate', () => {
  ['Digital', 'digital', 'Inspire', 'Inspire 2', 'GM', 'gm', 'GM 1', 'Digital GM'].forEach(x => assert.strictEqual(L.machineType(x), 'Digital', x));
  ['Reels', 'Reel', 'reels 2'].forEach(x => assert.strictEqual(L.machineType(x), 'Reels', x));
  assert.strictEqual(L.machineType('Pool'), 'Pool');
  assert.strictEqual(L.machineType('Jukebox'), 'Jukebox');       // unknown types keep their own name
  assert.strictEqual(L.machineType('Gamma'), 'Gamma');            // 'gm' only as its own word, not inside other words
  assert.deepStrictEqual(['Pool', 'Jukebox', 'Digital', 'Reels'].sort(L.typeSort), ['Reels', 'Digital', 'Pool', 'Jukebox']);
});

t('rows carry a type; grouping by type merges Digital + Inspire + GM but keeps real names', () => {
  const e = { id: 'x', timestamp: 'x', date: '2026-05-10', locations: [{ id: 's1', name: 's1', poolGross: 40, poolSS: 20, poolCL: 20, categories: [
    { name: 'Reels', gross: 100, net: 100 }, { name: 'Digital', gross: 10, net: 10 }, { name: 'Inspire', gross: 20, net: 20 }, { name: 'GM', gross: 30, net: 30 } ] }] };
  const rows = L.buildRows([e], info, keyFn);
  assert.deepStrictEqual(rows.map(r => r.type), ['Reels', 'Digital', 'Digital', 'Digital', 'Pool']);
  assert.deepStrictEqual(rows.map(r => r.cat), ['Reels', 'Digital', 'Inspire', 'GM', 'Pool']);
  const g = L.groupRows(rows, 'type', 'type');
  assert.deepStrictEqual(g.map(x => [x.key, x.net]).sort(), [['Digital', 60], ['Pool', 40], ['Reels', 100]].sort());
});

t('21 day window is exactly 21 calendar days (today and the 20 before)', () => {
  const rows = L.buildRows([mkEntry('2026-09-29', 1), mkEntry('2026-09-30', 2), mkEntry('2026-10-20', 4)], info, keyFn);
  assert.deepStrictEqual(rows.filter(L.periodTest('21d', '2026-10-20')).map(r => r.gross), [2, 4]);   // 30 Sep..20 Oct = 21 days
});

t('day buckets zero-fill 21 days and count collections once per site visit', () => {
  const es = [mkEntry('2026-10-18', 50), mkEntry('2026-10-20', 30), mkEntry('2026-10-20', 70, 's2')];
  const b = L.dayBuckets(L.buildRows(es, info, keyFn), '2026-10-20', 21);
  assert.strictEqual(b.length, 21);
  assert.deepStrictEqual([b[0].date, b[20].date], ['2026-09-30', '2026-10-20']);
  assert.deepStrictEqual([b[18].net, b[19].net, b[20].net, b[20].collections], [50, 0, 100, 2]);
});

t('days between, last collected per site, usual gross and typo check', () => {
  assert.strictEqual(L.daysBetween('2026-10-10', '2026-10-20'), 10);
  assert.strictEqual(L.daysBetween('2026-12-30', '2027-01-02'), 3);
  const es = [100, 110, 90, 100, 120].map((g, i) => mkEntry('2026-0' + (i + 1) + '-10', g)).concat([mkEntry('2026-06-10', 5, 's2')]);
  const rows = L.buildRows(es, info, keyFn);
  assert.deepStrictEqual(L.lastCollectedBySite(rows), { s1: '2026-05-10', s2: '2026-06-10' });
  assert.strictEqual(L.usualGross(rows, 's1', 'Reels', '2026-06-01'), 104);      // mean of last 5
  assert.strictEqual(L.usualGross(rows, 's1', 'Reels', '2026-02-20'), null);       // only 2 earlier: not enough
  assert.strictEqual(L.grossLooksOff(1000, 104), 'high');
  assert.strictEqual(L.grossLooksOff(30, 104), 'low');
  assert.strictEqual(L.grossLooksOff(150, 104), '');
  assert.strictEqual(L.grossLooksOff(0, 104), '');
  assert.strictEqual(L.grossLooksOff(50, null), '');
});
console.log(n + ' tests passed');
