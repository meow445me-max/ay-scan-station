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
  function applyScan(delivery, products, raw, at) {
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
      } else if (index === -1) {
        outcome = rejected('not_expected', 'Wrong item', `${product.name} is not on this delivery. Put it aside.`, {code: parsed.code, product});
      } else if (lines[index].counted >= lines[index].expected) {
        outcome = rejected('over', 'Too many', `All ${lines[index].expected} of ${product.name} are already counted. Put the extra aside.`, {code: parsed.code, product});
      } else {
        lines = lines.map((line, i) => i === index ? Object.assign({}, line, {counted: line.counted + 1}) : line);
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
      productId: outcome.product ? outcome.product.id : null};
    const next = Object.assign({}, delivery, {lines, scans: delivery.scans.concat([scan])});
    if (outcome.accepted && totals(next).complete) {
      outcome = Object.assign({}, outcome, {kind: 'all_done', detail: 'Every item on this delivery is counted.'});
      next.scans[next.scans.length - 1] = Object.assign({}, scan, {kind: 'all_done'});
    }
    return {delivery: next, outcome};
  }

  // Removes the most recent accepted scan and its count. Rejected scans stay in the log.
  function undoLast(delivery) {
    let index = -1;
    for (let i = delivery.scans.length - 1; i >= 0; i -= 1) {
      if (delivery.scans[i].accepted && !delivery.scans[i].undone) { index = i; break; }
    }
    if (index === -1) return {delivery, undone: null};
    const scan = delivery.scans[index];
    const lines = delivery.lines.map(line => line.productId === scan.productId && line.counted > 0
      ? Object.assign({}, line, {counted: line.counted - 1}) : line);
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

  return {parse, checkDigitValid, matchKey, findProduct, lookup, applyScan, undoLast, totals, validateNewProduct};
});
