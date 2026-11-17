/* 3BarBros — pure business logic (no DOM). Loaded by index.html and by tests/logic.test.js */
(function (root) {
  'use strict';

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

  var api = {
    MGD_RATE: MGD_RATE, BUSINESS_MONTH_CUTOFF_DAY: BUSINESS_MONTH_CUTOFF_DAY, EPOCH: EPOCH,
    round: round, businessMonthKey: businessMonthKey, sortTerms: sortTerms, termAt: termAt,
    addTerm: addTerm, lastTerm: lastTerm, mgdAt: mgdAt, resolveLoc: resolveLoc,
    applyTermChanges: applyTermChanges, seedCatTerms: seedCatTerms, seedPoolTerms: seedPoolTerms,
    calcCategory: calcCategory, calcPool: calcPool
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.keys(api).forEach(function (k) { root[k] = api[k]; });
})(typeof window !== 'undefined' ? window : this);
