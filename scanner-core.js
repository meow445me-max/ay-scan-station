'use strict';

// Pure scan rules shared by the browser app and the Node tests. No DOM, no network.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScannerCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // 8-digit codes are skipped: EAN-8 and UPC-E use different check-digit rules.
  const GTIN_LENGTHS = [12, 13, 14];

  function checkDigitValid(code) {
    if (!GTIN_LENGTHS.includes(code.length)) return null;
    const digits = code.split('').map(Number);
    const check = digits.pop();
    let sum = 0;
    for (let i = digits.length - 1, weight = 3; i >= 0; i -= 1, weight = 4 - weight) {
      sum += digits[i] * weight;
    }
    return (10 - (sum % 10)) % 10 === check;
  }

  // UPC-A (12) and the same code read as EAN-13 with a leading zero are one product.
  // Only leading zeros are ever added; a different digit is always a different product.
  function matchKey(code) {
    return [12, 13, 14].includes(code.length) ? code.padStart(14, '0') : code;
  }

  function parse(raw) {
    const code = String(raw == null ? '' : raw).replace(/\s+/g, '');
    if (code === '') return {ok: false, error: 'empty', code};
    if (!/^[0-9]{1,128}$/.test(code)) return {ok: false, error: 'not_digits', code};
    if (checkDigitValid(code) === false) return {ok: false, error: 'bad_check_digit', code};
    return {ok: true, code, key: matchKey(code)};
  }

  function findProduct(products, code) {
    const key = matchKey(code);
    return products.find(product => matchKey(product.barcode) === key) || null;
  }

  const PARSE_MESSAGES = {
    empty: ['Nothing scanned', 'Scan a barcode or type the number and press Enter.'],
    not_digits: ['Not a product barcode', 'Barcodes contain numbers only. Check what was scanned and try again.'],
    bad_check_digit: ['Misread — scan again', 'The last digit does not check out, so the scanner probably misread the label.'],
  };

  function rejected(kind, title, detail, extra) {
    return Object.assign({accepted: false, kind, title, detail}, extra || {});
  }

  function lookup(products, raw) {
    const parsed = parse(raw);
    if (!parsed.ok) return rejected(parsed.error, ...PARSE_MESSAGES[parsed.error], {code: parsed.code});
    const product = findProduct(products, parsed.code);
    if (!product) {
      return rejected('unknown', 'Unknown barcode', `${parsed.code} is not in the product list.`, {code: parsed.code});
    }
    return {accepted: true, kind: 'found', title: product.name, detail: `1 scan = ${product.unit}`, code: parsed.code, product};
  }

  function totals(delivery) {
    const expected = delivery.lines.reduce((sum, line) => sum + line.expected, 0);
    const counted = delivery.lines.reduce((sum, line) => sum + line.counted, 0);
    return {expected, counted, remaining: expected - counted, complete: expected > 0 && counted === expected};
  }

  // Returns {delivery, outcome}; never mutates the input. Rejected scans are logged but change no count.
  // With focusId set, only that product's barcode is accepted (the worker picked it from the list).
  function applyScan(delivery, products, raw, at, focusId) {
    const parsed = parse(raw);
    let outcome;
    let lines = delivery.lines;
    if (!parsed.ok) {
      outcome = rejected(parsed.error, ...PARSE_MESSAGES[parsed.error], {code: parsed.code});
    } else {
      const product = findProduct(products, parsed.code);
      const index = product ? lines.findIndex(line => line.productId === product.id) : -1;
      if (!product) {
        outcome = rejected('unknown', 'Unknown barcode', `${parsed.code} is not in the product list. Put this item aside.`, {code: parsed.code});
      } else if (focusId && product.id !== focusId) {
        const wanted = products.find(p => p.id === focusId);
        outcome = rejected('not_this_item', 'Wrong item',
          `This is ${product.name}, not ${wanted ? wanted.name : 'the selected item'}.`, {code: parsed.code, product});
      } else if (index === -1) {
        outcome = rejected('not_expected', 'Wrong item', `${product.name} is not on this delivery. Put it aside.`, {code: parsed.code, product});
      } else if (lines[index].expected === 0) {
        outcome = rejected('over', 'Not needed', `${product.name} is not needed here. It is already covered.`, {code: parsed.code, product});
      } else if (lines[index].counted >= lines[index].expected) {
        outcome = rejected('over', 'Too many', `All ${lines[index].expected} of ${product.name} are already counted. Put the extra aside.`, {code: parsed.code, product});
      } else {
        lines = lines.map((line, i) => i === index ? Object.assign({}, line, {counted: line.counted + 1, validated: true}) : line);
        const line = lines[index];
        const done = line.counted === line.expected;
        outcome = {
          accepted: true, kind: done ? 'line_done' : 'counted', code: parsed.code, product,
          title: product.name,
          detail: done ? `All ${line.expected} counted for this item.` : `${line.counted} of ${line.expected} counted`,
        };
      }
    }
    const scan = {at, code: outcome.code || '', kind: outcome.kind, accepted: outcome.accepted,
      productId: outcome.product ? outcome.product.id : null, delta: outcome.accepted ? 1 : 0};
    const next = Object.assign({}, delivery, {lines, scans: delivery.scans.concat([scan])});
    if (outcome.accepted && totals(next).complete) {
      outcome = Object.assign({}, outcome, {kind: 'all_done', detail: 'Every item on this delivery is counted.'});
      next.scans[next.scans.length - 1] = Object.assign({}, scan, {kind: 'all_done'});
    }
    return {delivery: next, outcome};
  }

  // Lines saved before validation was tracked only ever got counts from real scans.
  function isValidated(line) { return Boolean(line.validated) || line.counted > 0; }

  // Manual +/- after the product has been validated by one correct scan. Never below 0 or above expected.
  function adjust(delivery, products, productId, delta, at) {
    const index = delivery.lines.findIndex(line => line.productId === productId);
    const product = products.find(p => p.id === productId) || null;
    const name = product ? product.name : 'this item';
    if (index === -1 || (delta !== 1 && delta !== -1)) return {delivery, outcome: rejected('invalid', 'Not on this delivery', '')};
    const line = delivery.lines[index];
    let outcome = null;
    if (!isValidated(line)) outcome = rejected('not_validated', 'Scan it first', `Scan one ${name} to confirm it is the right product, then use + and −.`, {product});
    else if (delta === 1 && line.counted >= line.expected) outcome = rejected('over', 'Too many', `All ${line.expected} of ${name} are already counted.`, {product});
    else if (delta === -1 && line.counted <= 0) outcome = rejected('below_zero', 'Already zero', `No ${name} counted yet.`, {product});
    if (outcome) return {delivery, outcome};
    const counted = line.counted + delta;
    const lines = delivery.lines.map((l, i) => i === index ? Object.assign({}, l, {counted}) : l);
    const scan = {at, code: product ? product.barcode : '', kind: delta > 0 ? 'manual_add' : 'manual_remove', accepted: true,
      productId, delta, manual: true};
    const next = Object.assign({}, delivery, {lines, scans: delivery.scans.concat([scan])});
    outcome = {accepted: true, kind: scan.kind, product, title: name,
      detail: counted === line.expected ? `All ${line.expected} counted for this item.` : `${counted} of ${line.expected} counted`};
    if (delta > 0 && totals(next).complete) outcome = Object.assign({}, outcome, {kind: 'all_done', detail: 'Every item on this delivery is counted.'});
    return {delivery: next, outcome};
  }

  // Reverses the most recent scan or +/- change. Rejected scans stay in the log.
  function undoLast(delivery) {
    let index = -1;
    for (let i = delivery.scans.length - 1; i >= 0; i -= 1) {
      if (delivery.scans[i].accepted && !delivery.scans[i].undone) { index = i; break; }
    }
    if (index === -1) return {delivery, undone: null};
    const scan = delivery.scans[index];
    const delta = typeof scan.delta === 'number' ? scan.delta : 1;
    const lines = delivery.lines.map(line => line.productId === scan.productId
      ? Object.assign({}, line, {counted: Math.min(line.expected, Math.max(0, line.counted - delta))}) : line);
    const scans = delivery.scans.map((item, i) => i === index ? Object.assign({}, item, {undone: true}) : item);
    return {delivery: Object.assign({}, delivery, {lines, scans}), undone: scan};
  }

  function validateNewProduct(products, input) {
    const barcode = String(input.barcode || '').replace(/\s+/g, '');
    const name = String(input.name || '').trim();
    const unit = String(input.unit || '').trim() || '1 unit';
    if (!name) return {ok: false, error: 'Enter a product name.'};
    const parsed = parse(barcode);
    if (!parsed.ok) {
      return {ok: false, error: parsed.error === 'bad_check_digit'
        ? 'That barcode fails its check digit. Re-scan it from the package.'
        : 'Barcodes contain numbers only.'};
    }
    const clash = findProduct(products, barcode);
    if (clash) return {ok: false, error: `That barcode already belongs to ${clash.name}.`};
    return {ok: true, product: {barcode, name, sku: String(input.sku || '').trim(), unit}};
  }

  /* ---------- purchasing: one purchase list, ranked locations, one PO per location ---------- */
  const LOCATIONS = [
    {id: 'storage', name: 'Storage', code: 'STO'},
    {id: 'ja', name: 'JA', code: 'JA'},
    {id: 'midatlantic', name: 'Midatlantic', code: 'MA'},
  ];
  // Picks at a location count as bought once its PO is sent (pending) or approved, so the next
  // location only asks for what is still missing. A denied PO stops counting until it is resent.
  const COUNTS_AS_BOUGHT = ['pending', 'approved'];

  function stopOf(run, locationId) {
    const saved = (run.stops || {})[locationId] || {};
    return {lines: Array.isArray(saved.lines) ? saved.lines : [], scans: Array.isArray(saved.scans) ? saved.scans : [],
      status: saved.status || 'open', deniedReason: saved.deniedReason || '', short: Array.isArray(saved.short) ? saved.short : []};
  }
  function pickedAt(stop, productId) {
    const line = stop.lines.find(l => l.productId === productId);
    return line ? line.counted : 0;
  }
  function boughtElsewhere(run, productId, exceptLocationId) {
    return LOCATIONS.filter(l => l.id !== exceptLocationId).reduce((sum, l) => {
      const stop = stopOf(run, l.id);
      return sum + (COUNTS_AS_BOUGHT.includes(stop.status) ? pickedAt(stop, productId) : 0);
    }, 0);
  }
  function runTotals(run) {
    const needed = run.lines.reduce((s, l) => s + l.needed, 0);
    const bought = run.lines.reduce((s, l) => s + Math.min(l.needed, boughtElsewhere(run, l.productId, null)), 0);
    return {needed, bought, remaining: needed - bought, complete: needed > 0 && bought >= needed};
  }
  // A location seen as a delivery-shaped object, so applyScan/adjust work on it unchanged:
  // expected = what is still needed after the other locations (never below what was already picked here).
  function stopView(run, locationId) {
    const stop = stopOf(run, locationId);
    const lines = run.lines.map(need => {
      const own = stop.lines.find(l => l.productId === need.productId) || {counted: 0, validated: false};
      const remaining = Math.max(0, need.needed - boughtElsewhere(run, need.productId, locationId));
      return {productId: need.productId, expected: Math.max(remaining, own.counted), counted: own.counted, validated: Boolean(own.validated)};
    });
    return {id: locationId, lines, scans: stop.scans, status: stop.status, deniedReason: stop.deniedReason};
  }
  function saveStop(run, view) {
    const stop = stopOf(run, view.id);
    const lines = view.lines.filter(l => l.counted > 0 || l.validated)
      .map(l => ({productId: l.productId, counted: l.counted, validated: Boolean(l.validated)}));
    const stops = Object.assign({}, run.stops, {[view.id]: Object.assign({}, stop, {lines, scans: view.scans})});
    return Object.assign({}, run, {stops});
  }
  function setStop(run, locationId, patch) {
    const stops = Object.assign({}, run.stops, {[locationId]: Object.assign({}, stopOf(run, locationId), patch)});
    return Object.assign({}, run, {stops});
  }
  // Items still short at this location: everything needed here that was not fully picked.
  function shortLines(view) {
    return view.lines.filter(l => l.expected > 0 && l.counted < l.expected);
  }
  // "Done from location": freezes what was picked into a purchase order waiting for a manager.
  // Every short item needs a reason (reasons: {productId: text}); otherwise nothing is finished.
  function finishStop(run, locationId, products, at, by, reasons) {
    const location = LOCATIONS.find(l => l.id === locationId);
    const view = stopView(run, locationId);
    if (!location || view.status !== 'open') return {run, po: null, error: 'This location is already finished.'};
    const given = reasons || {};
    const short = shortLines(view);
    const missing = short.filter(l => !String(given[l.productId] || '').trim()).map(l => l.productId);
    if (missing.length) return {run, po: null, error: 'incomplete', missing};
    const nameOf = id => (products.find(p => p.id === id) || {}).name || 'Removed product';
    const shortOut = short.map(l => ({productId: l.productId, name: nameOf(l.productId), picked: l.counted,
      short: l.expected - l.counted, reason: String(given[l.productId]).trim()}));
    const picked = view.lines.filter(l => l.counted > 0);
    if (!picked.length) return {run: setStop(run, locationId, {status: 'skipped', deniedReason: '', short: shortOut}), po: null};
    const pos = Array.isArray(run.pos) ? run.pos : [];
    const revision = pos.filter(p => p.locationId === locationId).length + 1;
    const lines = picked.map(l => {
      const p = products.find(x => x.id === l.productId) || {};
      return {productId: l.productId, name: p.name || 'Removed product', sku: p.sku || '', barcode: p.barcode || '', unit: p.unit || '', qty: l.counted};
    });
    const po = {number: `PO-${run.ref || 'RUN'}-${location.code}-${revision}`, locationId, locationName: location.name,
      rank: LOCATIONS.indexOf(location) + 1, revision, createdAt: at, by: by || '', lines,
      totalUnits: lines.reduce((s, l) => s + l.qty, 0), short: shortOut, status: 'pending', decidedAt: null, reason: ''};
    const next = setStop(run, locationId, {status: 'pending', deniedReason: '', short: shortOut});
    return {run: Object.assign({}, next, {pos: pos.concat([po])}), po};
  }
  // Manager decision on a pending PO. Deny sends the location back to shopping with the reason shown.
  function decidePO(run, number, approve, reason, at) {
    const pos = Array.isArray(run.pos) ? run.pos : [];
    const po = pos.find(p => p.number === number);
    if (!po || po.status !== 'pending') return {run, error: 'This purchase order was already decided.'};
    const why = String(reason || '').trim();
    if (!approve && !why) return {run, error: 'Enter a reason so the buyer knows what to fix.'};
    const decided = Object.assign({}, po, {status: approve ? 'approved' : 'denied', decidedAt: at, reason: why});
    let next = Object.assign({}, run, {pos: pos.map(p => p.number === number ? decided : p)});
    next = setStop(next, po.locationId, approve ? {status: 'approved', deniedReason: ''} : {status: 'open', deniedReason: why});
    return {run: next, po: decided};
  }
  // Manager-only removal of a PO. The record is kept, marked deleted, for the audit trail; its location
  // reopens (picks kept) so the buyer can fix it and send a new revision.
  function deletePO(run, number, reason, at) {
    const pos = Array.isArray(run.pos) ? run.pos : [];
    const po = pos.find(p => p.number === number);
    if (!po || po.status === 'deleted') return {run, error: 'This purchase order was already deleted.'};
    const why = String(reason || '').trim();
    if (!why) return {run, error: 'Enter a reason for deleting this purchase order.'};
    const deleted = Object.assign({}, po, {status: 'deleted', previousStatus: po.status, deletedAt: at, deleteReason: why});
    let next = Object.assign({}, run, {pos: pos.map(p => p.number === number ? deleted : p)});
    const stop = stopOf(next, po.locationId);
    if (COUNTS_AS_BOUGHT.includes(stop.status)) {
      next = setStop(next, po.locationId, {status: 'open', deniedReason: `${number} was deleted by a manager: ${why}`});
    }
    return {run: next, po: deleted};
  }
  function activePOs(run, locationId) {
    return (Array.isArray(run.pos) ? run.pos : []).filter(p => p.status !== 'deleted' && (!locationId || p.locationId === locationId));
  }
  function nextLocation(run) {
    if (runTotals(run).complete) return null;
    return LOCATIONS.find(l => stopOf(run, l.id).status === 'open') || null;
  }

  return {LOCATIONS, stopOf, boughtElsewhere, runTotals, stopView, saveStop, shortLines, finishStop, decidePO, deletePO, activePOs, nextLocation,
    parse, checkDigitValid, matchKey, findProduct, lookup, applyScan, adjust, isValidated, undoLast, totals, validateNewProduct};
});
