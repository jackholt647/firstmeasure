/* FirstMate date/time picker. No dependencies; original inputs own values and validation. */
(function () {
  'use strict';
  if (window.FirstMateDateTimePicker) return;
  const selector = 'input:is([type="date"],[type="time"],[type="datetime-local"]):not([data-native-picker])';
  const pad = n => String(n).padStart(2, '0');
  const dateKey = d => `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const localDate = value => { const [y, m, d] = value.split('-').map(Number); const out = new Date(2000, 0, 1, 12); out.setFullYear(y, m - 1, d); return out; };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const locale = () => window.PlatformLanguage?.formatLocale?.() || document.documentElement.lang || navigator.language;
  const text = value => window.PlatformLanguage?.text?.('date-time-picker', value, value) ?? value;
  let active = null;
  const style = document.createElement('style');
  style.textContent = `${selector}{cursor:pointer} ${selector}::-webkit-calendar-picker-indicator{opacity:.6;pointer-events:none}`;
  document.head.append(style);
  const css = `
    :host{all:initial;position:fixed!important;inset:auto;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;z-index:2147483647!important;color-scheme:light}
    *{box-sizing:border-box} .picker{--accent:#345ae8;--line:#e5e8f0;font:14px/1.4 Inter,system-ui,sans-serif;color:#202638;background:#fff;border:1px solid var(--line);border-radius:20px;box-shadow:0 18px 65px #18244826,0 3px 12px #18244812;width:340px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;padding:20px}
    button,input{font:inherit} button{cursor:pointer;border:0;background:transparent;color:inherit;border-radius:9px;padding:8px 10px} button:hover{background:#f0f3fa} button:disabled{opacity:.3;cursor:default} :focus-visible{outline:3px solid #345ae850;outline-offset:2px}
    .heading,.navigation,.footer,.quick,.time{display:flex;align-items:center;gap:8px}.heading{justify-content:space-between;margin-bottom:14px}.heading strong{font-size:16px;letter-spacing:-.3px}.muted{color:#788196;font-size:12px}.navigation{margin:12px 0;justify-content:space-between}.month{font-weight:650;flex:1}.year{width:76px;border:1px solid var(--line);border-radius:7px;padding:5px;color:inherit;background:transparent}.week,.days{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}.week span{text-align:center;font-size:11px;font-weight:600;color:#788196;padding:5px 0}.days button{padding:0;height:36px;font-size:13px}.days .other{color:#9ca4b4}.days .today{box-shadow:inset 0 0 0 1px #a7b7f8}.days [aria-pressed=true]{background:var(--accent);color:white}.quick{margin-bottom:10px}.quick button{background:#f3f5fa;font-size:12px;padding:7px 11px}.time-section{border-top:1px solid var(--line);margin-top:16px;padding-top:14px}.time-only{border:0;margin:0;padding:0}.time{margin:8px 0}.time label{flex:1;color:#788196;font-size:11px}.time input{display:block;width:100%;margin-top:4px;padding:10px 6px;text-align:center;border:1px solid var(--line);border-radius:10px;font-size:22px;font-variant-numeric:tabular-nums;color:#202638;background:#f8f9fc}.period{align-self:flex-end;border:1px solid var(--line);height:52px;font-weight:600}.slots{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-top:12px}.slots button{font-size:12px;background:#f3f5fa;padding:7px 3px}.footer{border-top:1px solid var(--line);padding-top:14px;margin-top:16px}.footer .spacer{flex:1}.primary{background:var(--accent);color:white;font-weight:600}.primary:hover{background:#2649ce}.error{font-size:12px;color:#b42318;margin-top:10px}.error:empty{display:none}
    @media(prefers-reduced-motion:no-preference){.picker{animation:enter .12s ease-out}@keyframes enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}}
  `;
  function valid(input, value) {
    const probe = input.cloneNode();
    probe.value = value;
    // Use the browser's date/step rules without changing the live form or its custom errors.
    return (!value || probe.value === value) && probe.validity.valid;
  }
  function close(restore = true) {
    if (!active) return;
    const { input, host, observer } = active;
    active = null;
    observer.disconnect();
    host.remove();
    input.setAttribute('aria-expanded', 'false');
    if (restore && input.isConnected) input.focus({ preventScroll: true });
  }
  function position() {
    if (!active) return;
    const { input, host, shadow } = active;
    const box = input.getBoundingClientRect(), size = shadow.querySelector('.picker').getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    host.style.setProperty('left', `${Math.max(left + 12, Math.min(box.left, left + width - size.width - 12))}px`, 'important');
    host.style.setProperty('top', `${Math.max(top + 12, Math.min(box.bottom + 8 + size.height <= top + height ? box.bottom + 8 : box.top - size.height - 8, top + height - size.height - 12))}px`, 'important');
  }
  function open(input) {
    if (!(input instanceof HTMLInputElement) || !input.matches(selector) || input.matches(':disabled') || input.readOnly) return;
    if (active?.input === input) return;
    close(false);
    const now = new Date(), kind = input.type, hasDate = kind !== 'time', hasTime = kind !== 'date';
    const parts = input.value.split('T');
    let chosenDate = hasDate && parts[0] ? parts[0] : dateKey(now);
    let chosenTime = (kind === 'time' ? parts[0] : parts[1]) || `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    let month = localDate(chosenDate); month.setDate(1);
    const seconds = hasTime && (Number(input.step) > 0 && Number(input.step) % 60 !== 0 || chosenTime.split(':').length > 2 || input.step === 'any');
    const fractional = seconds && (input.step === 'any' || (Number(input.step) > 0 && Number(input.step) < 1) || chosenTime.includes('.'));
    const hour12 = new Intl.DateTimeFormat(locale(), { hour:'numeric' }).resolvedOptions().hour12;
    const host = document.createElement('fm-date-time-picker');
    host.setAttribute('popover', 'manual');
    const shadow = host.attachShadow({mode:'open'});
    const name = input.getAttribute('aria-label') || [...(input.labels || [])].map(l => l.textContent.trim()).join(' ') || text(hasDate ? hasTime ? 'Choose date & time' : 'Choose date' : 'Choose time');
    const observer = new MutationObserver(() => {
      if (!input.isConnected || input.matches(':disabled') || input.readOnly || input.type !== kind || input.closest('dialog:not([open])')) close(false);
    });
    active = { input, host, shadow, observer };
    (input.closest('dialog,[role="dialog"]') || document.body).append(host);
    if (host.showPopover) host.showPopover();
    input.setAttribute('aria-expanded','true');
    const candidate = () => kind === 'date' ? chosenDate : kind === 'time' ? chosenTime : `${chosenDate}T${chosenTime}`;
    function commit(value) {
      if (!valid(input, value)) { shadow.querySelector('.error').textContent = text('Choose a value within the allowed range and time interval.'); return; }
      const changed = input.value !== value;
      input.value = value;
      close();
      if (changed) { input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); }
    }
    function render(focusDate) {
      let calendar = '';
      if (hasDate) {
        const start = new Date(month); start.setDate(1 - month.getDay());
        const days = Array.from({length:42}, (_,i) => {
          const day = new Date(start); day.setDate(start.getDate()+i); const key = dateKey(day);
          const min = input.min.slice(0,10), max = input.max.slice(0,10);
          const disabled = day.getFullYear() < 1 || (min && key < min) || (max && key > max) || kind === 'date' && !valid(input,key);
          return `<button type="button" data-date="${key}" tabindex="${key === (focusDate || chosenDate) ? 0 : -1}" aria-label="${esc(new Intl.DateTimeFormat(locale(),{dateStyle:'full'}).format(day))}" aria-pressed="${key === chosenDate}" class="${day.getMonth() !== month.getMonth() ? 'other' : ''} ${key === dateKey(now) ? 'today' : ''}" ${disabled?'disabled':''}>${day.getDate()}</button>`;
        }).join('');
        const weekdays = Array.from({length:7},(_,i)=>`<span>${esc(new Intl.DateTimeFormat(locale(),{weekday:'narrow'}).format(new Date(2026,8,6+i)))}</span>`).join('');
        calendar = `<div class="quick"><button type="button" data-offset="0">${text('Today')}</button><button type="button" data-offset="1">${text('Tomorrow')}</button><button type="button" data-offset="7">${text('Next week')}</button></div><div class="navigation"><button type="button" data-month="-1" aria-label="${text('Previous month')}">‹</button><span class="month" aria-live="polite">${esc(new Intl.DateTimeFormat(locale(),{month:'long'}).format(month))}</span><input class="year" aria-label="${text('Year')}" type="number" min="1" max="9999" value="${month.getFullYear()}"><button type="button" data-month="1" aria-label="${text('Next month')}">›</button></div><div class="week" aria-hidden="true">${weekdays}</div><div class="days" role="group" aria-label="${text('Calendar')}">${days}</div>`;
      }
      const [h,m,s='00'] = chosenTime.split(':');
      const times = hasTime ? `<section class="time-section ${hasDate?'':'time-only'}"><span class="muted">${text('Time')}</span><div class="time"><label>${text('Hour')}<input data-time="hour" type="number" min="${hour12?1:0}" max="${hour12?12:23}" value="${hour12?Number(h)%12||12:Number(h)}"></label><span>:</span><label>${text('Minute')}<input data-time="minute" type="number" min="0" max="59" value="${m}"></label>${seconds?`<span>:</span><label>${text('Second')}<input data-time="second" type="number" min="0" max="59.999" step="${fractional?'0.001':'1'}" value="${s}"></label>`:''}${hour12?`<button type="button" class="period" data-period aria-label="${text('Toggle AM/PM')}">${Number(h)>=12?'PM':'AM'}</button>`:''}</div><div class="slots">${[9,12,15,18].map(h=>`<button type="button" data-slot="${pad(h)}:00">${esc(new Intl.DateTimeFormat(locale(),{hour:'numeric',minute:'2-digit'}).format(new Date(2000,0,1,h)))}</button>`).join('')}</div></section>` : '';
      shadow.innerHTML = `<style>${css}</style><div class="picker" role="dialog" aria-label="${esc(name)}"><div class="heading"><strong>${text(hasDate?hasTime?'Date & time':'Choose date':'Choose time')}</strong><button type="button" data-close aria-label="${text('Close picker')}">×</button></div>${calendar}${times}<div class="error" role="alert"></div><div class="footer"><button type="button" data-clear ${input.required?'disabled':''}>${text('Clear')}</button><span class="spacer"></span><button type="button" data-close>${text('Cancel')}</button><button type="button" class="primary" data-apply>${text('Apply')}</button></div></div>`;
      // Ensure a keyboard entry point even when the selected date is out of range.
      const days = shadow.querySelector('.days');
      if (days && !days.querySelector('button[tabindex="0"]:not(:disabled)')) days.querySelector('button:not(:disabled)')?.setAttribute('tabindex','0');
      position();
      if (focusDate) (shadow.querySelector(`[data-date="${focusDate}"]:not(:disabled)`) || days?.querySelector('button[tabindex="0"]:not(:disabled)') || shadow.querySelector('[data-month="-1"]'))?.focus();
    }
    function readTime() {
      if (!hasTime) return true;
      const fields = [...shadow.querySelectorAll('[data-time]')];
      if (fields.some(f => !f.value || !f.validity.valid)) { shadow.querySelector('.error').textContent = text('Enter a valid time.'); return false; }
      let h = Number(fields[0].value);
      if (hour12) h = h % 12 + (shadow.querySelector('[data-period]').textContent === 'PM' ? 12 : 0);
      chosenTime = `${pad(h)}:${pad(Number(fields[1].value))}${seconds?`:${Number(fields[2].value).toFixed(fractional ? 3 : 0).padStart(fractional ? 6 : 2, '0')}`:''}`;
      return true;
    }
    shadow.addEventListener('click', event => {
      const b = event.target.closest('button'); if (!b || b.disabled) return;
      if (b.hasAttribute('data-close')) { close(); return; }
      if (b.hasAttribute('data-clear')) { commit(''); return; }
      if (!readTime()) return;
      if (b.hasAttribute('data-apply')) { commit(candidate()); return; }
      if (b.dataset.date) { chosenDate = b.dataset.date; month = localDate(chosenDate); month.setDate(1); render(chosenDate); return; }
      if (b.dataset.month) { month.setMonth(month.getMonth()+Number(b.dataset.month)); render(); shadow.querySelector(`[data-month="${b.dataset.month}"]`).focus(); return; }
      if (b.dataset.offset) { const d = new Date(now); d.setDate(d.getDate()+Number(b.dataset.offset)); chosenDate = dateKey(d); month = localDate(chosenDate); month.setDate(1); render(chosenDate); return; }
      if (b.dataset.slot) chosenTime = b.dataset.slot + (seconds?':00':'');
      if (b.hasAttribute('data-period')) { const [h,...rest] = chosenTime.split(':'); chosenTime = [pad((Number(h)+12)%24),...rest].join(':'); }
      render();
      shadow.querySelector(b.hasAttribute('data-period')?'[data-period]':`[data-slot="${b.dataset.slot}"]`)?.focus();
    });
    shadow.addEventListener('change', event => {
      if (event.target.matches('.year') && event.target.validity.valid && event.target.value && readTime()) { month.setFullYear(Number(event.target.value)); render(); shadow.querySelector('.year').focus(); }
    });
    shadow.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') {
        const list = [...shadow.querySelectorAll('button:not(:disabled):not([tabindex="-1"]),input:not(:disabled)')];
        const index = list.indexOf(shadow.activeElement);
        if (event.shiftKey && index === 0 || !event.shiftKey && index === list.length-1) { event.preventDefault(); (event.shiftKey?list.at(-1):list[0]).focus(); }
      }
      if (event.target.dataset.date && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) {
        event.preventDefault();
        const d = localDate(event.target.dataset.date);
        if (event.key.startsWith('Page')) { const oldDay=d.getDate(); d.setDate(1); d.setMonth(d.getMonth()+(event.key==='PageUp'?-1:1)); d.setDate(Math.min(oldDay,new Date(d.getFullYear(),d.getMonth()+1,0).getDate())); }
        else d.setDate(d.getDate()+({ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7,Home:-d.getDay(),End:6-d.getDay()}[event.key]));
        if (readTime()) { month = new Date(d); month.setDate(1); render(dateKey(d)); }
      } else if (event.key === 'Enter' && event.target.matches('[data-time]')) { event.preventDefault(); if (readTime()) commit(candidate()); }
    });
    render();
    (shadow.querySelector('[data-date][tabindex="0"]:not(:disabled)') || shadow.querySelector('[data-time]') || shadow.querySelector('button')).focus();
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','readonly','type','open']});
  }
  // Observe only insertions and type changes; no per-field handlers or polling.
  function enhance(node) {
    if (!(node instanceof Element)) return;
    const fields = [...node.querySelectorAll(selector)];
    if (node.matches(selector)) fields.push(node);
    for (const field of fields) {
      field.setAttribute('aria-haspopup', 'dialog');
      if (active?.input !== field) field.setAttribute('aria-expanded', 'false');
    }
  }
  enhance(document.documentElement);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') enhance(record.target);
      else record.addedNodes.forEach(enhance);
    }
  }).observe(document.documentElement, {childList:true,subtree:true,attributes:true,attributeFilter:['type']});
  document.addEventListener('click', event => {
    const input = event.target.closest?.(selector);
    if (input && !input.matches(':disabled') && !input.readOnly) { event.preventDefault(); open(input); }
    else if (active && !event.composedPath().includes(active.host)) close(false);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.target.matches?.(selector) && (event.key === ' ' || event.key === 'F4' || event.key === 'ArrowDown' && event.altKey)) { event.preventDefault(); open(event.target); }
  }, true);
  document.addEventListener('focusin', event => { if (active && event.target !== active.input && !event.composedPath().includes(active.host)) close(false); });
  document.addEventListener('reset', () => close(false), true);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  window.visualViewport?.addEventListener('resize', position);
  window.FirstMateDateTimePicker = Object.freeze({open,close,version:1});
})();
