/* pdf-reports.js — builds the app's documents as real PDFs.
 *
 * Two builders sit on top of SarvaPDF's drawing primitives:
 *   buildTablePDF()   — any report: paginates rows across A4 pages, repeats
 *                       the header row on every page, and never truncates.
 *   buildInvoicePDF() — the boxed SSCA-style tax invoice / delivery note.
 *
 * Both read from the app's own data rather than screenshotting the screen,
 * so the output is real text: selectable, searchable, sharp at any zoom, and
 * a fraction of the file size of the old bitmap approach.
 */
(function (global) {
  'use strict';

  var M = { left: 32, right: 32, top: 40, bottom: 46 };   // page margins, pt

  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Wrapping only breaks on whitespace, so a long unbroken token — an
  // invoice number like SDS/26-27/INV/0012 — can't wrap at all and spills
  // into the next column. Long tokens are split at punctuation first (which
  // reads naturally) and by character only as a last resort.
  function breakLongTokens(str, width, size, bold) {
    var D = global.SarvaPDF;
    return String(str == null ? '' : str).split(/\n/).map(function (para) {
      return para.split(/\s+/).map(function (w) {
        if (D.widthOf(w, size, bold) <= width) return w;
        // Prefer breaking after / - . which invoice numbers are full of.
        var pieces = w.split(/(?<=[\/\-.])/);
        var out = [], cur = '';
        pieces.forEach(function (piece) {
          // A single piece still too wide: chop it by character.
          while (D.widthOf(piece, size, bold) > width) {
            var cut = piece.length;
            while (cut > 1 && D.widthOf(piece.slice(0, cut), size, bold) > width) cut--;
            if (cur) { out.push(cur); cur = ''; }
            out.push(piece.slice(0, cut));
            piece = piece.slice(cut);
          }
          var test = cur + piece;
          if (cur && D.widthOf(test, size, bold) > width) { out.push(cur); cur = piece; }
          else cur = test;
        });
        if (cur) out.push(cur);
        return out.join(' ');
      }).join(' ');
    }).join('\n');
  }

  // Mirrors Doc.wrap()'s line-breaking so height measurement and drawing
  // can never disagree. Explicit newlines start a new line, as they do there.
  function countWrappedLines(str, width, size, bold) {
    var D = global.SarvaPDF, total = 0;
    String(str == null ? '' : str).split(/\n/).forEach(function (para) {
      var line = '', n = 1;
      para.split(/\s+/).forEach(function (w) {
        var test = line ? line + ' ' + w : w;
        if (D.widthOf(test, size, bold) > width && line) { n++; line = w; }
        else line = test;
      });
      total += n;
    });
    return Math.max(1, total);
  }

  /* ------------------------------------------------------------- tables */

  // cols: [{ label, width (relative), align, key|get }]
  // rows: array of plain objects
  function buildTablePDF(opts) {
    var D = global.SarvaPDF, doc = new D.Doc();
    var cols = opts.columns || [];
    var rows = opts.rows || [];
    var usableW = doc.W - M.left - M.right;

    // Relative widths -> absolute, so callers describe proportions and the
    // table always fills the page exactly whatever the paper size.
    var totalUnits = cols.reduce(function (s, c) { return s + (c.width || 1); }, 0);
    var x = M.left, colX = [];
    cols.forEach(function (c) {
      var w = usableW * ((c.width || 1) / totalUnits);
      colX.push({ x: x, w: w });
      x += w;
    });

    var rowH = opts.rowHeight || 15;
    var headH = 18;
    var y, page = 0, pageCount = 0;

    function header() {
      doc.newPage();
      page++;
      y = M.top;
      if (opts.title) {
        doc.text(doc.W / 2, y, opts.title, { size: 13, bold: true, align: 'center' });
        y += 15;
      }
      if (opts.subtitle) {
        doc.text(doc.W / 2, y, opts.subtitle, { size: 8.5, align: 'center', gray: 0.35 });
        y += 13;
      }
      y += 4;
      // Header band
      doc.rect(M.left, y, usableW, headH, 0.92, 0.75);
      cols.forEach(function (c, i) {
        var cx = colX[i].x + 4;
        if (c.align === 'right') cx = colX[i].x + colX[i].w - 4;
        else if (c.align === 'center') cx = colX[i].x + colX[i].w / 2;
        doc.text(cx, y + 12, c.label, { size: 7.5, bold: true, align: c.align || 'left' });
      });
      y += headH;
    }

    function ensureRoom(need) {
      if (y + need > doc.H - M.bottom) header();
    }

    header();

    rows.forEach(function (r, idx) {
      // Row height must be measured with the SAME word-wrapping the
      // renderer uses. Estimating by dividing total text width by column
      // width under-counted lines, so tall cells overflowed into the row
      // below — the overlap seen in the GST register and Sales Statement.
      var lines = 1;
      cols.forEach(function (c, i) {
        var val = c.get ? c.get(r) : (r[c.key] == null ? '' : String(r[c.key]));
        if (!c.wrap) {
          lines = Math.max(lines, String(val).split('\n').length);
          return;
        }
        lines = Math.max(lines,
          countWrappedLines(breakLongTokens(String(val), colX[i].w - 8, 7.5, c.bold),
                            colX[i].w - 8, 7.5, c.bold));
      });
      var h = Math.max(rowH, lines * 9.5 + 6);
      ensureRoom(h);

      if (idx % 2 === 1) doc.rect(M.left, y, usableW, h, 0.97, null);

      cols.forEach(function (c, i) {
        var val = c.get ? c.get(r) : (r[c.key] == null ? '' : String(r[c.key]));
        var cx = colX[i].x + 4;
        if (c.align === 'right') cx = colX[i].x + colX[i].w - 4;
        else if (c.align === 'center') cx = colX[i].x + colX[i].w / 2;
        if (c.wrap) {
          doc.wrap(cx, y + 10, breakLongTokens(String(val), colX[i].w - 8, 7.5, c.bold),
                   colX[i].w - 8, { size: 7.5, align: c.align || 'left', lh: 9.5 });
        } else {
          var parts = String(val).split('\n');
          parts.forEach(function (p, li) {
            doc.text(cx, y + 10 + li * 9.5, p, { size: 7.5, bold: !!c.bold, align: c.align || 'left' });
          });
        }
      });
      doc.line(M.left, y + h, M.left + usableW, y + h, 0.85);
      y += h;
    });

    // Totals band
    if (opts.totals && opts.totals.length) {
      ensureRoom(rowH + 4);
      doc.rect(M.left, y, usableW, rowH + 2, 0.90, 0.6);
      opts.totals.forEach(function (t) {
        var i = t.colIndex;
        if (i == null || !colX[i]) return;
        var cx = colX[i].x + 4;
        if (t.align === 'right') cx = colX[i].x + colX[i].w - 4;
        doc.text(cx, y + 12, String(t.text), { size: 8, bold: true, align: t.align || 'left' });
      });
      y += rowH + 2;
    }

    if (rows.length === 0) {
      doc.text(doc.W / 2, y + 18, opts.emptyText || 'Nothing to show for this selection.',
        { size: 9, align: 'center', gray: 0.4 });
    }

    // Footer on every page: who produced it, when, and page x of y.
    pageCount = doc.pages.length;
    for (var pi = 0; pi < pageCount; pi++) {
      doc.i = pi;
      doc.text(M.left, doc.H - 26, opts.footerLeft || 'Sarvadharani Seeds', { size: 7.5, gray: 0.45 });
      doc.text(doc.W - M.right, doc.H - 26, 'Page ' + (pi + 1) + ' of ' + pageCount,
        { size: 7.5, gray: 0.45, align: 'right' });
    }
    return doc.bytes();
  }

  /* ----------------------------------------------------------- invoices */

  // Payment / Receipt voucher. A cash voucher has no line items, so forcing
  // it through the goods-invoice layout produced an empty item grid, a
  // "Taxable Value 0.00" line and a nonsensical Round Off. This is its own
  // shape: who, how much, which account, and what it was against.
  function buildVoucherPDF(v) {
    var D = global.SarvaPDF, doc = new D.Doc();
    doc.newPage();
    var L = 30, R = doc.W - 30, W = R - L;
    var y = 34;

    doc.text(doc.W / 2, y, v.docTitle || 'RECEIPT VOUCHER', { size: 13, bold: true, align: 'center' });
    y += 16;

    /* header: company | voucher meta */
    var hTop = y, midX = L + W * 0.56;
    var sy = hTop + 13;
    sy = doc.wrap(L + 4, sy, v.sellerName || 'Sarvadharani Seeds', midX - L - 8, { size: 10.5, bold: true, lh: 12 });
    if (v.sellerAddress) sy = doc.wrap(L + 4, sy, v.sellerAddress, midX - L - 8, { size: 8, lh: 9.5 });
    if (v.sellerGstin) { doc.text(L + 4, sy, 'GSTIN/UIN: ' + v.sellerGstin, { size: 8, bold: true }); sy += 10; }
    if (v.sellerPhone) { doc.text(L + 4, sy, 'Contact : ' + v.sellerPhone, { size: 8 }); sy += 10; }

    var rowH = 26, my = hTop;
    var meta = [
      [v.numberLabel || 'Voucher No.', v.invNo || ''],
      ['Dated', v.date || ''],
      ['Mode', v.mode || 'Cash / Bank'],
      ['Account', v.accountName || '']
    ];
    for (var m = 0; m < meta.length; m += 2) {
      doc.text(midX + 4, my + 9, meta[m][0], { size: 6.5, gray: 0.35 });
      doc.wrap(midX + 4, my + 19, meta[m][1], (R - midX) / 2 - 8, { size: 8.5, bold: true, lh: 9 });
      doc.text(midX + (R - midX) / 2 + 4, my + 9, meta[m + 1][0], { size: 6.5, gray: 0.35 });
      doc.wrap(midX + (R - midX) / 2 + 4, my + 19, meta[m + 1][1], (R - midX) / 2 - 8, { size: 8.5, bold: true, lh: 9 });
      my += rowH;
    }
    var hBot = Math.max(sy + 4, my);
    doc.rect(L, hTop, W, hBot - hTop, null, 0.6);
    doc.line(midX, hTop, midX, hBot, 0.6);
    doc.line(midX, hTop + rowH, R, hTop + rowH, 0.6);
    doc.line(midX + (R - midX) / 2, hTop, midX + (R - midX) / 2, hTop + 2 * rowH, 0.6);
    y = hBot;

    /* party */
    var pTop = y, py = pTop + 12;
    doc.text(L + 4, py, v.partyLabel || 'Received From', { size: 7, gray: 0.35 }); py += 11;
    py = doc.wrap(L + 4, py, v.partyName || '', W - 8, { size: 10.5, bold: true, lh: 12 });
    if (v.partyAddress) py = doc.wrap(L + 4, py, v.partyAddress, W - 8, { size: 8, lh: 9.5 });
    var pBot = py + 5;
    doc.rect(L, pTop, W, pBot - pTop, null, 0.6);
    y = pBot;

    /* against-invoice grid — the point of the voucher */
    var aTop = y;
    var cw = [0.16, 0.30, 0.18, 0.18, 0.18];
    var cHead = ['Sl No.', 'Against Invoice No.', 'Invoice Date', 'Invoice Amount', 'Amount Paid'];
    var cAlign = ['center', 'left', 'center', 'right', 'right'];
    var cx = L, cP = [];
    cw.forEach(function (f) { cP.push({ x: cx, w: W * f }); cx += W * f; });
    doc.rect(L, aTop, W, 20, 0.93, 0.6);
    cHead.forEach(function (h, i) {
      var tx = cP[i].x + 4;
      if (cAlign[i] === 'right') tx = cP[i].x + cP[i].w - 4;
      else if (cAlign[i] === 'center') tx = cP[i].x + cP[i].w / 2;
      doc.text(tx, aTop + 13, h, { size: 7, bold: true, align: cAlign[i] });
    });
    var ay = aTop + 20;
    var against = (v.against && v.against.length) ? v.against
      : [{ invNo: 'On Account', date: '', invAmount: null, paid: v.amount }];
    against.forEach(function (a, i) {
      var vals = [String(i + 1), a.invNo || 'On Account', a.date || '\u2014',
                  a.invAmount == null ? '\u2014' : money(a.invAmount), money(a.paid)];
      vals.forEach(function (val, k) {
        var tx = cP[k].x + 4;
        if (cAlign[k] === 'right') tx = cP[k].x + cP[k].w - 4;
        else if (cAlign[k] === 'center') tx = cP[k].x + cP[k].w / 2;
        doc.text(tx, ay + 12, val, { size: 8.5, bold: (k === 1 || k === 4), align: cAlign[k] });
      });
      ay += 17;
      doc.line(L, ay, R, ay, 0.6);
    });
    doc.rect(L, aTop, W, ay - aTop, null, 0.6);
    cP.forEach(function (c, i) { if (i) doc.line(c.x, aTop, c.x, ay, 0.6); });
    y = ay;

    /* total */
    doc.rect(L, y, W, 22, 0.93, 0.6);
    doc.text(cP[4].x - 8, y + 15, v.totalLabel || 'Total Received', { size: 10, bold: true, align: 'right' });
    doc.text(R - 4, y + 15, 'Rs. ' + money(v.amount), { size: 10, bold: true, align: 'right' });
    y += 22;

    /* words */
    var wTop = y, wy = wTop + 12;
    doc.text(L + 4, wy, 'Amount (in words)', { size: 7, gray: 0.35 }); wy += 11;
    wy = doc.wrap(L + 4, wy, v.amountWords || '', W - 8, { size: 9.5, bold: true, lh: 11 });
    var wBot = wy + 4;
    doc.rect(L, wTop, W, wBot - wTop, null, 0.6);
    y = wBot;

    if (v.balanceNote) {
      doc.rect(L, y, W, 18, null, 0.6);
      doc.text(L + 4, y + 12, v.balanceNote, { size: 8 });
      y += 18;
    }
    if (v.narration) {
      var nTop = y, ny = nTop + 12;
      doc.text(L + 4, ny, 'Narration', { size: 7, gray: 0.35 }); ny += 11;
      ny = doc.wrap(L + 4, ny, v.narration, W - 8, { size: 8.5, lh: 10 });
      doc.rect(L, nTop, W, ny + 4 - nTop, null, 0.6);
      y = ny + 4;
    }

    /* signatures */
    var sTop = y, sH = 54, sMid = L + W / 2;
    doc.rect(L, sTop, W, sH, null, 0.6);
    doc.line(sMid, sTop, sMid, sTop + sH, 0.6);
    doc.text(L + 4, sTop + 12, v.leftSign || "Receiver's Signature", { size: 7.5 });
    doc.text(R - 4, sTop + 12, 'for ' + (v.sellerName || 'Sarvadharani Seeds'), { size: 8, bold: true, align: 'right' });
    doc.text(R - 4, sTop + sH - 8, 'Authorised Signatory', { size: 7.5, align: 'right' });
    y = sTop + sH;

    doc.text(doc.W / 2, y + 14, v.footerNote || 'This is a Computer Generated Voucher',
      { size: 7.5, align: 'center' });
    return doc.bytes();
  }

  function buildInvoicePDF(inv) {
    var D = global.SarvaPDF, doc = new D.Doc();
    doc.newPage();
    var L = 30, R = doc.W - 30, W = R - L;
    var y = 34;

    // Every panel is drawn at exact page coordinates, so nothing depends on
    // a screen layout being scaled to fit — which is what distorted the old
    // screenshot-based version. Text that could be long is wrapped inside
    // its own box rather than allowed to run past the border.

    function boxText(x, yy, w, str, o) {
      o = o || {};
      return doc.wrap(x + 4, yy, String(str == null ? '' : str), w - 8,
        { size: o.size || 8, bold: !!o.bold, lh: o.lh || 9.5, gray: o.gray });
    }

    doc.text(doc.W / 2, y, inv.docTitle || 'TAX INVOICE', { size: 12, bold: true, align: 'center' });
    y += 12;

    /* ---- header grid: seller | invoice meta ---- */
    var hTop = y, midX = L + W * 0.56;
    var sy = hTop + 13;
    sy = boxText(L, sy, midX - L, inv.sellerName || 'Sarvadharani Seeds', { size: 10.5, bold: true, lh: 12 });
    if (inv.sellerAddress) sy = boxText(L, sy, midX - L, inv.sellerAddress, { size: 8 });
    if (inv.sellerTin) sy = boxText(L, sy, midX - L, 'TIN No ' + inv.sellerTin, { size: 8 });
    if (inv.sellerGstin) sy = boxText(L, sy, midX - L, 'GSTIN/UIN: ' + inv.sellerGstin, { size: 8, bold: true });
    sy = boxText(L, sy, midX - L, 'State Name : Odisha, Code : 21', { size: 8 });
    if (inv.sellerPhone) sy = boxText(L, sy, midX - L, 'Contact : ' + inv.sellerPhone, { size: 8 });

    // Right side: four stacked meta cells, two per row.
    var metaRowH = 26, qX = midX + (R - midX) / 2;
    var meta = [
      [inv.numberLabel || 'Invoice No.', inv.invNo || ''],
      ['Dated', inv.date || ''],
      ['Delivery Note', inv.deliveryNoteRef || ''],
      ['Mode/Terms of Payment', inv.payTerms || ''],
      ['Reference No. & Date.', inv.refNo || ''],
      ['Other References', inv.otherRef || '']
    ];
    var my = hTop;
    for (var m = 0; m < meta.length; m += 2) {
      doc.text(midX + 4, my + 9, meta[m][0], { size: 6.5, gray: 0.35 });
      doc.text(midX + 4, my + 19, meta[m][1], { size: 8.5, bold: true });
      doc.text(qX + 4, my + 9, meta[m + 1][0], { size: 6.5, gray: 0.35 });
      doc.text(qX + 4, my + 19, meta[m + 1][1], { size: 8.5, bold: true });
      my += metaRowH;
    }

    var hBot = Math.max(sy + 4, my);
    doc.rect(L, hTop, W, hBot - hTop, null, 0.6);
    doc.line(midX, hTop, midX, hBot, 0.6);
    for (var g = 1; g < 3; g++) doc.line(midX, hTop + g * metaRowH, R, hTop + g * metaRowH, 0.6);
    doc.line(qX, hTop, qX, hTop + 3 * metaRowH, 0.6);
    y = hBot;

    /* ---- buyer | terms of delivery ---- */
    var bTop = y;
    var byy = bTop + 12;
    doc.text(L + 4, byy, 'Buyer (Bill to)', { size: 7, gray: 0.35 }); byy += 11;
    byy = boxText(L, byy, midX - L, inv.partyName || 'Retail Sale', { size: 10, bold: true, lh: 11.5 });
    if (inv.partyAddress) byy = boxText(L, byy, midX - L, inv.partyAddress, { size: 8 });
    if (inv.partyGstin) byy = boxText(L, byy, midX - L, 'GSTIN/UIN : ' + inv.partyGstin, { size: 8 });
    byy = boxText(L, byy, midX - L, 'State Name : Odisha, Code : 21', { size: 8 });
    byy = boxText(L, byy, midX - L, 'Place of Supply : ' + (inv.placeOfSupply || 'Odisha'), { size: 8 });
    doc.text(midX + 4, bTop + 12, 'Terms of Delivery', { size: 7, gray: 0.35 });
    if (inv.termsOfDelivery) boxText(midX, bTop + 23, R - midX, inv.termsOfDelivery, { size: 8 });
    var bBot = byy + 5;
    doc.rect(L, bTop, W, bBot - bTop, null, 0.6);
    doc.line(midX, bTop, midX, bBot, 0.6);
    y = bBot;

    /* ---- items grid ---- */
    var cw = [0.045, 0.275, 0.095, 0.06, 0.115, 0.115, 0.10, 0.055, 0.14];
    var cAlign = ['center', 'left', 'center', 'center', 'right', 'right', 'right', 'center', 'right'];
    var cHead = ['Sl\nNo.', 'Description of Goods', 'HSN/SAC', 'GST\nRate', 'Quantity',
                 'Rate\n(Incl. of Tax)', 'Rate', 'per', 'Amount'];
    var cx = L, colP = [];
    cw.forEach(function (f) { colP.push({ x: cx, w: W * f }); cx += W * f; });

    var headH = 24;
    function drawItemHead(yy) {
      doc.rect(L, yy, W, headH, 0.93, 0.6);
      cHead.forEach(function (h, i) {
        var tx = colP[i].x + 4;
        if (cAlign[i] === 'right') tx = colP[i].x + colP[i].w - 4;
        else if (cAlign[i] === 'center') tx = colP[i].x + colP[i].w / 2;
        h.split('\n').forEach(function (ln, li) {
          doc.text(tx, yy + 10 + li * 8.5, ln, { size: 6.8, bold: true, align: cAlign[i] });
        });
      });
      colP.forEach(function (c, i) { if (i) doc.line(c.x, yy, c.x, yy + headH, 0.6); });
      return yy + headH;
    }
    y = drawItemHead(y);

    var gridTop = y;
    (inv.items || []).forEach(function (it, idx) {
      var nameLines = countWrappedLines(String(it.name || ''), colP[1].w - 8, 8, false);
      var h = Math.max(15, nameLines * 9.5 + 5);
      if (y + h > doc.H - 250) {                 // keep the totals block intact
        doc.rect(L, gridTop, W, y - gridTop, null, 0.6);
        colP.forEach(function (c, i) { if (i) doc.line(c.x, gridTop, c.x, y, 0.6); });
        doc.newPage(); y = 34; y = drawItemHead(y); gridTop = y;
      }
      var vals = [String(idx + 1), it.name || '', it.hsn || '', it.gstLabel || '',
                  it.qtyLabel || '', money(it.rate), money(it.exRate != null ? it.exRate : it.rate),
                  it.uom || '', money(it.amount)];
      vals.forEach(function (v, i) {
        var tx = colP[i].x + 4;
        if (cAlign[i] === 'right') tx = colP[i].x + colP[i].w - 4;
        else if (cAlign[i] === 'center') tx = colP[i].x + colP[i].w / 2;
        if (i === 1) doc.wrap(tx, y + 10, v, colP[i].w - 8, { size: 8, bold: true, lh: 9.5 });
        else doc.text(tx, y + 10, v, { size: 8, bold: (i === 4 || i === 8), align: cAlign[i] });
      });
      y += h;
    });

    // Close the item grid here, so the vertical column rules stop before
    // the totals. Otherwise a label like "Taxable Value" gets sliced in two
    // by the column line running through it.
    var itemsBottom = y;
    doc.rect(L, gridTop, W, itemsBottom - gridTop, null, 0.6);
    colP.forEach(function (c, i) { if (i) doc.line(c.x, gridTop, c.x, itemsBottom, 0.6); });

    /* ---- totals: full-width rows below the item grid ---- */
    var totLabelX = colP[8].x - 8;
    (inv.totalLines || []).forEach(function (t) {
      doc.text(totLabelX, y + 11, t.label, { size: 8.5, bold: !!t.bold, align: 'right' });
      doc.text(R - 4, y + 11, money(t.value), { size: 8.5, align: 'right' });
      y += 15;
      doc.line(L, y, R, y, 0.6);
    });
    doc.rect(L, y, W, 20, 0.93, null);
    doc.text(totLabelX, y + 14, inv.grandLabel || 'Total', { size: 10, bold: true, align: 'right' });
    doc.text(R - 4, y + 14, 'Rs. ' + money(inv.grandTotal), { size: 10, bold: true, align: 'right' });
    y += 20;
    doc.line(L, itemsBottom, L, y, 0.6);
    doc.line(R, itemsBottom, R, y, 0.6);
    doc.line(colP[8].x, itemsBottom, colP[8].x, y, 0.6);
    doc.line(L, y, R, y, 0.6);

    /* ---- payment position: received / balance due ---- */
    if (inv.payment) {
        var pH = 34;
        doc.rect(L, y, W, pH, null, 0.6);
        // The status label sits in the left half, the figures in the right,
        // so the divider must stop at the split — drawn full width it ran
        // straight through the wording like a strikethrough.
        var paySplit = colP[6].x;
        doc.line(paySplit, y, paySplit, y + pH, 0.6);
        doc.line(colP[8].x, y, colP[8].x, y + pH, 0.6);
        doc.line(paySplit, y + pH / 2, R, y + pH / 2, 0.6);

        doc.text(colP[8].x - 8, y + 12, 'Amount Received', { size: 8.5, align: 'right' });
        doc.text(R - 4, y + 12, money(inv.payment.received), { size: 8.5, align: 'right' });

        // The balance is what the customer looks for, so it's the heaviest
        // thing in the block.
        doc.text(colP[8].x - 8, y + 26, 'Balance Due', { size: 9.5, bold: true, align: 'right' });
        doc.text(R - 4, y + 26, 'Rs. ' + money(inv.payment.due),
                 { size: 9.5, bold: true, align: 'right' });

        doc.text(L + 8, y + 21, inv.payment.label, { size: 11, bold: true,
                 gray: inv.payment.due > 0.004 ? 0 : 0.4 });
        y += pH;
    }

    /* ---- amount in words ---- */
    var aTop = y, ay = aTop + 12;
    doc.text(L + 4, ay, 'Amount Chargeable (in words)', { size: 7, gray: 0.35 }); ay += 11;
    ay = boxText(L, ay, W * 0.72, inv.amountWords || '', { size: 9, bold: true, lh: 11 });
    doc.text(R - 4, aTop + 12, 'E. & O.E', { size: 7.5, align: 'right' });
    var aBot = ay + 4;
    doc.rect(L, aTop, W, aBot - aTop, null, 0.6);
    y = aBot;

    /* ---- tax summary grid ---- */
    if (inv.taxRows && inv.taxRows.length) {
      var tTop = y;
      var tw = [0.28, 0.12, 0.18, 0.12, 0.18, 0.12];
      var tx2 = L, tP = [];
      tw.forEach(function (f) { tP.push({ x: tx2, w: W * f }); tx2 += W * f; });
      var thH = 30;
      doc.rect(L, tTop, W, thH, 0.93, 0.6);
      doc.text(tP[0].x + tP[0].w / 2, tTop + 18, 'Taxable Value', { size: 6.8, bold: true, align: 'center' });
      doc.text(tP[1].x + (tP[1].w + tP[2].w) / 2, tTop + 10, 'CGST', { size: 6.8, bold: true, align: 'center' });
      doc.text(tP[3].x + (tP[3].w + tP[4].w) / 2, tTop + 10, 'SGST/UTGST', { size: 6.8, bold: true, align: 'center' });
      doc.text(tP[5].x + tP[5].w / 2, tTop + 14, 'Total', { size: 6.8, bold: true, align: 'center' });
      doc.text(tP[5].x + tP[5].w / 2, tTop + 23, 'Tax Amount', { size: 6.8, bold: true, align: 'center' });
      ['Rate', 'Amount', 'Rate', 'Amount'].forEach(function (h, k) {
        doc.text(tP[k + 1].x + tP[k + 1].w / 2, tTop + 25, h, { size: 6.8, bold: true, align: 'center' });
      });
      doc.line(tP[1].x, tTop + 15, tP[5].x, tTop + 15, 0.6);
      var ty2 = tTop + thH;
      inv.taxRows.forEach(function (r) {
        r.forEach(function (v, k) {
          var ax = (k === 0 || k === 2 || k === 4 || k === 5)
            ? tP[k].x + tP[k].w - 4 : tP[k].x + tP[k].w / 2;
          doc.text(ax, ty2 + 11, String(v), { size: 8, align: (k === 1 || k === 3) ? 'center' : 'right' });
        });
        ty2 += 15;
        doc.line(L, ty2, R, ty2, 0.6);
      });
      doc.rect(L, tTop, W, ty2 - tTop, null, 0.6);
      tP.forEach(function (c, i) { if (i) doc.line(c.x, tTop, c.x, ty2, 0.6); });
      y = ty2;
    } else if (inv.taxNote) {
      doc.rect(L, y, W, 18, null, 0.6);
      doc.text(doc.W / 2, y + 12, inv.taxNote, { size: 8, align: 'center' });
      y += 18;
    }

    if (inv.taxWords) {
      doc.rect(L, y, W, 18, null, 0.6);
      doc.text(L + 4, y + 12, 'Tax Amount (in words) : ', { size: 8 });
      doc.text(L + 4 + D.widthOf('Tax Amount (in words) : ', 8, false), y + 12, inv.taxWords, { size: 8, bold: true });
      y += 18;
    }

    /* ---- narration ---- */
    // Was lost when the boxed layout replaced the earlier plain one. It
    // matters on a seed invoice, where a note like "balance for 2 urea"
    // is often the only record of what the sale actually covered.
    if (inv.narration) {
      var nTop = y, ny2 = nTop + 12;
      doc.text(L + 4, ny2, 'Narration', { size: 7, gray: 0.35 }); ny2 += 11;
      ny2 = doc.wrap(L + 4, ny2, inv.narration, W - 8, { size: 8.5, lh: 10 });
      doc.rect(L, nTop, W, ny2 + 4 - nTop, null, 0.6);
      y = ny2 + 4;
    }

    /* ---- declaration | bank ---- */
    var dTop = y, dMid = L + W * 0.56;
    var dy = dTop + 12;
    doc.text(L + 4, dy, 'Declaration', { size: 8, bold: true }); dy += 11;
    dy = boxText(L, dy, dMid - L, inv.declaration ||
      'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
      { size: 7.5, lh: 9.5 });
    var ky = dTop + 12;
    if (inv.bank && inv.bank.length) {
      doc.text(dMid + 4, ky, "Company's Bank Details", { size: 8, bold: true }); ky += 11;
      inv.bank.forEach(function (b) { ky = boxText(dMid, ky, R - dMid, b, { size: 7.5, lh: 9.5 }); });
    }
    var dBot = Math.max(dy, ky) + 4;
    doc.rect(L, dTop, W, dBot - dTop, null, 0.6);
    doc.line(dMid, dTop, dMid, dBot, 0.6);
    y = dBot;

    /* ---- signature ---- */
    var sTop = y, sH = 52;
    doc.rect(L, sTop, W, sH, null, 0.6);
    doc.line(dMid, sTop, dMid, sTop + sH, 0.6);
    doc.text(L + 4, sTop + 12, "Customer's Seal and Signature", { size: 7.5 });
    doc.text(R - 4, sTop + 12, 'for ' + (inv.sellerName || 'Sarvadharani Seeds'),
      { size: 8, bold: true, align: 'right' });
    doc.text(R - 4, sTop + sH - 8, 'Authorised Signatory', { size: 7.5, align: 'right' });
    y = sTop + sH;

    doc.text(doc.W / 2, y + 14, inv.footerNote || 'This is a Computer Generated Invoice',
      { size: 7.5, align: 'center' });
    if (inv.jurisdiction) {
      doc.text(doc.W / 2, y + 25, 'SUBJECT TO ' + inv.jurisdiction + ' JURISDICTION',
        { size: 7.5, align: 'center' });
    }
    return doc.bytes();
  }

  global.SarvaDocs = { buildTablePDF: buildTablePDF, buildInvoicePDF: buildInvoicePDF,
                       buildVoucherPDF: buildVoucherPDF, money: money };
})(window);
