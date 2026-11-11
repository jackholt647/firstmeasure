/* public/libraries/platform-offline/offline-ui.js
 *
 * window.PlatformOfflineUI: what people see of offline (docs/architecture/offline.md, "What people see").
 *
 *   indicator   one pill in the chrome, hidden while everything is normal
 *   tray        what is waiting, Retry and Discard, Send now, conflicts, this device's settings
 *   badge       waitingBadge({ record }): a mark apps put on a record whose change is still on the device
 *   project     "Available offline" in the project window, and a mark on saved projects in lists while offline
 *   sign-out    asks first while changes wait
 *
 * platform-offline.js loads this once the worker is in use, in the page and in each of its frames. It only reads
 * window.PlatformOffline and never wraps fetch. Every string is in STRINGS (namespace `platform-offline`).
 * NOTHING HERE RELOADS A PAGE BY ITSELF: the two reloads are buttons a person presses.
 */
(function () {
  'use strict';
  if (window.PlatformOfflineUI) return;
  const PO = window.PlatformOffline;
  if (!PO || typeof PO.state !== 'function') return;

  const NS = 'platform-offline';
  const isTop = (() => { try { return window.top === window; } catch (_) { return false; } })();
  const inProjectWindow = /[?&]projectWindow=/.test(location.search);
  const APP = window.__APP || {};
  const Z = 2147483580;                         // above the project window and guides, below toasts and the Refresh pill
  const SENT_MS = 4000;
  const READS_CHOICES = [50, 150, 500];         // MB: less, standard, more
  const MEDIA_CHOICES = [100, 300, 1024];

  // ---------------------------------------------------------------------------------------------------------
  // Words
  // ---------------------------------------------------------------------------------------------------------

  /** English for every key. The catalog source's `platform-offline` block is this table (tests compare them). */
  const STRINGS = {
    connect_once_title: 'No connection',
    connect_once_body: 'FirstMate is not saved on this device yet. Connect to the internet and open it once. After that it opens without a connection.',
    connect_once_retry: 'Try again',

    ind_offline_long: 'Offline. Changes are saved on this device and sent when you reconnect.',
    ind_offline_waiting_long: '{count, plural, one {Offline. # change is saved on this device and will be sent when you reconnect.} other {Offline. # changes are saved on this device and will be sent when you reconnect.}}',
    ind_offline_saved_long: 'Offline. You are seeing what was saved on this device.',
    ind_offline_short: 'Offline',
    ind_offline_waiting_short: 'Offline · {count} waiting',
    ind_offline_waiting_compact: 'Offline · {count}',
    ind_sending_long: '{count, plural, one {Sending # change…} other {Sending # changes…}}',
    ind_sending_short: 'Sending {count}…',
    ind_sent_long: 'All changes sent.',
    ind_sent_short: 'All changes sent',
    ind_sent_compact: 'Sent',
    ind_attention_long: '{count, plural, one {# change was not sent and needs you.} other {# changes were not sent and need you.}}',
    ind_attention_short: '{count} not sent',
    ind_signin_long: '{count, plural, one {Sign in again to send # waiting change.} other {Sign in again to send # waiting changes.}}',
    ind_signin_short: 'Sign in to send',
    ind_signin_compact: 'Sign in',
    ind_saved_long: 'Back online. This page is the copy saved on this device.',
    ind_saved_short: 'Saved copy',
    ind_download_long: 'Saving FirstMate on this device so it opens without a connection: {percent}%',
    ind_download_short: 'Saving for offline {percent}%',
    ind_download_compact: '{percent}%',
    ind_ready_long: 'FirstMate is saved on this device. It now opens without a connection.',
    ind_ready_short: 'Ready offline',
    ind_open: 'Show changes on this device',

    tray_title: 'Changes on this device',
    tray_close: 'Close',
    tray_back: 'Back',
    tray_device: 'This device',
    tray_none: 'Nothing is waiting. Everything you changed has been sent.',
    tray_attention_heading: 'Not sent',
    tray_waiting_heading: 'Waiting to be sent',
    tray_last_sent: 'Last sent {when}',
    tray_send_now: 'Send now',
    tray_sending: 'Sending…',
    tray_sign_in: 'Sign in',
    tray_storage_warning_title: 'This browser may clear waiting changes',
    tray_storage_warning: 'This browser has not promised to keep what FirstMate saves. It can clear it when the device runs low on space, and Safari clears a site\'s storage after seven days without a visit. Changes still waiting here would be lost, so connect and send them soon. The FirstMate app does not have this limit.',
    tray_saved_copy: 'This page is the copy saved on this device. Load the latest when you are ready.',
    tray_offline_note: 'Changes you make are saved on this device and sent when you reconnect.',
    tray_load_latest: 'Load the latest',

    entry_waiting: 'Waiting',
    entry_background: 'Uploading in the background',
    entry_failed: 'Not sent',
    entry_conflict: 'Needs your choice',
    entry_made: 'Made {when}',
    entry_retry: 'Retry',
    entry_discard: 'Discard',
    entry_review: 'Review',
    entry_discard_ask: 'Discard this change? It was never sent and will be lost.',
    entry_discard_yes: 'Discard change',
    entry_discard_no: 'Keep it',
    entry_action_failed: 'That did not work. Try again.',
    error_refused: 'The server did not accept this change ({status}).',
    error_not_found: 'What this change was for no longer exists.',
    error_forbidden: 'You are not allowed to make this change.',
    error_server: 'The server had a problem. Retry in a moment.',
    error_parked: 'This change was made under another sign-in. Sign in as that person to send it.',
    kind_create: 'New item',
    kind_patch: 'Edit',
    kind_upload: 'Upload',
    kind_delete: 'Removal',
    kind_action: 'Change',

    when_now: 'just now',
    when_today: 'today at {time}',
    when_yesterday: 'yesterday at {time}',
    when_date: '{date} at {time}',

    conflict_title: 'Choose what to keep',
    conflict_intro: 'This was changed here and on the server before your change could be sent. Choose which value to keep for each field.',
    conflict_mine: 'Yours',
    conflict_theirs: 'The server\'s',
    conflict_before: 'Before: {value}',
    conflict_all_mine: 'Keep all of mine',
    conflict_all_theirs: 'Keep all of the server\'s',
    conflict_send: 'Send my choices',
    conflict_remaining: '{count, plural, one {# field left to choose} other {# fields left to choose}}',
    conflict_ready: 'Every field is chosen.',
    conflict_failed: 'Your choices could not be saved. Try again.',
    conflict_order: 'Order of {name}',
    value_empty: 'Empty',
    value_yes: 'Yes',
    value_no: 'No',
    value_none: 'None',
    value_items: '{count, plural, one {# item} other {# items}}',

    badge_waiting: 'Waiting to send',
    badge_waiting_tip: 'Saved on this device. It is sent when you reconnect.',
    badge_failed: 'Not sent',
    badge_failed_tip: 'This was not sent. Open to retry or discard it.',
    badge_conflict: 'Needs your choice',
    badge_conflict_tip: 'This was also changed on the server. Open to choose what to keep.',

    project_title: 'Available offline',
    project_not_saved: 'This project is not saved on this device.',
    project_downloading: 'Saving this project on this device…',
    project_saved: 'Saved on this device {when}.',
    project_auto: 'Kept automatically because you opened it recently. The ten most recent projects are kept.',
    project_chosen: 'You chose to keep this project on this device.',
    project_waits_for_connection: 'It will be saved when you reconnect.',
    project_keep: 'Keep on this device',
    project_keep_always: 'Always keep',
    project_remove: 'Remove from this device',
    project_failed: 'That did not work. Try again.',
    mark_saved: 'Saved on this device',

    set_section_title: 'Offline',
    set_section_subtitle: 'Saved data and waiting changes on this device.',
    set_intro: 'These settings are for this device only.',
    set_space: 'Space on this device',
    set_space_used: '{used} used of about {quota} this browser allows',
    set_space_unknown: 'This browser does not report how much space is available.',
    set_part_app: 'The app',
    set_part_reads: 'Saved data',
    set_part_media: 'Pictures',
    set_part_queued: 'Waiting changes',
    set_limit: 'limit {size}',
    set_keep_heading: 'What to keep',
    set_reads_limit: 'Saved data',
    set_reads_help: 'How much project data to keep. The oldest is removed first. Projects you keep are never removed.',
    set_media_limit: 'Pictures',
    set_media_help: 'How many pictures to keep for viewing without a connection.',
    set_choice_less: 'Less',
    set_choice_standard: 'Standard',
    set_choice_more: 'More',
    set_choice_current: 'Current',
    set_auto_pin: 'Keep recently opened projects',
    set_auto_pin_help: 'The ten projects you opened last are saved on this device automatically.',
    set_camera_roll: 'Also save photos to the camera roll',
    set_camera_roll_help: 'Photos you take in FirstMate stay in the app. Turn this on to save a copy to your phone\'s photos as well.',
    set_projects: '{count, plural, =0 {No projects are saved on this device.} one {# project is saved on this device.} other {# projects are saved on this device.}}',
    set_waiting: '{count, plural, =0 {No changes are waiting to be sent.} one {# change is waiting to be sent.} other {# changes are waiting to be sent.}}',
    set_show_waiting: 'Show waiting changes',
    set_remove_heading: 'Remove saved data',
    set_remove: 'Remove saved data from this device',
    set_remove_help: 'Removes saved projects, pictures and pages from this device, including projects you chose to keep. They are saved again when you open them with a connection. Changes waiting to be sent are kept and still sent.',
    set_remove_ask: 'Remove saved data now? Changes waiting to be sent are kept.',
    set_remove_yes: 'Remove saved data',
    set_remove_no: 'Cancel',
    set_removed: 'Saved data was removed. Waiting changes were kept.',
    set_remove_failed: 'Saved data could not be removed. Try again.',
    set_save_failed: 'That setting could not be saved. Try again.',

    signout_title: 'Changes are still waiting',
    signout_body: '{count, plural, one {# change has not been sent yet.} other {# changes have not been sent yet.}} If you sign out now they stay on this device and are sent the next time you sign in here.',
    signout_stay: 'Stay signed in',
    signout_leave: 'Sign out anyway'
  };

  /** A small ICU reader for when the language library is not on the page: {name} and {n, plural, =0 {..} one {..} other {..}}. */
  function format(message, values) {
    const data = values || {};
    let out = '';
    for (let at = 0; at < message.length; at++) {
      const char = message[at];
      if (char !== '{') { out += char; continue; }
      let depth = 1, end = at + 1;
      while (end < message.length && depth) { if (message[end] === '{') depth++; else if (message[end] === '}') depth--; end++; }
      const inner = message.slice(at + 1, end - 1);
      at = end - 1;
      const plural = inner.match(/^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/);
      if (!plural) { const name = inner.trim(); out += data[name] == null ? '' : String(data[name]); continue; }
      const count = Number(data[plural[1]]);
      const forms = {};
      const body = plural[2];
      for (let i = 0; i < body.length; i++) {
        const open = body.indexOf('{', i);
        if (open < 0) break;
        let level = 1, close = open + 1;
        while (close < body.length && level) { if (body[close] === '{') level++; else if (body[close] === '}') level--; close++; }
        forms[body.slice(i, open).trim()] = body.slice(open + 1, close - 1);
        i = close - 1;
      }
      const chosen = forms['=' + count] != null ? forms['=' + count] : (count === 1 && forms.one != null ? forms.one : forms.other || '');
      out += format(chosen.replace(/#/g, String(count)), data);
    }
    return out;
  }

  function T(key, values) {
    const fallback = STRINGS[key] == null ? key : STRINGS[key];
    const language = window.PlatformLanguage;
    try { if (language && typeof language.text === 'function') return String(language.text(NS, key, fallback, values || {})); } catch (_) { /* fall through */ }
    return format(fallback, values);
  }
  /** A contract's label part: `{ key, title }` shows the language text for `key`, with `title` when there is none. */
  function labelText(key, fallback) {
    const language = window.PlatformLanguage;
    const parts = String(key || '').split('/');
    if (key) { try { if (language && typeof language.text === 'function') return String(language.text(parts.length > 1 ? parts[0] : NS, parts[parts.length - 1], fallback || '', {})); } catch (_) { /* fall through */ } }
    return fallback || '';
  }
  const locale = () => { try { return (window.PlatformLanguage && window.PlatformLanguage.formatLocale && window.PlatformLanguage.formatLocale()) || undefined; } catch (_) { return undefined; } };

  function when(ms) {
    const date = new Date(ms);
    if (!ms || Number.isNaN(date.getTime())) return '';
    const now = new Date();
    if (Math.abs(now - date) < 60000) return T('when_now');
    const time = new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' }).format(date);
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((day(now) - day(date)) / 86400000);
    if (days === 0) return T('when_today', { time });
    if (days === 1) return T('when_yesterday', { time });
    const options = date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
    return T('when_date', { date: new Intl.DateTimeFormat(locale(), options).format(date), time });
  }

  function size(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    const GB = 1073741824, MB = 1048576;       // the engine's budgets are binary megabytes
    const pick = value >= GB * 0.95 ? ['gigabyte', value / GB, 1] : value >= MB ? ['megabyte', value / MB, value >= 10 * MB ? 0 : 1] : ['kilobyte', value / 1024, 0];
    try { return new Intl.NumberFormat(locale(), { style: 'unit', unit: pick[0], unitDisplay: 'short', maximumFractionDigits: pick[2] }).format(pick[1]); } catch (_) { return pick[1].toFixed(pick[2]) + ' ' + { gigabyte: 'GB', megabyte: 'MB', kilobyte: 'kB' }[pick[0]]; }
  }
  const megabytes = (mb) => size(mb * 1048576);

  // ---------------------------------------------------------------------------------------------------------
  // DOM helpers and styles
  // ---------------------------------------------------------------------------------------------------------

  function el(doc, tag, attrs) {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (name === 'text') node.textContent = value;
      else if (name === 'on') for (const [type, handler] of Object.entries(value)) node.addEventListener(type, handler);
      else node.setAttribute(name, value === true ? '' : String(value));
    }
    for (let i = 3; i < arguments.length; i++) { const kid = arguments[i]; if (kid != null && kid !== false) node.append(kid); }
    return node;
  }
  const h = (tag, attrs, ...kids) => el(document, tag, attrs, ...kids);
  const ICONS = {
    offline: 'fa-wifi', sending: 'fa-arrows-rotate', sent: 'fa-circle-check', attention: 'fa-triangle-exclamation', signin: 'fa-right-to-bracket',
    saved: 'fa-floppy-disk', download: 'fa-cloud-arrow-down', ready: 'fa-circle-check', waiting: 'fa-cloud-arrow-up', conflict: 'fa-code-compare',
    close: 'fa-xmark', back: 'fa-chevron-left', device: 'fa-mobile-alt', retry: 'fa-rotate', discard: 'fa-trash-can', chevron: 'fa-chevron-right',
    create: 'fa-plus', patch: 'fa-pen', upload: 'fa-image', delete: 'fa-trash-can', action: 'fa-bolt', mark: 'fa-circle-down', warn: 'fa-triangle-exclamation'
  };
  function icon(doc, name, extra) {
    return el(doc, 'i', { class: 'fas ' + (ICONS[name] || name) + ' fmo-ico' + (name === 'offline' ? ' fmo-ico-off' : '') + (name === 'sending' ? ' fmo-spin' : '') + (extra ? ' ' + extra : ''), 'aria-hidden': 'true' });
  }

  const CSS = `
.fmo-ico{flex:none;line-height:1}
.fmo-ico-off{position:relative}
.fmo-ico-off::after{content:"";position:absolute;left:50%;top:50%;width:135%;height:1.5px;background:currentColor;box-shadow:0 0 0 1px var(--fmo-cut,#111827);transform:translate(-50%,-50%) rotate(-45deg);border-radius:1px}
@keyframes fmo-spin{to{transform:rotate(360deg)}}
.fmo-spin{animation:fmo-spin 1.6s linear infinite}
@media (prefers-reduced-motion:reduce){.fmo-spin{animation:none}.fmo-tray,.fmo-scrim{transition:none!important}}
.fmo-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* The indicator: one slot that moves to wherever the chrome is, one pill inside it. */
.fmo-slot{display:flex;align-items:center;min-width:0;font-size:12px;font-weight:600;line-height:1.4}
.fmo-slot[hidden]{display:none!important}
.fmo-slot[data-host=topbar]{flex:1 1 0;justify-content:flex-end;container:fmo-slot/inline-size}
#platformTopbarAppLeft:not(:empty)~.fmo-slot[data-host=topbar]{flex:0 0 auto;container-type:normal}
.fmo-slot[data-host=sidebar]{display:block;padding:0 0 10px;container:fmo-slot/inline-size}
.fmo-slot[data-host=sidebar] .fmo-pill{width:100%;justify-content:flex-start}
.fmo-slot[data-host=mobile]{flex:0 0 auto;margin-left:8px}
.fmo-slot[data-host=shell]{flex:0 0 auto;margin-right:6px}
.fmo-slot[data-host=project]{flex:0 0 auto;gap:6px;margin-left:2px}
.fmo-slot[data-host=project] .fmo-pill{min-height:26px;padding:3px 10px}
.fmo-slot[data-host=float]{position:fixed;left:12px;bottom:12px;z-index:${Z - 1}}
.fmo-pill{appearance:none;display:inline-flex;align-items:center;gap:7px;max-width:100%;min-height:30px;box-sizing:border-box;margin:0;padding:5px 12px;border:0;border-radius:999px;background:#111827;color:#fff;font-size:inherit;font-weight:inherit;line-height:inherit;text-align:left;cursor:pointer;white-space:nowrap;box-shadow:0 1px 2px rgba(15,23,42,.18);--fmo-cut:#111827}
.fmo-pill[hidden]{display:none!important}
.fmo-pill:hover{background:#1f2937;--fmo-cut:#1f2937}
.fmo-pill:focus-visible,.fmo-tray button:focus-visible,.fmo-tray a:focus-visible,.fmo-proj:focus-visible,.fmo-badge:focus-visible,.fmo-dialog button:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.fmo-pill[data-tone=attention]{background:#b42318;--fmo-cut:#b42318}
.fmo-pill[data-tone=attention]:hover{background:#912018;--fmo-cut:#912018}
.fmo-pill[data-tone=signin]{background:#b54708;--fmo-cut:#b54708}
.fmo-pill[data-tone=good] .fmo-ico{color:#6ce9a6}
.fmo-pill .fmo-ico{font-size:12px}
.fmo-pill .fmo-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.fmo-pill .fmo-l,.fmo-pill .fmo-c,.fmo-pill .fmo-t{display:none}
.fmo-pill .fmo-bar{flex:none;width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,.28);overflow:hidden}
.fmo-pill .fmo-bar>span{display:block;height:100%;background:#fff;border-radius:2px}
.fmo-slot[data-size=compact] .fmo-pill{min-height:28px;padding:4px 10px;gap:6px}
.fmo-slot[data-size=compact] .fmo-s,.fmo-slot[data-size=compact] .fmo-bar{display:none}
.fmo-slot[data-size=compact] .fmo-c{display:inline}
.fmo-slot[data-size=tiny] .fmo-pill{min-width:28px;min-height:28px;padding:4px 9px;gap:5px;justify-content:center}
.fmo-slot[data-size=tiny] .fmo-s,.fmo-slot[data-size=tiny] .fmo-bar,.fmo-slot[data-size=tiny] .fmo-t:empty{display:none}
.fmo-slot[data-size=tiny] .fmo-t{display:inline}
.fmo-slot[data-size=tiny] .fmo-pill:has(.fmo-t:empty){width:28px;padding:0}
.fmo-slot[data-size=tiny] .fmo-pill:has(.fmo-t:empty) .fmo-text{display:none}
@container fmo-slot (min-width:540px){.fmo-pill .fmo-s{display:none}.fmo-pill .fmo-l{display:inline}}
@container fmo-slot (max-width:110px){.fmo-slot .fmo-pill{justify-content:center!important;width:32px!important;height:32px;min-height:0;padding:0;margin:0 auto;display:flex}.fmo-pill .fmo-text,.fmo-pill .fmo-bar{display:none}}

/* The mark apps put on a waiting record. */
.fmo-badge{display:inline-flex;align-items:center;gap:4px;max-width:100%;box-sizing:border-box;padding:2px 7px;border-radius:999px;border:1px solid rgba(15,23,42,.08);background:#f2f4f7;color:#475467;font-size:10.5px;font-weight:700;line-height:1.5;white-space:nowrap;vertical-align:middle;cursor:default}
.fmo-badge[hidden]{display:none!important}
.fmo-badge .fmo-ico{font-size:9.5px}
.fmo-badge>span{overflow:hidden;text-overflow:ellipsis}
.fmo-badge[data-state=failed]{background:#fef3f2;border-color:#fecdca;color:#b42318;cursor:pointer}
.fmo-badge[data-state=conflict]{background:#fffaeb;border-color:#fedf89;color:#b54708;cursor:pointer}
.fmo-badge[data-compact]{padding:0;width:20px;height:20px;justify-content:center}
.fmo-badge[data-compact]>span{display:none}

/* In lists, while offline: this project is on the device. */
.fmo-mark{display:inline-flex;align-items:center;margin-left:6px;color:#475467;font-size:11px;vertical-align:baseline}

/* "Available offline" in the project window. */
.fmo-proj{appearance:none;flex:none;display:inline-grid;place-items:center;width:26px;height:26px;margin:0;padding:0;border:1px solid rgba(15,23,42,.10);border-radius:999px;background:#fff;color:#667085;font-size:12px;cursor:pointer}
.fmo-proj[hidden]{display:none!important}
.fmo-proj:hover{color:#101828;border-color:rgba(15,23,42,.24)}
.fmo-proj[data-state=saved]{color:#067647;border-color:#abefc6;background:#ecfdf3}
.fmo-proj[data-state=downloading]{color:#344054}

/* The tray and the dialogs live in the top page, above everything but toasts and the Refresh pill. */
.fmo-layer{position:fixed;inset:0;z-index:${Z};pointer-events:none;container:fmo-layer/size;font-size:13px;font-weight:500;line-height:1.45;color:#101828;text-align:left}
.fmo-layer[hidden]{display:none!important}
.fmo-scrim{position:absolute;inset:0;pointer-events:auto;background:transparent;transition:background-color .18s ease}
.fmo-tray{position:absolute;pointer-events:auto;display:flex;flex-direction:column;box-sizing:border-box;width:min(400px,calc(100% - 24px));max-height:calc(100% - 24px);background:#fff;border:1px solid rgba(15,23,42,.10);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.18);overflow:hidden;container:fmo-tray/inline-size}
.fmo-tray[data-view=conflict]{width:min(620px,calc(100% - 24px))}
.fmo-tray *{box-sizing:border-box}
.fmo-head{flex:none;display:flex;align-items:center;gap:8px;padding:11px 10px 11px 14px;border-bottom:1px solid rgba(15,23,42,.08)}
.fmo-tray:focus,.fmo-pop:focus,.fmo-head h2:focus{outline:none}
.fmo-head h2{flex:1;min-width:0;margin:0;font-size:13px;font-weight:800;color:#101828;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmo-iconbtn{appearance:none;flex:none;display:inline-grid;place-items:center;width:30px;height:30px;margin:0;padding:0;border:0;border-radius:9px;background:transparent;color:#475467;font-size:13px;cursor:pointer}
.fmo-iconbtn:hover{background:#f2f4f7;color:#101828}
.fmo-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
.fmo-status{display:flex;gap:10px;padding:13px 14px;border-bottom:1px solid rgba(15,23,42,.06)}
.fmo-status>.fmo-ico{margin-top:2px;font-size:14px;color:#475467;--fmo-cut:#fff}
.fmo-status[data-tone=attention]>.fmo-ico{color:#b42318}
.fmo-status[data-tone=signin]>.fmo-ico{color:#b54708}
.fmo-status[data-tone=good]>.fmo-ico{color:#079455}
.fmo-status p{margin:0;font-size:13px;font-weight:650;color:#101828}
.fmo-status small{display:block;margin-top:3px;font-size:12px;font-weight:500;color:#667085}
.fmo-status .fmo-progress{margin-top:8px;height:5px;border-radius:3px;background:#eaecf0;overflow:hidden}
.fmo-status .fmo-progress>span{display:block;height:100%;background:#111827;border-radius:3px}
.fmo-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.fmo-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;margin:0;padding:6px 12px;border:1px solid rgba(15,23,42,.14);border-radius:10px;background:#fff;color:#344054;font-size:12px;font-weight:700;line-height:1.3;cursor:pointer;white-space:nowrap}
.fmo-btn:hover{background:#f9fafb;border-color:rgba(15,23,42,.24)}
.fmo-btn[disabled]{opacity:.55;cursor:default}
.fmo-btn.primary{background:var(--primary,#d93025);border-color:transparent;color:var(--on-primary,#fff)}
.fmo-btn.primary:hover{filter:brightness(.95)}
.fmo-btn.danger{color:#b42318;border-color:#fecdca}
.fmo-btn.danger.solid{background:#b42318;border-color:transparent;color:#fff}
.fmo-btn.quiet{border-color:transparent;padding-left:6px;padding-right:6px}
.fmo-warn{margin:12px 14px 0;padding:10px 12px;border:1px solid #fedf89;border-radius:12px;background:#fffaeb;color:#93370d;font-size:12px}
.fmo-warn strong{display:block;margin-bottom:2px;font-size:12px;font-weight:800;color:#7a2e0e}
.fmo-group{margin:0;padding:12px 14px 4px;font-size:11px;font-weight:800;letter-spacing:.02em;color:#667085;text-transform:none}
.fmo-list{margin:0;padding:0;list-style:none}
.fmo-entry{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:2px 10px;align-items:start;padding:10px 14px;border-top:1px solid rgba(15,23,42,.06)}
.fmo-entry:first-child{border-top:0}
.fmo-entry[data-flash]{background:rgba(var(--primary-rgb,217,48,37),.06)}
.fmo-kind{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#f2f4f7;color:#475467;font-size:11px}
.fmo-entry[data-state=failed] .fmo-kind,.fmo-entry[data-state=parked] .fmo-kind{background:#fef3f2;color:#b42318}
.fmo-entry[data-state=conflict] .fmo-kind{background:#fffaeb;color:#b54708}
.fmo-entry-main{min-width:0}
.fmo-entry-title{font-size:13px;font-weight:700;color:#101828;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmo-entry-detail{font-size:12px;color:#475467;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmo-entry-meta{margin-top:2px;font-size:11.5px;color:#667085}
.fmo-entry-error{margin-top:4px;font-size:12px;color:#b42318}
.fmo-chip{align-self:start;display:inline-flex;align-items:center;gap:4px;margin-top:3px;padding:2px 8px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:11px;font-weight:700;white-space:nowrap}
.fmo-chip[data-state=failed],.fmo-chip[data-state=parked]{background:#fef3f2;color:#b42318}
.fmo-chip[data-state=conflict]{background:#fffaeb;color:#b54708}
.fmo-entry-actions{grid-column:2 / -1;display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}
.fmo-entry-actions p{flex:1 1 100%;margin:0;font-size:12px;font-weight:650;color:#101828}
.fmo-empty{padding:18px 14px;font-size:12.5px;color:#667085}
.fmo-foot{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid rgba(15,23,42,.08);background:#fcfcfd}
.fmo-foot .fmo-grow{flex:1;min-width:0;font-size:12px;color:#667085}

/* Conflicts: each field with both values side by side. */
.fmo-conflict{padding:12px 14px 4px}
.fmo-conflict>p{margin:0 0 10px;font-size:12.5px;color:#475467}
.fmo-conflict-what{display:flex;flex-wrap:wrap;gap:0 6px;margin:0 0 4px;font-size:13px;color:#101828}
.fmo-conflict-what strong{font-weight:800}
.fmo-conflict-what span{color:#475467;overflow-wrap:anywhere}
.fmo-conflict-all{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}
.fmo-field{margin:0;padding:12px 0;border-top:1px solid rgba(15,23,42,.06);min-width:0}
.fmo-field-name{font-size:12.5px;font-weight:800;color:#101828;overflow-wrap:anywhere}
.fmo-field .fmo-before{margin:2px 0 0;font-size:11.5px;color:#667085;overflow-wrap:anywhere}
.fmo-sides{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin-top:8px}
@container fmo-tray (max-width:380px){.fmo-sides{grid-template-columns:minmax(0,1fr)}}
.fmo-side{position:relative;display:block;min-width:0;padding:9px 10px 10px 34px;border:1px solid rgba(15,23,42,.14);border-radius:12px;background:#fff;cursor:pointer}
.fmo-side:hover{border-color:rgba(15,23,42,.3)}
.fmo-side input{position:absolute;left:10px;top:10px;width:16px;height:16px;margin:0;accent-color:var(--primary,#d93025)}
.fmo-side:has(input:checked){border-color:var(--primary,#d93025);box-shadow:inset 0 0 0 1px var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.04)}
.fmo-side:has(input:focus-visible){outline:2px solid var(--primary,#d93025);outline-offset:2px}
.fmo-side b{display:block;font-size:11px;font-weight:800;color:#667085}
.fmo-value{display:block;margin-top:2px;max-height:9.5em;overflow:auto;font-size:13px;font-weight:600;color:#101828;white-space:pre-wrap;overflow-wrap:anywhere}
.fmo-value[data-empty]{font-weight:500;font-style:italic;color:#98a2b3}
.fmo-value ul,.fmo-value ol{margin:0;padding-left:18px}
.fmo-value dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:1px 8px}
.fmo-value dt{color:#667085;font-weight:600}
.fmo-value dd{margin:0}
.fmo-note{font-size:12px;color:#667085}
.fmo-note[data-tone=error]{color:#b42318}

/* Narrow layer: the tray is a bottom sheet. */
@container fmo-layer (max-width:639px){
  .fmo-layer[data-open] .fmo-scrim{background:rgba(15,23,42,.42)}
  .fmo-tray,.fmo-tray[data-view=conflict]{left:0!important;right:0!important;top:auto!important;bottom:0!important;width:100%;max-height:min(86%,calc(100% - 40px));border:0;border-radius:22px 22px 0 0;box-shadow:0 -12px 40px rgba(15,23,42,.18);padding-bottom:env(safe-area-inset-bottom,0px)}
  .fmo-head{padding:14px 12px 12px 16px}
  .fmo-head h2{font-size:16px;font-weight:800}
  .fmo-iconbtn{width:34px;height:34px;border-radius:10px;background:#f2f4f7}
  .fmo-btn{min-height:38px;font-size:13px}
}

/* A question that stops the person: signing out with changes waiting. */
.fmo-dialog-wrap{position:absolute;inset:0;display:grid;place-items:center;padding:16px;pointer-events:auto;background:rgba(15,23,42,.42)}
.fmo-dialog{width:min(430px,100%);padding:20px;border-radius:18px;background:#fff;box-shadow:0 24px 60px rgba(15,23,42,.28)}
.fmo-dialog h2{margin:0 0 8px;font-size:16px;font-weight:800;color:#101828}
.fmo-dialog p{margin:0;font-size:13px;color:#475467}
.fmo-dialog .fmo-actions{justify-content:flex-end;margin-top:18px}

/* A small panel beside its button (the project's offline control). */
.fmo-pop{position:absolute;pointer-events:auto;width:min(300px,calc(100% - 24px));padding:13px 14px;background:#fff;border:1px solid rgba(15,23,42,.10);border-radius:14px;box-shadow:0 18px 44px rgba(15,23,42,.18)}
.fmo-pop h2{margin:0 0 4px;font-size:13px;font-weight:800;color:#101828}
.fmo-pop p{margin:0;font-size:12.5px;color:#475467}
.fmo-pop p+p{margin-top:4px;color:#667085;font-size:12px}
@container fmo-layer (max-width:639px){.fmo-pop{left:12px!important;right:12px!important;width:auto}}

/* Device settings (the Settings app's Offline page and the tray's "This device"). */
.fmo-set{container:fmo-set/inline-size;font-size:13px;font-weight:500;line-height:1.45;color:#101828}
.fmo-set *{box-sizing:border-box}
.fmo-set-intro{margin:0 0 12px;font-size:12.5px;color:#667085}
.fmo-set-group{margin:0 0 14px;padding:14px;border:1px solid var(--border,#dadce0);border-radius:var(--radius-lg,12px);background:#fff}
.fmo-tray .fmo-set{padding:12px 14px 2px}
.fmo-tray .fmo-set-group{padding:12px;border-color:rgba(15,23,42,.10)}
.fmo-set-group h4{margin:0 0 10px;font-size:13px;font-weight:800;color:#101828}
.fmo-meter{display:flex;height:10px;border-radius:5px;background:#eaecf0;overflow:hidden}
.fmo-meter>span{min-width:3px;height:100%}
.fmo-meter>span+span{margin-left:1px}
.fmo-set [data-part=app]{background:#475467}
.fmo-set [data-part=reads]{background:#2e90fa}
.fmo-set [data-part=media]{background:#12b76a}
.fmo-set [data-part=queued]{background:#f79009}
.fmo-set-total{margin:8px 0 10px;font-size:12.5px;color:#475467}
.fmo-legend{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.fmo-legend li{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:8px;align-items:center;font-size:12.5px}
.fmo-legend i{width:10px;height:10px;border-radius:3px}
.fmo-legend b{font-weight:650}
.fmo-legend small{font-size:11.5px;color:#667085;font-weight:500}
.fmo-legend span{font-variant-numeric:tabular-nums;color:#344054;font-weight:650}
.fmo-set-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;align-items:center;padding:10px 0;border-top:1px solid rgba(15,23,42,.06)}
.fmo-set-row:first-of-type{border-top:0;padding-top:0}
.fmo-set-row:last-child{padding-bottom:0}
.fmo-set-row strong{display:block;font-size:13px;font-weight:700}
.fmo-set-row small{display:block;margin-top:2px;font-size:12px;color:#667085;font-weight:500}
@container fmo-set (max-width:520px){.fmo-set-row{grid-template-columns:minmax(0,1fr)}.fmo-set-row.inline{grid-template-columns:minmax(0,1fr) auto}}
.fmo-seg{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:6px}
.fmo-seg label{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:86px;min-height:40px;padding:5px 10px;border:1px solid rgba(15,23,42,.14);border-radius:10px;background:#fff;color:#344054;font-size:12px;cursor:pointer;white-space:nowrap}
.fmo-seg label b{font-weight:700}
.fmo-seg label small{margin:0;font-size:11px;font-weight:500;color:#667085}
@container fmo-set (max-width:520px){.fmo-seg label{min-width:0}}
.fmo-seg input{position:absolute;opacity:0;pointer-events:none}
.fmo-seg label:has(input:checked){border-color:var(--primary,#d93025);box-shadow:inset 0 0 0 1px var(--primary,#d93025);color:#101828;background:rgba(var(--primary-rgb,217,48,37),.05)}
.fmo-seg label:has(input:focus-visible){outline:2px solid var(--primary,#d93025);outline-offset:2px}
.fmo-switch{position:relative;display:inline-block;width:40px;height:24px;flex:none}
.fmo-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.fmo-switch span{position:absolute;inset:0;border-radius:999px;background:#d0d5dd;transition:background-color .15s ease;pointer-events:none}
.fmo-switch span::after{content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.3);transition:transform .15s ease}
.fmo-switch input:checked+span{background:var(--primary,#d93025)}
.fmo-switch input:checked+span::after{transform:translateX(16px)}
.fmo-switch input:focus-visible+span{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.fmo-set-line{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:0;font-size:12.5px;color:#475467}
.fmo-set-line+.fmo-set-line{margin-top:8px}
.fmo-set-help{margin:0 0 10px;font-size:12.5px;color:#667085}
`;

  function styles(doc) {
    if (doc.getElementById('fmo-ui-css')) return;
    const style = doc.createElement('style');
    style.id = 'fmo-ui-css';
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }
  styles(document);

  // ---------------------------------------------------------------------------------------------------------
  // What is true now
  // ---------------------------------------------------------------------------------------------------------

  let state = PO.state();
  let entries = [];
  let entriesAsked = 0;
  let sentUntil = 0;
  let readyUntil = 0;
  let sawFirstDownload = false;
  let sentTimer = 0;
  const listeners = new Set();
  const changed = () => { for (const listener of [...listeners]) { try { listener(); } catch (error) { console.error('[offline] UI update failed', error); } } };

  const waitingCount = (s) => (s.pending || 0) + (s.failed || 0) + (s.conflicts || 0);
  const isNative = () => { try { return !!(window.PhoneFeatures && window.PhoneFeatures.isNative && window.PhoneFeatures.isNative()); } catch (_) { return false; } };

  /** The one thing the indicator says, most pressing first. null: everything is normal and nothing shows. */
  function situation(s) {
    if (!s || !s.supported || (!s.controlled && !waitingCount(s))) return null;
    const attention = (s.failed || 0) + (s.conflicts || 0);
    const count = s.pending || 0;
    if (attention) return { mode: 'attention', tone: 'attention', icon: 'attention', count: attention, long: T('ind_attention_long', { count: attention }), short: T('ind_attention_short', { count: attention }), compact: String(attention), tiny: String(attention) };
    if (s.blocked === 'sign-in' && count) return { mode: 'signin', tone: 'signin', icon: 'signin', count, long: T('ind_signin_long', { count }), short: T('ind_signin_short'), compact: T('ind_signin_compact') };
    if (!s.online) {
      if (count) return { mode: 'offline', tone: 'dark', icon: 'offline', count, long: T('ind_offline_waiting_long', { count }), short: T('ind_offline_waiting_short', { count }), compact: T('ind_offline_waiting_compact', { count }), tiny: String(count) };
      return { mode: 'offline', tone: 'dark', icon: 'offline', count: 0, long: T(s.savedPage ? 'ind_offline_saved_long' : 'ind_offline_long'), short: T('ind_offline_short'), compact: T('ind_offline_short') };
    }
    if (count) return { mode: 'sending', tone: 'dark', icon: 'sending', count, long: T('ind_sending_long', { count }), short: T('ind_sending_short', { count }), compact: String(count), tiny: String(count) };
    if (Date.now() < sentUntil) return { mode: 'sent', tone: 'good', icon: 'sent', count: 0, long: T('ind_sent_long'), short: T('ind_sent_short'), compact: T('ind_sent_compact') };
    if (s.savedPage) return { mode: 'saved', tone: 'dark', icon: 'saved', count: 0, long: T('ind_saved_long'), short: T('ind_saved_short'), compact: T('ind_saved_short') };
    const code = s.code || {};
    // Only the first download is shown: a later release's set downloads quietly behind the one in use.
    if (code.status === 'downloading' && !code.release) {
      const percent = Math.max(0, Math.min(99, Math.round((code.progress || 0) * 100)));
      return { mode: 'download', tone: 'dark', icon: 'download', count: 0, progress: percent, long: T('ind_download_long', { percent }), short: T('ind_download_short', { percent }), compact: T('ind_download_compact', { percent }), tiny: T('ind_download_compact', { percent }) };
    }
    if (Date.now() < readyUntil) return { mode: 'ready', tone: 'good', icon: 'ready', count: 0, long: T('ind_ready_long'), short: T('ind_ready_short'), compact: T('ind_ready_short') };
    return null;
  }

  function flash(which) {
    const until = Date.now() + SENT_MS;
    if (which === 'ready') readyUntil = until; else sentUntil = until;
    clearTimeout(sentTimer);
    sentTimer = setTimeout(changed, SENT_MS + 30);
  }

  let entriesRun = null;
  /** Reads the queue again (the worker's answer); one read at a time, the newest request wins. */
  function loadEntries() {
    const asked = ++entriesAsked;
    if (!waitingCount(state)) { entries = []; changed(); return Promise.resolve(entries); }
    entriesRun = Promise.resolve().then(() => PO.pending()).then((list) => {
      if (asked !== entriesAsked) return entries;
      entries = Array.isArray(list) ? list : [];
      changed();
      return entries;
    }, () => entries);
    return entriesRun;
  }

  let syncedAt = 0;
  /** "All changes sent" is said only when the server took the last of them, never after a discard. */
  function maybeSent() {
    if (!syncedAt || Date.now() - syncedAt > 6000 || waitingCount(state) || !state.online) return;
    syncedAt = 0;
    flash('sent');
  }
  function onState(next) {
    const before = state;
    state = next || PO.state();
    maybeSent();
    const code = state.code || {};
    if (code.status === 'downloading' && !code.release) sawFirstDownload = true;
    if (sawFirstDownload && code.status === 'ready') { sawFirstDownload = false; flash('ready'); }
    changed();
    if (before.pending !== state.pending || before.failed !== state.failed || before.conflicts !== state.conflicts) loadEntries();
  }
  PO.on('state', onState);
  PO.on('code', () => onState(PO.state()));
  for (const type of ['queued', 'synced', 'failed', 'conflict', 'discarded']) {
    PO.on(type, () => { state = PO.state(); if (type === 'synced') { syncedAt = Date.now(); maybeSent(); } loadEntries(); });
  }
  if (PO.ready && PO.ready.then) PO.ready.then(() => onState(PO.state())).catch(() => {});
  window.addEventListener('fm:language:updated', changed);
  try { const language = window.PlatformLanguage; if (language && language.ensure) Promise.resolve(language.ensure([NS])).then(changed, () => {}); } catch (_) { /* no catalog: English */ }

  /**
   * The engine learns that the connection is back from the next request that gets an answer. When the browser
   * says it is online again and nothing else asks, the top page asks: one small read through the worker, only
   * while the indicator still says Offline.
   */
  function probe() {
    if (!isTop || state.online || navigator.onLine === false || document.hidden || !state.controlled) return;
    fetch('/v1/platform/offline/assets', { cache: 'no-store', credentials: 'same-origin' }).catch(() => {});
  }
  window.addEventListener('online', () => setTimeout(probe, 800));
  setInterval(probe, 15000);

  // ---------------------------------------------------------------------------------------------------------
  // The indicator
  // ---------------------------------------------------------------------------------------------------------

  const slot = h('div', { class: 'fmo-slot', hidden: true });
  const pill = h('button', { type: 'button', class: 'fmo-pill', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', on: { click: () => api.open({ anchor: pill }) } });
  slot.append(pill);
  let announced = '';
  let live = null;

  /** Where the chrome is in this frame: the project window's header, the phone bar, the top bar, the sidebar. */
  function chromeHost() {
    const shown = (node) => !!node && node.getClientRects().length > 0;
    const identity = document.querySelector('#rOverlay .r-window-identity');
    if (inProjectWindow || (identity && shown(identity) && !isTop)) {
      if (!identity) return null;
      const trigger = identity.querySelector('#rProjectIdentityTrigger');
      const phone = !!identity.closest('[data-window-mobile=true]');
      return { host: 'project', parent: identity, before: trigger ? trigger.nextSibling : null, size: phone ? 'tiny' : 'short' };
    }
    const mobile = document.querySelector('.mobile-topbar');
    const logo = mobile && mobile.querySelector('.mob-logo');
    if (shown(mobile) && logo) return { host: 'mobile', parent: logo, before: null, size: 'compact' };
    const bar = document.getElementById('platformTopbar');
    if (shown(bar)) return { host: 'topbar', parent: bar, before: bar.querySelector('.platform-search'), size: 'auto' };
    const sidebar = document.getElementById('mainSidebar');
    const footer = sidebar && sidebar.querySelector('.sidebar-footer');
    if (shown(sidebar) && footer) return { host: 'sidebar', parent: footer.parentElement, before: footer, size: 'auto' };
    const shell = document.querySelector('header.app-header .header-actions');
    if (shown(shell)) return { host: 'shell', parent: shell, before: shell.firstChild, size: 'compact' };
    if (mobile || bar || sidebar || document.querySelector('header.app-header') || !isTop) return null;   // chrome exists but is not shown yet (booting), or a frame without chrome
    return document.body ? { host: 'float', parent: document.body, before: null, size: 'short' } : null;
  }

  function placeIndicator() {
    const place = chromeHost();
    if (!place) return;                          // no chrome on show yet: it stays where it is
    const before = place.before === slot ? slot.nextSibling : place.before;
    const there = slot.parentElement === place.parent && (place.host === 'float' || slot.nextSibling === before);
    if (!there) place.parent.insertBefore(slot, before);
    slot.dataset.host = place.host;
    if (place.size === 'auto') delete slot.dataset.size; else slot.dataset.size = place.size;
  }

  function renderIndicator() {
    placeIndicator();
    const now = situation(state);
    slot.hidden = !now && !slot.querySelector('.fmo-proj:not([hidden])');
    pill.hidden = !now;
    if (!now) { announced = ''; return; }
    const key = [now.mode, now.long, now.short, now.compact, now.tiny, now.progress].join('|');
    if (pill.dataset.key !== key) {
      pill.dataset.key = key;
      pill.dataset.mode = now.mode;
      pill.dataset.tone = now.tone;
      const text = h('span', { class: 'fmo-text' }, h('span', { class: 'fmo-l', text: now.long }), h('span', { class: 'fmo-s', text: now.short }), h('span', { class: 'fmo-c', text: now.compact }), h('span', { class: 'fmo-t', text: now.tiny || '' }));
      const bar = now.mode === 'download' ? h('span', { class: 'fmo-bar', 'aria-hidden': 'true' }, h('span', { style: 'width:' + now.progress + '%' })) : null;
      pill.replaceChildren(icon(document, now.icon), text, bar || '');
      pill.setAttribute('aria-label', now.long + ' ' + T('ind_open'));
      pill.title = now.long;
    }
    // Screen readers hear a change of situation once, not every step of a download or each count.
    if (isTop && announced !== now.mode + ':' + (now.mode === 'download' ? '' : now.count)) {
      announced = now.mode + ':' + (now.mode === 'download' ? '' : now.count);
      if (!live) { live = h('div', { class: 'fmo-sr', role: 'status', 'aria-live': 'polite' }); (document.body || document.documentElement).append(live); }
      live.textContent = now.long;
    }
  }
  listeners.add(renderIndicator);

  // The chrome appears, changes layout and (in the project window) is built after this file runs.
  const watchSizes = window.ResizeObserver ? new ResizeObserver(() => renderIndicator()) : null;
  const watched = new WeakSet();
  function watchChrome() {
    for (const node of [document.querySelector('.mobile-topbar'), document.getElementById('platformTopbar'), document.getElementById('mainSidebar'), document.querySelector('#rOverlay .r-window-bar'), document.body]) {
      if (node && watchSizes && !watched.has(node)) { watched.add(node); watchSizes.observe(node); }
    }
    renderIndicator();
  }
  for (const type of ['fm:platform-topbar-visibility', 'fm:project-modal:hydrated', 'load', 'resize']) window.addEventListener(type, watchChrome);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchChrome, { once: true });
  if (window.MutationObserver && document.documentElement) {
    // The project window's header is created when the first project opens; the boot cover lifts by a body class.
    const chromeWatch = new MutationObserver(() => { if (!slot.isConnected || !slot.getClientRects().length) watchChrome(); });
    const start = () => { if (document.body) chromeWatch.observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] }); };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  // ---------------------------------------------------------------------------------------------------------
  // The layer in the top page: tray, conflict view, device settings, dialogs
  // ---------------------------------------------------------------------------------------------------------

  /** The instance in the top page draws everything that floats, so it sits above the project window. */
  function topUi() {
    if (isTop) return null;
    try { return window.top.PlatformOfflineUI || null; } catch (_) { return null; }
  }
  /** A node's box in this frame's page, as the top page sees it. */
  function topRect(node) {
    if (!node || !node.getBoundingClientRect) return null;
    const rect = node.getBoundingClientRect();
    let left = rect.left, top = rect.top;
    try {
      for (let win = node.ownerDocument.defaultView; win && win !== win.parent; win = win.parent) {
        const frame = win.frameElement;
        if (!frame) break;
        const box = frame.getBoundingClientRect();
        left += box.left + frame.clientLeft; top += box.top + frame.clientTop;
      }
    } catch (_) { /* a frame we cannot see into */ }
    return { left, top, right: left + rect.width, bottom: top + rect.height, width: rect.width, height: rect.height };
  }

  const view = { open: false, name: 'list', entry: null, choices: {}, confirm: null, busy: {}, errors: {}, sending: false, flash: null, conflictError: '', anchor: null, restore: null };
  let layer = null, scrim = null, tray = null, popover = null, dialog = null;

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = h('div', { class: 'fmo-layer', hidden: true });
    scrim = h('div', { class: 'fmo-scrim', on: { click: () => { closePopover(); closeTray(); } } });
    layer.append(scrim);
    (document.body || document.documentElement).append(layer);
    return layer;
  }
  function syncLayer() {
    if (!layer) return;
    const any = view.open || !!popover || !!dialog;
    layer.hidden = !any;
    scrim.hidden = !(view.open || popover);
    if (view.open) layer.dataset.open = ''; else delete layer.dataset.open;
  }

  /** Puts a floating panel beside its anchor, inside the layer. A narrow layer makes the tray a sheet in CSS. */
  function position(panel, anchor) {
    const width = layer.clientWidth, height = layer.clientHeight;
    // The same width at which the layer's container query turns the tray into a bottom sheet.
    if (width < 640) { panel.style.maxHeight = ''; panel.style.left = ''; panel.style.top = ''; if (panel !== tray) { panel.style.top = Math.round(Math.max(12, Math.min(anchor ? anchor.bottom + 8 : 60, height - panel.getBoundingClientRect().height - 12))) + 'px'; } return; }
    const rect = anchor || { left: width - 12, right: width - 12, top: 46, bottom: 46, width: 0, height: 0 };
    const own = panel.getBoundingClientRect();
    const below = height - rect.bottom - 20, above = rect.top - 20;
    const under = below >= Math.min(own.height, 360) || below >= above;
    const room = Math.max(160, under ? below : above);
    panel.style.maxHeight = Math.min(room, height - 24) + 'px';
    const tall = Math.min(panel.getBoundingClientRect().height, room);
    const top = under ? rect.bottom + 8 : rect.top - 8 - tall;
    const center = (rect.left + rect.right) / 2;
    let left = center > width / 2 ? rect.right - own.width : rect.left;
    left = Math.max(12, Math.min(left, width - own.width - 12));
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(Math.max(12, Math.min(top, height - tall - 12))) + 'px';
  }

  function focusables(root) {
    return [...root.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((node) => node.getClientRects().length);
  }
  /** Tab stays inside the open panel; Escape closes it before anything behind it hears the key. */
  function onKeydown(event) {
    const panel = dialog || popover || (view.open ? tray : null);
    if (!panel) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (dialog) dialog.__answer(false); else if (popover) closePopover(); else if (view.name !== 'list') showView('list'); else closeTray();
      return;
    }
    if (event.key !== 'Tab') return;
    const list = focusables(panel);
    if (!list.length) { event.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1], active = document.activeElement;
    if (!panel.contains(active)) { event.preventDefault(); first.focus(); }
    else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  }
  window.addEventListener('keydown', onKeydown, true);

  function openTray(options) {
    const other = topUi();
    if (other && other !== api) {
      const anchor = options && options.anchor;
      return other.open(Object.assign({}, options, { anchor: null, rect: anchor ? topRect(anchor) : (options && options.rect) || null, restore: anchor || null }));
    }
    ensureLayer();
    if (!tray) {
      tray = h('section', { class: 'fmo-tray', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fmoTrayTitle', tabindex: '-1' });
      layer.append(tray);
    }
    closePopover();
    const anchor = options && options.anchor;
    view.open = true;
    view.anchor = anchor ? () => topRect(anchor) : options && options.rect ? () => options.rect : () => (pill.isConnected && !pill.hidden ? topRect(pill) : null);
    view.restore = (options && options.restore) || anchor || (document.activeElement !== document.body ? document.activeElement : null);
    view.name = 'list'; view.entry = null; view.confirm = null; view.conflictError = '';
    view.flash = options && options.entry ? String(options.entry) : null;
    if (options && options.view === 'device') view.name = 'device';
    pill.setAttribute('aria-expanded', 'true');
    syncLayer();
    renderTray();
    loadEntries().then(() => {
      if (!view.open) return;
      const record = options && options.record;
      const target = record ? entries.find((entry) => (entry.records || []).map(String).includes(String(record)) && entry.state !== 'waiting' && entry.state !== 'delegated') || entries.find((entry) => (entry.records || []).map(String).includes(String(record))) : null;
      if (target) { view.flash = target.id; if (target.state === 'conflict') { showView('conflict', target.id); return; } renderTray(); }
    });
    (tray.querySelector('[data-autofocus]') || tray).focus({ preventScroll: true });
    return true;
  }

  function closeTray() {
    if (!view.open) return;
    view.open = false;
    pill.setAttribute('aria-expanded', 'false');
    if (settingsStop) { settingsStop(); settingsStop = null; }
    syncLayer();
    const back = view.restore;
    view.restore = null;
    try { if (back && back.isConnected && back.focus) back.focus({ preventScroll: true }); } catch (_) { /* gone */ }
  }

  function showView(name, entryId) {
    view.name = name;
    view.entry = entryId || null;
    view.confirm = null;
    view.conflictError = '';
    if (name === 'conflict') view.choices = {};
    renderTray();
    (tray.querySelector('[data-autofocus]') || tray).focus({ preventScroll: true });
  }

  const entryOf = (id) => entries.find((entry) => entry.id === id) || null;
  function entryWords(entry) {
    const label = entry.label && typeof entry.label === 'object' ? entry.label : { title: typeof entry.label === 'string' ? entry.label : '' };
    const title = labelText(label.key, label.title) || T('kind_' + (STRINGS['kind_' + entry.kind] ? entry.kind : 'action'));
    return { title, detail: label.detail ? String(label.detail) : '' };
  }
  function errorWords(entry) {
    if (entry.state === 'parked') return T('error_parked');
    const error = entry.error || {};
    const status = Number(error.status) || 0;
    const reason = status === 404 || status === 410 ? T('error_not_found') : status === 403 ? T('error_forbidden') : status >= 500 ? T('error_server') : T('error_refused', { status: status || '?' });
    const said = error.message && !/^[a-z0-9_.-]+$/i.test(String(error.message)) ? String(error.message) : '';
    return said && said !== reason ? reason + ' ' + said : reason;
  }

  let settingsStop = null;
  function renderTray() {
    if (!tray || !view.open) return;
    if (view.name === 'conflict' && (!entryOf(view.entry) || entryOf(view.entry).state !== 'conflict')) { view.name = 'list'; view.entry = null; }
    const focusKey = document.activeElement && tray.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
    const scrollTop = tray.querySelector('.fmo-body') ? tray.querySelector('.fmo-body').scrollTop : 0;
    const sameView = tray.dataset.view === view.name;
    if (settingsStop && view.name !== 'device') { settingsStop(); settingsStop = null; }
    tray.dataset.view = view.name;
    const close = h('button', { type: 'button', class: 'fmo-iconbtn', 'aria-label': T('tray_close'), title: T('tray_close'), 'data-fk': 'close', on: { click: closeTray } }, icon(document, 'close'));
    const back = () => h('button', { type: 'button', class: 'fmo-iconbtn', 'aria-label': T('tray_back'), title: T('tray_back'), 'data-fk': 'back', on: { click: () => showView('list') } }, icon(document, 'back'));
    if (view.name === 'device') {
      if (sameView && settingsStop) return;                 // the settings panel keeps itself current
      const body = h('div', { class: 'fmo-body' });
      tray.replaceChildren(h('header', { class: 'fmo-head' }, back(), h('h2', { id: 'fmoTrayTitle', text: T('tray_device'), 'data-autofocus': true, 'data-fk': 'title', tabindex: '-1' }), close), body);
      settingsStop = mountSettings(body, { inTray: true });
    } else if (view.name === 'conflict') {
      tray.replaceChildren(h('header', { class: 'fmo-head' }, back(), h('h2', { id: 'fmoTrayTitle', text: T('conflict_title'), 'data-autofocus': true, 'data-fk': 'title', tabindex: '-1' }), close), ...conflictParts(entryOf(view.entry)));
    } else {
      const device = h('button', { type: 'button', class: 'fmo-iconbtn', 'aria-label': T('tray_device'), title: T('tray_device'), 'data-fk': 'device', on: { click: () => showView('device') } }, icon(document, 'device'));
      tray.replaceChildren(h('header', { class: 'fmo-head' }, h('h2', { id: 'fmoTrayTitle', text: T('tray_title'), 'data-autofocus': true, 'data-fk': 'title', tabindex: '-1' }), device, close), listBody(), listFoot());
    }
    const body = tray.querySelector('.fmo-body');
    if (body && sameView) body.scrollTop = scrollTop;
    if (focusKey) { const again = [...tray.querySelectorAll('[data-fk]')].find((node) => node.dataset.fk === focusKey); if (again) again.focus({ preventScroll: true }); else if (sameView) tray.focus({ preventScroll: true }); }
    position(tray, view.anchor ? view.anchor() : null);
  }
  listeners.add(renderTray);
  window.addEventListener('resize', () => { if (view.open && tray) position(tray, view.anchor ? view.anchor() : null); });

  function statusBlock() {
    const now = situation(state);
    const code = state.code || {};
    const tone = now ? now.tone : 'good';
    const block = h('div', { class: 'fmo-status', 'data-tone': tone }, icon(document, now ? now.icon : 'sent'));
    const words = h('div', { style: 'min-width:0;flex:1' }, h('p', { text: now ? now.long : T('tray_none') }));
    if (now && now.mode === 'offline' && !now.count && state.savedPage) words.append(h('small', { text: T('tray_offline_note') }));
    if (state.lastSyncAt) words.append(h('small', { text: T('tray_last_sent', { when: when(state.lastSyncAt) }) }));
    if (now && now.mode === 'download') words.append(h('div', { class: 'fmo-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(now.progress) }, h('span', { style: 'width:' + now.progress + '%' })));
    const actions = h('div', { class: 'fmo-actions' });
    if (state.blocked === 'sign-in') actions.append(h('button', { type: 'button', class: 'fmo-btn primary', 'data-fk': 'signin', text: T('tray_sign_in'), on: { click: () => { window.location.assign('/portal/login.php'); } } }));
    if (state.savedPage && state.online && code.status !== 'downloading') {
      words.append(h('small', { text: T('tray_saved_copy') }));
      // A reload a person asks for. Nothing else in this file loads a page.
      actions.append(h('button', { type: 'button', class: 'fmo-btn', 'data-fk': 'latest', text: T('tray_load_latest'), on: { click: () => { window.location.reload(); } } }));
    }
    if (actions.childNodes.length) words.append(actions);
    block.append(words);
    return block;
  }

  function entryRow(entry) {
    const words = entryWords(entry);
    const shownState = entry.state === 'delegated' ? 'waiting' : entry.state;
    const chipText = { waiting: T('entry_waiting'), delegated: T('entry_background'), failed: T('entry_failed'), parked: T('entry_failed'), conflict: T('entry_conflict') }[entry.state] || T('entry_waiting');
    const row = h('li', { class: 'fmo-entry', 'data-entry': entry.id, 'data-state': shownState, 'data-flash': view.flash === entry.id ? true : null },
      h('span', { class: 'fmo-kind', 'aria-hidden': 'true' }, icon(document, ICONS[entry.kind] ? entry.kind : 'action')),
      h('div', { class: 'fmo-entry-main' },
        h('div', { class: 'fmo-entry-title', text: words.title }),
        words.detail ? h('div', { class: 'fmo-entry-detail', text: words.detail }) : null,
        h('div', { class: 'fmo-entry-meta', text: T('entry_made', { when: when(entry.createdAt) }) }),
        entry.state === 'failed' || entry.state === 'parked' ? h('div', { class: 'fmo-entry-error', text: errorWords(entry) }) : null,
        view.errors[entry.id] ? h('div', { class: 'fmo-entry-error', role: 'alert', text: view.errors[entry.id] }) : null),
      h('span', { class: 'fmo-chip', 'data-state': entry.state, text: chipText }));
    const busy = !!view.busy[entry.id];
    const act = (run) => async () => {
      view.busy[entry.id] = true; delete view.errors[entry.id]; view.confirm = null; renderTray();
      try { await run(); } catch (_) { view.errors[entry.id] = T('entry_action_failed'); }
      delete view.busy[entry.id];
      state = PO.state();
      await loadEntries();
      renderTray();
    };
    if (entry.state === 'conflict') {
      row.append(h('div', { class: 'fmo-entry-actions' }, h('button', { type: 'button', class: 'fmo-btn primary', 'data-fk': 'review:' + entry.id, text: T('entry_review'), on: { click: () => showView('conflict', entry.id) } })));
    } else if (entry.state === 'failed' || entry.state === 'parked') {
      if (view.confirm === entry.id) {
        row.append(h('div', { class: 'fmo-entry-actions', role: 'group' },
          h('p', { text: T('entry_discard_ask') }),
          h('button', { type: 'button', class: 'fmo-btn danger solid', disabled: busy, 'data-fk': 'discard-yes:' + entry.id, text: T('entry_discard_yes'), on: { click: act(() => PO.discard(entry.id)) } }),
          h('button', { type: 'button', class: 'fmo-btn', 'data-fk': 'discard-no:' + entry.id, text: T('entry_discard_no'), on: { click: () => { view.confirm = null; renderTray(); const again = tray.querySelector('[data-fk="discard:' + entry.id + '"]'); if (again) again.focus(); } } })));
      } else {
        row.append(h('div', { class: 'fmo-entry-actions' },
          h('button', { type: 'button', class: 'fmo-btn', disabled: busy, 'data-fk': 'retry:' + entry.id, on: { click: act(() => PO.retry(entry.id)) } }, icon(document, 'retry'), T('entry_retry')),
          h('button', { type: 'button', class: 'fmo-btn danger', disabled: busy, 'data-fk': 'discard:' + entry.id, text: T('entry_discard'), on: { click: () => { view.confirm = entry.id; renderTray(); const yes = tray.querySelector('[data-fk="discard-no:' + entry.id + '"]'); if (yes) yes.focus(); } } })));
      }
    }
    return row;
  }

  function listBody() {
    const body = h('div', { class: 'fmo-body' }, statusBlock());
    const storage = state.storage || {};
    if (waitingCount(state) && storage.persisted === false && !isNative()) {
      body.append(h('div', { class: 'fmo-warn', role: 'note' }, h('strong', { text: T('tray_storage_warning_title') }), T('tray_storage_warning')));
    }
    const needs = entries.filter((entry) => entry.state === 'failed' || entry.state === 'parked' || entry.state === 'conflict');
    const waits = entries.filter((entry) => !needs.includes(entry));
    if (needs.length) body.append(h('h3', { class: 'fmo-group', text: T('tray_attention_heading') }), h('ul', { class: 'fmo-list' }, ...needs.map(entryRow)));
    if (waits.length) body.append(h('h3', { class: 'fmo-group', text: T('tray_waiting_heading') }), h('ul', { class: 'fmo-list' }, ...waits.map(entryRow)));
    return body;
  }

  function listFoot() {
    const can = (state.pending || 0) > 0 || state.blocked === 'sign-in';
    const send = h('button', { type: 'button', class: 'fmo-btn primary', disabled: !can || view.sending, 'data-fk': 'send', text: view.sending ? T('tray_sending') : T('tray_send_now'), on: { click: async () => {
      view.sending = true; renderTray();
      try { await PO.syncNow(); } catch (_) { /* the state says what happened */ }
      view.sending = false; state = PO.state();
      await loadEntries(); renderTray();
    } } });
    return h('footer', { class: 'fmo-foot' }, h('span', { class: 'fmo-grow', text: T('set_waiting', { count: state.pending || 0 }) }), send);
  }

  // --- conflicts ---

  const humanize = (key) => { const text = String(key).replace(/^#/, '').replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim(); return text ? text[0].toUpperCase() + text.slice(1) : text; };
  function fieldName(path) {
    const parts = String(path).split('.');
    if (parts[parts.length - 1] === '#order') return T('conflict_order', { name: humanize(parts[parts.length - 2] || 'items').toLowerCase() });
    return parts.map(humanize).join(' › ');
  }
  const NAME_KEYS = ['name', 'title', 'label', 'full_name', 'display_name', 'email', 'text', 'description'];
  const nameOf = (item) => { for (const key of NAME_KEYS) if (item && typeof item[key] === 'string' && item[key].trim()) return item[key].trim(); return null; };
  function scalar(value) {
    if (typeof value === 'boolean') return T(value ? 'value_yes' : 'value_no');
    if (typeof value === 'number') { try { return new Intl.NumberFormat(locale(), { maximumFractionDigits: 6 }).format(value); } catch (_) { return String(value); } }
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) { const [y, m, d] = value.split('-').map(Number); return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(new Date(y, m - 1, d)); }
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value))) return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
      return value;
    }
    return String(value);
  }
  const isEmpty = (value) => value == null || value === '' || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
  /** A value as a person reads it: text, numbers, dates, lists of names. JSON only as the last resort. */
  function readable(value, depth) {
    const level = depth || 0;
    if (isEmpty(value)) return h('span', { class: 'fmo-value', 'data-empty': true, 'data-fmr-ignore': true, text: T(Array.isArray(value) ? 'value_none' : 'value_empty') });
    const box = h('span', { class: 'fmo-value', 'data-fmr-ignore': true });
    if (typeof value !== 'object') { box.textContent = scalar(value); return box; }
    if (Array.isArray(value)) {
      const words = value.map((item) => (item != null && typeof item === 'object' ? (Array.isArray(item) ? null : nameOf(item)) : scalar(item)));
      if (words.every((word) => word != null)) {
        if (words.join(', ').length <= 80 && words.every((word) => !/[,\n]/.test(word))) { box.textContent = words.join(', '); return box; }
        box.append(h('ul', null, ...words.map((word) => h('li', { text: word }))));
        return box;
      }
      box.textContent = T('value_items', { count: value.length });
      return box;
    }
    const name = nameOf(value);
    const simple = Object.entries(value).filter(([key, item]) => key !== 'id' && (item == null || typeof item !== 'object'));
    if (level === 0 && simple.length && simple.length === Object.keys(value).filter((key) => key !== 'id').length && simple.length <= 8) {
      const list = h('dl');
      for (const [key, item] of simple) list.append(h('dt', { text: humanize(key) }), h('dd', { text: isEmpty(item) ? T('value_empty') : scalar(item) }));
      box.append(list);
      return box;
    }
    if (name) { box.textContent = name; return box; }
    try { box.textContent = JSON.stringify(value, null, 1); } catch (_) { box.textContent = String(value); }
    return box;
  }
  function plain(value) { const node = readable(value, 1); return node.textContent; }

  function conflictParts(entry) {
    const fields = (entry.conflict && entry.conflict.fields) || [];
    const words = entryWords(entry);
    const left = fields.filter((field) => !view.choices[field.path]).length;
    const choose = (path, side) => { view.choices[path] = side; view.conflictError = ''; renderTray(); };
    const all = (side) => () => { for (const field of fields) view.choices[field.path] = side; view.conflictError = ''; renderTray(); };
    const body = h('div', { class: 'fmo-body' });
    const inner = h('div', { class: 'fmo-conflict' },
      h('div', { class: 'fmo-conflict-what' }, h('strong', { text: words.title }), words.detail ? h('span', { 'data-fmr-ignore': true, text: words.detail }) : null),
      h('p', { text: T('conflict_intro') }),
      h('div', { class: 'fmo-conflict-all' },
        h('button', { type: 'button', class: 'fmo-btn', 'data-fk': 'all-mine', text: T('conflict_all_mine'), on: { click: all('mine') } }),
        h('button', { type: 'button', class: 'fmo-btn', 'data-fk': 'all-theirs', text: T('conflict_all_theirs'), on: { click: all('theirs') } })));
    fields.forEach((field, index) => {
      const group = 'fmo-choice-' + index;
      const side = (which, label, value) => h('label', { class: 'fmo-side', 'data-side': which },
        h('input', { type: 'radio', name: group, value: which, checked: view.choices[field.path] === which ? true : null, 'data-fk': 'pick:' + index + ':' + which, on: { change: () => choose(field.path, which) } }),
        h('b', { text: label }), readable(value));
      const set = h('div', { class: 'fmo-field', role: 'radiogroup', 'aria-labelledby': group + '-name', 'data-path': field.path }, h('div', { class: 'fmo-field-name', id: group + '-name', text: fieldName(field.path) }));
      if (!isEmpty(field.base)) set.append(h('p', { class: 'fmo-before', 'data-fmr-ignore': true, text: T('conflict_before', { value: plain(field.base) }) }));
      set.append(h('div', { class: 'fmo-sides' }, side('mine', T('conflict_mine'), field.mine), side('theirs', T('conflict_theirs'), field.theirs)));
      inner.append(set);
    });
    // `checked` set as an attribute does not survive a redraw of a group the person already used.
    for (const input of inner.querySelectorAll('input[type=radio]')) input.checked = view.choices[input.closest('.fmo-field').dataset.path] === input.value;
    body.append(inner);
    const busy = !!view.busy[entry.id];
    const send = h('button', { type: 'button', class: 'fmo-btn primary', disabled: left > 0 || busy, 'data-fk': 'resolve', text: T('conflict_send'), on: { click: async () => {
      const choices = {};
      for (const field of fields) choices[field.path] = view.choices[field.path];
      view.busy[entry.id] = true; view.conflictError = ''; renderTray();
      try {
        await PO.resolve(entry.id, choices);
        delete view.busy[entry.id];
        state = PO.state();
        await loadEntries();
        if (view.open && view.name === 'conflict' && view.entry === entry.id) showView('list');
      } catch (_) {
        delete view.busy[entry.id];
        view.conflictError = T('conflict_failed');
        renderTray();
      }
    } } });
    const note = view.conflictError ? h('span', { class: 'fmo-grow fmo-note', 'data-tone': 'error', role: 'alert', text: view.conflictError }) : h('span', { class: 'fmo-grow', 'aria-live': 'polite', text: left ? T('conflict_remaining', { count: left }) : T('conflict_ready') });
    return [body, h('footer', { class: 'fmo-foot' }, note, send)];
  }

  // --- a small panel beside a button (the project control) ---

  function closePopover() {
    if (!popover) return;
    const back = popover.__restore;
    popover.remove(); popover = null;
    syncLayer();
    try { if (back && back.isConnected) back.focus({ preventScroll: true }); } catch (_) { /* gone */ }
  }
  /** Shows a panel built by `build(panel, redraw)` beside `rect` (top-page coordinates). Returns a function that redraws it. */
  function openPopover(rect, build, restore) {
    ensureLayer();
    closePopover();
    if (view.open) closeTray();
    const panel = h('section', { class: 'fmo-pop', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' });
    panel.__restore = restore || null;
    popover = panel;
    layer.append(panel);
    const redraw = () => {
      if (popover !== panel) return;
      const key = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      build(panel);
      position(panel, rect);
      const again = key && [...panel.querySelectorAll('[data-fk]')].find((node) => node.dataset.fk === key);
      if (again) again.focus({ preventScroll: true }); else if (key) (panel.querySelector('button:not([disabled])') || panel).focus({ preventScroll: true });
    };
    syncLayer();
    redraw();
    (panel.querySelector('button') || panel).focus({ preventScroll: true });
    return redraw;
  }

  // --- the question before signing out ---

  function ask(title, body, yes, no) {
    const other = topUi();
    if (other && other !== api && other._ask) return other._ask(title, body, yes, no);
    ensureLayer();
    if (dialog) dialog.__answer(false);
    return new Promise((resolve) => {
      const restore = document.activeElement;
      const wrap = h('div', { class: 'fmo-dialog-wrap' });
      const answer = (value) => {
        if (dialog !== wrap) return;
        wrap.remove(); dialog = null; syncLayer();
        try { if (restore && restore.isConnected && restore.focus) restore.focus({ preventScroll: true }); } catch (_) { /* gone */ }
        resolve(value);
      };
      wrap.__answer = answer;
      const stay = h('button', { type: 'button', class: 'fmo-btn primary', text: no, on: { click: () => answer(false) } });
      wrap.append(h('div', { class: 'fmo-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'fmoAskTitle', 'aria-describedby': 'fmoAskBody' },
        h('h2', { id: 'fmoAskTitle', text: title }), h('p', { id: 'fmoAskBody', text: body }),
        h('div', { class: 'fmo-actions' }, h('button', { type: 'button', class: 'fmo-btn', text: yes, on: { click: () => answer(true) } }), stay)));
      wrap.addEventListener('click', (event) => { if (event.target === wrap) answer(false); });
      dialog = wrap;
      layer.append(wrap);
      syncLayer();
      stay.focus({ preventScroll: true });
    });
  }

  /**
   * Resolves true when it is fine to sign out: at once with nothing waiting, else after the person said so.
   * Their changes stay on this device and are sent the next time they sign in here.
   */
  function confirmSignOut() {
    const count = waitingCount(PO.state());
    if (!count) return Promise.resolve(true);
    return ask(T('signout_title'), T('signout_body', { count }), T('signout_leave'), T('signout_stay'));
  }

  // Sign-out links (the phone shell's menu, the sidebar's link). On window, so it runs before the page's own handlers.
  let leaving = false;
  window.addEventListener('click', (event) => {
    const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link || leaving || event.defaultPrevented) return;
    let path = '';
    try { path = new URL(link.href, location.href).pathname; } catch (_) { return; }
    if (!/\/logout\.php$/.test(path) || !waitingCount(PO.state())) return;
    event.preventDefault(); event.stopImmediatePropagation();
    confirmSignOut().then((go) => {
      if (!go) return;
      leaving = true;
      try { link.click(); } finally { setTimeout(() => { leaving = false; }, 0); }
    });
  }, true);

  // ---------------------------------------------------------------------------------------------------------
  // waitingBadge({ record })
  // ---------------------------------------------------------------------------------------------------------

  const badges = new Set();                     // WeakRefs of the badges handed out
  function badgeState(record) {
    const id = String(record);
    const mine = entries.filter((entry) => (entry.records || []).map(String).includes(id));
    if (mine.some((entry) => entry.state === 'conflict')) return 'conflict';
    if (mine.some((entry) => entry.state === 'failed' || entry.state === 'parked')) return 'failed';
    if (mine.length || (PO.isPending && PO.isPending(id))) return 'waiting';
    return null;
  }
  function drawBadge(badge) {
    const now = badgeState(badge.dataset.record);
    badge.hidden = !now;
    if (!now) { delete badge.dataset.state; return; }
    if (badge.dataset.state === now && badge.dataset.words === T('badge_' + now)) return;
    badge.dataset.state = now;
    badge.dataset.words = T('badge_' + now);
    badge.replaceChildren(icon(badge.ownerDocument, now === 'waiting' ? 'waiting' : now === 'failed' ? 'attention' : 'conflict'), el(badge.ownerDocument, 'span', { text: T('badge_' + now) }));
    badge.title = T('badge_' + now + '_tip');
    badge.setAttribute('aria-label', T('badge_' + now) + '. ' + T('badge_' + now + '_tip'));
    // A waiting mark only informs. One that needs the person opens the tray at that change.
    if (now === 'waiting') { badge.removeAttribute('role'); badge.removeAttribute('tabindex'); }
    else { badge.setAttribute('role', 'button'); badge.setAttribute('tabindex', '0'); }
  }
  function drawBadges() {
    for (const ref of [...badges]) {
      const badge = ref.deref ? ref.deref() : ref;
      if (!badge) { badges.delete(ref); continue; }
      drawBadge(badge);
    }
  }
  listeners.add(drawBadges);

  /**
   * An element that shows itself only while a change naming this record is waiting, failed or in conflict, and
   * follows the queue. Put it wherever the record is drawn; it needs no cleanup.
   */
  function waitingBadge(options) {
    const record = options && options.record != null ? String(options.record) : '';
    const badge = h('span', { class: 'fmo-badge', hidden: true, 'data-record': record, 'data-compact': options && options.compact ? true : null });
    const act = (event) => {
      if (badge.dataset.state !== 'failed' && badge.dataset.state !== 'conflict') return;
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); event.stopPropagation();
      api.open({ anchor: badge, record });
    };
    badge.addEventListener('click', act);
    badge.addEventListener('keydown', act);
    badges.add(window.WeakRef ? new WeakRef(badge) : badge);
    drawBadge(badge);
    if (waitingCount(state) && !entries.length) loadEntries();
    return badge;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Projects: "Available offline" in the project window, a mark in lists while offline
  // ---------------------------------------------------------------------------------------------------------

  let pins = [];
  let pinsAt = 0;
  let pinsRun = null;
  function loadPins() {
    if (!state.controlled) return Promise.resolve(pins);
    if (!pinsRun) {
      pinsRun = Promise.resolve().then(() => PO.pinned()).then((list) => { pins = Array.isArray(list) ? list : []; }, () => {}).then(() => { pinsAt = Date.now(); pinsRun = null; drawProject(); drawMarks(); return pins; });
    }
    return pinsRun;
  }
  const orgId = () => String(APP.userOrgId || '');

  // --- the project window ---

  let projectId = inProjectWindow ? (new URLSearchParams(location.search).get('project') || '') : '';
  let projectBusy = '';
  let projectError = '';
  let projectRedraw = null;
  const projectButton = h('button', { type: 'button', class: 'fmo-proj', hidden: true, 'aria-haspopup': 'dialog', on: { click: () => openProjectPanel() } });

  function currentProject() {
    try {
      const active = window.activeBaseProject;
      const id = active && (active.platform_project_id || active.id);
      if (id) return String(id);
    } catch (_) { /* not defined in this frame */ }
    return projectId;
  }
  function projectPin() {
    const id = currentProject();
    if (!id) return { id: '', state: 'none' };
    const pin = pins.find((item) => String(item.project) === id && (!item.org || String(item.org) === orgId()));
    if (projectBusy === 'keep' || (pin && !pin.refreshedAt)) return { id, pin, state: 'downloading' };
    return { id, pin, state: pin ? 'saved' : 'none' };
  }
  function projectWords(now) {
    if (now.state === 'downloading') return [T('project_downloading'), state.online ? '' : T('project_waits_for_connection')];
    if (now.state === 'saved') return [T('project_saved', { when: when(now.pin.refreshedAt) }), T(now.pin.auto ? 'project_auto' : 'project_chosen')];
    return [T('project_not_saved'), state.online ? '' : T('project_waits_for_connection')];
  }
  function drawProject() {
    if (!projectButton.isConnected && !inProjectWindow) return;
    const now = projectPin();
    const show = !!now.id && !!state.controlled && slot.dataset.host === 'project';
    if (show && projectButton.parentElement !== slot) slot.prepend(projectButton);
    projectButton.hidden = !show;
    slot.hidden = pill.hidden && projectButton.hidden;
    if (!show) return;
    const key = now.state + '|' + (now.pin ? now.pin.refreshedAt + '|' + now.pin.auto : '');
    if (projectButton.dataset.key !== key) {
      projectButton.dataset.key = key;
      projectButton.dataset.state = now.state;
      projectButton.replaceChildren(now.state === 'downloading' ? icon(document, 'fa-circle-notch', 'fmo-spin') : now.state === 'saved' ? icon(document, 'fa-circle-check') : icon(document, 'download'));
      const words = projectWords(now).filter(Boolean).join(' ');
      projectButton.setAttribute('aria-label', T('project_title') + '. ' + words);
      projectButton.setAttribute('data-fm-tooltip', T('project_title') + ': ' + projectWords(now)[0]);
    }
    if (projectRedraw) projectRedraw();
  }
  listeners.add(drawProject);

  async function projectAct(kind, run) {
    projectBusy = kind; projectError = ''; drawProject();
    try { await run(); } catch (_) { projectError = T('project_failed'); }
    projectBusy = '';
    await loadPins();
    drawProject();
  }
  function openProjectPanel() {
    const host = topUi() || api;
    const build = (panel) => {
      const now = projectPin();
      const doc = panel.ownerDocument;
      const words = projectWords(now);
      const actions = el(doc, 'div', { class: 'fmo-actions' });
      const button = (key, text, cls, run) => el(doc, 'button', { type: 'button', class: 'fmo-btn ' + cls, disabled: !!projectBusy, 'data-fk': key, text, on: { click: run } });
      if (now.state === 'none') actions.append(button('keep', T('project_keep'), 'primary', () => projectAct('keep', () => PO.pinProject(orgId(), now.id))));
      if (now.state === 'saved' && now.pin.auto) actions.append(button('always', T('project_keep_always'), 'primary', () => projectAct('always', () => PO.pinProject(orgId(), now.id))));
      if (now.pin) actions.append(button('remove', T('project_remove'), '', () => projectAct('remove', () => PO.unpinProject(orgId(), now.id))));
      panel.replaceChildren(
        el(doc, 'h2', { text: T('project_title') }),
        el(doc, 'p', { 'data-project-status': now.state, text: words[0] }),
        words[1] ? el(doc, 'p', { text: words[1] }) : '',
        projectError ? el(doc, 'p', { class: 'fmo-note', 'data-tone': 'error', role: 'alert', text: projectError }) : '',
        actions);
      panel.setAttribute('aria-label', T('project_title'));
    };
    loadPins();
    projectRedraw = host._popover(topRect(projectButton), build, projectButton);
  }
  window.addEventListener('fm:project-modal:hydrated', (event) => {
    projectId = String((event.detail && event.detail.projectId) || projectId || '');
    projectButton.dataset.key = '';
    loadPins();
    // Opening a project also keeps it (the app pins it as recently opened), which takes a moment to download.
    setTimeout(loadPins, 4000);
    setTimeout(loadPins, 15000);
  });
  if (inProjectWindow) setInterval(() => { if (!document.hidden && projectPin().state === 'downloading') loadPins(); }, 5000);

  // --- lists: which projects are on this device, shown only while offline ---

  const ROWS = '.v-tile[data-id],.v-lrow[data-id],.v-stage-card[data-id]';
  const TITLES = { 'v-tile': '.v-addr>div:first-child', 'v-lrow': '.v-laddr1', 'v-stage-card': '.v-stage-name' };
  let marksWatch = null;
  let marksQueued = false;
  function drawMarks() {
    marksQueued = false;
    const offline = !state.online && !!state.controlled;
    if (!offline) {
      if (marksWatch) { marksWatch.disconnect(); marksWatch = null; }
      for (const mark of document.querySelectorAll('.fmo-mark')) mark.remove();
      return;
    }
    if (!pinsAt) { loadPins(); return; }
    const saved = new Set(pins.filter((pin) => pin.refreshedAt && (!pin.org || String(pin.org) === orgId())).map((pin) => String(pin.project)));
    if (marksWatch) marksWatch.disconnect();
    for (const row of document.querySelectorAll(ROWS)) {
      const title = row.querySelector(TITLES[[...row.classList].find((name) => TITLES[name])] || '');
      const has = row.querySelector('.fmo-mark');
      if (!title || !saved.has(String(row.dataset.id))) { if (has) has.remove(); continue; }
      if (has) continue;
      title.append(h('span', { class: 'fmo-mark', role: 'img', 'aria-label': T('mark_saved'), title: T('mark_saved') }, icon(document, 'mark')));
    }
    if (!marksWatch && window.MutationObserver) marksWatch = new MutationObserver(() => { if (!marksQueued) { marksQueued = true; requestAnimationFrame(drawMarks); } });
    if (marksWatch && document.body) marksWatch.observe(document.body, { childList: true, subtree: true });
  }
  let wasOnline = state.online;
  listeners.add(() => { if (wasOnline !== state.online) { wasOnline = state.online; if (!state.online) loadPins(); drawMarks(); } });

  // ---------------------------------------------------------------------------------------------------------
  // Device settings
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Draws this device's offline settings into `host` and keeps them current. Used by the Settings app's Offline
   * page and by the tray's "This device". Returns a function that stops updating.
   */
  function mountSettings(host, options) {
    if (!host) return () => {};
    const doc = host.ownerDocument;
    styles(doc);
    const e = (tag, attrs, ...kids) => el(doc, tag, attrs, ...kids);
    const local = { confirm: false, busy: false, note: '', noteTone: '', error: '' };
    const root = e('div', { class: 'fmo-set' });
    host.replaceChildren(root);

    const set = (name, value) => Promise.resolve().then(() => PO.settings.set(name, value)).then(() => { local.error = ''; return PO.measure ? PO.measure().catch(() => null) : null; }, () => { local.error = T('set_save_failed'); }).then(draw);
    const choice = (name, values, labelKey) => {
      const current = Number(PO.settings.get(name));
      const list = values.includes(current) || !current ? values.slice() : values.concat([current]).sort((a, b) => a - b);
      const group = e('div', { class: 'fmo-seg', role: 'radiogroup', 'aria-label': T(labelKey) });
      for (const value of list) {
        const at = values.indexOf(value);
        const words = T(at === 0 ? 'set_choice_less' : at === 1 ? 'set_choice_standard' : at === 2 ? 'set_choice_more' : 'set_choice_current');
        const input = e('input', { type: 'radio', name: 'fmo-' + name, value: String(value), 'data-fk': name + ':' + value, on: { change: () => set(name, value) } });
        input.checked = value === current;
        group.append(e('label', null, input, e('b', { text: words }), e('small', { text: megabytes(value) })));
      }
      return group;
    };
    const toggle = (name, labelKey) => {
      const input = e('input', { type: 'checkbox', role: 'switch', 'aria-label': T(labelKey), 'data-fk': name, on: { change: (event) => set(name, !!event.target.checked) } });
      input.checked = !!PO.settings.get(name);
      return e('span', { class: 'fmo-switch' }, input, e('span'));
    };
    const row = (labelKey, helpKey, control, inline) => e('div', { class: 'fmo-set-row' + (inline ? ' inline' : '') }, e('div', null, e('strong', { text: T(labelKey) }), e('small', { text: T(helpKey) })), control);

    let shown = false;
    function draw() {
      // The page that held these settings was drawn again without them: stop following the queue.
      if (!root.isConnected) { if (shown) listeners.delete(draw); return; }
      shown = true;
      const key = doc.activeElement && root.contains(doc.activeElement) ? doc.activeElement.dataset.fk : null;
      const s = PO.state();
      const storage = s.storage || {};
      const parts = { reads: storage.reads || 0, media: storage.media || 0, queued: storage.queued || 0 };
      const known = typeof storage.usage === 'number' && typeof storage.quota === 'number' && storage.quota > 0;
      parts.app = known ? Math.max(0, storage.usage - parts.reads - parts.media - parts.queued) : 0;
      const order = ['app', 'reads', 'media', 'queued'];
      const budgets = storage.budgets || {};
      const limits = { reads: budgets.reads || Number(PO.settings.get('readsBudgetMb')) * 1048576, media: budgets.media || Number(PO.settings.get('mediaBudgetMb')) * 1048576 };

      const space = e('section', { class: 'fmo-set-group', 'data-set': 'space' }, e('h4', { text: T('set_space') }));
      if (known) {
        const meter = e('div', { class: 'fmo-meter', role: 'img', 'aria-label': T('set_space_used', { used: size(storage.usage), quota: size(storage.quota) }) });
        for (const name of order) if (parts[name] > 0) meter.append(e('span', { 'data-part': name, style: 'width:' + (parts[name] / storage.quota * 100).toFixed(3) + '%' }));
        space.append(meter, e('p', { class: 'fmo-set-total', text: T('set_space_used', { used: size(storage.usage), quota: size(storage.quota) }) }));
      } else space.append(e('p', { class: 'fmo-set-total', text: T('set_space_unknown') }));
      const legend = e('ul', { class: 'fmo-legend' });
      for (const name of order) {
        if (name === 'app' && !known) continue;
        legend.append(e('li', { 'data-part-row': name }, e('i', { 'data-part': name }), e('b', null, T('set_part_' + name), limits[name] ? e('small', { text: '  ' + T('set_limit', { size: size(limits[name]) }) }) : ''), e('span', { text: size(parts[name]) })));
      }
      space.append(legend);

      const keep = e('section', { class: 'fmo-set-group', 'data-set': 'keep' }, e('h4', { text: T('set_keep_heading') }),
        row('set_reads_limit', 'set_reads_help', choice('readsBudgetMb', READS_CHOICES, 'set_reads_limit')),
        row('set_media_limit', 'set_media_help', choice('mediaBudgetMb', MEDIA_CHOICES, 'set_media_limit')),
        row('set_auto_pin', 'set_auto_pin_help', toggle('autoPinRecent', 'set_auto_pin'), true));
      let cameraRoll = false;
      try { cameraRoll = !!(window.PhoneFeatures && window.PhoneFeatures.supports && window.PhoneFeatures.supports('photoLibrarySave')); } catch (_) { cameraRoll = false; }
      if (cameraRoll) keep.append(row('set_camera_roll', 'set_camera_roll_help', toggle('saveToCameraRoll', 'set_camera_roll'), true));
      if (local.error) keep.append(e('p', { class: 'fmo-note', 'data-tone': 'error', role: 'alert', text: local.error }));

      const count = waitingCount(s);
      const savedProjects = pins.filter((pin) => pin.refreshedAt).length;
      const remove = e('section', { class: 'fmo-set-group', 'data-set': 'remove' }, e('h4', { text: T('set_remove_heading') }),
        e('p', { class: 'fmo-set-line' }, e('span', { text: T('set_projects', { count: savedProjects }) })),
        e('p', { class: 'fmo-set-line' }, e('span', { text: T('set_waiting', { count }) }), (count > 0 && !(options && options.inTray)) ? e('button', { type: 'button', class: 'fmo-btn', 'data-fk': 'show-waiting', text: T('set_show_waiting'), on: { click: (event) => api.open({ anchor: event.currentTarget }) } }) : ''),
        e('p', { class: 'fmo-set-help', style: 'margin-top:10px', text: T('set_remove_help') }));
      const actions = e('div', { class: 'fmo-actions' });
      if (local.confirm) {
        actions.append(
          e('p', { class: 'fmo-set-line', style: 'flex:1 1 100%;font-weight:650;color:#101828', text: T('set_remove_ask') }),
          e('button', { type: 'button', class: 'fmo-btn danger solid', disabled: local.busy, 'data-fk': 'remove-yes', text: T('set_remove_yes'), on: { click: removeSaved } }),
          e('button', { type: 'button', class: 'fmo-btn', disabled: local.busy, 'data-fk': 'remove-no', text: T('set_remove_no'), on: { click: () => { local.confirm = false; draw(); const again = root.querySelector('[data-fk="remove"]'); if (again) again.focus(); } } }));
      } else {
        actions.append(e('button', { type: 'button', class: 'fmo-btn danger', 'data-fk': 'remove', text: T('set_remove'), on: { click: () => { local.confirm = true; local.note = ''; draw(); const no = root.querySelector('[data-fk="remove-no"]'); if (no) no.focus(); } } }));
      }
      remove.append(actions);
      if (local.note) remove.append(e('p', { class: 'fmo-note', 'data-tone': local.noteTone, role: 'status', style: 'margin:10px 0 0', text: local.note }));

      root.replaceChildren(e('p', { class: 'fmo-set-intro', text: T('set_intro') }), space, keep, remove);
      const again = key && [...root.querySelectorAll('[data-fk]')].find((node) => node.dataset.fk === key);
      if (again) again.focus({ preventScroll: true });
    }

    async function removeSaved() {
      local.busy = true; draw();
      try {
        // Kept projects would be downloaded again at the next refresh, so they are let go first.
        for (const pin of await Promise.resolve(PO.pinned()).catch(() => [])) await PO.unpinProject(pin.org || orgId(), pin.project).catch(() => {});
        await (PO.removeSaved ? PO.removeSaved() : PO.signedOut());
        local.note = T('set_removed'); local.noteTone = '';
      } catch (_) { local.note = T('set_remove_failed'); local.noteTone = 'error'; }
      local.busy = false; local.confirm = false;
      await loadPins();
      draw();
    }

    listeners.add(draw);
    draw();
    loadPins().then(draw);
    if (PO.measure) Promise.resolve(PO.measure()).then(draw, () => {});
    return () => listeners.delete(draw);
  }

  // ---------------------------------------------------------------------------------------------------------
  // The API other code calls
  // ---------------------------------------------------------------------------------------------------------

  const api = {
    /** Opens the sync tray. options: { anchor, record, entry, view: 'device' }. */
    open: (options) => openTray(options || {}),
    close: closeTray,
    /** waitingBadge({ record, compact }): see above. */
    waitingBadge,
    /** Resolves true when signing out may go ahead (asks first while changes wait). */
    confirmSignOut,
    /** Draws this device's offline settings into an element. */
    mountSettings,
    /** For tests and the catalog: every key with its English. */
    strings: STRINGS,
    state: () => ({ situation: situation(state), entries: entries.slice(), open: view.open, view: view.name, host: slot.dataset.host || null }),
    _ask: ask,
    _popover: openPopover
  };
  window.PlatformOfflineUI = api;

  watchChrome();
  loadEntries();
  if (inProjectWindow || !state.online) loadPins();
  drawMarks();
  window.dispatchEvent(new CustomEvent('fm:offline-ui:ready'));
})();
