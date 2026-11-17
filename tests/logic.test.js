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
console.log(n + ' tests passed');
