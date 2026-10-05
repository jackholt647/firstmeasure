/* Shared availability calendar. Transport and booking belong to the host. */
(function(){
  const cleanText = value => String(value ?? '').trim();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  function localDateInput(date = new Date()){
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function dateFromInput(value){
    const [year, month, day] = cleanText(value).split('-').map(Number);
    const date = new Date(year || new Date().getFullYear(), (month || 1) - 1, day || 1);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }
  function addDays(date, days){
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }
  function calendarDays(selectedDate){
    const selected = dateFromInput(selectedDate);
    const first = new Date(selected.getFullYear(), selected.getMonth(), 1);
    const start = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, index) => addDays(start, index));
  }
  function dayButton(date, selectedDate, mobile = false){
    const value = localDateInput(date);
    const selected = value === selectedDate;
    if (mobile) {
      return `<button type="button" class="fmle-day-pill ${selected ? 'active' : ''}" aria-label="${esc(date.toLocaleDateString([], {weekday:'long',year:'numeric',month:'long',day:'numeric'}))}" aria-pressed="${selected}" data-date="${esc(value)}"><span>${esc(date.toLocaleDateString([], { weekday:'short' }))}</span><b>${date.getDate()}</b></button>`;
    }
    const muted = date.getMonth() !== dateFromInput(selectedDate).getMonth();
    return `<button type="button" class="fmle-cal-day ${selected ? 'active' : ''} ${muted ? 'muted' : ''}" aria-label="${esc(date.toLocaleDateString([], {weekday:'long',year:'numeric',month:'long',day:'numeric'}))}" aria-pressed="${selected}" data-date="${esc(value)}">${date.getDate()}</button>`;
  }

  function markup({submitLabel = ''} = {}) {
    return `<style>
.fm-availability{--fmle-primary:#d93025;--fmle-text:#111827;container-type:inline-size;font-family:inherit;color:var(--fmle-text)}
:is(.fm-availability,#fm-availability-picker) *{box-sizing:border-box}
:is(.fm-availability,#fm-availability-picker) button{font:inherit;cursor:pointer}
        :is(.fm-availability,#fm-availability-picker) .fmle-booking{display:grid;grid-template-columns:minmax(300px,1.35fr) minmax(170px,.65fr);gap:18px;align-items:stretch}
        :is(.fm-availability,#fm-availability-picker) .fmle-calendar,:is(.fm-availability,#fm-availability-picker) .fmle-time-panel{border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;padding:16px}
        :is(.fm-availability,#fm-availability-picker) .fmle-cal-head{display:flex;align-items:center;justify-content:space-between;font-size:14px;font-weight:900;margin-bottom:14px}
        :is(.fm-availability,#fm-availability-picker) .fmle-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
        :is(.fm-availability,#fm-availability-picker) .fmle-cal-dow{text-align:center;font-size:10px;font-weight:900;color:color-mix(in srgb,var(--fmle-text) 54%,#fff);padding:4px 0}
        :is(.fm-availability,#fm-availability-picker) .fmle-cal-day{border:1px solid transparent;background:#fff;color:#111827;border-radius:8px;padding:9px 0;font-size:13px;font-weight:900;box-shadow:none}
        :is(.fm-availability,#fm-availability-picker) .fmle-cal-day.muted{color:#a1a1aa}
        :is(.fm-availability,#fm-availability-picker) .fmle-cal-day.active{background:var(--fmle-primary);border-color:var(--fmle-primary);color:#fff}
        :is(.fm-availability,#fm-availability-picker) .fmle-mobile-days{display:none;gap:8px;overflow-x:auto;padding:2px calc(50% - 35px) 8px;scroll-snap-type:x proximity;scroll-behavior:smooth;mask-image:linear-gradient(to right,transparent,#000 14%,#000 86%,transparent);-webkit-mask-image:linear-gradient(to right,transparent,#000 14%,#000 86%,transparent)}
        :is(.fm-availability,#fm-availability-picker) .fmle-day-pill{min-width:70px;border:1px solid rgba(15,23,42,.14);background:#fff;color:#111827;border-radius:10px;padding:9px 10px;display:grid;gap:3px;scroll-snap-align:start;box-shadow:none}
        :is(.fm-availability,#fm-availability-picker) .fmle-day-pill span{font-size:11px;font-weight:900;color:color-mix(in srgb,var(--fmle-text) 58%,#fff)}
        :is(.fm-availability,#fm-availability-picker) .fmle-day-pill b{font-size:18px;line-height:1}
        :is(.fm-availability,#fm-availability-picker) .fmle-day-pill.active{background:var(--fmle-primary);border-color:var(--fmle-primary);color:#fff}
        :is(.fm-availability,#fm-availability-picker) .fmle-day-pill.active span{color:#fff}
        :is(.fm-availability,#fm-availability-picker) .fmle-time-title{font-size:13px;font-weight:900;margin-bottom:13px;text-align:center}
        :is(.fm-availability,#fm-availability-picker) .fmle-slots{height:225px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:88px 6px;scroll-snap-type:y proximity;scroll-behavior:smooth;mask-image:linear-gradient(to bottom,transparent,#000 18%,#000 82%,transparent);-webkit-mask-image:linear-gradient(to bottom,transparent,#000 18%,#000 82%,transparent)}
        :is(.fm-availability,#fm-availability-picker) .fmle-slot{border:1px solid rgba(15,23,42,.16);background:#fff;color:#111827;border-radius:8px;padding:12px 10px;font-size:14px;font-weight:900;box-shadow:none;scroll-snap-align:center}
        :is(.fm-availability,#fm-availability-picker) .fmle-slot:hover{border-color:var(--fmle-primary)}
        :is(.fm-availability,#fm-availability-picker) .fmle-slot.active{background:var(--fmle-primary);border-color:var(--fmle-primary);color:#fff}
        :is(.fm-availability,#fm-availability-picker) .fmle-slot[disabled]{opacity:.42;cursor:not-allowed;text-decoration:line-through}
        :is(.fm-availability,#fm-availability-picker) .fmle-schedule-note{min-height:8px;margin-top:12px;font-size:12px;font-weight:800;color:color-mix(in srgb,var(--fmle-text) 62%,#fff);line-height:1.35}
:is(.fm-availability,#fm-availability-picker) button:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
:is(.fm-availability,#fm-availability-picker) [data-month-step]{border:0;background:transparent;padding:8px;color:inherit}
:is(.fm-availability,#fm-availability-picker) button[type=submit]{background:var(--fmle-primary);color:white;border:0;border-radius:8px;padding:12px 18px;margin-top:16px;width:100%;font-weight:800}
:is(.fm-availability,#fm-availability-picker) button:disabled{opacity:.5;cursor:not-allowed}
@container(max-width:680px){:is(.fm-availability,#fm-availability-picker) .fmle-booking{grid-template-columns:1fr}:is(.fm-availability,#fm-availability-picker) .fmle-calendar{display:none}:is(.fm-availability,#fm-availability-picker) .fmle-mobile-days{display:flex}:is(.fm-availability,#fm-availability-picker) .fmle-slots{height:210px}}
</style><div class="fmle-booking">
<input name="preferred_start_at" type="hidden">
<div class="fmle-mobile-days" data-mobile-days></div>
<section class="fmle-calendar" aria-label="Appointment date">
<div class="fmle-cal-head"><button type="button" data-month-step="-1" aria-label="Previous month">‹</button><span data-cal-month></span><button type="button" data-month-step="1" aria-label="Next month">›</button></div><div class="fmle-cal-grid" data-calendar></div></section>
<section class="fmle-time-panel"><div class="fmle-time-title" data-selected-day>Choose a day</div><div class="fmle-slots" data-slots></div><div class="fmle-schedule-note" data-schedule-note role="status"></div>${submitLabel ? `<button type="submit">${esc(submitLabel)}</button>` : ''}</section></div>`;
  }
  function mount(wrap, options){
    const hidden = wrap.querySelector('input[name="preferred_start_at"]');
    const calendarEl = wrap.querySelector('[data-calendar]');
    const monthEl = wrap.querySelector('[data-cal-month]');
    const mobileDaysEl = wrap.querySelector('[data-mobile-days]');
    const selectedDayEl = wrap.querySelector('[data-selected-day]');
    const slotsEl = wrap.querySelector('[data-slots]');
    const noteEl = wrap.querySelector('[data-schedule-note]');
    if (!hidden || !slotsEl) return;
    let selectedDate = options.date || localDateInput();
    let generation = 0;
    let destroyed = false;
    const notify = slot => { hidden.value = slot?.start || slot?.start_at || ''; options.onChange?.(slot || null); };
    const fetchSlots = async date => {
      const data = await options.loadAvailability(date);
      return { ...data, slots:(data.slots || []).map(slot => ({...slot, start:slot.start || slot.start_at})) };
    };
    const centerInScroller = (scroller, item, axis = 'x', behavior = 'smooth') => {
      if (!scroller || !item) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      if (axis === 'y') {
        const delta = (itemRect.top + itemRect.height / 2) - (scrollerRect.top + scrollerRect.height / 2);
        scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior });
        return;
      }
      const delta = (itemRect.left + itemRect.width / 2) - (scrollerRect.left + scrollerRect.width / 2);
      scroller.scrollTo({ left: Math.max(0, scroller.scrollLeft + delta), behavior });
    };
    const restoreHorizontalScroll = (scroller, left) => {
      if (!scroller) return;
      const previousBehavior = scroller.style.scrollBehavior;
      scroller.style.scrollBehavior = 'auto';
      scroller.scrollLeft = left;
      void scroller.offsetWidth;
      scroller.style.scrollBehavior = previousBehavior;
    };
    const centerSelectedDay = (behavior = 'smooth') => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        centerInScroller(mobileDaysEl, mobileDaysEl?.querySelector('.fmle-day-pill.active'), 'x', behavior);
      }));
    };
    const centerSelectedSlot = (behavior = 'smooth') => {
      requestAnimationFrame(() => {
        centerInScroller(slotsEl, slotsEl?.querySelector('.fmle-slot.active'), 'y', behavior);
      });
    };
    const renderDays = () => {
      const previousMobileScroll = mobileDaysEl ? mobileDaysEl.scrollLeft : 0;
      const selected = dateFromInput(selectedDate);
      if (monthEl) monthEl.textContent = selected.toLocaleDateString([], { month:'long', year:'numeric' });
      wrap.querySelectorAll('[data-month-step]').forEach(button => { button.onclick = () => {
        selectedDate = localDateInput(new Date(selected.getFullYear(), selected.getMonth() + Number(button.dataset.monthStep), 1));
        renderDays(); load(false);
      }; });
      if (calendarEl) {
        const dows = ['S','M','T','W','T','F','S'].map((day) => `<div class="fmle-cal-dow">${day}</div>`).join('');
        calendarEl.innerHTML = dows + calendarDays(selectedDate).map((date) => dayButton(date, selectedDate, false)).join('');
      }
      if (mobileDaysEl) {
        mobileDaysEl.innerHTML = Array.from({length:21}, (_, i) => addDays(dateFromInput(selectedDate), i - 3)).map((date) => dayButton(date, selectedDate, true)).join('');
        restoreHorizontalScroll(mobileDaysEl, previousMobileScroll);
      }
      if (selectedDayEl) selectedDayEl.textContent = selected.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' });
      centerSelectedDay('smooth');
      wrap.querySelectorAll('[data-date]').forEach((button) => {
        button.addEventListener('click', () => {
          selectedDate = button.dataset.date || selectedDate;
          renderDays();
          load(false);
        });
      });
    };
    const load = async (autoAdvance = false) => {
      const request = ++generation;
      notify(null);
      if (noteEl) {noteEl.textContent = '';delete noteEl.dataset.error;}
      const requestedDate = selectedDate;
      slotsEl.innerHTML = `<button type="button" disabled>${(globalThis.PlatformLanguage?.htmlText("lead-embed","m_f7396ba34388fb","Loading times...") ?? "Loading times...")}</button>`;
      try {
        const data = await fetchSlots(requestedDate);
        if (destroyed || request !== generation) return;
        const slots = Array.isArray(data.slots) ? data.slots : [];
        let available = slots.filter((slot) => slot.available || slot.hasAvailability);
        if (!available.length && autoAdvance) {
          for (let offset = 1; offset <= 14; offset += 1) {
            const nextDate = new Date();
            nextDate.setDate(nextDate.getDate() + offset);
            const nextDateText = localDateInput(nextDate);
            const nextData = await fetchSlots(nextDateText);
            if (destroyed || request !== generation) return;
            const nextAvailable = (Array.isArray(nextData.slots) ? nextData.slots : []).filter((slot) => slot.available || slot.hasAvailability);
            if (nextAvailable.length) {
              selectedDate = nextDateText;
              available = nextAvailable;
              renderDays();
              break;
            }
          }
        }
        slotsEl.innerHTML = available.length
          ? available.map((slot) => `<button type="button" class="fmle-slot" aria-pressed="false" data-start="${esc(slot.start)}">${esc(slot.label || slot.time)}</button>`).join('')
          : `<button type="button" disabled>${(globalThis.PlatformLanguage?.htmlText("lead-embed","m_e971bf8117127c","No times available") ?? "No times available")}</button>`;
        if (noteEl) noteEl.textContent = available.length
          ? ''
          : 'Choose another date to see more availability.';
        slotsEl.querySelectorAll('.fmle-slot').forEach((button) => {
          button.addEventListener('click', () => {
            notify(available.find(slot => slot.start === button.dataset.start));
            slotsEl.querySelectorAll('.fmle-slot').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
            slotsEl.querySelectorAll('.fmle-slot').forEach((item) => item.classList.toggle('active', item === button));
            centerSelectedSlot('smooth');
          });
        });
      } catch (error) {
        if (destroyed || request !== generation) return;
        slotsEl.innerHTML = `<button type="button" disabled>${(globalThis.PlatformLanguage?.htmlText("lead-embed","m_f7267d11b3a3b7","Times unavailable") ?? "Times unavailable")}</button>`;
        if (noteEl) {noteEl.dataset.error='true';noteEl.textContent = error.message || 'Could not load appointment times.';}
      }
    };
    renderDays();
    const ready = load(options.autoAdvance !== false);
    return { ready, refresh:() => load(false), destroy:() => { destroyed = true; generation++; notify(null); } };
  }
  function rangeMarkup(){return `<div class="fm-range"><div class="fm-range-dates"><button type="button" data-range-field="start" title="Choose the first day">Start <b data-range-start>Choose date</b></button><span aria-hidden="true">→</span><button type="button" data-range-field="end" title="Choose the last day, included in the appointment">End <b data-range-end>Choose date</b></button></div><div class="fm-range-head"><button type="button" data-range-month="-1" aria-label="Previous month">‹</button><div><strong data-range-month-label></strong><small data-range-loading></small></div><button type="button" data-range-month="1" aria-label="Next month">›</button></div><div class="fm-range-grid" data-range-grid></div><div class="fm-range-footer"><span role="status" data-range-status></span><button type="submit" disabled>Book appointment</button></div></div>`;}
  function mountRange(wrap,options){
    let start=options.date||localDateInput(),days=options.days||2,month=dateFromInput(start),field='start',picked=false,disposed=false,epoch=0,selectionEpoch=0;
    const cache=new Map(),today=localDateInput(),$=q=>wrap.querySelector(q),end=()=>localDateInput(addDays(dateFromInput(start),days-1));
    const utc=date=>{const [y,m,d]=date.split('-').map(Number);return Date.UTC(y,m-1,d);};
    const length=date=>Math.round((utc(date)-utc(start))/86400000)+1;
    const caption=date=>dateFromInput(date).toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});
    async function available(date,count){const key=date+':'+count;if(!cache.has(key)){const pending=Promise.resolve().then(()=>options.loadAvailability(date,count)).then(data=>(data.slots||[]).find(s=>s.available||s.hasAvailability)||null).catch(error=>{cache.delete(key);throw error;});cache.set(key,pending);}return cache.get(key);}
    function header(){ $('[data-range-start]').textContent=picked?caption(start):'Choose date';$('[data-range-end]').textContent=picked?caption(end()):'Choose date';wrap.querySelectorAll('[data-range-field]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.rangeField===field))); }
    async function select(date){
      const ticket=++selectionEpoch;options.onChange?.(null);$('[type=submit]').disabled=true;
      if(field==='end'){days=length(date);options.onDurationChange?.(days);}else start=date;
      picked=true;header();paint();$('[data-range-status]').textContent='Checking crew availability…';
      try{const slot=await available(start,days);if(disposed||ticket!==selectionEpoch)return;options.onChange?.(slot);$('[type=submit]').disabled=!slot;$('[data-range-status]').textContent=slot?`${days} day${days===1?'':'s'} · ${caption(start)} – ${caption(end())}`:'No matching team is available for this entire range.';}catch(error){if(!disposed&&ticket===selectionEpoch)$('[data-range-status]').textContent=error.message||'Could not check availability.';}
    }
    function paint(){wrap.querySelectorAll('[data-range-date]').forEach(b=>{const date=b.dataset.rangeDate;b.classList.toggle('in-range',picked&&date>=start&&date<=end());b.classList.toggle('endpoint',picked&&(date===start||date===end()));b.setAttribute('aria-pressed',String(picked&&(date===start||date===end())));});}
    async function render(){
      const ticket=++epoch;header();$('[data-range-month-label]').textContent=month.toLocaleDateString([],{month:'long',year:'numeric'});
      $('[data-range-loading]').textContent='Checking dates…';
      const dates=calendarDays(localDateInput(month)).slice(0,Math.ceil((new Date(month.getFullYear(),month.getMonth(),1).getDay()+new Date(month.getFullYear(),month.getMonth()+1,0).getDate())/7)*7);$('[data-range-grid]').innerHTML=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<span class="fm-range-dow">${d}</span>`).join('')+dates.map(d=>{const date=localDateInput(d),valid=d.getMonth()===month.getMonth()&&date>=today&&(field==='start'||(picked&&length(date)>=1&&length(date)<=31));return `<button type="button" data-range-date="${date}" ${valid?'':'disabled'} class="${valid?'pending':'outside'}" aria-label="${esc(d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric',year:'numeric'}))}">${d.getDate()}</button>`;}).join('');paint();
      const queue=[...wrap.querySelectorAll('[data-range-date]:not(:disabled)')];queue.forEach(b=>{b.disabled=true;b.onclick=()=>void select(b.dataset.rangeDate);});
      if(options.unavailableMessage){$('[data-range-loading]').textContent='';$('[data-range-status]').textContent=options.unavailableMessage;return;}
      let failures=0,found=0;
      async function worker(){while(queue.length&&!disposed&&ticket===epoch){const b=queue.shift(),date=b.dataset.rangeDate;try{const slot=await available(field==='end'?start:date,field==='end'?length(date):days);if(disposed||ticket!==epoch)return;b.classList.remove('pending');b.disabled=!slot;b.classList.toggle('unavailable',!slot);b.title=slot?'Available for the entire appointment':'No matching team available for the entire range';if(slot)found++;}catch{if(disposed||ticket!==epoch)return;failures++;b.classList.remove('pending');b.title='Could not check availability';}}}
      await Promise.all(Array.from({length:3},worker));if(!disposed&&ticket===epoch)$('[data-range-loading]').textContent='';if(!disposed&&ticket===epoch&&!picked)$('[data-range-status]').textContent=failures?'Some dates could not be checked. Try another month or reopen the calendar.':found?'Choose an available start date.':'No matching team is available this month.';
    }
    wrap.querySelectorAll('[data-range-field]').forEach(b=>b.onclick=()=>{if(b.dataset.rangeField==='end'&&!picked)return;field=b.dataset.rangeField;month=dateFromInput(field==='start'?start:end());void render();});
    wrap.querySelectorAll('[data-range-month]').forEach(b=>b.onclick=()=>{month=new Date(month.getFullYear(),month.getMonth()+Number(b.dataset.rangeMonth),1);void render();});
    const ready=render();return {ready,get value(){return {date:start,days};},refresh(){cache.clear();return picked?select(field==='end'?end():start):render();},destroy(){disposed=true;epoch++;selectionEpoch++;options.onChange?.(null);}};
  }
  window.FirstMateAvailability = { markup, mount, rangeMarkup, mountRange };
})();
