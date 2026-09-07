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

  function buildInvoicePDF(inv) {
    var D = global.SarvaPDF, doc = new D.Doc();
    doc.newPage();
    var L = M.left, R = doc.W - M.right, W = R - L;
    var y = M.top;

    doc.text(doc.W / 2, y, inv.docTitle || 'TAX INVOICE', { size: 13, bold: true, align: 'center' });
    y += 16;

    // Seller / invoice-number box
    var boxTop = y, boxH = 78, midX = L + W * 0.58;
    doc.rect(L, boxTop, W, boxH, null, 0.5);
    doc.line(midX, boxTop, midX, boxTop + boxH, 0.5);

    var ty = boxTop + 14;
    doc.text(L + 8, ty, inv.sellerName || 'Sarvadharani Seeds', { size: 11, bold: true }); ty += 13;
    if (inv.sellerAddress) ty = doc.wrap(L + 8, ty, inv.sellerAddress, midX - L - 16, { size: 8, lh: 10 });
    if (inv.sellerGstin) { doc.text(L + 8, ty, 'GSTIN/UIN: ' + inv.sellerGstin, { size: 8 }); ty += 10; }
    doc.text(L + 8, ty, 'State Name : Odisha, Code : 21', { size: 8 }); ty += 10;
    if (inv.sellerPhone) doc.text(L + 8, ty, 'Contact : ' + inv.sellerPhone, { size: 8 });

    var ry = boxTop + 14;
    doc.text(midX + 8, ry, inv.numberLabel || 'Invoice No.', { size: 8, gray: 0.35 }); ry += 11;
    doc.text(midX + 8, ry, inv.invNo || '', { size: 10, bold: true }); ry += 16;
    doc.text(midX + 8, ry, 'Dated', { size: 8, gray: 0.35 }); ry += 11;
    doc.text(midX + 8, ry, inv.date || '', { size: 10, bold: true });
    y = boxTop + boxH;

    // Buyer box
    var bH = 56;
    doc.rect(L, y, W, bH, null, 0.5);
    var by = y + 13;
    doc.text(L + 8, by, 'Buyer (Bill to)', { size: 8, gray: 0.35 }); by += 12;
    doc.text(L + 8, by, inv.partyName || 'Retail Sale', { size: 10, bold: true }); by += 12;
    if (inv.partyAddress) by = doc.wrap(L + 8, by, inv.partyAddress, W - 16, { size: 8, lh: 10 });
    if (inv.partyGstin) { doc.text(L + 8, by, 'GSTIN/UIN : ' + inv.partyGstin, { size: 8 }); by += 10; }
    doc.text(L + 8, by, 'Place of Supply : Odisha', { size: 8 });
    y += bH;

    // Items table
    var cols = [
      { label: 'Sl', w: 0.05, align: 'center' },
      { label: 'Description of Goods', w: 0.30 },
      { label: 'HSN', w: 0.10, align: 'center' },
      { label: 'GST', w: 0.07, align: 'center' },
      { label: 'Qty', w: 0.13, align: 'right' },
      { label: 'Rate', w: 0.12, align: 'right' },
      { label: 'per', w: 0.07, align: 'center' },
      { label: 'Amount', w: 0.16, align: 'right' }
    ];
    var cx = L, colPos = [];
    cols.forEach(function (c) { colPos.push({ x: cx, w: W * c.w }); cx += W * c.w; });

    var headH = 17;
    doc.rect(L, y, W, headH, 0.92, 0.5);
    cols.forEach(function (c, i) {
      var tx = colPos[i].x + 4;
      if (c.align === 'right') tx = colPos[i].x + colPos[i].w - 4;
      else if (c.align === 'center') tx = colPos[i].x + colPos[i].w / 2;
      doc.text(tx, y + 12, c.label, { size: 7.5, bold: true, align: c.align || 'left' });
    });
    y += headH;

    (inv.items || []).forEach(function (it, idx) {
      var h = 16;
      if (y + h > doc.H - M.bottom - 120) {   // leave room for the totals block
        doc.newPage(); y = M.top;
      }
      var vals = [
        String(idx + 1), it.name || '', it.hsn || '',
        it.gstLabel || '', it.qtyLabel || '', money(it.rate), it.uom || '', money(it.amount)
      ];
      cols.forEach(function (c, i) {
        var tx = colPos[i].x + 4;
        if (c.align === 'right') tx = colPos[i].x + colPos[i].w - 4;
        else if (c.align === 'center') tx = colPos[i].x + colPos[i].w / 2;
        doc.text(tx, y + 11, vals[i], { size: 8, bold: (i === 7), align: c.align || 'left' });
      });
      doc.line(L, y + h, R, y + h, 0.85);
      y += h;
    });

    // Totals
    var lines = inv.totalLines || [];
    lines.forEach(function (t) {
      doc.text(R - 6, y + 12, money(t.value), { size: 8.5, bold: !!t.bold, align: 'right' });
      doc.text(colPos[6].x - 6, y + 12, t.label, { size: 8.5, bold: !!t.bold, align: 'right' });
      doc.line(L, y + 16, R, y + 16, 0.85);
      y += 16;
    });
    doc.rect(L, y, W, 20, 0.92, 0.5);
    doc.text(colPos[6].x - 6, y + 14, inv.grandLabel || 'Total', { size: 10, bold: true, align: 'right' });
    doc.text(R - 6, y + 14, '\u20B9 ' + money(inv.grandTotal), { size: 10, bold: true, align: 'right' });
    y += 26;

    if (inv.amountWords) {
      doc.text(L, y, 'Amount Chargeable (in words)', { size: 8, gray: 0.35 }); y += 11;
      y = doc.wrap(L, y, inv.amountWords, W, { size: 9, bold: true, lh: 11 });
      y += 6;
    }

    if (inv.taxSummary && inv.taxSummary.length) {
      doc.text(L, y, 'Tax Summary', { size: 8, bold: true }); y += 12;
      inv.taxSummary.forEach(function (t) {
        doc.text(L, y, t, { size: 8 }); y += 10;
      });
      y += 4;
    }

    if (inv.bank && inv.bank.length) {
      doc.text(L, y, "Company's Bank Details", { size: 8, bold: true }); y += 11;
      inv.bank.forEach(function (b) { doc.text(L, y, b, { size: 8 }); y += 10; });
      y += 4;
    }

    if (inv.narration) {
      doc.text(L, y, 'Narration: ' + inv.narration, { size: 8, gray: 0.3 });
      y += 12;
    }

    var footY = Math.max(y + 20, doc.H - M.bottom - 46);
    doc.text(L, footY, "Customer's Seal and Signature", { size: 8, gray: 0.35 });
    doc.text(R, footY, 'for ' + (inv.sellerName || 'Sarvadharani Seeds'), { size: 8.5, bold: true, align: 'right' });
    doc.text(R, footY + 30, 'Authorised Signatory', { size: 8, align: 'right' });
    doc.text(doc.W / 2, doc.H - 26, inv.footerNote || 'This is a Computer Generated Invoice',
      { size: 7.5, align: 'center', gray: 0.45 });

    return doc.bytes();
  }

  global.SarvaDocs = { buildTablePDF: buildTablePDF, buildInvoicePDF: buildInvoicePDF, money: money };
})(window);
