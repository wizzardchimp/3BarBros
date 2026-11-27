/* 3BarBros — pure business logic (no DOM). Loaded by index.html and by tests/logic.test.js */
(function (root) {
  'use strict';

  // Bump together with the ?v= on the <script src> in index.html and REQUIRED_LOGIC_VERSION there
  // (tests/version.test.js fails if they drift). Prevents a stale cached logic.js breaking the pages.
  var LOGIC_VERSION = '2026-11-27.1';

  var MGD_RATE = 0.2;              // default / fallback MGD when no dated schedule exists
  var BUSINESS_MONTH_CUTOFF_DAY = 5; // collections on the 1st–5th belong to the PREVIOUS month
  var EPOCH = '0000-00';           // "from the beginning" marker for a first schedule row

  function round(v) { return Math.round((parseFloat(v) || 0) * 100) / 100; }

  /** Business month key 'YYYY-MM' for a 'YYYY-MM-DD' date. 6th→5th of next month. */
  function businessMonthKey(dateStr) {
    if (!dateStr || String(dateStr).length < 10) return '';
    var y = parseInt(String(dateStr).slice(0, 4), 10);
    var mo = parseInt(String(dateStr).slice(5, 7), 10);
    var day = parseInt(String(dateStr).slice(8, 10), 10);
    if (!y || !mo || !day) return String(dateStr).slice(0, 7);
    var yy = y, mm = mo;
    if (day <= BUSINESS_MONTH_CUTOFF_DAY) {
      mm -= 1;
      if (mm < 1) { mm = 12; yy -= 1; }
    }
    return yy + '-' + String(mm).padStart(2, '0');
  }

  /* ---------- dated schedules: [{ from: 'YYYY-MM', ...values }] ---------- */

  function sortTerms(terms) {
    return (terms || []).slice().sort(function (a, b) { return String(a.from).localeCompare(String(b.from)); });
  }

  /** The row in force for a business month: latest row with from <= monthKey (else the earliest). */
  function termAt(terms, monthKey) {
    var list = sortTerms(terms);
    if (!list.length) return null;
    var hit = list[0];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].from) <= String(monthKey)) hit = list[i];
    }
    return hit;
  }

  /** Add (or replace the same-month) row; returns a new sorted array. */
  function addTerm(terms, from, values) {
    var list = sortTerms(terms).filter(function (t) { return t.from !== from; });
    list.push(Object.assign({ from: from }, values));
    return sortTerms(list);
  }

  function lastTerm(terms) {
    var list = sortTerms(terms);
    return list.length ? list[list.length - 1] : null;
  }

  /** MGD rate (0–1) in force for a collection date. cfg.mgd = [{from, value}] */
  function mgdAt(cfg, dateStr) {
    var t = cfg && Array.isArray(cfg.mgd) && cfg.mgd.length ? termAt(cfg.mgd, businessMonthKey(dateStr)) : null;
    var v = t ? parseFloat(t.value) : NaN;
    return isNaN(v) ? MGD_RATE : v;
  }

  /** Copy of a site with category rate/flatFee and pool terms as they applied on dateStr. */
  function resolveLoc(loc, dateStr) {
    var mk = businessMonthKey(dateStr);
    var out = Object.assign({}, loc);
    var pt = Array.isArray(loc.poolTerms) && loc.poolTerms.length ? termAt(loc.poolTerms, mk) : null;
    if (pt) {
      out.poolMode = pt.poolMode;
      out.poolRent = pt.poolRent;
      out.poolPercent = pt.poolPercent;
    }
    out.categories = (loc.categories || []).map(function (c) {
      var t = Array.isArray(c.terms) && c.terms.length ? termAt(c.terms, mk) : null;
      var o = Object.assign({}, c);
      if (t) { o.rate = t.rate; o.flatFee = t.flatFee; }
      return o;
    });
    return out;
  }

  function seedCatTerms(c) { return [{ from: EPOCH, rate: c.rate, flatFee: c.flatFee || 0 }]; }
  function seedPoolTerms(l) {
    return [{ from: EPOCH, poolMode: l.poolMode, poolRent: l.poolRent || 0, poolPercent: l.poolPercent }];
  }

  /**
   * Merge a site edit into dated schedules.
   * prev = saved site (or null for a new site); next = edited draft; effMonth = 'YYYY-MM' or ''.
   * With effMonth: a changed value becomes a new row from that month (history untouched).
   * With '' : the latest row is corrected in place.
   * Mutates and returns `next`. Mirrors the latest row onto cat.rate / cat.flatFee / pool fields.
   */
  function applyTermChanges(prev, next, effMonth) {
    var prevCats = {};
    (prev && prev.categories || []).forEach(function (c) { prevCats[c.id] = c; });

    (next.categories || []).forEach(function (c) {
      var p = prevCats[c.id];
      if (!p) { c.terms = seedCatTerms(c); return; }
      var terms = Array.isArray(p.terms) && p.terms.length ? sortTerms(p.terms) : seedCatTerms(p);
      var cur = lastTerm(terms);
      var changed = round(c.rate * 100) !== round(cur.rate * 100) || round(c.flatFee) !== round(cur.flatFee);
      if (changed) {
        var vals = { rate: c.rate, flatFee: c.flatFee || 0 };
        if (effMonth) terms = addTerm(terms, effMonth, vals);
        else terms = addTerm(terms, cur.from, vals);
      }
      c.terms = terms;
      var latest = lastTerm(terms);
      c.rate = latest.rate; c.flatFee = latest.flatFee;
    });

    var pPrev = prev && Array.isArray(prev.poolTerms) && prev.poolTerms.length
      ? sortTerms(prev.poolTerms)
      : (prev ? seedPoolTerms(prev) : null);
    if (!pPrev) {
      next.poolTerms = seedPoolTerms(next);
    } else {
      var pc = lastTerm(pPrev);
      var pChanged = next.poolMode !== pc.poolMode ||
        round(next.poolRent) !== round(pc.poolRent) ||
        round(next.poolPercent) !== round(pc.poolPercent);
      var pTerms = pPrev;
      if (pChanged) {
        var pv = { poolMode: next.poolMode, poolRent: next.poolRent || 0, poolPercent: next.poolPercent };
        pTerms = addTerm(pPrev, effMonth || pc.from, pv);
      }
      next.poolTerms = pTerms;
      var pl = lastTerm(pTerms);
      next.poolMode = pl.poolMode; next.poolRent = pl.poolRent; next.poolPercent = pl.poolPercent;
    }
    return next;
  }

  /* ---------- money maths ---------- */

  /**
   * Float + split for one category. mgdRate defaults to MGD_RATE; callers pass the
   * rate in force on the collection date (mgdAt).
   */
  function calcCategory(gross, rate, hasFloat, floatRequired, floatOwedIn, flatFee, mgdRate) {
    gross = parseFloat(gross) || 0;
    rate = parseFloat(rate);
    if (isNaN(rate)) rate = 0.5;
    var mgdR = parseFloat(mgdRate);
    if (isNaN(mgdR)) mgdR = MGD_RATE;
    floatRequired = hasFloat ? (parseFloat(floatRequired) || 0) : 0;
    floatOwedIn = hasFloat ? (parseFloat(floatOwedIn) || 0) : 0;
    flatFee = parseFloat(flatFee) || 0;
    if (floatRequired < 0) floatRequired = 0;
    if (floatOwedIn < 0) floatOwedIn = 0;

    var fee = flatFee > 0 ? Math.min(flatFee, gross) : 0;
    var afterFee = gross - fee;
    var toRecover = hasFloat ? (floatRequired + floatOwedIn) : 0;
    var floatTaken = Math.min(afterFee, toRecover);
    var net = afterFee - floatTaken;
    var floatOwedAfter = toRecover - floatTaken;

    var mgd = flatFee > 0 ? 0 : net * mgdR;
    var cashLeft = net * rate;
    var supplierShare = (net - cashLeft) + fee;

    return {
      gross: round(gross), floatTaken: round(floatTaken), floatOwedIn: round(floatOwedIn),
      floatOwedAfter: round(floatOwedAfter), net: round(net), total: round(net),
      mgd: round(mgd), cashLeft: round(cashLeft), supplierShare: round(supplierShare)
    };
  }

  function calcPool(poolGross, loc) {
    var g = parseFloat(poolGross) || 0;
    var mode = (loc && loc.poolMode) || (loc && loc.poolRent > 0 ? 'rent' : 'fifty');
    var poolSS, poolCL;
    if (mode === 'rent') {
      var rent = parseFloat(loc.poolRent) || 0;
      poolSS = Math.min(rent, g);
      poolCL = g - poolSS;
    } else if (mode === 'percent') {
      var pct = parseFloat(loc.poolPercent);
      if (isNaN(pct)) pct = 50;
      pct = Math.max(0, Math.min(100, pct));
      poolSS = g * (pct / 100);
      poolCL = g - poolSS;
    } else {
      poolSS = g * 0.5;
      poolCL = g * 0.5;
    }
    return { poolGross: round(g), poolSS: round(poolSS), poolCL: round(poolCL), poolMode: mode };
  }


  /* ---------- history / review helpers (pure) ---------- */

  function shiftMonth(key, n) {
    var y = parseInt(String(key).slice(0, 4), 10), m = parseInt(String(key).slice(5, 7), 10);
    var idx = y * 12 + (m - 1) + n;
    return Math.floor(idx / 12) + '-' + String((idx % 12) + 1).padStart(2, '0');
  }

  function daysBefore(dateStr, n) {
    var y = parseInt(dateStr.slice(0, 4), 10), m = parseInt(dateStr.slice(5, 7), 10), d = parseInt(dateStr.slice(8, 10), 10);
    var t = new Date(Date.UTC(y, m - 1, d - n));
    return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0') + '-' + String(t.getUTCDate()).padStart(2, '0');
  }

  /**
   * Filter "type" for a category/machine name. Digital groups Digital, Inspire and GM;
   * Reels and Pool are their own types; anything else keeps its own name (e.g. Jukebox).
   */
  var TYPE_ORDER = ['Reels', 'Digital', 'Pool'];
  function machineType(name) {
    var n = String(name || '').trim();
    if (/reel/i.test(n)) return 'Reels';
    if (/^pool/i.test(n)) return 'Pool';
    if (/digital|inspire|(^|[^a-z])gm([^a-z]|$)/i.test(n)) return 'Digital';
    return n || 'Other';
  }
  function typeSort(a, b) {
    var ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
    if (ia < 0) ia = 99; if (ib < 0) ib = 99;
    return ia - ib || String(a).localeCompare(String(b));
  }

  /** One flat row per entry x site x category (pool as category 'Pool'). */
  function buildRows(entries, siteInfo, keyFn) {
    var rows = [];
    (entries || []).forEach(function (e) {
      if (!e || !e.date || !e.locations) return;
      var bm = businessMonthKey(e.date);
      var ek = keyFn(e);
      e.locations.forEach(function (loc) {
        if (!loc || typeof loc !== 'object') return;
        var si = siteInfo(loc);
        (loc.categories || []).forEach(function (c) {
          if (!c || typeof c !== 'object') return;
          var gross = c.gross != null ? c.gross : (c.cash != null ? c.cash : 0);
          var net = c.net != null ? c.net : (c.total != null ? c.total : gross);
          rows.push({ entry: e, entryKey: ek, date: e.date, bm: bm, siteKey: si.key, siteName: si.label,
            cat: c.name || '', type: machineType(c.name), gross: +gross || 0, floatTaken: +c.floatTaken || 0, net: +net || 0,
            mgd: +c.mgd || 0, ss: +c.supplierShare || 0, cl: +c.cashLeft || 0, low: null });
        });
        if (loc.poolGross != null && loc.poolGross !== '' && (parseFloat(loc.poolGross) > 0 || loc.poolSS != null || loc.poolCL != null)) {
          var pg = parseFloat(loc.poolGross) || 0;
          rows.push({ entry: e, entryKey: ek, date: e.date, bm: bm, siteKey: si.key, siteName: si.label,
            cat: 'Pool', type: 'Pool', gross: pg, floatTaken: 0, net: pg, mgd: 0, ss: +loc.poolSS || 0, cl: +loc.poolCL || 0, low: null });
        }
      });
    });
    return rows;
  }

  /** Predicate for a period id: 'm0' this business month, 'm1' last, '21d', '3m','6m','12m','all', or 'YYYY-MM'. */
  function periodTest(period, today) {
    var cur = businessMonthKey(today);
    if (period === 'all') return function () { return true; };
    if (period === 'm0') return function (r) { return r.bm === cur; };
    if (period === 'm1') { var p = shiftMonth(cur, -1); return function (r) { return r.bm === p; }; }
    if (period === '21d') { var from = daysBefore(today, 20); return function (r) { return r.date >= from && r.date <= today; }; }
    var mm = /^(\d+)m$/.exec(period);
    if (mm) { var start = shiftMonth(cur, -(parseInt(mm[1], 10) - 1)); return function (r) { return r.bm >= start && r.bm <= cur; }; }
    if (/^\d{4}-\d{2}$/.test(period)) return function (r) { return r.bm === period; };
    return function () { return true; };
  }

  /** The single business month a period means (for vs-last-month deltas), else ''. */
  function periodMonth(period, today) {
    var cur = businessMonthKey(today);
    if (period === 'm0') return cur;
    if (period === 'm1') return shiftMonth(cur, -1);
    return /^\d{4}-\d{2}$/.test(period) ? period : '';
  }

  function sumRows(rows) {
    var t = { net: 0, gross: 0, ss: 0, cl: 0, mgd: 0, floatTaken: 0, collections: 0 };
    var seen = {};
    rows.forEach(function (r) {
      t.net += r.net; t.gross += r.gross; t.ss += r.ss; t.cl += r.cl; t.mgd += r.mgd; t.floatTaken += r.floatTaken;
      var k = r.entryKey + '|' + r.siteKey;
      if (!seen[k]) { seen[k] = 1; t.collections++; }
    });
    ['net', 'gross', 'ss', 'cl', 'mgd', 'floatTaken'].forEach(function (k) { t[k] = round(t[k]); });
    return t;
  }

  /** Group rows by a field -> [{key,label,...sums}] sorted by net desc. */
  function groupRows(rows, field, labelField) {
    var map = {}, order = [];
    rows.forEach(function (r) {
      var k = r[field];
      if (!map[k]) { map[k] = { key: k, label: r[labelField || field], rows: [] }; order.push(k); }
      map[k].rows.push(r);
    });
    return order.map(function (k) {
      var g = map[k]; var s = sumRows(g.rows); s.key = g.key; s.label = g.label; return s;
    }).sort(function (a, b) { return b.net - a.net; });
  }

  /** Totals per business month for the last n months ending endKey (zero-filled). */
  function monthSeries(rows, endKey, n) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) out.push({ key: shiftMonth(endKey, -i), net: 0, ss: 0, cl: 0, mgd: 0 });
    var idx = {}; out.forEach(function (m, i) { idx[m.key] = i; });
    rows.forEach(function (r) {
      var m = out[idx[r.bm]];
      if (m) { m.net += r.net; m.ss += r.ss; m.cl += r.cl; m.mgd += r.mgd; }
    });
    out.forEach(function (m) { m.net = round(m.net); m.ss = round(m.ss); m.cl = round(m.cl); m.mgd = round(m.mgd); });
    return out;
  }

  /** Latest outstanding float per site+category (from floatOwedAfter), only where > 0. */
  function floatOutstanding(entries, siteInfo, keyFn) {
    var sorted = (entries || []).filter(function (e) { return e && e.date && e.locations; }).slice().sort(function (a, b) {
      return a.date.localeCompare(b.date) || String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
    });
    var map = {};
    sorted.forEach(function (e) {
      e.locations.forEach(function (loc) {
        var si = siteInfo(loc);
        (loc.categories || []).forEach(function (c) {
          if (c.floatOwedAfter == null) return;
          map[si.key + '|' + c.name] = { siteKey: si.key, siteName: si.label, cat: c.name, owed: round(c.floatOwedAfter), date: e.date };
        });
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; }).filter(function (x) { return x.owed > 0; });
  }

  /**
   * Flag collections well below that site+category's recent norm.
   * Needs >= minPrior earlier collections; compares gross with the mean of up to `window` prior ones.
   * Sets row.low = average, or null. Pool rows are never flagged (fixed rent).
   */
  function markLow(rows, opts) {
    opts = opts || {};
    var ratio = opts.ratio || 0.5, minPrior = opts.minPrior || 5, win = opts.window || 8;
    var groups = {};
    rows.forEach(function (r) {
      r.low = null;
      if (r.cat === 'Pool') return;
      var k = r.siteKey + '|' + r.cat;
      (groups[k] = groups[k] || []).push(r);
    });
    Object.keys(groups).forEach(function (k) {
      var list = groups[k].slice().sort(function (a, b) {
        return a.date.localeCompare(b.date) || String(a.entry.timestamp || '').localeCompare(String(b.entry.timestamp || ''));
      });
      for (var i = minPrior; i < list.length; i++) {
        var prior = list.slice(Math.max(0, i - win), i);
        var avg = prior.reduce(function (s, r) { return s + r.gross; }, 0) / prior.length;
        if (avg > 0 && list[i].gross < avg * ratio) list[i].low = round(avg);
      }
    });
    return rows;
  }

  /* ---------- float recalculation ---------- */

  var FLOAT_FIELDS = ['floatOwedIn', 'floatTaken', 'floatOwedAfter', 'net', 'mgd', 'cashLeft', 'supplierShare'];

  function catKeyOf(c) { return c.id || c.name || ''; }

  /** Recompute grand totals on an entry from its (updated) locations/categories/pool. */
  function recomputeGrands(e) {
    var gt = 0, gcl = 0, gmgd = 0, gss = 0, gf = 0;
    (e.locations || []).forEach(function (loc) {
      (loc.categories || []).forEach(function (c) {
        gt += c.net || 0; gcl += c.cashLeft || 0; gmgd += c.mgd || 0; gss += c.supplierShare || 0; gf += c.floatTaken || 0;
      });
      if (loc.poolGross != null && loc.poolGross !== '') {
        gt += parseFloat(loc.poolGross) || 0; gcl += loc.poolCL || 0; gss += loc.poolSS || 0;
      }
    });
    e.grandTotal = round(gt); e.grandCL = round(gcl); e.grandMGD = round(gmgd); e.grandSS = round(gss); e.grandFloat = round(gf);
    return e;
  }

  /**
   * Recalculate the float carry-forward chain (per site + machine) for entries dated fromDate onward.
   * Opening balance = floatOwedAfter of the last entry before fromDate (0 if none).
   * Each category keeps the share rate / flat fee / float required it was saved with; MGD uses mgdAtFn(date).
   * Gross takings are never changed. Returns changed entries as clones (originals untouched).
   *   opts: { siteKey: only this site, or '' for all }
   */
  function recalcFloat(entries, siteInfo, fromDate, mgdAtFn, opts) {
    opts = opts || {};
    var chains = {};
    (entries || []).forEach(function (e) {
      if (!e || !e.date || !e.locations) return;
      e.locations.forEach(function (loc, li) {
        var si = siteInfo(loc);
        if (opts.siteKey && si.key !== opts.siteKey) return;
        (loc.categories || []).forEach(function (c, ci) {
          var k = si.key + '|' + catKeyOf(c);
          (chains[k] = chains[k] || []).push({ e: e, li: li, ci: ci, si: si });
        });
      });
    });

    var clones = {}; // entry -> clone (by identity via index)
    var cloneList = [];
    function cloneOf(e) {
      var i = cloneList.findIndex(function (x) { return x.orig === e; });
      if (i < 0) { cloneList.push({ orig: e, copy: JSON.parse(JSON.stringify(e)), changes: [] }); i = cloneList.length - 1; }
      return cloneList[i];
    }

    var skipped = 0;
    Object.keys(chains).forEach(function (k) {
      var list = chains[k].sort(function (a, b) {
        return a.e.date.localeCompare(b.e.date) || String(a.e.timestamp || '').localeCompare(String(b.e.timestamp || ''));
      });
      var owed = 0;
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var c = it.e.locations[it.li].categories[it.ci];
        if (it.e.date < fromDate) { owed = parseFloat(c.floatOwedAfter) || 0; continue; }
        var gross = c.gross != null ? c.gross : (c.cash != null ? c.cash : 0);
        var rate = c.rate != null ? parseFloat(c.rate) : ((c.net > 0) ? (c.cashLeft || 0) / c.net : NaN);
        if (isNaN(rate)) { skipped++; owed = parseFloat(c.floatOwedAfter) || 0; continue; }
        var r = calcCategory(gross, rate, true, c.floatRequired || 0, owed, c.flatFee || 0, mgdAtFn(it.e.date));
        var after = { floatOwedIn: r.floatOwedIn, floatTaken: r.floatTaken, floatOwedAfter: r.floatOwedAfter,
                      net: r.net, mgd: r.mgd, cashLeft: r.cashLeft, supplierShare: r.supplierShare };
        var changed = FLOAT_FIELDS.some(function (f) { return Math.abs((+c[f] || 0) - after[f]) >= 0.005; });
        if (changed) {
          var cl = cloneOf(it.e);
          var cc = cl.copy.locations[it.li].categories[it.ci];
          var before = {}; FLOAT_FIELDS.forEach(function (f) { before[f] = +c[f] || 0; });
          FLOAT_FIELDS.forEach(function (f) { cc[f] = after[f]; });
          cc.total = after.net;
          cl.changes.push({ siteName: it.si.label, cat: c.name || '', before: before, after: after });
        }
        owed = r.floatOwedAfter;
      }
    });

    var out = cloneList.map(function (x) {
      recomputeGrands(x.copy);
      return { entry: x.copy, original: x.orig, date: x.orig.date, changes: x.changes };
    }).sort(function (a, b) { return a.date.localeCompare(b.date) || String(a.entry.timestamp || '').localeCompare(String(b.entry.timestamp || '')); });

    var tot = { netBefore: 0, netAfter: 0, clBefore: 0, clAfter: 0, ssBefore: 0, ssAfter: 0, mgdBefore: 0, mgdAfter: 0 };
    out.forEach(function (o) {
      o.changes.forEach(function (ch) {
        tot.netBefore += ch.before.net; tot.netAfter += ch.after.net;
        tot.clBefore += ch.before.cashLeft; tot.clAfter += ch.after.cashLeft;
        tot.ssBefore += ch.before.supplierShare; tot.ssAfter += ch.after.supplierShare;
        tot.mgdBefore += ch.before.mgd; tot.mgdAfter += ch.after.mgd;
      });
    });
    Object.keys(tot).forEach(function (k) { tot[k] = round(tot[k]); });
    return { changed: out, skipped: skipped, totals: tot };
  }

  /* ---------- daily entry dashboard helpers ---------- */

  /** Net per calendar day for the n days ending endDate (zero-filled): [{date, net, ss, cl, collections}] */
  function dayBuckets(rows, endDate, n) {
    var out = [], idx = {};
    for (var i = n - 1; i >= 0; i--) { var d = daysBefore(endDate, i); idx[d] = out.length; out.push({ date: d, net: 0, ss: 0, cl: 0, collections: 0 }); }
    var seen = {};
    rows.forEach(function (r) {
      var b = out[idx[r.date]];
      if (!b) return;
      b.net += r.net; b.ss += r.ss; b.cl += r.cl;
      var k = r.entryKey + '|' + r.siteKey;
      if (!seen[k]) { seen[k] = 1; b.collections++; }
    });
    out.forEach(function (b) { b.net = round(b.net); b.ss = round(b.ss); b.cl = round(b.cl); });
    return out;
  }

  /** Whole days between two YYYY-MM-DD dates (b - a). */
  function daysBetween(a, b) {
    var pa = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
    var pb = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
    return Math.round((pb - pa) / 86400000);
  }

  /** Latest collection date per site: { siteKey: 'YYYY-MM-DD' } */
  function lastCollectedBySite(rows) {
    var m = {};
    rows.forEach(function (r) { if (!m[r.siteKey] || r.date > m[r.siteKey]) m[r.siteKey] = r.date; });
    return m;
  }

  /**
   * "Usual" gross for a site + machine: mean of up to `n` most recent collections strictly before beforeDate.
   * Returns null when there are fewer than minCount earlier collections.
   */
  function usualGross(rows, siteKey, cat, beforeDate, n, minCount) {
    n = n || 8; minCount = minCount || 3;
    var list = rows.filter(function (r) { return r.siteKey === siteKey && r.cat === cat && r.date < beforeDate; })
      .sort(function (a, b) { return a.date.localeCompare(b.date) || String(a.entry.timestamp || '').localeCompare(String(b.entry.timestamp || '')); })
      .slice(-n);
    if (list.length < minCount) return null;
    var avg = list.reduce(function (s, r) { return s + r.gross; }, 0) / list.length;
    return avg > 0 ? round(avg) : null;
  }

  /** 'check' when an entered gross looks like a typo (far below/above usual), else ''. */
  function grossLooksOff(gross, usual) {
    if (!usual || !(gross > 0)) return '';
    if (gross < usual * 0.4) return 'low';
    if (gross > usual * 2.5) return 'high';
    return '';
  }

  /* ---------- statements, search, sort, sparklines, next site, overdue, float review ---------- */

  /** Plain-text month-end statement for one site (also used for the printable page). rows = that site's rows for the month. */
  function statementText(siteName, monthLabel, rangeLabel, rows, fmt) {
    fmt = fmt || function (v) { return '£' + (v || 0).toFixed(2); };
    var byEntry = {}, order = [];
    rows.forEach(function (r) {
      var k = r.entryKey + '|' + r.siteKey;
      if (!byEntry[k]) { byEntry[k] = { date: r.date, ts: String(r.entry.timestamp || ''), rows: [] }; order.push(k); }
      byEntry[k].rows.push(r);
    });
    var cols = order.map(function (k) { return byEntry[k]; }).sort(function (a, b) { return a.date.localeCompare(b.date) || a.ts.localeCompare(b.ts); });
    var t = sumRows(rows);
    var lines = ['3BarBros — month-end statement', siteName + ' · ' + monthLabel + (rangeLabel ? ' (' + rangeLabel + ')' : ''), ''];
    cols.forEach(function (c) {
      var ct = sumRows(c.rows);
      lines.push(c.date + '  net ' + fmt(ct.net) + ' · supplier ' + fmt(ct.ss) + ' · site ' + fmt(ct.cl));
      c.rows.forEach(function (r) { lines.push('   ' + r.cat + ': gross ' + fmt(r.gross) + ', net ' + fmt(r.net) + ', supplier ' + fmt(r.ss) + ', site ' + fmt(r.cl)); });
    });
    lines.push('', 'Collections: ' + t.collections, 'Net: ' + fmt(t.net), 'MGD: ' + fmt(t.mgd), 'Supplier share: ' + fmt(t.ss), 'Site share: ' + fmt(t.cl));
    return lines.join('\n');
  }

  /** Does a History card match a search? Every word must match the date, site, machine or an amount. */
  function cardMatches(card, q) {
    var words = String(q || '').toLowerCase().replace(/[£,]/g, '').split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    var nums = [];
    card.rows.forEach(function (r) { [r.net, r.gross, r.cl, r.ss].forEach(function (v) { nums.push(v.toFixed(2)); nums.push(String(Math.round(v))); }); });
    var hay = [card.date, card.label || '', card.siteName || '', card.rows.map(function (r) { return r.cat; }).join(' '), nums.join(' ')].join(' ').toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }

  /** Sort History cards: 'new' (default), 'old', 'high' (net high→low), 'low'. Returns a new array. */
  function sortCards(cards, mode) {
    var c = cards.slice();
    var net = function (x) { return x.rows.reduce(function (s, r) { return s + r.net; }, 0); };
    var cmpDate = function (a, b) { return a.date.localeCompare(b.date) || String(a.ts || '').localeCompare(String(b.ts || '')); };
    if (mode === 'old') return c.sort(cmpDate);
    if (mode === 'high') return c.sort(function (a, b) { return net(b) - net(a); });
    if (mode === 'low') return c.sort(function (a, b) { return net(a) - net(b); });
    return c.sort(function (a, b) { return cmpDate(b, a); });
  }

  /** Gross per collection (oldest→newest, last n) for one machine at one site, plus % change vs the earlier average. */
  function sparkSeries(rows, siteKey, cat, n) {
    n = n || 12;
    var list = rows.filter(function (r) { return r.siteKey === siteKey && r.cat === cat; })
      .sort(function (a, b) { return a.date.localeCompare(b.date) || String(a.entry.timestamp || '').localeCompare(String(b.entry.timestamp || '')); })
      .slice(-n);
    var vals = list.map(function (r) { return r.gross; });
    var pct = null;
    if (vals.length >= 4) {
      var prior = vals.slice(0, -1), avg = prior.reduce(function (s, v) { return s + v; }, 0) / prior.length;
      if (avg > 0) pct = Math.round(((vals[vals.length - 1] - avg) / avg) * 100);
    }
    return { vals: vals, pct: pct };
  }

  /** The next site (in list order, wrapping) not already collected on `done`. Returns id or ''. */
  function nextSiteAfter(ids, doneIds, currentId) {
    var done = {}; doneIds.forEach(function (d) { done[String(d)] = true; });
    var start = ids.map(String).indexOf(String(currentId));
    for (var k = 1; k <= ids.length; k++) {
      var id = String(ids[(start + k + ids.length) % ids.length]);
      if (!done[id] && id !== String(currentId)) return id;
    }
    return '';
  }

  /** '' | 'late' | 'vlate' for days since last collection against a site's limit (very late = limit + 7). */
  function overdueLevel(days, limit) {
    limit = limit > 0 ? limit : 14;
    if (days >= limit + 7) return 'vlate';
    if (days >= limit) return 'late';
    return '';
  }

  /** If other collections for this site come AFTER `date`, their float carry may now be wrong: return `date`, else ''. */
  function floatReviewFrom(entries, siteKey, date, siteInfo) {
    var later = (entries || []).some(function (e) {
      return e && e.date > date && (e.locations || []).some(function (l) { return l && siteInfo(l).key === siteKey; });
    });
    return later ? date : '';
  }

  var api = {
    LOGIC_VERSION: LOGIC_VERSION,
    MGD_RATE: MGD_RATE, BUSINESS_MONTH_CUTOFF_DAY: BUSINESS_MONTH_CUTOFF_DAY, EPOCH: EPOCH,
    round: round, businessMonthKey: businessMonthKey, sortTerms: sortTerms, termAt: termAt,
    addTerm: addTerm, lastTerm: lastTerm, mgdAt: mgdAt, resolveLoc: resolveLoc,
    applyTermChanges: applyTermChanges, seedCatTerms: seedCatTerms, seedPoolTerms: seedPoolTerms,
    calcCategory: calcCategory, calcPool: calcPool,
    shiftMonth: shiftMonth, daysBefore: daysBefore, buildRows: buildRows, periodTest: periodTest,
    periodMonth: periodMonth, sumRows: sumRows, groupRows: groupRows, monthSeries: monthSeries, markLow: markLow, floatOutstanding: floatOutstanding, recalcFloat: recalcFloat, statementText: statementText, cardMatches: cardMatches, sortCards: sortCards, sparkSeries: sparkSeries, nextSiteAfter: nextSiteAfter, overdueLevel: overdueLevel, floatReviewFrom: floatReviewFrom, dayBuckets: dayBuckets, daysBetween: daysBetween, lastCollectedBySite: lastCollectedBySite, usualGross: usualGross, grossLooksOff: grossLooksOff, machineType: machineType, typeSort: typeSort, recomputeGrands: recomputeGrands
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.keys(api).forEach(function (k) { root[k] = api[k]; });
})(typeof window !== 'undefined' ? window : this);
