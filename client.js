/* FollowUp Pro — browser app (no build step). All text is rendered with
   textContent via h(); only trusted icon SVG markup uses innerHTML. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- utils
  const $app = document.getElementById('app');
  const $toasts = document.getElementById('toasts');
  const state = { user: null, today: null, overdueCount: 0 };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, ...children);
    return el;
  }
  function append(el, ...children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function icon(name, cls) {
    const s = document.createElement('span');
    s.className = 'ico' + (cls ? ' ' + cls : '');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (window.ICONS[name] || '') + '</svg>';
    return s;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  const STATUS_LABEL = { new: 'New', interested: 'Interested', follow_up: 'Follow-up', converted: 'Converted', lost: 'Lost' };
  const SOURCE_LABEL = { walk_in: 'Showroom visit', phone: 'Phone call', whatsapp: 'WhatsApp', online: 'Online enquiry', referral: 'Referral', other: 'Other' };
  const OPEN = ['new', 'interested', 'follow_up'];

  const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  const money = (v) => (v === null || v === undefined ? '—' : inr.format(v));

  function tz() { return (state.user && state.user.business.timezone) || 'Asia/Kolkata'; }
  function todayStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function addDays(d, n) {
    const t = new Date(d + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
  function fmtDate(d, opts) {
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', ...(opts || {}) }).format(new Date(d + 'T00:00:00Z'));
  }
  function fmtTime(t) {
    if (!t) return '';
    const [H, M] = t.split(':').map(Number);
    const ampm = H >= 12 ? 'pm' : 'am';
    const hh = H % 12 || 12;
    return `${hh}:${String(M).padStart(2, '0')} ${ampm}`;
  }
  function fmtStamp(ts) {
    return new Intl.DateTimeFormat('en-IN', { timeZone: tz(), day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
  }
  // Relative label + tone for a due date.
  function whenInfo(dueDate) {
    if (!dueDate) return { text: 'No follow-up set', tone: 'none' };
    const diff = daysBetween(todayStr(), dueDate);
    if (diff < 0) return { text: diff === -1 ? '1 day late' : `${-diff} days late`, tone: 'overdue' };
    if (diff === 0) return { text: 'Today', tone: 'today' };
    if (diff === 1) return { text: 'Tomorrow', tone: 'later' };
    if (diff < 7) return { text: fmtDate(dueDate, { weekday: 'short', day: undefined, month: undefined }), tone: 'later' };
    return { text: fmtDate(dueDate), tone: 'later' };
  }
  function whenEl(dueDate, dueTime) {
    const w = whenInfo(dueDate);
    return h('span', { class: `when when-${w.tone}` }, w.text, dueTime && w.tone !== 'none' ? `, ${fmtTime(dueTime)}` : '');
  }
  function fmtPhone(m) {
    if (!m) return '';
    if (m.startsWith('91') && m.length === 12) return `+91 ${m.slice(2, 7)} ${m.slice(7)}`;
    return '+' + m;
  }
  function initials(name) {
    const p = String(name || '?').trim().split(/\s+/);
    return ((p[0] || '')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  function avatar(name) {
    let hsh = 0;
    for (const ch of String(name)) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    return h('div', { class: `avatar av-${hsh % 6}`, 'aria-hidden': 'true' }, initials(name));
  }
  function pill(status) { return h('span', { class: `pill pill-${status}` }, STATUS_LABEL[status] || status); }

  // WhatsApp official click-to-chat: https://wa.me/<number>?text=<message>
  function waMessage(c) {
    const tpl = (state.user && state.user.business.whatsappTemplate) || 'Hello {name}';
    return tpl
      .replaceAll('{name}', (c.customerName || '').split(' ')[0] || '')
      .replaceAll('{product}', c.product || 'our products')
      .replaceAll('{business}', state.user ? state.user.business.name : '');
  }
  const waHref = (c) => `https://wa.me/${c.mobile}?text=${encodeURIComponent(waMessage(c))}`;
  const telHref = (c) => `tel:+${c.mobile}`;

  // Contact buttons. Opening WhatsApp/the dialer does not send anything; we
  // then offer to log the outcome so the follow-up list stays honest.
  function contactButtons(c, { size = 'sm', labels = false, followUp = null } = {}) {
    const after = (kind) => () => {
      if (!followUp) return;
      setTimeout(() => toast(kind === 'wa' ? 'WhatsApp opened. Log what happened when you are done.' : 'Calling. Log what happened when you are done.', {
        action: 'Log outcome', onAction: () => completeSheet(followUp),
      }), 600);
    };
    const cls = size === 'lg' ? 'btn btn-lg' : labels ? 'btn btn-sm' : 'btn icon-btn';
    return [
      h('a', { class: `${cls} btn-call`, href: telHref(c), 'aria-label': `Call ${c.customerName}`, title: 'Call', onclick: (e) => { e.stopPropagation(); after('call')(); } },
        icon('phone'), labels ? 'Call' : null),
      h('a', { class: `${cls} btn-wa`, href: waHref(c), target: '_blank', rel: 'noopener noreferrer', 'aria-label': `WhatsApp ${c.customerName}`, title: 'WhatsApp', onclick: (e) => { e.stopPropagation(); after('wa')(); } },
        icon('message-circle'), labels ? 'WhatsApp' : null),
    ];
  }

  // ---------------------------------------------------------------- api
  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.error && body.error.message) || 'Something went wrong. Please try again.');
      this.status = status;
      this.fields = (body && body.error && body.error.details && body.error.details.fields) || {};
    }
  }
  async function api(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (method !== 'GET') opts.headers['X-Requested-With'] = 'FollowUpPro';
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch('/api' + path, opts); } catch {
      throw new ApiError(0, { error: { message: 'No internet connection. Check your network and try again.' } });
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/auth/')) { state.user = null; render(); }
      throw new ApiError(res.status, data);
    }
    return data;
  }

  // ---------------------------------------------------------------- toasts
  function toast(message, { error = false, action, onAction, ms = 4500 } = {}) {
    const t = h('div', { class: 'toast' + (error ? ' error' : '') }, icon(error ? 'triangle-alert' : 'circle-check'), h('span', null, message));
    if (action) t.appendChild(h('button', { type: 'button', onclick: () => { t.remove(); onAction(); } }, action));
    $toasts.appendChild(t);
    while ($toasts.children.length > 3) $toasts.firstChild.remove();
    setTimeout(() => t.remove(), action ? ms + 3000 : ms);
  }

  // ---------------------------------------------------------------- forms
  function field(label, input, { hint, name } = {}) {
    const err = h('div', { class: 'err', hidden: true });
    const id = 'f-' + Math.random().toString(36).slice(2, 8);
    if (input.tagName && !input.id) input.id = id;
    const wrap = h('div', { class: 'field', 'data-field': name || '' },
      h('label', { for: input.id || id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null, err);
    return wrap;
  }
  function showErrors(root, err, formError) {
    root.querySelectorAll('.field').forEach((f) => { f.classList.remove('has-err'); const e = f.querySelector('.err'); if (e) e.hidden = true; });
    let placed = false;
    for (const [k, msg] of Object.entries(err.fields || {})) {
      const f = root.querySelector(`.field[data-field="${k}"]`);
      if (f) { f.classList.add('has-err'); const e = f.querySelector('.err'); e.textContent = msg; e.hidden = false; placed = true; }
    }
    if (formError) {
      clear(formError);
      if (!placed || !Object.keys(err.fields || {}).length) {
        append(formError, [icon('triangle-alert', 'ico-sm'), h('span', null, err.message)]);
        formError.hidden = false;
      } else formError.hidden = true;
    } else if (!placed) toast(err.message, { error: true });
  }
  const input = (attrs) => h('input', { class: 'input', ...attrs });
  const textarea = (attrs) => h('textarea', { class: 'textarea', ...attrs });

  // Chip group acting as a radio group.
  function chipGroup(options, value, onChange, { label } = {}) {
    const wrap = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': label || '' });
    let current = value;
    const btns = options.map(([v, text]) => {
      const b = h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(v === current), onclick: () => select(v) }, text);
      b.dataset.v = v;
      return b;
    });
    function select(v) {
      current = v;
      btns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === v)));
      onChange && onChange(v);
    }
    append(wrap, btns);
    wrap.getValue = () => current;
    wrap.select = select;
    return wrap;
  }

  // Date picker with quick chips (most shop owners pick "Tomorrow").
  function datePicker({ initial, withTime = true, allowNone = false, name = 'dueDate' } = {}) {
    const today = todayStr();
    const opts = [['0', 'Today'], ['1', 'Tomorrow'], ['3', 'In 3 days'], ['7', 'Next week'], ['custom', 'Pick date']];
    if (allowNone) opts.push(['none', 'Not now']);
    const dateInput = input({ type: 'date', min: today, value: initial || addDays(today, 1), 'aria-label': 'Follow-up date' });
    const timeInput = input({ type: 'time', 'aria-label': 'Time (optional)' });
    const custom = h('div', { class: 'grid-2' }, dateInput, withTime ? timeInput : h('span'));
    let mode = '1';
    if (initial) {
      const d = daysBetween(today, initial);
      mode = ['0', '1', '3', '7'].includes(String(d)) ? String(d) : 'custom';
    }
    const chips = chipGroup(opts, mode, (v) => {
      mode = v;
      if (v !== 'custom' && v !== 'none') dateInput.value = addDays(today, Number(v));
      custom.hidden = v === 'none';
      dateInput.hidden = v !== 'custom';
      if (v === 'custom') dateInput.focus();
    }, { label: 'Follow-up date' });
    dateInput.hidden = mode !== 'custom';
    const wrap = h('div', { class: 'field', 'data-field': name }, h('span', { class: 'field-label' }, 'Next follow-up'), chips, custom, withTime ? h('div', { class: 'hint' }, 'Time is optional.') : null, h('div', { class: 'err', hidden: true }));
    wrap.getValue = () => (mode === 'none' ? null : { date: dateInput.value || null, time: timeInput.value || null });
    return wrap;
  }

  // ---------------------------------------------------------------- sheets (modals)
  let activeSheet = null;
  function openSheet({ title, sub, body, submitLabel, onSubmit, danger, secondary, noFooter }) {
    closeSheet();
    const prevFocus = document.activeElement;
    const formError = h('div', { class: 'form-error', hidden: true, role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary') }, submitLabel || 'Save');
    const form = h('form', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, novalidate: true },
      h('div', { class: 'sheet-head' },
        h('div', null, h('h2', null, title), sub ? h('div', { class: 's-sub' }, sub) : null),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-ghost icon-btn', 'aria-label': 'Close', onclick: closeSheet }, icon('x'))),
      h('div', { class: 'sheet-body' }, h('div', { class: 'stack' }, formError, body)),
      noFooter ? null : h('div', { class: 'sheet-foot' }, secondary || null, h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn', onclick: closeSheet }, 'Cancel'), submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      formError.hidden = true;
      try {
        await onSubmit();
        closeSheet();
      } catch (err) {
        if (err instanceof ApiError) showErrors(form, err, formError);
        else { console.error(err); showErrors(form, { message: err.message || 'Something went wrong.', fields: {} }, formError); }
      } finally { submit.disabled = false; }
    });
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) closeSheet(); } }, form);
    const onKey = (e) => {
      if (e.key === 'Escape') closeSheet();
      if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...form.querySelectorAll('button, a[href], input:not([hidden]), select, textarea')].filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    activeSheet = { overlay, onKey, prevFocus };
    setTimeout(() => { const first = form.querySelector('.sheet-body input:not([hidden]), .sheet-body textarea, .sheet-body button'); if (first) first.focus(); }, 30);
    return form;
  }
  function closeSheet() {
    if (!activeSheet) return;
    document.removeEventListener('keydown', activeSheet.onKey);
    activeSheet.overlay.remove();
    document.body.style.overflow = '';
    if (activeSheet.prevFocus && activeSheet.prevFocus.focus) activeSheet.prevFocus.focus();
    activeSheet = null;
  }

  // Re-render current page after a data change.
  function refresh() { route(); }

  // ---------------------------------------------------------------- sheet: add customer
  function addCustomerSheet() {
    const name = input({ name: 'name', autocomplete: 'off', placeholder: 'e.g. Anil Kumar', maxlength: 120 });
    const mobile = input({ name: 'mobile', type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '98450 12345', maxlength: 25 });
    const product = input({ name: 'product', placeholder: 'e.g. 3-seater recliner sofa', maxlength: 160 });
    const source = chipGroup(Object.entries(SOURCE_LABEL), 'walk_in', null, { label: 'Enquiry source' });
    const when = datePicker({ allowNone: true, name: 'nextFollowUpDate' });
    const value = input({ inputmode: 'numeric', placeholder: 'Optional', maxlength: 16 });
    const enqDate = input({ type: 'date', value: todayStr(), max: todayStr() });
    const notes = textarea({ placeholder: 'Colour, budget, who they came with…', maxlength: 2000 });
    const body = [
      field('Customer name', name, { name: 'name' }),
      field('Mobile number', mobile, { name: 'mobile', hint: 'Used for the Call and WhatsApp buttons.' }),
      field('Interested in', product, { name: 'product' }),
      h('div', { class: 'field', 'data-field': 'source' }, h('span', { class: 'field-label' }, 'How did they reach you?'), source, h('div', { class: 'err', hidden: true })),
      when,
      h('details', { class: 'more' }, h('summary', null, icon('plus', 'ico-sm'), 'More details (optional)'),
        h('div', { class: 'stack' },
          h('div', { class: 'grid-2' },
            field('Estimated value', h('div', { class: 'input-prefix' }, h('span', null, '₹'), value), { name: 'estimatedValue' }),
            field('Enquiry date', enqDate, { name: 'enquiryDate' })),
          field('Notes', notes, { name: 'notes' }))),
    ];
    openSheet({
      title: 'Add new customer', sub: 'Takes about 10 seconds. Only the first three fields are required.', body, submitLabel: 'Save customer',
      onSubmit: async () => {
        const next = when.getValue();
        const r = await api('POST', '/enquiries', {
          name: name.value, mobile: mobile.value, product: product.value, source: source.getValue(),
          estimatedValue: value.value, enquiryDate: enqDate.value, notes: notes.value,
          nextFollowUpDate: next ? next.date : null, nextFollowUpTime: next ? next.time : null,
        });
        toast(r.existingCustomer ? `Added to existing customer ${r.existingCustomerName}` : 'Customer saved', {
          action: 'Open', onAction: () => { location.hash = `#/customers/${r.enquiry.id}`; },
        });
        refresh();
      },
    });
  }

  // ---------------------------------------------------------------- sheet: add follow-up
  function addFollowUpSheet(enquiry) {
    let chosen = enquiry || null;
    const pickerArea = h('div', { class: 'stack' });
    const when = datePicker({ name: 'dueDate' });
    const note = textarea({ placeholder: 'What to discuss, e.g. share price for grey fabric', maxlength: 1000, rows: 2 });

    function renderPicked() {
      clear(pickerArea);
      if (chosen) {
        append(pickerArea, h('div', { class: 'picked' }, avatar(chosen.customerName),
          h('div', { class: 'main-col' }, h('div', { class: 'name' }, chosen.customerName), h('div', { class: 'meta' }, chosen.product)),
          h('span', { class: 'spacer' }),
          enquiry ? null : h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { chosen = null; renderPicked(); } }, 'Change')));
        return;
      }
      const q = input({ placeholder: 'Search name, mobile or product', 'aria-label': 'Search customer' });
      const list = h('div', { class: 'pick-list', role: 'listbox' });
      let timer;
      async function load() {
        clear(list).appendChild(h('div', { class: 'skeleton sk-line' }));
        try {
          const r = await api('GET', `/enquiries?status=open&q=${encodeURIComponent(q.value.trim())}`);
          clear(list);
          if (!r.items.length) list.appendChild(h('div', { class: 'empty' }, h('p', null, q.value ? 'No open customer matches this search.' : 'No open customers yet. Add a customer first.')));
          r.items.forEach((it) => list.appendChild(h('div', { class: 'lrow', role: 'option', tabindex: '0', onclick: () => { chosen = it; renderPicked(); }, onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); chosen = it; renderPicked(); } } },
            avatar(it.customerName), h('div', { class: 'main-col' }, h('div', { class: 'name' }, it.customerName), h('div', { class: 'meta' }, `${it.product} · ${fmtPhone(it.mobile)}`)),
            whenEl(it.nextFollowUp && it.nextFollowUp.dueDate))));
        } catch (err) { clear(list).appendChild(h('div', { class: 'load-error' }, err.message)); }
      }
      q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
      append(pickerArea, field('Customer', q, { name: 'customer' }), list);
      load();
      setTimeout(() => q.focus(), 40);
    }
    renderPicked();
    openSheet({
      title: 'Add follow-up', sub: 'Set a reminder to contact the customer again.',
      body: [pickerArea, when, field('Note (optional)', note, { name: 'note' })], submitLabel: 'Schedule follow-up',
      onSubmit: async () => {
        if (!chosen) throw new ApiError(400, { error: { message: 'Choose a customer first.', details: { fields: { customer: 'Choose a customer.' } } } });
        const v = when.getValue();
        await api('POST', `/enquiries/${chosen.id}/follow-ups`, { dueDate: v.date, dueTime: v.time, note: note.value });
        const wt = whenInfo(v.date).text;
        toast(`Follow-up scheduled for ${['Today', 'Tomorrow'].includes(wt) ? wt.toLowerCase() : wt}`);
        refresh();
      },
    });
  }

  // ---------------------------------------------------------------- sheet: complete follow-up
  function completeSheet(f) {
    const outcome = textarea({ placeholder: 'What did the customer say?', maxlength: 1000, rows: 3 });
    let next = 'again';
    const extra = h('div', { class: 'opt-extra' });
    const when = datePicker({ initial: addDays(todayStr(), 2), name: 'next.dueDate' });
    const interested = h('label', { class: 'row', style: null }, h('input', { type: 'checkbox' }), h('span', null, 'Customer is interested'));
    const sale = input({ inputmode: 'numeric', placeholder: f.estimatedValue ? String(f.estimatedValue) : 'Sale amount', maxlength: 16 });
    const reason = input({ placeholder: 'e.g. Bought elsewhere, price too high', maxlength: 300 });
    const options = [
      ['again', 'calendar-clock', 'Follow up again', 'Pick the next date now so they stay on your list.', '#946505', '#FCF3DC'],
      ['converted', 'trophy', 'Converted to sale', 'They bought. Record the sale value.', '#0F7246', '#E2F5EB'],
      ['lost', 'circle-x', 'Lost', 'They are not buying. Note why.', '#A02C3F', '#FBE7EA'],
      ['stop', 'check', 'Done, no next follow-up', 'Keeps the enquiry open with no reminder.', '#44526A', '#EEF1F6'],
    ];
    const optBtns = options.map(([v, ic, t, s, col, bg]) => {
      const ico = icon(ic);
      const icoWrap = h('span', { class: 'o-ico' }, ico);
      icoWrap.style.color = col; icoWrap.style.background = bg;
      const b = h('button', { type: 'button', class: 'opt', role: 'radio', 'aria-checked': String(v === next), onclick: () => pick(v) },
        icoWrap, h('span', null, h('b', null, t), h('span', { class: 'o-sub' }, s)));
      b.dataset.v = v;
      return b;
    });
    function pick(v) {
      next = v;
      optBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === v)));
      clear(extra);
      if (v === 'again') append(extra, when, f.enquiryStatus !== 'interested' ? interested : null);
      if (v === 'converted') append(extra, field('Sale value', h('div', { class: 'input-prefix' }, h('span', null, '₹'), sale), { name: 'saleValue', hint: f.estimatedValue ? `Leave empty to use the estimate of ${money(f.estimatedValue)}.` : null }));
      if (v === 'lost') append(extra, field('Reason', reason, { name: 'lostReason' }));
    }
    pick('again');
    openSheet({
      title: 'Log follow-up', sub: `${f.customerName}, ${f.product}`,
      body: [
        h('div', { class: 'row-wrap' }, contactButtons(f, { labels: true })),
        field('Outcome', outcome, { name: 'outcome' }),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'What happens next?'), h('div', { class: 'next-opt', role: 'radiogroup' }, optBtns)),
        extra,
      ],
      submitLabel: 'Save',
      onSubmit: async () => {
        const body = { outcome: outcome.value };
        if (next === 'again') {
          const v = when.getValue();
          body.next = { dueDate: v.date, dueTime: v.time };
          if (interested.querySelector('input').checked) body.status = 'interested';
          else if (f.enquiryStatus === 'new') body.status = 'follow_up';
        } else if (next === 'converted') { body.status = 'converted'; body.saleValue = sale.value; }
        else if (next === 'lost') { body.status = 'lost'; body.lostReason = reason.value; }
        else if (f.enquiryStatus === 'new') body.status = 'follow_up';
        if (next === 'lost' && !reason.value.trim() && !outcome.value.trim()) {
          throw new ApiError(400, { error: { message: 'Add a short reason why this enquiry was lost.', details: { fields: { lostReason: 'Reason is required.' } } } });
        }
        await api('POST', `/follow-ups/${f.id}/complete`, body);
        toast(next === 'converted' ? 'Marked as converted. Well done.' : next === 'again' ? 'Saved. Next follow-up is scheduled.' : 'Follow-up saved');
        refresh();
      },
    });
  }

  function rescheduleSheet(f) {
    const when = datePicker({ initial: f.dueDate >= todayStr() ? f.dueDate : addDays(todayStr(), 1), name: 'dueDate' });
    openSheet({
      title: 'Reschedule follow-up', sub: `${f.customerName}, ${f.product}`, body: [when], submitLabel: 'Reschedule',
      onSubmit: async () => {
        const v = when.getValue();
        await api('PATCH', `/follow-ups/${f.id}`, { dueDate: v.date, dueTime: v.time });
        toast('Follow-up rescheduled');
        refresh();
      },
    });
  }

  function statusSheet(e, status) {
    const note = textarea({ maxlength: 1000, rows: 2, placeholder: 'Optional note' });
    const sale = input({ inputmode: 'numeric', placeholder: e.estimatedValue ? String(e.estimatedValue) : 'Sale amount', maxlength: 16 });
    const reason = input({ placeholder: 'e.g. Bought elsewhere, price too high', maxlength: 300 });
    const body = [];
    if (status === 'converted') body.push(field('Sale value', h('div', { class: 'input-prefix' }, h('span', null, '₹'), sale), { name: 'saleValue', hint: e.estimatedValue ? `Leave empty to use the estimate of ${money(e.estimatedValue)}.` : null }));
    if (status === 'lost') body.push(field('Reason', reason, { name: 'lostReason' }));
    body.push(field('Note', note, { name: 'note' }));
    if ((status === 'converted' || status === 'lost') && e.nextFollowUp) body.push(h('div', { class: 'hint' }, 'Pending follow-ups for this enquiry will be cancelled.'));
    openSheet({
      title: `Mark as ${STATUS_LABEL[status].toLowerCase()}`, sub: `${e.customerName}, ${e.product}`, body, submitLabel: `Mark ${STATUS_LABEL[status].toLowerCase()}`,
      onSubmit: async () => {
        await api('POST', `/enquiries/${e.id}/status`, { status, note: note.value, saleValue: sale.value, lostReason: reason.value });
        toast(`Marked as ${STATUS_LABEL[status].toLowerCase()}`);
        refresh();
      },
    });
  }

  function editSheet(e, customer) {
    const name = input({ value: customer.name, maxlength: 120 });
    const mobile = input({ type: 'tel', inputmode: 'tel', value: fmtPhone(customer.mobile), maxlength: 25 });
    const product = input({ value: e.product, maxlength: 160 });
    const source = chipGroup(Object.entries(SOURCE_LABEL), e.source, null, { label: 'Enquiry source' });
    const value = input({ inputmode: 'numeric', value: e.estimatedValue ?? '', maxlength: 16 });
    const enqDate = input({ type: 'date', value: e.enquiryDate });
    const notes = textarea({ value: e.notes || '', maxlength: 2000 });
    openSheet({
      title: 'Edit customer', body: [
        h('div', { class: 'grid-2' }, field('Customer name', name, { name: 'name' }), field('Mobile number', mobile, { name: 'mobile' })),
        field('Interested in', product, { name: 'product' }),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Enquiry source'), source),
        h('div', { class: 'grid-2' }, field('Estimated value', h('div', { class: 'input-prefix' }, h('span', null, '₹'), value), { name: 'estimatedValue' }), field('Enquiry date', enqDate, { name: 'enquiryDate' })),
        field('Notes', notes, { name: 'notes' }),
      ],
      submitLabel: 'Save changes',
      onSubmit: async () => {
        await api('PATCH', `/customers/${customer.id}`, { name: name.value, mobile: mobile.value });
        await api('PATCH', `/enquiries/${e.id}`, { product: product.value, source: source.getValue(), estimatedValue: value.value, enquiryDate: enqDate.value, notes: notes.value });
        toast('Changes saved');
        refresh();
      },
    });
  }

  function confirmSheet({ title, message, confirmLabel, onConfirm }) {
    openSheet({ title, body: [h('p', null, message)], submitLabel: confirmLabel, danger: true, onSubmit: onConfirm });
  }

  // ---------------------------------------------------------------- shared rows
  function followUpRow(f) {
    const done = f.status !== 'pending';
    return h('div', { class: 'lrow', role: 'link', tabindex: '0',
      onclick: () => { location.hash = `#/customers/${f.enquiryId}`; },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) location.hash = `#/customers/${f.enquiryId}`; } },
      avatar(f.customerName),
      h('div', { class: 'main-col' },
        h('div', { class: 'name' }, f.customerName),
        h('div', { class: 'meta' }, f.product, f.note ? h('span', { class: 'note hide-sm' }, ` · ${f.note}`) : null, done && f.outcome ? h('span', { class: 'note' }, ` · ${f.outcome}`) : null)),
      h('div', { class: 'side-col hide-sm' },
        done ? h('span', { class: 'time' }, f.completedAt ? `Done ${fmtStamp(f.completedAt)}` : '') : whenEl(f.dueDate, f.dueTime),
        h('span', { class: 'time' }, fmtPhone(f.mobile))),
      done ? null : h('div', { class: 'acts' },
        contactButtons(f, { followUp: f }),
        h('button', { type: 'button', class: 'btn btn-primary icon-btn', 'aria-label': `Log follow-up for ${f.customerName}`, title: 'Log outcome', onclick: (e) => { e.stopPropagation(); completeSheet(f); } }, icon('check'))));
  }

  function enquiryRow(e, { compact = false } = {}) {
    return h('div', { class: 'lrow', role: 'link', tabindex: '0',
      onclick: () => { location.hash = `#/customers/${e.id}`; },
      onkeydown: (ev) => { if (ev.key === 'Enter' && ev.target === ev.currentTarget) location.hash = `#/customers/${e.id}`; } },
      avatar(e.customerName),
      h('div', { class: 'main-col' }, h('div', { class: 'name' }, e.customerName), h('div', { class: 'meta' }, e.product, compact ? null : h('span', { class: 'note hide-sm' }, ` · ${fmtPhone(e.mobile)}`))),
      compact ? null : h('div', { class: 'side-col' }, pill(e.status),
        OPEN.includes(e.status) ? whenEl(e.nextFollowUp && e.nextFollowUp.dueDate) : h('span', { class: 'time' }, e.status === 'converted' ? money(e.saleValue) : (e.lostReason || ''))),
      compact
        ? h('button', { type: 'button', class: 'btn btn-sm', onclick: (ev) => { ev.stopPropagation(); addFollowUpSheet(e); } }, icon('calendar-plus', 'ico-sm'), 'Set date')
        : h('div', { class: 'acts hide-sm' }, contactButtons(e)));
  }

  function emptyState(ico, title, text, action) {
    return h('div', { class: 'empty' }, h('div', { class: 'e-ico' }, icon(ico)), h('h3', null, title), h('p', null, text), action || null);
  }
  function skeleton(n = 4) { return h('div', null, Array.from({ length: n }, () => h('div', { class: 'skeleton sk-line' }))); }
  function loadError(err, retry) {
    return h('div', { class: 'load-error' }, h('p', null, err.message), h('button', { class: 'btn btn-sm', style: null, onclick: retry }, icon('rotate-ccw', 'ico-sm'), 'Try again'));
  }

  // ---------------------------------------------------------------- page: Today
  async function todayPage(page) {
    const hero = h('div', { class: 'today-hero' });
    const metrics = h('div', { class: 'metrics' });
    const left = h('div', { class: 'panel' }, skeleton(4));
    const right = h('div', { class: 'side-stack' });
    append(page, hero, metrics, h('div', { class: 'today-grid' }, left, right));
    const dateLine = new Intl.DateTimeFormat('en-IN', { timeZone: tz(), weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    append(hero, h('div', null, h('div', { class: 'today-date' }, dateLine), h('h1', { class: 'today-line' }, 'Loading your day…')),
      h('div', { class: 'cta-row' },
        h('button', { class: 'btn btn-primary btn-lg', onclick: addCustomerSheet }, icon('user-plus'), 'Add new customer'),
        h('button', { class: 'btn btn-lg', onclick: () => addFollowUpSheet() }, icon('calendar-plus'), 'Add follow-up'),
        h('a', { class: 'btn btn-lg', href: '#/follow-ups?view=today' }, icon('list-todo'), "Today's follow-ups")));

    let d;
    try { d = await api('GET', '/dashboard'); } catch (err) { clear(left).appendChild(loadError(err, refresh)); return; }
    state.today = d.today;
    state.overdueCount = d.stats.overdue;
    updateBadges();
    const s = d.stats;
    const toCall = s.overdue + s.dueToday;
    const line = hero.querySelector('.today-line');
    clear(line);
    if (toCall === 0) append(line, s.totalEnquiries ? 'No calls due today. You are all caught up.' : 'Add your first customer to start your follow-up list.');
    else {
      append(line, `Call ${toCall} ${toCall === 1 ? 'customer' : 'customers'} today`);
      if (s.overdue) append(line, ', ', h('span', { class: 't-over' }, `${s.overdue} ${s.overdue === 1 ? 'is' : 'are'} overdue`));
      append(line, '.');
    }

    const metric = (val, label, href, cls, valCls) => h('a', { class: 'metric ' + (cls || ''), href }, h('div', { class: 'm-val ' + (valCls || '') }, val), h('div', { class: 'm-lab' }, label));
    append(metrics,
      metric(s.totalEnquiries, 'Total enquiries', '#/customers?status=all'),
      metric(s.newEnquiries, 'New enquiries', '#/customers?status=new'),
      metric(s.dueToday, 'Due today', '#/follow-ups?view=today'),
      metric(s.pendingFollowUps, 'Pending follow-ups', '#/follow-ups?view=upcoming', '', s.overdue ? '' : ''),
      metric(s.converted, 'Converted', '#/customers?status=converted'),
      metric(s.lost, 'Lost', '#/customers?status=lost'),
      metric(money(s.wonValueThisMonth), 'Sales won this month', '#/customers?status=converted', 'm-won'));

    clear(left);
    append(left, h('div', { class: 'panel-head' }, h('h2', null, 'Call list'), h('span', { class: 'count' }, toCall ? `${toCall} to contact` : ''), h('span', { class: 'spacer' }),
      h('a', { class: 'btn btn-sm btn-ghost', href: '#/follow-ups?view=upcoming' }, 'Upcoming')));
    const body = h('div', { class: 'panel-body' });
    if (d.overdue.length) append(body, h('div', { class: 'group-label' }, h('span', { class: 'dot dot-rose' }), `Overdue (${d.overdue.length})`), d.overdue.map(followUpRow));
    if (d.dueToday.length) append(body, h('div', { class: 'group-label' }, h('span', { class: 'dot dot-mari' }), `Due today (${d.dueToday.length})`), d.dueToday.map(followUpRow));
    if (!toCall) append(body, s.totalEnquiries
      ? emptyState('sun', 'Nothing due today', 'Use the quiet time to add walk-in customers, so tomorrow’s list builds itself.', h('button', { class: 'btn btn-primary', onclick: addCustomerSheet }, icon('user-plus'), 'Add new customer'))
      : emptyState('inbox', 'Your call list is empty', 'Every customer you add with a follow-up date will appear here on the right day.', h('button', { class: 'btn btn-primary', onclick: addCustomerSheet }, icon('user-plus'), 'Add your first customer')));
    left.appendChild(body);

    const won = h('div', { class: 'panel won-card' },
      h('div', { class: 'w-lab' }, 'Sales won this month'),
      h('div', { class: 'w-val' }, money(s.wonValueThisMonth)),
      h('div', { class: 'w-sub' }, h('span', null, `${s.convertedThisMonth} converted this month`), h('span', null, `${money(s.pipelineValue)} still open`)));
    const leak = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'No next step'), h('span', { class: 'count' }, String(s.noNextStep))),
      h('p', { class: 'leak-note' }, 'Open customers with no follow-up date. These are the sales that slip away.'),
      h('div', { class: 'panel-body' }, d.noNextStep.length ? d.noNextStep.map((e) => enquiryRow(e, { compact: true })) : h('div', { class: 'empty' }, h('p', null, 'Every open customer has a next follow-up.'))));
    append(right, won, leak);
  }

  // ---------------------------------------------------------------- page: Customers
  async function customersPage(page, params) {
    let status = params.get('status') || 'open';
    let q = params.get('q') || '';
    let pageNo = 1;
    const search = input({ type: 'search', placeholder: 'Search name, mobile or product', value: q, 'aria-label': 'Search customers' });
    const filters = chipGroup([['open', 'Open'], ['all', 'All'], ['new', 'New'], ['interested', 'Interested'], ['follow_up', 'Follow-up'], ['converted', 'Converted'], ['lost', 'Lost']], status, (v) => { status = v; pageNo = 1; load(); }, { label: 'Filter by status' });
    const panel = h('div', { class: 'panel list-panel' });
    append(page,
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Customers'), h('p', { class: 'sub' }, 'Every enquiry, with its status and next follow-up.')), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-primary', onclick: addCustomerSheet }, icon('user-plus'), 'Add new customer')),
      h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search'), search)),
      h('div', { class: 'toolbar' }, filters),
      panel);
    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); pageNo = 1; load(); }, 250); });
    async function load() {
      clear(panel).appendChild(skeleton(5));
      const qs = new URLSearchParams({ status, page: String(pageNo) });
      if (q) qs.set('q', q);
      history.replaceState(null, '', `#/customers?${new URLSearchParams({ status, ...(q ? { q } : {}) })}`);
      let r;
      try { r = await api('GET', `/enquiries?${qs}`); } catch (err) { clear(panel).appendChild(loadError(err, load)); return; }
      clear(panel);
      if (!r.items.length) {
        panel.appendChild(q || status !== 'open'
          ? emptyState('search', 'No customers found', 'Try a different search or filter.')
          : emptyState('users', 'No open customers yet', 'Add customers as they visit, call or message you.', h('button', { class: 'btn btn-primary', onclick: addCustomerSheet }, icon('user-plus'), 'Add new customer')));
        return;
      }
      append(panel, h('div', { class: 'panel-body' }, r.items.map((e) => enquiryRow(e))));
      if (r.totalPages > 1) {
        append(panel, h('div', { class: 'pager' },
          h('button', { class: 'btn btn-sm', disabled: pageNo <= 1, onclick: () => { pageNo -= 1; load(); } }, icon('chevron-left', 'ico-sm'), 'Previous'),
          h('span', { class: 'num' }, `Page ${r.page} of ${r.totalPages}, ${r.total} customers`),
          h('button', { class: 'btn btn-sm', disabled: pageNo >= r.totalPages, onclick: () => { pageNo += 1; load(); } }, 'Next', icon('chevron-right', 'ico-sm'))));
      } else append(panel, h('div', { class: 'pager' }, h('span', { class: 'num' }, `${r.total} ${r.total === 1 ? 'customer' : 'customers'}`)));
    }
    load();
  }

  // ---------------------------------------------------------------- page: Customer detail
  async function detailPage(page, enquiryId) {
    page.appendChild(skeleton(3));
    let d;
    try { d = await api('GET', `/enquiries/${encodeURIComponent(enquiryId)}`); } catch (err) {
      clear(page).appendChild(err.status === 404
        ? emptyState('search', 'Customer not found', 'It may have been deleted.', h('a', { class: 'btn', href: '#/customers' }, 'Back to customers'))
        : loadError(err, refresh));
      return;
    }
    clear(page);
    const e = d.enquiry;
    const c = { ...e };
    const open = OPEN.includes(e.status);
    const pending = d.followUps.filter((f) => f.status === 'pending');
    const isOwner = state.user.role === 'owner';

    const statusTrack = h('div', { class: 'status-track', role: 'radiogroup', 'aria-label': 'Status' },
      Object.entries(STATUS_LABEL).map(([v, label]) => h('button', { type: 'button', class: `chip s-${v}`, role: 'radio', 'aria-checked': String(v === e.status),
        onclick: async () => {
          if (v === e.status) return;
          if (v === 'converted' || v === 'lost') return statusSheet(e, v);
          try { await api('POST', `/enquiries/${e.id}/status`, { status: v }); toast(`Marked as ${label.toLowerCase()}`); refresh(); } catch (err) { toast(err.message, { error: true }); }
        } }, label)));

    const fuItems = d.followUps.map((f) => {
      const overdue = f.status === 'pending' && f.dueDate < todayStr();
      const kind = f.status === 'pending' ? (overdue ? 'overdue' : 'pending') : f.status;
      const title = f.status === 'pending' ? h('span', null, whenEl(f.dueDate, f.dueTime))
        : f.status === 'done' ? `Done${f.completedByName ? ` by ${f.completedByName}` : ''}, ${fmtStamp(f.completedAt)}`
        : `Cancelled (was due ${fmtDate(f.dueDate)})`;
      return h('div', { class: 'fu-item' },
        h('div', { class: `fu-ico ${kind}` }, icon(f.status === 'done' ? 'check' : f.status === 'cancelled' ? 'x' : 'clock', 'ico-sm')),
        h('div', { class: 'fu-main' },
          h('div', { class: 'fu-title' }, title),
          f.note ? h('div', { class: 'fu-text' }, f.note) : null,
          f.outcome ? h('div', { class: 'fu-text' }, `Outcome: ${f.outcome}`) : null,
          f.status === 'pending' ? h('div', { class: 'fu-acts' },
            h('button', { class: 'btn btn-primary btn-sm', onclick: () => completeSheet({ ...f, enquiryStatus: e.status }) }, icon('check', 'ico-sm'), 'Log outcome'),
            h('button', { class: 'btn btn-sm', onclick: () => rescheduleSheet(f) }, icon('calendar', 'ico-sm'), 'Reschedule'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => confirmSheet({ title: 'Cancel this follow-up?', message: 'The reminder will be removed from your list.', confirmLabel: 'Cancel follow-up', onConfirm: async () => { await api('POST', `/follow-ups/${f.id}/cancel`); toast('Follow-up cancelled'); refresh(); } }) }, 'Cancel')) : null));
    });

    append(page,
      h('a', { class: 'back', href: '#/customers' }, icon('chevron-left', 'ico-sm'), 'Customers'),
      h('div', { class: 'detail-head' }, avatar(d.customer.name),
        h('div', null, h('h1', null, d.customer.name), h('div', { class: 'phone' }, fmtPhone(d.customer.mobile))),
        h('div', { class: 'detail-actions' }, contactButtons(c, { size: 'lg', labels: true, followUp: pending[0] ? { ...pending[0], enquiryStatus: e.status } : null }),
          h('button', { class: 'btn btn-lg icon-btn', 'aria-label': 'Edit customer', title: 'Edit', onclick: () => editSheet(e, d.customer) }, icon('pencil')))),
      h('div', { class: 'detail-grid' },
        h('div', { class: 'side-stack' },
          h('div', { class: 'panel panel-pad' },
            h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Status'), statusTrack),
            h('div', { class: 'facts', style: null }, ...[
              ['Interested in', e.product], ['Source', SOURCE_LABEL[e.source]], ['Estimated value', money(e.estimatedValue)], ['Enquiry date', fmtDate(e.enquiryDate, { year: 'numeric' })],
              ...(e.status === 'converted' ? [['Sale value', money(e.saleValue)]] : []),
              ...(e.status === 'lost' ? [['Lost reason', e.lostReason || '—']] : []),
            ].map(([l, v]) => h('div', { class: 'fact' }, h('div', { class: 'f-lab' }, l), h('div', { class: 'f-val' }, v)))),
            e.notes ? h('div', { class: 'notes-box' }, e.notes) : null),
          h('div', { class: 'panel' },
            h('div', { class: 'panel-head' }, h('h2', null, 'Follow-ups'), h('span', { class: 'count' }, pending.length ? `${pending.length} pending` : ''), h('span', { class: 'spacer' }),
              open ? h('button', { class: 'btn btn-sm', onclick: () => addFollowUpSheet(e) }, icon('calendar-plus', 'ico-sm'), 'Add follow-up') : null),
            h('div', { class: 'panel-body' }, fuItems.length ? fuItems : h('div', { class: 'empty' }, h('p', null, open ? 'No follow-up set. Add one so this customer is not forgotten.' : 'No follow-ups.'))))),
        h('div', { class: 'side-stack' },
          h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'History')),
            h('ul', { class: 'timeline' }, d.history.map((x) => h('li', null,
              x.fromStatus ? h('span', null, 'Status changed to ', h('b', null, STATUS_LABEL[x.toStatus])) : h('span', null, h('b', null, 'Enquiry created')),
              x.note && x.note !== 'Enquiry created' ? h('span', null, `: ${x.note}`) : null,
              h('span', { class: 'tl-when' }, `${fmtStamp(x.changedAt)}${x.changedByName ? `, ${x.changedByName}` : ''}`))))),
          d.otherEnquiries.length ? h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Other enquiries')),
            h('div', { class: 'panel-body' }, d.otherEnquiries.map((o) => h('a', { class: 'lrow', href: `#/customers/${o.id}` },
              h('div', { class: 'main-col' }, h('div', { class: 'name' }, o.product), h('div', { class: 'meta' }, fmtDate(o.enquiryDate, { year: 'numeric' }))), pill(o.status))))) : null,
          h('div', { class: 'row-wrap' },
            h('button', { class: 'btn btn-sm', onclick: () => addCustomerSheetFor(d.customer) }, icon('plus', 'ico-sm'), 'New enquiry for this customer'),
            isOwner ? h('button', { class: 'btn btn-sm btn-danger', onclick: () => confirmSheet({ title: 'Delete this enquiry?', message: 'This permanently deletes the enquiry and its follow-ups. This cannot be undone.', confirmLabel: 'Delete enquiry', onConfirm: async () => { await api('DELETE', `/enquiries/${e.id}`); toast('Enquiry deleted'); location.hash = '#/customers'; } }) }, icon('trash-2', 'ico-sm'), 'Delete') : null))));
  }

  // Opens Add Customer with name and mobile pre-filled.
  function addCustomerSheetFor(customer) {
    addCustomerSheet();
    const form = document.querySelector('.sheet');
    const inputs = form.querySelectorAll('input');
    inputs[0].value = customer.name;
    inputs[1].value = fmtPhone(customer.mobile);
    setTimeout(() => inputs[2].focus(), 40);
  }

  // ---------------------------------------------------------------- page: Follow-ups
  async function followUpsPage(page, params) {
    let view = params.get('view') || 'today';
    const tabs = [['overdue', 'Overdue'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['done', 'Done']];
    const tabBar = h('div', { class: 'tabs', role: 'tablist' });
    const panel = h('div', { class: 'panel list-panel' });
    function renderTabs() {
      clear(tabBar);
      tabs.forEach(([v, label]) => tabBar.appendChild(h('button', { class: 'tab', role: 'tab', 'aria-selected': String(v === view), onclick: () => { view = v; renderTabs(); load(); } },
        label, v === 'overdue' && state.overdueCount ? h('span', { class: 'count alert' }, String(state.overdueCount)) : null)));
    }
    append(page,
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Follow-ups'), h('p', { class: 'sub' }, 'Who to contact, and when.')), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-primary', onclick: () => addFollowUpSheet() }, icon('calendar-plus'), 'Add follow-up')),
      tabBar, panel);
    renderTabs();
    async function load() {
      history.replaceState(null, '', `#/follow-ups?view=${view}`);
      clear(panel).appendChild(skeleton(4));
      let r;
      try { r = await api('GET', `/follow-ups?view=${view}`); } catch (err) { clear(panel).appendChild(loadError(err, load)); return; }
      if (view === 'overdue') { state.overdueCount = r.items.length; renderTabs(); updateBadges(); }
      clear(panel);
      if (!r.items.length) {
        const msg = {
          overdue: ['circle-check', 'Nothing overdue', 'Every follow-up is on time.'],
          today: ['sun', 'No follow-ups today', 'Schedule follow-ups when you add customers and they will show up here.'],
          upcoming: ['calendar', 'Nothing scheduled ahead', 'Add a follow-up for customers who are still deciding.'],
          done: ['history', 'No completed follow-ups yet', 'Follow-ups you log will appear here with their outcome.'],
        }[view];
        panel.appendChild(emptyState(...msg));
        return;
      }
      append(panel, h('div', { class: 'panel-body' }, r.items.map(followUpRow)));
    }
    load();
  }

  // ---------------------------------------------------------------- page: Settings
  async function settingsPage(page) {
    const isOwner = state.user.role === 'owner';
    append(page, h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Settings'), h('p', { class: 'sub' }, state.user.business.name))));
    const grid = h('div', { class: 'settings-grid' }, h('div', { class: 'side-stack' }, skeleton(3)), h('div', { class: 'side-stack' }));
    page.appendChild(grid);
    let s, team;
    try { [s, team] = await Promise.all([api('GET', '/settings'), api('GET', '/team')]); } catch (err) { clear(grid.firstChild).appendChild(loadError(err, refresh)); return; }
    const b = s.business;
    const [colA, colB] = grid.children;
    clear(colA);

    // Business profile + WhatsApp template
    const name = input({ value: b.name, maxlength: 120, disabled: !isOwner });
    const phone = input({ value: b.phone || '', maxlength: 25, disabled: !isOwner, type: 'tel' });
    const city = input({ value: b.city || '', maxlength: 80, disabled: !isOwner });
    const cc = input({ value: b.countryCode, maxlength: 4, inputmode: 'numeric', disabled: !isOwner });
    const zones = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Colombo', 'Europe/London', 'America/New_York'];
    if (!zones.includes(b.timezone)) zones.unshift(b.timezone);
    const tzSel = h('select', { class: 'select', disabled: !isOwner }, zones.map((z) => h('option', { value: z, selected: z === b.timezone }, z)));
    const tpl = textarea({ value: b.whatsappTemplate, maxlength: 1000, rows: 4, disabled: !isOwner });
    const preview = h('div', { class: 'preview-bubble' });
    const updPreview = () => {
      preview.textContent = tpl.value.replaceAll('{name}', 'Anil').replaceAll('{product}', 'recliner sofa').replaceAll('{business}', name.value);
    };
    tpl.addEventListener('input', updPreview); name.addEventListener('input', updPreview); updPreview();
    const bizErr = h('div', { class: 'form-error', hidden: true });
    const bizForm = h('form', { class: 'panel panel-pad', novalidate: true },
      h('h2', { class: 'ph' }, 'Business'), h('p', { class: 'pdesc' }, 'Shown in WhatsApp messages and used for dates and phone numbers.'),
      h('div', { class: 'stack' }, bizErr,
        field('Business name', name, { name: 'name' }),
        h('div', { class: 'grid-2' }, field('Phone', phone, { name: 'phone' }), field('City', city, { name: 'city' })),
        h('div', { class: 'grid-2' }, field('Country code', cc, { name: 'countryCode', hint: 'Added to 10-digit mobile numbers.' }), field('Time zone', tzSel, { name: 'timezone' })),
        field('WhatsApp message', tpl, { name: 'whatsappTemplate', hint: 'Use {name}, {product} and {business}. You can still edit the message in WhatsApp before sending.' }),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Preview'), preview),
        isOwner ? h('div', null, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save business')) : h('p', { class: 'hint' }, 'Only the owner can change these settings.')));
    bizForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const r = await api('PATCH', '/settings', { name: name.value, phone: phone.value, city: city.value, countryCode: cc.value, timezone: tzSel.value, whatsappTemplate: tpl.value });
        Object.assign(state.user.business, { name: r.business.name, timezone: r.business.timezone, countryCode: r.business.countryCode, whatsappTemplate: r.business.whatsappTemplate });
        bizErr.hidden = true;
        toast('Business saved');
        renderShell();
      } catch (err) { showErrors(bizForm, err, bizErr); }
    });
    colA.appendChild(bizForm);

    // Team
    const teamPanel = h('div', { class: 'panel panel-pad' }, h('h2', { class: 'ph' }, 'Team'),
      h('p', { class: 'pdesc' }, 'Staff can add customers and log follow-ups. Only the owner can change settings, export data or delete records.'),
      team.items.map((u) => h('div', { class: 'team-row' }, avatar(u.name),
        h('div', { class: 'who' }, h('b', null, u.name, u.id === state.user.id ? ' (you)' : ''), h('span', null, `${u.email} · ${u.role === 'owner' ? 'Owner' : 'Staff'}${u.isActive ? '' : ' · Deactivated'}`)),
        isOwner && u.role !== 'owner' ? h('div', { class: 'row' },
          h('button', { class: 'btn btn-sm', onclick: () => staffPasswordSheet(u) }, 'Reset password'),
          h('button', { class: 'btn btn-sm ' + (u.isActive ? 'btn-danger' : ''), onclick: async () => {
            try { await api('PATCH', `/team/${u.id}`, { isActive: !u.isActive }); toast(u.isActive ? `${u.name} deactivated` : `${u.name} reactivated`); refresh(); } catch (err) { toast(err.message, { error: true }); }
          } }, u.isActive ? 'Deactivate' : 'Reactivate')) : null)),
      isOwner ? h('div', { style: null, class: 'row', }, h('button', { class: 'btn btn-sm', onclick: addStaffSheet }, icon('user-plus', 'ico-sm'), 'Add staff member')) : null);
    teamPanel.lastChild && teamPanel.lastChild.classList && teamPanel.lastChild.classList.add('team-add');
    colA.appendChild(teamPanel);

    // Account
    append(colB,
      h('div', { class: 'panel panel-pad' }, h('h2', { class: 'ph' }, 'Your account'), h('p', { class: 'pdesc' }, `${state.user.name}, ${state.user.email}`),
        h('div', { class: 'row-wrap' },
          h('button', { class: 'btn', onclick: changePasswordSheet }, icon('key-round'), 'Change password'),
          h('button', { class: 'btn', onclick: logout }, icon('log-out'), 'Sign out'))),
      isOwner ? h('div', { class: 'panel panel-pad' }, h('h2', { class: 'ph' }, 'Your data'),
        h('p', { class: 'pdesc' }, 'Download every customer and enquiry as a spreadsheet file. Keep a copy as your own backup.'),
        h('a', { class: 'btn', href: '/api/export.csv', download: '' }, icon('download'), 'Export to CSV')) : null,
      isOwner && s.security ? h('div', { class: 'panel panel-pad' }, h('h2', { class: 'ph' }, 'Data protection'),
        h('div', { class: 'sec-line' }, h('span', { class: 'ok' }, icon('shield-check', 'ico-sm')), 'Your customers are visible only to your business.'),
        h('div', { class: 'sec-line' }, s.security.rowLevelSecurity.enforced
          ? [h('span', { class: 'ok' }, icon('shield-check', 'ico-sm')), 'Database row-level security is active.']
          : [h('span', { class: 'warn' }, icon('triangle-alert', 'ico-sm')), 'Database row-level security is not enforced for this database user. App-level isolation still applies. See DEPLOYMENT.md.'])) : null);
  }

  function addStaffSheet() {
    const name = input({ maxlength: 100 });
    const email = input({ type: 'email', autocomplete: 'off', maxlength: 254 });
    const pw = input({ type: 'text', autocomplete: 'new-password', maxlength: 128 });
    openSheet({
      title: 'Add staff member', sub: 'Share the email and password with them. They can change the password after signing in.',
      body: [field('Name', name, { name: 'name' }), field('Email', email, { name: 'email' }), field('Temporary password', pw, { name: 'password', hint: 'At least 8 characters.' })],
      submitLabel: 'Add staff member',
      onSubmit: async () => { await api('POST', '/team', { name: name.value, email: email.value, password: pw.value }); toast('Staff member added'); refresh(); },
    });
  }
  function staffPasswordSheet(u) {
    const pw = input({ type: 'text', autocomplete: 'new-password', maxlength: 128 });
    openSheet({
      title: `Reset password for ${u.name}`, sub: 'They will be signed out on all devices.', body: [field('New password', pw, { name: 'password', hint: 'At least 8 characters.' })],
      submitLabel: 'Reset password',
      onSubmit: async () => { await api('PATCH', `/team/${u.id}`, { password: pw.value }); toast('Password reset'); },
    });
  }
  function changePasswordSheet() {
    const cur = input({ type: 'password', autocomplete: 'current-password', maxlength: 128 });
    const nw = input({ type: 'password', autocomplete: 'new-password', maxlength: 128 });
    openSheet({
      title: 'Change password', sub: 'Other devices will be signed out.',
      body: [field('Current password', cur, { name: 'currentPassword' }), field('New password', nw, { name: 'newPassword', hint: 'At least 8 characters.' })],
      submitLabel: 'Change password',
      onSubmit: async () => { await api('POST', '/auth/change-password', { currentPassword: cur.value, newPassword: nw.value }); toast('Password changed'); },
    });
  }
  async function logout() {
    try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
    state.user = null;
    location.hash = '#/today';
    render();
  }

  // ---------------------------------------------------------------- auth screen
  function authScreen() {
    let mode = location.hash === '#/signup' ? 'signup' : 'login';
    const panel = h('div', { class: 'auth-card' });
    function draw() {
      clear(panel);
      const err = h('div', { class: 'form-error', hidden: true, role: 'alert' });
      const biz = input({ autocomplete: 'organization', placeholder: 'e.g. Sharma Furniture', maxlength: 120 });
      const nm = input({ autocomplete: 'name', maxlength: 100 });
      const em = input({ type: 'email', autocomplete: 'email', maxlength: 254, inputmode: 'email' });
      const pw = input({ type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', maxlength: 128 });
      const btn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, mode === 'signup' ? 'Create account' : 'Sign in');
      const form = h('form', { class: 'stack', novalidate: true }, err,
        mode === 'signup' ? field('Business name', biz, { name: 'businessName' }) : null,
        mode === 'signup' ? field('Your name', nm, { name: 'name' }) : null,
        field('Email', em, { name: 'email' }),
        field('Password', pw, { name: 'password', hint: mode === 'signup' ? 'At least 8 characters.' : null }),
        btn);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          const r = mode === 'signup'
            ? await api('POST', '/auth/signup', { businessName: biz.value, name: nm.value, email: em.value, password: pw.value })
            : await api('POST', '/auth/login', { email: em.value, password: pw.value });
          state.user = r.user;
          if (!location.hash || location.hash === '#/signup' || location.hash === '#/login') location.hash = '#/today';
          render();
        } catch (ex) { showErrors(form, ex, err); } finally { btn.disabled = false; }
      });
      append(panel,
        h('h2', null, mode === 'signup' ? 'Create your account' : 'Welcome back'),
        h('p', { class: 'sub' }, mode === 'signup' ? 'Set up your shop in under a minute. No card needed.' : 'Sign in to see who to call today.'),
        form,
        h('p', { class: 'auth-switch' }, mode === 'signup' ? 'Already have an account? ' : 'New to FollowUp Pro? ',
          h('button', { class: 'link-btn', type: 'button', onclick: () => { mode = mode === 'signup' ? 'login' : 'signup'; history.replaceState(null, '', '#/' + mode); draw(); } }, mode === 'signup' ? 'Sign in' : 'Create an account')));
      setTimeout(() => (mode === 'signup' ? biz : em).focus(), 30);
    }
    draw();
    const sample = (n, sub, tag, cls) => h('div', { class: 's-row' }, h('div', null, h('div', { class: 's-name' }, n), h('div', { class: 's-sub' }, sub)), h('span', { class: `s-tag ${cls}` }, tag));
    return h('div', { class: 'auth' },
      h('div', { class: 'auth-brand' },
        h('div', { class: 'logo' }, h('span', { class: 'logo-mark' }, icon('check')), 'FollowUp Pro'),
        h('div', { class: 'auth-pitch' },
          h('h1', null, 'Every enquiry gets a call back.'),
          h('p', null, 'Note each walk-in, call and WhatsApp enquiry in seconds. Each morning you see exactly who to contact, with one tap to call or WhatsApp them.'),
          h('div', { class: 'auth-sample', 'aria-hidden': 'true' },
            sample('Anil Kumar', 'Recliner sofa, ₹48,000', '2 days late', 'late'),
            sample('Meera Joshi', 'Activa 6G, test ride done', 'Today, 11:30 am', 'today'),
            sample('Rahul Desai', 'Double door fridge', 'Today', 'today'))),
        h('div', { class: 'auth-foot' }, 'Built for showrooms and shops.')),
      h('div', { class: 'auth-panel' }, panel));
  }

  // ---------------------------------------------------------------- shell + router
  const NAV = [
    ['today', 'Today', 'sun'],
    ['customers', 'Customers', 'users'],
    ['follow-ups', 'Follow-ups', 'calendar-check'],
    ['settings', 'Settings', 'settings'],
  ];
  let $page = null;
  let $shell = null;

  function updateBadges() {
    document.querySelectorAll('[data-badge="follow-ups"]').forEach((el) => {
      el.textContent = state.overdueCount ? String(state.overdueCount) : '';
      el.hidden = !state.overdueCount;
    });
  }
  function quickAddSheet() {
    openSheet({
      title: 'What would you like to do?',
      body: [h('div', { class: 'next-opt' },
        h('button', { type: 'button', class: 'opt', onclick: () => addCustomerSheet() }, h('span', { class: 'o-ico' }, icon('user-plus')), h('span', null, h('b', null, 'Add new customer'), h('span', { class: 'o-sub' }, 'Someone visited, called or messaged.'))),
        h('button', { type: 'button', class: 'opt', onclick: () => addFollowUpSheet() }, h('span', { class: 'o-ico' }, icon('calendar-plus')), h('span', null, h('b', null, 'Add follow-up'), h('span', { class: 'o-sub' }, 'Remind yourself to contact an existing customer.'))),
        h('a', { class: 'opt', href: '#/follow-ups?view=today', onclick: closeSheet }, h('span', { class: 'o-ico' }, icon('list-todo')), h('span', null, h('b', null, "View today's follow-ups"), h('span', { class: 'o-sub' }, 'See who to contact today.'))))],
      noFooter: true, onSubmit: async () => {},
    });
    document.querySelectorAll('.opt .o-ico').forEach((x) => { x.style.background = 'var(--peacock-soft)'; x.style.color = 'var(--peacock)'; });
  }

  function renderShell() {
    const current = (location.hash.split('?')[0].split('/')[1]) || 'today';
    const navLink = ([key, label, ic]) => h('a', { href: `#/${key}`, 'aria-current': current === key ? 'page' : null }, icon(ic), h('span', null, label),
      key === 'follow-ups' ? h('span', { class: 'badge', 'data-badge': 'follow-ups', hidden: !state.overdueCount }, state.overdueCount ? String(state.overdueCount) : '') : null);
    $page = h('main', { class: 'page', id: 'page' });
    $shell = h('div', { class: 'shell' },
      h('aside', { class: 'sidebar' },
        h('a', { class: 'logo', href: '#/today' }, h('span', { class: 'logo-mark' }, icon('check')), 'FollowUp Pro'),
        h('button', { class: 'btn btn-primary btn-block side-cta', onclick: addCustomerSheet }, icon('user-plus'), 'Add new customer'),
        h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map(navLink)),
        h('div', { class: 'side-foot' }, avatar(state.user.name), h('div', { class: 'who' }, h('b', null, state.user.name), h('span', null, state.user.business.name)), h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-ghost icon-btn', 'aria-label': 'Sign out', title: 'Sign out', onclick: logout }, icon('log-out')))),
      h('header', { class: 'topbar' }, h('a', { class: 'logo', href: '#/today' }, h('span', { class: 'logo-mark' }, icon('check')), state.user.business.name)),
      h('div', { class: 'main' }, $page),
      h('nav', { class: 'tabbar', 'aria-label': 'Main' },
        navLink(NAV[0]), navLink(NAV[1]),
        h('div', { class: 'fab-wrap' }, h('button', { class: 'fab', 'aria-label': 'Add', onclick: quickAddSheet }, icon('plus'))),
        navLink(NAV[2]), navLink(NAV[3])));
    clear($app).appendChild($shell);
  }

  function route() {
    if (!state.user) return render();
    closeSheet();
    const [pathPart, query] = (location.hash.slice(1) || '/today').split('?');
    const parts = pathPart.split('/').filter(Boolean);
    const params = new URLSearchParams(query || '');
    renderShell();
    window.scrollTo(0, 0);
    const key = parts[0] || 'today';
    const titles = { today: 'Today', customers: 'Customers', 'follow-ups': 'Follow-ups', settings: 'Settings' };
    document.title = `${titles[key] || 'FollowUp Pro'} · FollowUp Pro`;
    if (key === 'customers' && parts[1]) return detailPage($page, parts[1]);
    if (key === 'customers') return customersPage($page, params);
    if (key === 'follow-ups') return followUpsPage($page, params);
    if (key === 'settings') return settingsPage($page);
    if (key !== 'today') { location.hash = '#/today'; return; }
    return todayPage($page);
  }

  function render() {
    closeSheet();
    if (!state.user) {
      document.title = 'FollowUp Pro';
      clear($app).appendChild(authScreen());
      return;
    }
    route();
  }

  window.addEventListener('hashchange', () => { if (state.user) route(); });

  (async function boot() {
    try {
      const r = await api('GET', '/auth/me');
      state.user = r.user;
    } catch { state.user = null; }
    render();
  })();
})();
