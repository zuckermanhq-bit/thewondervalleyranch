/* Availability calendar — progressive enhancement for the direct booking site.
 *
 * Drops a real, availability-aware calendar into every .booking-box on the page.
 * - Fetches blocked dates from /api/availability/{slug} (direct + Airbnb/Vrbo, merged).
 * - Renders a navigable month grid; past + booked nights are not selectable.
 * - Guest picks check-in then check-out; a range that spans any booked night is rejected.
 * - Writes the chosen dates into the existing hidden checkin/checkout inputs, so the
 *   existing "Check Availability" modal + Formspree inquiry flow keeps working unchanged.
 *
 * Pricing is intentionally NOT here yet. When PriceLabs is wired, listen for the
 * 'availability:range' event (dispatched on the .booking-box) to fill in a live quote;
 * a .avcal-quote slot is already rendered and ready for it.
 *
 * No dependencies, no build step. Self-contained styles injected once.
 */
(function () {
  'use strict';

  // API base — same-origin by default. A second site (e.g. thewondervalleyranch.com) can
  // point this widget at the shared backend by setting data-api-base on the script tag:
  //   <script src="/availability-calendar.js" data-api-base="https://www.healdsburgstays.com" defer></script>
  var API_BASE = (function () {
    var s = document.currentScript;
    if (!s) {
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].src && /availability-calendar\.js/.test(all[i].src)) { s = all[i]; break; }
      }
    }
    var base = s && s.getAttribute('data-api-base');
    return base ? base.replace(/\/$/, '') : '';
  })();

  // Marketing display name (data-property) → backend slug (see api/_lib/properties.js)
  var SLUGS = {
    'Creekfront': 'creekfront',
    'Casa de Lucca': 'casa-de-lucca',
    'Wonder Valley Ranch': 'wonder-valley-ranch'
  };

  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DOW = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  // ---- date helpers (string-based, UTC math to dodge DST/timezone drift) ----
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function parseYMD(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function addDays(s, n) { var d = parseYMD(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
  function todayYMD() { var n = new Date(); return n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate()); }
  function nightsBetween(a, b) { return Math.round((parseYMD(b) - parseYMD(a)) / 86400000); }

  function injectStyles() {
    if (document.getElementById('avcal-styles')) return;
    var css = [
      '.avcal{font-family:"Montserrat",sans-serif;margin:0 0 1rem;color:var(--charcoal,#2C2C2A);background:var(--warm-white,#FDFBF8);border-radius:10px;padding:1rem 1.1rem;box-shadow:0 2px 12px rgba(0,0,0,.14)}',
      '.avcal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem}',
      '.avcal-title{font-family:"Cormorant Garamond",serif;font-size:1.25rem;color:var(--navy,#1B2A4A);font-weight:600}',
      '.avcal-nav{background:none;border:1px solid var(--border,rgba(27,42,74,.18));border-radius:50%;width:34px;height:34px;cursor:pointer;color:var(--navy,#1B2A4A);font-size:1rem;line-height:1;display:flex;align-items:center;justify-content:center;transition:background .15s,border-color .15s}',
      '.avcal-nav:hover:not(:disabled){background:var(--cream,#F7F4EF);border-color:var(--gold,#C19A4E)}',
      '.avcal-nav:disabled{opacity:.3;cursor:default}',
      '.avcal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}',
      '.avcal-dow{text-align:center;font-size:.62rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#888780);padding:.3rem 0}',
      '.avcal-day{position:relative;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;font-size:.82rem;font-weight:300;border:none;background:none;color:var(--charcoal,#2C2C2A);cursor:pointer;border-radius:6px;transition:background .12s,color .12s}',
      '.avcal-day.empty{cursor:default}',
      '.avcal-day:hover:not(:disabled):not(.sel){background:var(--cream,#F7F4EF)}',
      '.avcal-day:disabled{cursor:not-allowed;color:#c9c7c1;text-decoration:line-through;text-decoration-thickness:1px}',
      '.avcal-day.inrange{background:rgba(193,154,78,.16);border-radius:0}',
      '.avcal-day.sel{background:var(--navy,#1B2A4A);color:#fff;font-weight:500}',
      '.avcal-day.sel.start{border-radius:6px 0 0 6px}',
      '.avcal-day.sel.end{border-radius:0 6px 6px 0}',
      '.avcal-day.sel.only{border-radius:6px}',
      '.avcal-legend{display:flex;gap:1rem;margin-top:.6rem;font-size:.66rem;color:var(--muted,#888780);letter-spacing:.03em}',
      '.avcal-legend span{display:inline-flex;align-items:center;gap:.35rem}',
      '.avcal-dot{width:9px;height:9px;border-radius:50%;display:inline-block}',
      '.avcal-summary{margin-top:.7rem;padding-top:.7rem;border-top:1px solid var(--border,rgba(27,42,74,.12));font-size:.85rem;min-height:1.2em}',
      '.avcal-summary .nights{color:var(--navy,#1B2A4A);font-weight:500}',
      '.avcal-quote{color:var(--gold,#C19A4E)}',
      '.avcal-msg{color:#b3261e;font-size:.78rem;margin-top:.4rem;min-height:1em}',
      '.avcal-loading,.avcal-error{font-size:.82rem;color:var(--muted,#888780);padding:1rem 0;text-align:center}',
      '.avcal-quote strong{color:var(--navy,#1B2A4A)}',
      '.avcal-on .booking-form{display:none!important}',
      '.avcal-on .btn-inquire:disabled{opacity:.45;cursor:not-allowed;filter:grayscale(.35)}'
    ].join('');
    var s = document.createElement('style');
    s.id = 'avcal-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function Calendar(box, slug) {
    this.box = box;
    this.slug = slug;
    this.checkinInput = box.querySelector('input[name="checkin"]');
    this.checkoutInput = box.querySelector('input[name="checkout"]');
    this.inquireBtn = box.querySelector('.btn-inquire');
    this.inquireDefaultLabel = this.inquireBtn ? this.inquireBtn.textContent : 'Check Availability';
    this.blocked = [];           // [{start,end}] end-exclusive
    this.ci = null;              // selected check-in (YYYY-MM-DD)
    this.co = null;              // selected check-out
    this.today = todayYMD();
    var t = parseYMD(this.today);
    this.viewY = t.getUTCFullYear();
    this.viewM = t.getUTCMonth();  // 0-11
    this.el = null;
    this.quoteSeq = 0;             // guards against out-of-order quote responses
  }

  Calendar.prototype.isBlockedNight = function (day) {
    for (var i = 0; i < this.blocked.length; i++) {
      if (day >= this.blocked[i].start && day < this.blocked[i].end) return true;
    }
    return false;
  };

  // Is `day` selectable as a CHECK-IN? Needs to be today-or-later and its night free.
  Calendar.prototype.selectableCheckin = function (day) {
    return day >= this.today && !this.isBlockedNight(day);
  };

  // Every night in [ci, co) must be free for the range to be valid.
  Calendar.prototype.rangeClear = function (ci, co) {
    for (var d = ci; d < co; d = addDays(d, 1)) {
      if (this.isBlockedNight(d)) return false;
    }
    return true;
  };

  Calendar.prototype.mount = function () {
    var wrap = document.createElement('div');
    wrap.className = 'avcal';
    wrap.innerHTML = '<div class="avcal-loading">Loading availability…</div>';
    // Insert above the (now hidden) native booking-form fields
    var form = this.box.querySelector('.booking-form');
    if (form) this.box.insertBefore(wrap, form);
    else this.box.insertBefore(wrap, this.box.firstChild);
    this.box.classList.add('avcal-on');
    this.el = wrap;
    this.updateButton();   // start disabled until dates are chosen
    var self = this;
    fetch(API_BASE + '/api/availability/' + this.slug, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        self.blocked = Array.isArray(data.blocked) ? data.blocked : [];
        self.render();
      })
      .catch(function () {
        // Graceful fallback: keep the native date inputs visible so inquiries still work.
        self.box.classList.remove('avcal-on');
        if (self.el && self.el.parentNode) self.el.parentNode.removeChild(self.el);
        self.restoreButton();
      });
  };

  // The booking-box's "Check Availability" button becomes the calendar-driven CTA:
  // disabled with a prompt until a valid range is picked, then an active "Request These Dates".
  Calendar.prototype.updateButton = function () {
    if (!this.inquireBtn) return;
    if (this.ci && this.co) {
      this.inquireBtn.disabled = false;
      this.inquireBtn.textContent = 'Request These Dates';
    } else {
      this.inquireBtn.disabled = true;
      this.inquireBtn.textContent = 'Select Your Dates Above';
    }
  };

  Calendar.prototype.restoreButton = function () {
    if (!this.inquireBtn) return;
    this.inquireBtn.disabled = false;
    this.inquireBtn.textContent = this.inquireDefaultLabel;
  };

  Calendar.prototype.canGoPrev = function () {
    var t = parseYMD(this.today);
    return (this.viewY > t.getUTCFullYear()) || (this.viewY === t.getUTCFullYear() && this.viewM > t.getUTCMonth());
  };

  Calendar.prototype.render = function () {
    var y = this.viewY, m = this.viewM;
    var first = new Date(Date.UTC(y, m, 1));
    var startDow = first.getUTCDay();
    var daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

    var html = '';
    html += '<div class="avcal-head">';
    html += '<button type="button" class="avcal-nav" data-nav="-1" aria-label="Previous month"' + (this.canGoPrev() ? '' : ' disabled') + '>‹</button>';
    html += '<div class="avcal-title">' + MONTHS[m] + ' ' + y + '</div>';
    html += '<button type="button" class="avcal-nav" data-nav="1" aria-label="Next month">›</button>';
    html += '</div>';
    html += '<div class="avcal-grid">';
    for (var i = 0; i < 7; i++) html += '<div class="avcal-dow">' + DOW[i] + '</div>';
    for (var b = 0; b < startDow; b++) html += '<div class="avcal-day empty"></div>';

    for (var d = 1; d <= daysInMonth; d++) {
      var day = y + '-' + pad(m + 1) + '-' + pad(d);
      var disabled = !this.selectableCheckin(day);
      // when picking a checkout, allow any future free day strictly after ci
      var picking = this.ci && !this.co;
      if (picking && day > this.ci && this.rangeClear(this.ci, day)) disabled = false;
      if (picking && day <= this.ci) disabled = (day !== this.ci) ? true : false;

      var cls = 'avcal-day';
      if (this.ci && day === this.ci) cls += ' sel start' + (this.co ? '' : ' only');
      if (this.co && day === this.co) cls += ' sel end';
      if (this.ci && this.co && day > this.ci && day < this.co) cls += ' inrange';

      html += '<button type="button" class="' + cls + '"' + (disabled ? ' disabled' : '') + ' data-day="' + day + '">' + d + '</button>';
    }
    html += '</div>';
    html += '<div class="avcal-legend">';
    html += '<span><i class="avcal-dot" style="background:var(--navy,#1B2A4A)"></i>Selected</span>';
    html += '<span><i class="avcal-dot" style="background:#c9c7c1"></i>Unavailable</span>';
    html += '</div>';
    html += '<div class="avcal-summary"></div>';
    html += '<div class="avcal-msg" role="status" aria-live="polite"></div>';

    this.el.innerHTML = html;
    this.bind();
    this.updateSummary();
  };

  Calendar.prototype.bind = function () {
    var self = this;
    this.el.querySelectorAll('[data-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var dir = +btn.getAttribute('data-nav');
        var m = self.viewM + dir;
        self.viewY += Math.floor(m / 12);
        self.viewM = ((m % 12) + 12) % 12;
        self.render();
      });
    });
    this.el.querySelectorAll('[data-day]').forEach(function (btn) {
      if (btn.disabled) return;
      btn.addEventListener('click', function () { self.pick(btn.getAttribute('data-day')); });
    });
  };

  Calendar.prototype.pick = function (day) {
    this.setMsg('');
    if (!this.ci || this.co || day < this.ci) {
      // start a fresh selection
      if (!this.selectableCheckin(day)) return;
      this.ci = day; this.co = null;
    } else if (day === this.ci) {
      this.ci = null; this.co = null;        // tap check-in again to clear
    } else {
      // choosing a checkout
      if (!this.rangeClear(this.ci, day)) {
        this.setMsg('Those dates include nights that are already booked. Try a shorter stay.');
        return;
      }
      this.co = day;
    }
    this.syncInputs();
    this.render();
  };

  Calendar.prototype.syncInputs = function () {
    if (this.checkinInput) { this.checkinInput.value = this.ci || ''; fire(this.checkinInput); }
    if (this.checkoutInput) { this.checkoutInput.value = this.co || ''; fire(this.checkoutInput); }
  };

  Calendar.prototype.updateSummary = function () {
    var sum = this.el.querySelector('.avcal-summary');
    if (!sum) return;
    if (this.ci && this.co) {
      var n = nightsBetween(this.ci, this.co);
      sum.innerHTML = '<span class="nights">' + n + ' night' + (n === 1 ? '' : 's') + '</span> · ' +
        fmt(this.ci) + ' → ' + fmt(this.co) +
        '<div class="avcal-quote" data-quote>Calculating price…</div>';
      this.box.dispatchEvent(new CustomEvent('availability:range', {
        bubbles: true,
        detail: { slug: this.slug, checkin: this.ci, checkout: this.co, nights: n }
      }));
      this.fetchQuote(this.ci, this.co, n);
    } else if (this.ci) {
      sum.innerHTML = 'Check-in <span class="nights">' + fmt(this.ci) + '</span> — now choose your check-out date.';
      this.box.removeAttribute('data-quote-text');
    } else {
      sum.innerHTML = 'Select your check-in date to see available nights.';
      this.box.removeAttribute('data-quote-text');
    }
    this.updateButton();
  };

  // Fetch a live PriceLabs-backed quote and fill the [data-quote] slot.
  // Degrades silently to "priced on inquiry" on any error or unconfigured pricing.
  Calendar.prototype.fetchQuote = function (ci, co, n) {
    var self = this;
    var seq = ++this.quoteSeq;
    var fallback = 'Pricing confirmed with your inquiry (within 24 hours).';
    fetch(API_BASE + '/api/quote/' + this.slug + '?checkin=' + ci + '&checkout=' + co, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (q) {
        if (seq !== self.quoteSeq) return;            // a newer selection superseded this
        var slot = self.el.querySelector('[data-quote]');
        if (!slot) return;
        if (!q || q.pricingAvailable === false || typeof q.subtotal !== 'number') {
          slot.textContent = (q && q.message) || fallback;
          return;
        }
        var cur = q.currency || 'USD';
        var n = q.nights;
        function row(label, val, isTotal) {
          var base = 'display:flex;justify-content:space-between;gap:1rem;';
          base += isTotal
            ? 'font-weight:600;color:var(--navy,#1B2A4A);border-top:1px solid var(--border,rgba(27,42,74,.18));padding-top:.4rem;margin-top:.4rem;'
            : 'margin-top:.25rem;';
          return '<div style="' + base + '"><span>' + label + '</span><span>' + money(val, cur) + '</span></div>';
        }
        var nightLabel = q.avgNightly
          ? money(q.avgNightly, cur) + ' × ' + n + ' night' + (n === 1 ? '' : 's')
          : n + ' night' + (n === 1 ? '' : 's');
        var taxPct = Math.round((q.taxRate || 0) * 100);
        var rows = row(nightLabel, q.nightlySubtotal);
        if (q.cleaningFee) rows += row('Cleaning fee', q.cleaningFee);
        if (q.tax) rows += row((q.taxLabel || 'Tax') + ' (' + taxPct + '%)', q.tax);
        rows += row('Total' + (q.complete === false ? ' (estimate)' : ''), q.total, true);
        var html = '<div style="color:var(--charcoal,#2C2C2A);font-size:.8rem;">' + rows + '</div>';
        if (q.minStay && q.minStayOk === false) {
          html += '<div class="avcal-msg" style="color:#b3261e">Minimum stay is ' + q.minStay + ' nights for these dates.</div>';
        }
        html += '<div style="color:var(--muted,#888780);font-size:.72rem;margin-top:.35rem">Final total confirmed when you inquire.</div>';
        slot.innerHTML = html;
        // Stash a compact all-in total the inquiry modal can show alongside the dates.
        self.box.setAttribute('data-quote-text', money(q.total, cur) + ' total (incl. cleaning + tax)');
      })
      .catch(function () {
        if (seq !== self.quoteSeq) return;
        var slot = self.el.querySelector('[data-quote]');
        if (slot) slot.textContent = fallback;
      });
  };

  Calendar.prototype.setMsg = function (m) {
    var el = this.el.querySelector('.avcal-msg');
    if (el) el.textContent = m;
  };

  function fmt(s) {
    var d = parseYMD(s);
    return MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCDate();
  }
  function fire(input) {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function money(n, cur) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(n);
    } catch (e) {
      return '$' + Math.round(n).toLocaleString();
    }
  }

  function init() {
    var boxes = document.querySelectorAll('.booking-box[data-property]');
    if (!boxes.length) return;
    injectStyles();
    boxes.forEach(function (box) {
      var slug = SLUGS[box.getAttribute('data-property')];
      if (!slug) return;
      new Calendar(box, slug).mount();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
