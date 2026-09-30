/* FirstMate date/time picker. No dependencies; original inputs own values and validation. */
(function () {
  'use strict';
  if (window.FirstMateDateTimePicker?.version >= 2) return;
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
    *{box-sizing:border-box}.picker{--accent:var(--primary,#d93025);--on-accent:var(--on-primary,#fff);--ink:var(--primary-readable,var(--accent));--tint:color-mix(in srgb,var(--accent) 8%,white);--line:#e5e8f0;font:13px/1.4 var(--fm-picker-font,system-ui,sans-serif);color:#202638;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 65px #18244826,0 3px 12px #18244812;width:280px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;padding:12px}.picker.combined{width:540px}.picker.time-only{width:232px}.combined .days button{height:32px}
    button,input,select{font:inherit}button{cursor:pointer;border:0;background:transparent;color:inherit;border-radius:9px;padding:8px 10px}button:hover{background:var(--tint)}button:disabled{opacity:.3;cursor:default}:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 40%,transparent);outline-offset:2px}
    .heading,.navigation,.footer,.quick,.time{display:flex;align-items:center;gap:8px}.heading{justify-content:space-between;margin-bottom:8px}.heading strong{font-size:14px;letter-spacing:-.3px}.muted{color:#788196;font-size:12px}.layout{display:grid;grid-template-columns:minmax(0,1fr)}.combined .layout{grid-template-columns:minmax(0,1fr) 150px;gap:12px}.calendar{min-width:0}.navigation{margin:12px 0;justify-content:space-between}.month{font-weight:650;flex:1}.year{width:68px;border:1px solid var(--line);border-radius:7px;padding:5px;color:inherit;background:transparent}.week,.days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px}.week span{text-align:center;font-size:11px;font-weight:600;color:#788196;padding:5px 0}.days button{padding:0;height:36px;font-size:13px}.days .other{color:#9ca4b4}.days .today{box-shadow:inset 0 0 0 1px var(--accent)}.days [aria-pressed=true]{background:var(--accent);color:var(--on-accent)}.quick{margin-bottom:10px;gap:5px}.quick button{background:#f3f5fa;font-size:12px;padding:7px 9px;white-space:nowrap}
    .time-section{min-width:0}.combined .time-section{border-left:1px solid var(--line);padding-left:10px}.time-title{display:block;font-weight:650;margin-bottom:4px}.time-date{display:block;color:#788196;font-size:12px;min-height:16px;margin-bottom:6px}.slots{display:flex;flex-direction:column;gap:4px;height:194px;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;scrollbar-width:none;scrollbar-color:color-mix(in srgb,var(--accent) 35%,#ddd) transparent;padding:3px 5px 3px 3px;scroll-padding:4px}.slots button{flex:none;height:34px;min-height:34px;padding:4px 6px;border:1px solid color-mix(in srgb,var(--accent) 30%,var(--line));font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}.slots button:hover{border-color:var(--accent);background:var(--tint)}.slots button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}.slots button:disabled{border-color:var(--line);background:transparent;color:#788196}
    .time{height:34px;margin:6px 5px 0 3px;padding:2px 4px;gap:3px;border:1px solid color-mix(in srgb,var(--accent) 30%,var(--line));border-radius:9px;justify-content:center;color:var(--ink)}.time label{flex:1;min-width:0;max-width:52px}.time input{display:block;width:100%;min-width:0;padding:2px 0;text-align:center;border:0;border-radius:4px;font:inherit;font-weight:600;font-variant-numeric:tabular-nums;color:inherit;background:transparent;appearance:textfield}.time input::-webkit-inner-spin-button,.time input::-webkit-outer-spin-button{appearance:none;margin:0}.period{flex:none;padding:2px;width:32px;height:26px;font-size:12px;font-weight:600}.heading [data-close]{display:grid;place-items:center;width:32px;height:32px;padding:0;font-size:26px;line-height:1}.time-date:empty{display:none}
    .footer{border-top:1px solid var(--line);padding-top:8px;margin-top:10px}.footer .spacer{flex:1}.primary{background:var(--accent);color:var(--on-accent);font-weight:600}.primary:hover{background:var(--accent);filter:brightness(.93)}.error{font-size:12px;color:#b42318;margin-top:10px}.error:empty{display:none}
    .time input{padding-inline:0;text-align:center;appearance:textfield;-moz-appearance:textfield}.time input::-webkit-inner-spin-button,.time input::-webkit-outer-spin-button{-webkit-appearance:none;appearance:none;display:none;margin:0}
    @media(max-width:520px){.picker{padding:12px}.combined .layout{grid-template-columns:minmax(0,1fr) 128px;gap:10px}.combined .time-section{padding-left:9px}.quick{flex-wrap:wrap;gap:3px}.quick button{font-size:10px;padding:6px}.navigation{gap:2px}.navigation button{padding:6px}.month{font-size:12px}.year{width:53px;font-size:12px;padding:4px}.days{gap:1px}.days button{font-size:11px;height:32px}.slots{height:194px;padding-right:5px}.slots button{font-size:12px;padding:8px 2px}.time-date{font-size:10px}}
  `;
  function valid(input, value) {
    const probe = input.cloneNode();
    probe.value = value;
    // Use the browser's date/step rules without changing the live form or its custom errors.
    const future = !input.hasAttribute('data-future-only') || input.type !== 'datetime-local' || new Date(value).getTime() > Date.now();
    return (!value || probe.value === value) && probe.validity.valid && future;
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
    if (!active || active.inline) return;
    const { input, host, shadow } = active;
    const box = input.getBoundingClientRect(), size = shadow.querySelector('.picker').getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const gap=8,edge=12,minX=left+edge,maxX=left+width-size.width-edge,minY=top+edge,maxY=top+height-size.height-edge;
    const clamp=(n,min,max)=>Math.max(min,Math.min(n,Math.max(min,max)));
    // Inside a dialog/editor, sit beside that surface first so the picker never
    // covers its other fields or its Save button; otherwise beside the input.
    const surface=input.closest('[role="dialog"],dialog');
    const around=surface&&surface.getBoundingClientRect().width<width*.7?surface.getBoundingClientRect():null;
    const beside=around?[{x:around.right+gap,y:clamp(box.top,minY,maxY)},{x:around.left-size.width-gap,y:clamp(box.top,minY,maxY)}]:[];
    const candidates=[...beside,{x:box.right+gap,y:box.top},{x:box.left-size.width-gap,y:box.top},{x:box.left,y:box.bottom+gap},{x:box.left,y:box.top-size.height-gap}];
    const fitting=candidates.find(p=>p.x>=minX&&p.x<=maxX&&p.y>=minY&&p.y<=maxY);
    const overlap=p=>Math.max(0,Math.min(p.x+size.width,box.right)-Math.max(p.x,box.left))*Math.max(0,Math.min(p.y+size.height,box.bottom)-Math.max(p.y,box.top));
    const placed=fitting||candidates.map(p=>({x:clamp(p.x,minX,maxX),y:clamp(p.y,minY,maxY)})).sort((a,b)=>overlap(a)-overlap(b))[0];
    host.style.setProperty('left', `${placed.x}px`, 'important');
    host.style.setProperty('top', `${placed.y}px`, 'important');
  }
  function open(input, options = {}) {
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
    if (!options.mount) host.setAttribute('popover', 'manual');
    // The shadow root isolates styles, so carry the app's global font into it.
    host.style.setProperty('--fm-picker-font', getComputedStyle(input.closest('label') || input.parentElement || document.body).fontFamily);
    const theme = getComputedStyle(input);
    for (const [token, fallback] of [['--primary','--cp-primary'],['--on-primary','--cp-on-primary'],['--primary-readable','--primary']]) {
      const value = theme.getPropertyValue(token).trim() || theme.getPropertyValue(fallback).trim();
      if (value) host.style.setProperty(token,value);
    }
    const shadow = host.attachShadow({mode:'open'});
    const name = input.getAttribute('aria-label') || [...(input.labels || [])].map(l => l.textContent.trim()).join(' ') || text(hasDate ? hasTime ? 'Choose date & time' : 'Choose date' : 'Choose time');
    const observer = new MutationObserver(() => {
      if (!input.isConnected || input.matches(':disabled') || input.readOnly || input.type !== kind || input.closest('dialog:not([open])')) close(false);
    });
    active = { input, host, shadow, observer, inline:!!options.mount };
    // Keep the popup inside the input's own surface (it still renders in the top layer) so host
    // "click outside" handlers treat picker clicks as inside. Never inside a <label>, whose
    // activation would re-click the input.
    const anchor = input.closest('label') || input;
    (options.mount || input.closest('dialog,[role="dialog"]') || anchor.parentElement || document.body).append(host);
    if (!options.mount && host.showPopover) host.showPopover();
    input.setAttribute('aria-expanded','true');
    const candidate = () => kind === 'date' ? chosenDate : kind === 'time' ? chosenTime : `${chosenDate}T${chosenTime}`;
    let lastDayClick = { key:'', at:0 };
    function validateCandidate(value) {
      const allowed = valid(input, value);
      const past = input.hasAttribute('data-future-only') && kind === 'datetime-local' && new Date(value).getTime() <= Date.now();
      shadow.querySelector('.error').textContent = allowed ? '' : text(past ? 'Choose a future date and time.' : 'Choose a value within the allowed range and time interval.');
      for (const field of shadow.querySelectorAll('[data-time]')) field.setAttribute('aria-invalid', String(!allowed));
      return allowed;
    }
    function commit(value, refresh = true) {
      if (!validateCandidate(value)) return false;
      const changed = input.value !== value;
      input.value = value;
      if (!options.mount) close();
      else if (refresh) render();
      if (changed) { input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); }
      return true;
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
      const probe = input.cloneNode();
      const valueFor = time => kind === 'time' ? time : `${chosenDate}T${time}`;
      const timeString = ms => {
        const hours = Math.floor(ms/3600000), minutes = Math.floor(ms/60000)%60, secs = (ms%60000)/1000;
        return `${pad(hours)}:${pad(minutes)}${seconds || secs ? ':'+secs.toFixed(fractional?3:0).padStart(fractional?6:2,'0') : ''}`;
      };
      let slotMarkup = '';
      if (hasTime) {
        const step = input.step === 'any' ? 60 : Number(input.step) || 60;
        const interval = (step === 60 ? 900 : step < 60 ? Math.ceil(900/step)*step : step)*1000;
        probe.value = input.min || input.defaultValue;
        const base = Number.isFinite(probe.valueAsNumber) ? probe.valueAsNumber : 0;
        probe.value = kind === 'time' ? '00:00' : `${chosenDate}T00:00`;
        const dayStart = probe.valueAsNumber;
        // Normal minute inputs suggest quarter-hours regardless of a min such
        // as 08:07. Non-default step constraints retain their declared offset.
        const first = step === 60 ? 0 : ((base-dayStart)%interval+interval)%interval;
        const slotTimes = new Set();
        for (let ms=first;ms<86400000;ms+=interval) slotTimes.add(timeString(Math.round(ms)));
        if (step !== 60 && valid(input,valueFor(chosenTime))) slotTimes.add(chosenTime);
        slotMarkup = [...slotTimes].sort().filter(time => !(options.mount && step === 60 && kind === 'datetime-local' && input.min) || valid(input,valueFor(time))).map(time => {
          const [hour,minute,second=0]=time.split(':').map(Number);
          const label = new Intl.DateTimeFormat(locale(),{hour:'numeric',minute:'2-digit',...(seconds?{second:'2-digit'}:{})}).format(new Date(2000,0,1,hour,minute,second));
          return `<button type="button" data-slot="${time}" tabindex="-1" aria-pressed="${time===chosenTime}" ${valid(input,valueFor(time))?'':'disabled'}>${esc(label)}</button>`;
        }).join('');
      }
      const custom = hasTime ? `<div class="time" role="group" aria-label="${text('Custom time')}"><label><input aria-label="${text('Hour')}" data-time="hour" type="number" inputmode="numeric" min="${hour12?1:0}" max="${hour12?12:23}" value="${pad(hour12?Number(h)%12||12:Number(h))}"></label><span>:</span><label><input aria-label="${text('Minute')}" data-time="minute" type="number" inputmode="numeric" min="0" max="59" value="${m}"></label>${seconds?`<span>:</span><label><input aria-label="${text('Second')}" data-time="second" type="number" inputmode="decimal" min="0" max="59.999" step="${fractional?'0.001':'1'}" value="${s}"></label>`:''}${hour12?`<button type="button" class="period" data-period aria-label="${text('Toggle AM/PM')}">${Number(h)>=12?'PM':'AM'}</button>`:''}</div>` : '';
      const times = hasTime ? `<section class="time-section"><span class="time-title">${text('Select a time')}</span>${hasDate?`<span class="time-date">${esc(new Intl.DateTimeFormat(locale(),{month:'short',day:'numeric'}).format(localDate(chosenDate)))}</span>`:''}<div class="slots" role="group" aria-label="${text('Available times')}">${slotMarkup}</div>${custom}</section>` : '';
      shadow.innerHTML = `<style>${css}</style><div class="picker ${hasDate&&hasTime?'combined':hasTime?'time-only':''}" role="dialog" aria-label="${esc(name)}"><div class="heading"><strong>${text(hasDate?hasTime?'Select date & time':'Choose date':'Choose time')}</strong><button type="button" data-close aria-label="${text('Close picker')}">×</button></div><div class="layout">${hasDate?`<section class="calendar">${calendar}</section>`:''}${times}</div><div class="error" role="alert"></div><div class="footer"><button type="button" data-clear ${input.required?'disabled':''}>${text('Clear')}</button><span class="spacer"></span><button type="button" data-close>${text('Cancel')}</button><button type="button" class="primary" data-apply>${text('Apply')}</button></div></div>`;
      if (options.mount) {
        shadow.querySelector('style').textContent += ':host{position:static!important;display:block;z-index:auto!important}.picker{width:100%!important;max-width:none;max-height:none;box-shadow:none;border:0;padding:0}.heading,.footer{display:none}';
        shadow.querySelector('.picker').setAttribute('role','group');
      }
      const slots = shadow.querySelector('.slots');
      const selected = slots?.querySelector('[aria-pressed="true"]:not(:disabled)') || slots?.querySelector('button:not(:disabled)');
      if (selected) {
        selected.tabIndex=0;
        const reveal=()=>{if(selected.isConnected)slots.scrollTop=selected.offsetTop-slots.offsetTop-slots.clientHeight/3;};
        reveal();requestAnimationFrame(reveal);
      }
      // Ensure a keyboard entry point even when the selected date is out of range.
      const days = shadow.querySelector('.days');
      if (days && !days.querySelector('button[tabindex="0"]:not(:disabled)')) days.querySelector('button:not(:disabled)')?.setAttribute('tabindex','0');
      position();
      if (focusDate) (shadow.querySelector(`[data-date="${focusDate}"]:not(:disabled)`) || days?.querySelector('button[tabindex="0"]:not(:disabled)') || shadow.querySelector('[data-month="-1"]'))?.focus();
    }
    function readTime() {
      if (!hasTime) return true;
      const fields = [...shadow.querySelectorAll('[data-time]')];
      if (fields.some(f => !f.value || !f.validity.valid)) { shadow.querySelector('.error').textContent = text('Enter a valid time.'); for (const field of fields) field.setAttribute('aria-invalid', String(!field.value || !field.validity.valid)); return false; }
      let h = Number(fields[0].value);
      if (hour12) h = h % 12 + (shadow.querySelector('[data-period]').textContent === 'PM' ? 12 : 0);
      chosenTime = `${pad(h)}:${pad(Number(fields[1].value))}${seconds?`:${Number(fields[2].value).toFixed(fractional ? 3 : 0).padStart(fractional ? 6 : 2, '0')}`:''}`;
      return true;
    }
    shadow.addEventListener('click', event => {
      const b = event.target.closest('button'); if (!b || b.disabled) return;
      if (b.hasAttribute('data-close')) { close(); return; }
      if (b.hasAttribute('data-clear')) { commit(''); return; }
      if (b.dataset.slot) { chosenTime=b.dataset.slot; commit(candidate()); return; }
      if (!readTime()) return;
      if (b.hasAttribute('data-apply')) { commit(candidate()); return; }
      if (b.dataset.date) {
        const key = b.dataset.date, clickedAt = Date.now();
        // Date-only popup: a second click on the same day (a double-click)
        // applies it, like Enter.
        if (kind === 'date' && !options.mount && lastDayClick.key === key && clickedAt - lastDayClick.at < 450) { lastDayClick = { key:'', at:0 }; chosenDate = key; commit(candidate()); return; }
        lastDayClick = { key, at:clickedAt };
        const sameMonth = localDate(key).getMonth() === month.getMonth() && localDate(key).getFullYear() === month.getFullYear();
        chosenDate = key; month = localDate(chosenDate); month.setDate(1);
        // Picking a day in the shown month only moves the selection: the day
        // buttons stay in place, so a double-click reaches the same button.
        if (kind === 'date' && sameMonth) {
          for (const day of shadow.querySelectorAll('[data-date]')) { day.setAttribute('aria-pressed', String(day.dataset.date === key)); day.tabIndex = day.dataset.date === key ? 0 : -1; }
          b.focus();
        } else render(chosenDate);
        if(options.mount) commit(candidate(), false);
        return;
      }
      if (b.dataset.month) { month.setMonth(month.getMonth()+Number(b.dataset.month)); render(); shadow.querySelector(`[data-month="${b.dataset.month}"]`).focus(); return; }
      if (b.dataset.offset) { const d = new Date(now); d.setDate(d.getDate()+Number(b.dataset.offset)); chosenDate = dateKey(d); month = localDate(chosenDate); month.setDate(1); render(chosenDate); return; }
      if (b.hasAttribute('data-period')) { const [h,...rest] = chosenTime.split(':'); chosenTime = [pad((Number(h)+12)%24),...rest].join(':'); }
      render();
      if (b.hasAttribute('data-period') && options.mount) commit(candidate(), false);
      shadow.querySelector(b.hasAttribute('data-period')?'[data-period]':`[data-slot="${b.dataset.slot}"]`)?.focus();
    });
    shadow.addEventListener('change', event => {
      // Preserve the custom fields while tabbing between them; rebuilding on
      // blur detaches the next field before the user can finish their time.
      if(options.mount && event.target.matches('[data-time]') && readTime()) commit(candidate(), false);
      if (event.target.matches('.year') && event.target.validity.valid && event.target.value && readTime()) { month.setFullYear(Number(event.target.value)); render(); shadow.querySelector('.year').focus(); }
    });
    shadow.addEventListener('focusin', event => {
      if (event.target.matches('[data-time]')) event.target.select();
    });
    shadow.addEventListener('keydown', event => {
      if (event.key === 'Escape') { if(options.mount)return; event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab' && !options.mount) {
        const list = [...shadow.querySelectorAll('button:not(:disabled):not([tabindex="-1"]),input:not(:disabled),summary')].filter(el=>el.getClientRects().length);
        const index = list.indexOf(shadow.activeElement);
        if (event.shiftKey && index === 0 || !event.shiftKey && index === list.length-1) { event.preventDefault(); (event.shiftKey?list.at(-1):list[0]).focus(); }
      }
      if (event.target.dataset.slot && ['ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
        event.preventDefault();
        const slots=[...shadow.querySelectorAll('[data-slot]:not(:disabled)')];
        const i=slots.indexOf(event.target);
        const next=event.key==='Home'?0:event.key==='End'?slots.length-1:Math.max(0,Math.min(slots.length-1,i+(event.key==='ArrowUp'?-1:1)));
        slots.forEach(el=>el.tabIndex=-1); slots[next].tabIndex=0; slots[next].focus();
        return;
      }
      if (event.target.dataset.date && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) {
        event.preventDefault();
        const d = localDate(event.target.dataset.date);
        if (event.key.startsWith('Page')) { const oldDay=d.getDate(); d.setDate(1); d.setMonth(d.getMonth()+(event.key==='PageUp'?-1:1)); d.setDate(Math.min(oldDay,new Date(d.getFullYear(),d.getMonth()+1,0).getDate())); }
        else d.setDate(d.getDate()+({ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7,Home:-d.getDay(),End:6-d.getDay()}[event.key]));
        if (readTime()) { month = new Date(d); month.setDate(1); render(dateKey(d)); }
      } else if (event.key === 'Enter' && event.target.matches('[data-time]')) { event.preventDefault(); if (readTime()) commit(candidate()); }
      // A date-only popup: Enter on a day picks it and applies (Apply still works).
      else if (event.key === 'Enter' && kind === 'date' && event.target.dataset?.date && !event.target.disabled) { event.preventDefault(); chosenDate = event.target.dataset.date; commit(candidate()); }
    });
    // Double-clicking a day in a date-only popup applies it too.
    shadow.addEventListener('dblclick', event => {
      const b = event.target.closest?.('[data-date]');
      if (!b || b.disabled || kind !== 'date' || options.mount) return;
      chosenDate = b.dataset.date; commit(candidate());
    });
    render();
    (shadow.querySelector('[data-date][tabindex="0"]:not(:disabled)') || shadow.querySelector('[data-slot][tabindex="0"]') || shadow.querySelector('button')).focus();
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','readonly','type','open']});
    return { readValue: () => readTime() && validateCandidate(candidate()) ? candidate() : '', destroy: () => { if(active?.host===host)close(false); } };
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
    else if (active && !active.inline && !event.composedPath().includes(active.host)) close(false);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.target.matches?.(selector) && (event.key === ' ' || event.key === 'F4' || event.key === 'ArrowDown' && event.altKey)) { event.preventDefault(); open(event.target); }
  }, true);
  document.addEventListener('focusin', event => { if (active && !active.inline && event.target !== active.input && !event.composedPath().includes(active.host)) close(false); });
  // An open popup is the topmost layer: claim Escape before any document-level
  // modal/window handler (which would otherwise close the dialog underneath).
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !active || active.inline) return;
    event.preventDefault(); event.stopImmediatePropagation(); close();
  }, true);
  document.addEventListener('reset', () => close(false), true);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  window.visualViewport?.addEventListener('resize', position);
  window.FirstMateDateTimePicker = Object.freeze({open,close,mount:(container,input)=>open(input,{mount:container}),version:2});
})();
