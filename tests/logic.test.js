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

const rowsFor = es => L.buildRows(es, info, keyFn);

t('statement text lists every collection and machine, then the totals that matter to the supplier', () => {
  const e1 = mkEntry('2026-11-03', 100); e1.locations[0].categories.push({ name: 'GM', gross: 50, net: 50, mgd: 10, supplierShare: 20, cashLeft: 30, floatTaken: 0 });
  const txt = L.statementText('Alberto', 'November 2026', '6 Nov – 5 Dec', rowsFor([e1, mkEntry('2026-11-17', 200)]));
  assert.ok(/Alberto · November 2026 \(6 Nov – 5 Dec\)/.test(txt));
  assert.ok(txt.indexOf('2026-11-03') < txt.indexOf('2026-11-17'));
  assert.ok(/Reels: gross £100.00/.test(txt) && /GM: gross £50.00/.test(txt));
  assert.ok(/Collections: 2/.test(txt) && /Net: £350.00/.test(txt) && /Supplier share: £/.test(txt));
});

t('search matches dates, site, machine and amounts (with or without £ and commas); all words must match', () => {
  const card = { date: '2026-11-17', label: 'Tue 17 Nov', siteName: 'The Barley', rows: [{ cat: 'Reels', net: 1234.5, gross: 1234.5, cl: 740.7, ss: 493.8 }, { cat: 'Inspire', net: 70, gross: 70, cl: 42, ss: 28 }] };
  ['', 'barley', 'INSPIRE', 'tue 17', '2026-11', '£1,234.50', '1234', '70', 'barley reels'].forEach(q => assert.ok(L.cardMatches(card, q), q));
  ['alberto', 'barley gm', '999', 'dec'].forEach(q => assert.ok(!L.cardMatches(card, q), q));
});

t('sorting: newest/oldest by date, highest/lowest by net', () => {
  const mk = (date, net, ts) => ({ date, ts, rows: [{ net }] });
  const cs = [mk('2026-11-03', 50, 'a'), mk('2026-11-17', 10, 'b'), mk('2026-11-10', 90, 'c')];
  assert.deepStrictEqual(L.sortCards(cs, 'new').map(c => c.date), ['2026-11-17', '2026-11-10', '2026-11-03']);
  assert.deepStrictEqual(L.sortCards(cs, 'old').map(c => c.date), ['2026-11-03', '2026-11-10', '2026-11-17']);
  assert.deepStrictEqual(L.sortCards(cs, 'high').map(c => c.rows[0].net), [90, 50, 10]);
  assert.deepStrictEqual(L.sortCards(cs, 'low').map(c => c.rows[0].net), [10, 50, 90]);
  assert.strictEqual(cs[0].date, '2026-11-03');                                    // input untouched
});

t('sparkline series: last n collections for one machine, with % vs earlier average', () => {
  const es = [100, 100, 100, 100, 150].map((g, i) => mkEntry('2026-0' + (i + 1) + '-10', g));
  const s = L.sparkSeries(rowsFor(es), 's1', 'Reels', 12);
  assert.deepStrictEqual([s.vals.length, s.pct], [5, 50]);
  assert.strictEqual(L.sparkSeries(rowsFor(es.slice(0, 3)), 's1', 'Reels').pct, null);          // too few points
  assert.strictEqual(L.sparkSeries(rowsFor(es), 's1', 'Reels', 3).vals.length, 3);
});

t('next site after saving skips sites already collected that day and wraps round', () => {
  assert.strictEqual(L.nextSiteAfter(['a', 'b', 'c'], ['a'], 'a'), 'b');
  assert.strictEqual(L.nextSiteAfter(['a', 'b', 'c'], ['a', 'b'], 'b'), 'c');
  assert.strictEqual(L.nextSiteAfter(['a', 'b', 'c'], ['a', 'c'], 'c'), 'b');                    // wraps
  assert.strictEqual(L.nextSiteAfter(['a', 'b'], ['a', 'b'], 'b'), '');                            // all done
  assert.strictEqual(L.nextSiteAfter(['a'], ['a'], 'a'), '');
});

t('overdue level follows each site\'s own limit', () => {
  assert.strictEqual(L.overdueLevel(13, 14), ''); assert.strictEqual(L.overdueLevel(14, 14), 'late');
  assert.strictEqual(L.overdueLevel(21, 14), 'vlate'); assert.strictEqual(L.overdueLevel(29, 30), '');
  assert.strictEqual(L.overdueLevel(30, 30), 'late'); assert.strictEqual(L.overdueLevel(15, undefined), 'late');
});

t('float review is only needed when later collections exist for that site', () => {
  const es = [mkEntry('2026-03-10', 1), mkEntry('2026-05-10', 1), mkEntry('2026-04-10', 1, 's2')];
  assert.strictEqual(L.floatReviewFrom(es, 's1', '2026-03-10', info), '2026-03-10');             // May comes after
  assert.strictEqual(L.floatReviewFrom(es, 's1', '2026-05-10', info), '');                         // newest: nothing after
  assert.strictEqual(L.floatReviewFrom(es, 's2', '2026-03-01', info), '2026-03-01');
  assert.strictEqual(L.floatReviewFrom([], 's1', '2026-03-10', info), '');
});
console.log(n + ' tests passed');
