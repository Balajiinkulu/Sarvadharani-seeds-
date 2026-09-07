/* pdf-engine.js — writes real PDF files directly, with no external libraries.
 *
 * Replaces the previous html2canvas + jsPDF approach, which screenshotted the
 * page into a bitmap. That had hard limits that caused real problems here:
 * Safari silently truncates any canvas past ~8192px tall (long reports lost
 * their lower half), a backgrounded tab captured as blank, and the memory
 * cost was enough for iOS to kill the app mid-export — which is why printing
 * had to be restricted to desktop.
 *
 * Writing the PDF's own format sidesteps all of that: pages are real A4
 * (595.28 x 841.89 pt), the text stays selectable and sharp at any zoom,
 * length is unlimited, and the memory cost is trivial. Adapted from the
 * uploaded gst-print.js, keeping its Doc primitives and delivery helpers.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------- font metrics (1000em) */

  var W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  var W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

  /* Helvetica has no rupee glyph, so spell it. Same for the other stray marks. */
  var SUBS = { '\u20B9': 'Rs.', '\u00D7': 'x', '\u2014': '-', '\u2013': '-', '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u00B7': '-', '\u2022': '-', '\u2192': '->' };

  function ascii(s) {
    s = String(s == null ? '' : s);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i], c = s.charCodeAt(i);
      if (SUBS[ch]) out += SUBS[ch];
      else if (c >= 32 && c <= 126) out += ch;
      else if (c === 10 || c === 13) out += ch;
      else out += ' ';
    }
    return out;
  }
  function widthOf(text, size, bold) {
    var t = ascii(text), w = 0, tbl = bold ? W_BOLD : W_REG;
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i) - 32;
      w += (c >= 0 && c < tbl.length ? tbl[c] : 500);
    }
    return w * size / 1000;
  }
  function esc(s) { return ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

  /* --------------------------------------------------------- tiny pdf core */

  function Doc() {
    this.pages = [];
    this.buf = '';
    this.W = 595.28; this.H = 841.89;
  }
  Doc.prototype.newPage = function () { this.pages.push(this.buf = ''); this.i = this.pages.length - 1; return this; };
  Doc.prototype.put = function (s) { this.pages[this.i] += s + '\n'; };
  Doc.prototype.text = function (x, y, str, o) {
    o = o || {};
    var size = o.size || 9, bold = !!o.bold;
    var t = esc(str);
    if (!t) return;
    if (o.align === 'right') x -= widthOf(str, size, bold);
    else if (o.align === 'center') x -= widthOf(str, size, bold) / 2;
    var g = o.gray;
    this.put('BT /F' + (bold ? '2' : '1') + ' ' + size + ' Tf' +
      (g != null ? ' ' + g + ' ' + g + ' ' + g + ' rg' : ' 0 0 0 rg') +
      ' 1 0 0 1 ' + x.toFixed(2) + ' ' + (this.H - y).toFixed(2) + ' Tm (' + t + ') Tj ET');
  };
  Doc.prototype.wrap = function (x, y, str, width, o) {
    o = o || {};
    var size = o.size || 9, lh = o.lh || size * 1.25, self = this;
    String(str == null ? '' : str).split(/\n/).forEach(function (para) {
      var line = '', words = para.split(/\s+/);
      words.forEach(function (w) {
        var test = line ? line + ' ' + w : w;
        if (widthOf(test, size, o.bold) > width && line) { self.text(x, y, line, o); y += lh; line = w; }
        else line = test;
      });
      self.text(x, y, line, o); y += lh;
    });
    return y;
  };
  Doc.prototype.line = function (x1, y1, x2, y2, gray) {
    this.put((gray == null ? 0.75 : gray) + ' G 0.5 w ' + x1.toFixed(2) + ' ' + (this.H - y1).toFixed(2) +
      ' m ' + x2.toFixed(2) + ' ' + (this.H - y2).toFixed(2) + ' l S');
  };
  Doc.prototype.rect = function (x, y, w, h, fillGray, strokeGray) {
    var ops = '';
    if (fillGray != null) ops += fillGray + ' g ';
    if (strokeGray != null) ops += strokeGray + ' G 0.5 w ';
    this.put(ops + x.toFixed(2) + ' ' + (this.H - y - h).toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) +
      ' re ' + (fillGray != null && strokeGray != null ? 'B' : fillGray != null ? 'f' : 'S'));
  };
  Doc.prototype.bytes = function () {
    var objs = [], self = this;
    var kids = [], pageIds = [];
    var nPages = this.pages.length;
    // 1 catalog, 2 pages, 3 F1, 4 F2, then per page: content + page
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    var id = 5;
    this.pages.forEach(function (content) {
      var cid = id++, pid = id++;
      objs[cid] = '<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream';
      objs[pid] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + self.W.toFixed(2) + ' ' + self.H.toFixed(2) +
        '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + cid + ' 0 R >>';
      pageIds.push(pid);
    });
    objs[2] = '<< /Type /Pages /Count ' + nPages + ' /Kids [' +
      pageIds.map(function (p) { return p + ' 0 R'; }).join(' ') + '] >>';

    var out = '%PDF-1.4\n', offsets = [], max = id - 1;
    for (var n = 1; n <= max; n++) {
      offsets[n] = out.length;
      out += n + ' 0 obj\n' + objs[n] + '\nendobj\n';
    }
    var xref = out.length;
    out += 'xref\n0 ' + (max + 1) + '\n0000000000 65535 f \n';
    for (n = 1; n <= max; n++) out += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
    out += 'trailer\n<< /Size ' + (max + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';

    var arr = new Uint8Array(out.length);
    for (var i = 0; i < out.length; i++) arr[i] = out.charCodeAt(i) & 0xff;
    return arr;
  };

  /* -------------------------------------------------------------- helpers */

  function money(n) {
    return (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function dmy(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '-' + p[1] + '-' + p[0] : (iso || ''); }

  /* --------------------------------------------------------- the document */

  /* --------------------------------------------------------------- output */

  function blobOf(bytes) { return new Blob([bytes], { type: 'application/pdf' }); }

  function save(bytes, filename) {
    var url = URL.createObjectURL(blobOf(bytes));
    var a = document.createElement('a');
    if ('download' in a) {
      a.href = url; a.download = filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    } else {
      window.open(url, '_blank');
    }
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function openTab(bytes) {
    var url = URL.createObjectURL(blobOf(bytes));
    var w = window.open(url, '_blank');
    if (!w) { save(bytes, 'invoice.pdf'); return false; }
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    return true;
  }

  function share(bytes, filename, title) {
    var done = false;
    try {
      if (global.File && navigator.canShare) {
        var file = new File([bytes], filename, { type: 'application/pdf' });
        if (navigator.canShare({ files: [file] })) {
          done = true;
          return navigator.share({ files: [file], title: title || filename })
            .catch(function (e) { if (e && e.name !== 'AbortError') save(bytes, filename); });
        }
      }
    } catch (e) { /* fall through */ }
    if (!done) save(bytes, filename);
    return Promise.resolve();
  }

  global.SarvaPDF = {
    Doc: Doc, widthOf: widthOf, save: save, open: openTab, share: share, blob: blobOf,
    supportsShare: function () {
      try {
        return !!(global.File && navigator.canShare &&
          navigator.canShare({ files: [new File([new Uint8Array(1)], 'a.pdf', { type: 'application/pdf' })] }));
      } catch (e) { return false; }
    }
  };
})(window);
