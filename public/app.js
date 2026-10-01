import { localDate, frequencies, statuses, periodRange, shiftPeriod, daysBetween, activeOn, overlaps, validDate } from './domain.js';
import { config } from './config.js';
import { createCloudClient } from './cloud-client.js';

const cloud = config.mode === 'supabase' ? createCloudClient(config) : null;
let signedInUser = null;
let refreshInFlight = false;
let firstLoad = true;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  leaf: '<path d="M19 3c-1 5-13 1-14 10a6 6 0 0 0 10 5c5-4 4-10 4-15Z"/><path d="M4 21c1-6 5-10 10-12"/>',
  report: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'arrow-left': '<path d="M20 12H4m6-6-6 6 6 6"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  note: '<path d="M20 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z"/><path d="M7 7h9M7 11h6"/>',
  spark: '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7ZM20 2v4M18 4h4"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.leaf}</svg>`; }
function renderIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); }); }
renderIcons();

const state = { changes: [], entries: [], today: localDate(), anchor: localDate(), period: 'weekly', page: 'tracker', filter: 'active', search: '' };
let changeEditing = null;
let entryEditing = null;
let entryKey = '';
let entryBusy = false;
let changeBusy = false;
let reportGeneration = 0;
let reportMeta = null;
let toastTimer;
let loadGeneration = 0;

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4300);
}
function formError(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
async function api(path, { method = 'GET', body } = {}) {
  if (cloud) return cloud.request(path, { method, body });
  let response;
  try {
    response = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error('לא ניתן להתחבר לשרת. ודאו שהאפליקציה פועלת ונסו שוב.'); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || 'לא ניתן להשלים את הפעולה. נסו שוב.');
    error.status = response.status;
    error.entry = data.entry;
    throw error;
  }
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response.text();
}

function dateFormat(date, options = {}) {
  return new Intl.DateTimeFormat('he-IL', { timeZone: 'UTC', ...options }).format(new Date(`${date}T12:00:00Z`));
}
function rangeLabel(anchor = state.anchor, period = state.period) {
  const { start, end } = periodRange(anchor, period);
  if (period === 'daily') return dateFormat(start, { day: 'numeric', month: 'long', year: 'numeric' });
  if (period === 'monthly') return dateFormat(start, { month: 'long', year: 'numeric' });
  const format = start.slice(0, 7) === end.slice(0, 7) ? { day: 'numeric' } : { day: 'numeric', month: 'short' };
  return `${dateFormat(start, format)} – ${dateFormat(end, { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

async function refresh() {
  if (cloud && !signedInUser) return;
  const generation = ++loadGeneration;
  refreshInFlight = true;
  if (cloud) $('#sync-status').textContent = 'טוענים מהענן…';
  try {
    const data = await api('/api/state');
    if (generation !== loadGeneration) return;
    if (reportMeta && (JSON.stringify(data.changes) !== JSON.stringify(state.changes) || JSON.stringify(data.entries) !== JSON.stringify(state.entries))) invalidateReport();
    Object.assign(state, data);
    if (firstLoad) { state.anchor = data.today; $('#report-date').value = data.today; firstLoad = false; invalidateReport(); }
    $('#connection-error').hidden = true;
    $('#app-content').hidden = false;
    render();
    if (cloud) $('#sync-status').textContent = `עודכן ${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) {
    if (generation !== loadGeneration) return;
    if (cloud && error.status === 401) { setAuthState(null); formError('#auth-error', error.message); }
    $('#connection-message').textContent = error.message;
    $('#connection-error').hidden = false;
    if (cloud) $('#sync-status').textContent = 'העדכון לא הצליח';
    throw error;
  } finally { if (generation === loadGeneration) refreshInFlight = false; $('#loading').hidden = true; }
}

function setAuthState(user) {
  if (signedInUser?.id === user?.id && signedInUser && user) return;
  signedInUser = user;
  ++loadGeneration;
  refreshInFlight = false;
  firstLoad = true;
  state.changes = [];
  state.entries = [];
  $('#tracker-table').innerHTML = '';
  $('#changes-list').innerHTML = '';
  $('#nav-count').textContent = '0';
  for (const dialog of $$('dialog[open]')) dialog.close();
  $('#change-form').reset();
  $('#entry-form').reset();
  $('#entry-change').innerHTML = '';
  changeEditing = null;
  entryEditing = null;
  invalidateReport();
  $('#auth-panel').hidden = Boolean(user);
  $('#cloud-account').hidden = !user;
  $('#app-content').hidden = true;
  $('#loading').hidden = true;
  $('#connection-error').hidden = true;
  $('#account-email').textContent = user?.email || '';
  if (user) void refresh().catch(() => {});
}

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!cloud) return;
  $('#auth-submit').disabled = true;
  formError('#auth-error');
  try { await cloud.signIn($('#auth-email').value, $('#auth-password').value); $('#auth-password').value = ''; }
  catch (error) { formError('#auth-error', error.message); }
  finally { $('#auth-submit').disabled = false; }
});
$('#sign-out').addEventListener('click', () => { if (cloud) void cloud.signOut(); });
$('#sync-now').addEventListener('click', () => { if (!refreshInFlight) void refresh().catch(() => {}); });

const backupLink = $('a[href="/api/backup"]');
backupLink.addEventListener('click', async event => {
  if (!cloud) return;
  event.preventDefault();
  try {
    const data = await api('/api/backup');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `owntracker-backup-${data.today}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message); }
});

function render() {
  $('#today-label').textContent = dateFormat(state.today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#nav-count').textContent = state.changes.filter(change => !change.archived_on).length;
  renderTracker();
  renderChanges();
  route();
}

function renderTracker() {
  const { start, end } = periodRange(state.anchor, state.period);
  const days = daysBetween(start, end);
  const changes = state.changes.filter(change => overlaps(change, start, end));
  const entries = new Map(state.entries.map(entry => [`${entry.change_id}:${entry.date}`, entry]));
  const active = state.changes.filter(change => !change.archived_on);
  const activeIds = new Set(active.map(change => change.id));
  const todayEntries = state.entries.filter(entry => entry.date === state.today && activeIds.has(entry.change_id));
  const changeIds = new Set(changes.map(change => change.id));
  $('#stat-active').textContent = active.length;
  $('#stat-done').textContent = state.entries.filter(entry => entry.date >= start && entry.date <= end && entry.status === 'done' && changeIds.has(entry.change_id)).length;
  $('#stat-today').innerHTML = `${todayEntries.length}<span> / ${active.length}</span>`;
  $('#stat-period').textContent = ({ daily: 'ביום הנבחר', weekly: 'בשבוע הנבחר', monthly: 'בחודש הנבחר' })[state.period];
  $('#range-label').textContent = rangeLabel();
  $('#tracker-date').value = state.anchor;
  $$('#tracker-periods button').forEach(button => { button.classList.toggle('selected', button.dataset.period === state.period); button.setAttribute('aria-pressed', String(button.dataset.period === state.period)); });
  const empty = $('#tracker-empty');
  empty.hidden = changes.length > 0;
  $('#tracker-table').hidden = !changes.length;
  if (!changes.length) {
    const noChanges = state.changes.length === 0;
    empty.innerHTML = `<span class="empty-icon">${icon('leaf')}</span><h3>${noChanges ? 'השינוי הראשון שלך מתחיל כאן' : 'אין שינויים פעילים בתקופה הזו'}</h3><p>${noChanges ? 'בחרו משהו קטן שתרצו לשנות.<br>נעקוב אחריו יחד, יום אחרי יום.' : 'אפשר לבחור תקופה אחרת או להתחיל שינוי חדש.'}</p><button class="btn primary" data-action="new-change">${icon('plus')} ${noChanges ? 'יצירת השינוי הראשון' : 'יצירת שינוי חדש'}</button>`;
  }
  $('#tracker-table').innerHTML = `<table class="tracker-table ${state.period}"><caption class="sr-only">מעקב שינויים: ${escapeHTML(rangeLabel())}</caption><thead><tr><th scope="col">השינוי שלי</th>${days.map(day => `<th scope="col" class="${day === state.today ? 'today' : ''}"><span>${dateFormat(day, { weekday: 'short' })}</span><span class="date-number">${dateFormat(day, { day: 'numeric' })}</span>${day === state.today ? '<span>היום</span>' : ''}</th>`).join('')}</tr></thead><tbody>${changes.map(change => `<tr><td><div class="row-title"><span class="row-symbol">${icon('leaf')}</span><div><strong>${escapeHTML(change.title)}</strong><small class="${change.archived_on ? 'archived-label' : ''}">${frequencies[change.frequency]}${change.archived_on ? ' · נמחק' : ''}</small></div>${!change.archived_on ? `<button class="icon-btn" data-edit="${change.id}" aria-label="עריכת ${escapeHTML(change.title)}">${icon('edit')}</button>` : ''}</div></td>${days.map(day => {
    const entry = entries.get(`${change.id}:${day}`);
    let content;
    if (!activeOn(change, day)) content = '<span class="inactive-day" role="img" aria-label="מחוץ לתקופת הפעילות" title="מחוץ לתקופת הפעילות"></span>';
    else if (day > state.today) content = '<span class="inactive-day future-day" role="img" aria-label="יום עתידי" title="יום עתידי"></span>';
    else {
      const status = entry ? statuses[entry.status] : 'חסר מילוי';
      const label = `${change.title}, ${day}: ${status}${entry?.explanation ? ', יש הסבר' : ''}`;
      content = `<button class="cell-btn ${entry?.status || 'empty'}" data-entry-change="${change.id}" data-entry-date="${day}" aria-label="${escapeHTML(label)}" title="${escapeHTML(entry?.explanation || status)}">${entry ? `<span class="symbol" aria-hidden="true">${({ done: '✓', missed: '×', other: '○' })[entry.status]}</span>` : ''}${entry?.explanation ? `<span class="entry-note">${icon('note')}</span>` : ''}</button>`;
    }
    return `<td class="${day === state.today ? 'today' : ''}">${content}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table>`;
  $('#starter-section').hidden = active.length > 0;
}

function renderChanges() {
  $$('#change-filters button').forEach(button => { button.classList.toggle('selected', button.dataset.filter === state.filter); button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)); });
  const changes = state.changes.filter(change =>
    (state.filter === 'all' || (state.filter === 'archived' ? !!change.archived_on : !change.archived_on)) &&
    `${change.title} ${change.description}`.toLocaleLowerCase('he').includes(state.search.toLocaleLowerCase('he')));
  $('#changes-list').innerHTML = changes.length ? changes.map(change => `<article class="change-card"><div class="change-card-top"><span class="frequency-badge ${change.archived_on ? 'archived' : ''}">${frequencies[change.frequency]}${change.archived_on ? ' · נמחק' : ''}</span>${!change.archived_on ? `<button class="icon-btn" data-edit="${change.id}" aria-label="עריכת ${escapeHTML(change.title)}">${icon('edit')}</button>` : icon('leaf')}</div><h2>${escapeHTML(change.title)}</h2><p>${escapeHTML(change.description || 'כל צעד קטן הוא חלק מהשינוי.')}</p><div class="change-card-footer"><span>${change.archived_on ? `נמחק ב־${dateFormat(change.archived_on, { dateStyle: 'short' })}` : `בדרך מאז ${dateFormat(change.active_from, { dateStyle: 'short' })}`}</span><button class="text-btn" data-entry-change="${change.id}">${change.archived_on ? 'צפייה / עריכת דיווח' : 'מילוי דיווח'} ${icon('arrow-left')}</button></div></article>`).join('') : `<div class="empty-state"><span class="empty-icon">${icon('leaf')}</span><h3>${state.search ? 'לא נמצאו שינויים תואמים' : state.filter === 'archived' ? 'עדיין אין שינויים שנמחקו' : 'כאן מתחילה הדרך שלך'}</h3><p>${state.search ? 'אפשר לנסות חיפוש אחר.' : state.filter === 'archived' ? 'שינוי שנמחק יישאר בהיסטוריה ובדוחות הרלוונטיים.' : 'בחרו שינוי קטן ומשמעותי והתחילו לעקוב אחריו.'}</p>${state.filter !== 'archived' && !state.search ? '<button class="btn primary" data-action="new-change">יצירת שינוי חדש</button>' : ''}</div>`;
}

const pages = {
  tracker: ['המעקב שלי', 'קצת יותר קרוב לעצמך', 'מקום לשינויים קטנים שעושים הבדל גדול.'],
  changes: ['השינויים שלי', 'כל התחלה היא צעד קדימה', 'הכוונות שלך, במקום אחד. אפשר לעדכן אותן לאורך הדרך.'],
  reports: ['דוחות ותובנות', 'מסתכלים אחורה כדי לצמוח', 'להבין מה עבד, מה הקשה ומה כדאי לנסות בהמשך.'],
};
function route() {
  const page = location.hash.slice(1);
  state.page = Object.hasOwn(pages, page) ? page : 'tracker';
  const [title, eyebrow, description] = pages[state.page];
  $('#page-title').textContent = title;
  $('#page-crumb').textContent = title;
  $('#page-eyebrow').textContent = eyebrow;
  $('#page-description').textContent = description;
  document.title = `${title} — OwnTracker`;
  $$('.page').forEach(section => { section.hidden = section.id !== `${state.page}-page`; });
  $$('nav [data-page]').forEach(link => { link.classList.toggle('active', link.dataset.page === state.page); if (link.dataset.page === state.page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
}

function askConfirmation(title, message, acceptLabel) {
  return new Promise(resolve => {
    const dialog = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    $('#confirm-accept').textContent = acceptLabel;
    dialog.returnValue = '';
    dialog.onclose = () => resolve(dialog.returnValue === 'accept');
    dialog.showModal();
  });
}
$('#confirm-accept').addEventListener('click', () => $('#confirm-dialog').close('accept'));
$('#confirm-cancel').addEventListener('click', () => $('#confirm-dialog').close('cancel'));

function openChange(id = null, suggestion = '') {
  changeEditing = id ? state.changes.find(change => change.id === id) : null;
  $('#change-form').reset();
  $('#change-title').value = changeEditing?.title || suggestion;
  $('#change-description').value = changeEditing?.description || '';
  $('#change-frequency').value = changeEditing?.frequency || 'daily';
  $('#change-dialog-title').textContent = changeEditing ? 'עריכת שינוי' : 'שינוי חדש';
  $('#delete-change').hidden = !changeEditing;
  formError('#change-error');
  $('#change-dialog').showModal();
  $('#change-title').focus();
}

$('#change-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (changeBusy) return;
  const body = { title: $('#change-title').value.trim(), description: $('#change-description').value, frequency: $('#change-frequency').value, version: changeEditing?.version };
  if (!body.title) { formError('#change-error', 'יש להזין כותרת לשינוי.'); return; }
  changeBusy = true;
  $('#save-change').disabled = true;
  formError('#change-error');
  try {
    await api(changeEditing ? `/api/changes/${changeEditing.id}` : '/api/changes', { method: changeEditing ? 'PUT' : 'POST', body });
    $('#change-dialog').close();
    toast(changeEditing ? 'השינוי עודכן בהצלחה' : 'השינוי נשמר. הצעד הראשון כבר מאחוריך!');
    invalidateReport();
    await refresh();
  } catch (error) { formError('#change-error', error.message); }
  finally { changeBusy = false; $('#save-change').disabled = false; }
});

$('#delete-change').addEventListener('click', async () => {
  if (!changeEditing || changeBusy) return;
  const change = changeEditing;
  const accepted = await askConfirmation('למחוק את השינוי?', `״${change.title}״ יוסר מהשינויים הפעילים.\nכל הדיווחים יישמרו ויופיעו בתצוגה ובדוחות לתקופות שבהן השינוי היה פעיל.`, 'מחיקת השינוי');
  if (!accepted) return;
  changeBusy = true;
  $('#delete-change').disabled = true;
  try {
    await api(`/api/changes/${change.id}`, { method: 'DELETE', body: { version: change.version } });
    $('#change-dialog').close();
    toast('השינוי נמחק. ההיסטוריה שלך נשמרה.');
    invalidateReport();
    await refresh();
  } catch (error) { formError('#change-error', error.message); }
  finally { changeBusy = false; $('#delete-change').disabled = false; }
});

async function openEntry(id, date) {
  const available = state.changes.filter(change => !change.archived_on || change.id === id);
  if (!available.length) { openChange(); toast('כדי למלא דיווח, מתחילים ביצירת שינוי.'); return; }
  const selected = available.find(change => change.id === id) || available[0];
  $('#entry-form').reset();
  $('#entry-change').innerHTML = available.map(change => `<option value="${change.id}">${escapeHTML(change.title)}${change.archived_on ? ' (נמחק)' : ''}</option>`).join('');
  $('#entry-change').value = selected.id;
  $('#entry-date').value = date || selected.archived_on || state.today;
  entryKey = '';
  entryEditing = null;
  formError('#entry-error');
  $('#entry-dialog').showModal();
  await syncEntry();
}

function populateEntry(entry) {
  entryEditing = entry || null;
  $$('input[name="status"]').forEach(input => { input.checked = input.value === entry?.status; });
  $('#entry-explanation').value = entry?.explanation || '';
  $('#entry-dialog-title').textContent = entry ? 'עריכת הדיווח שלי' : 'איך הלך היום?';
  $('#save-entry').textContent = entry ? 'שמירת העדכון' : 'שמירת הדיווח';
}

async function syncEntry() {
  const change = state.changes.find(change => change.id === Number($('#entry-change').value));
  if (!change) return;
  $('#entry-date').max = change.archived_on || state.today;
  $('#entry-date-hint').textContent = change.archived_on ? `השינוי נמחק ב־${change.archived_on}. אפשר לערוך דיווחים ולהשלים ימים עד לתאריך זה.` : 'אפשר גם להשלים דיווח ליום קודם. מילוי מוקדם ירחיב את תקופת המעקב.';
  const date = $('#entry-date').value;
  const key = `${change.id}:${date}`;
  if (key === entryKey) return;
  entryKey = key;
  formError('#entry-error');
  populateEntry(null);
  const existing = state.entries.find(entry => entry.change_id === change.id && entry.date === date);
  if (existing) {
    $('#save-entry').disabled = true;
    const accepted = await askConfirmation('כבר מילאת דיווח ליום הזה', `קיים דיווח עבור ״${change.title}״ בתאריך ${dateFormat(date, { dateStyle: 'long' })}.\nאפשר לפתוח אותו ולעדכן את הפרטים.`, 'מעבר לעריכת הדיווח');
    $('#save-entry').disabled = false;
    if (accepted) populateEntry(existing);
    else $('#entry-dialog').close();
  }
}
$('#entry-change').addEventListener('change', syncEntry);
$('#entry-date').addEventListener('change', syncEntry);

$('#entry-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (entryBusy) return;
  const changeId = Number($('#entry-change').value);
  const body = { date: $('#entry-date').value, status: $('input[name="status"]:checked')?.value, explanation: $('#entry-explanation').value, version: entryEditing?.version };
  if (!validDate(body.date) || !body.status) { formError('#entry-error', 'יש לבחור תאריך ומצב ביצוע.'); return; }
  entryBusy = true;
  $('#save-entry').disabled = true;
  formError('#entry-error');
  try {
    await api(`/api/changes/${changeId}/entries`, { method: entryEditing ? 'PUT' : 'POST', body });
    $('#entry-dialog').close();
    toast(entryEditing ? 'הדיווח עודכן' : 'הדיווח נשמר. תודה על הרגע הזה לעצמך.');
    invalidateReport();
    await refresh();
  } catch (error) {
    if (error.status === 409 && error.entry) {
      const accepted = await askConfirmation('כבר קיים דיווח מעודכן', 'הדיווח נשמר או עודכן בחלון אחר. אפשר לטעון אותו לעריכה; הטקסט בטופס יוחלף בגרסה השמורה.', 'טעינת הדיווח השמור');
      if (accepted) populateEntry(error.entry);
      else formError('#entry-error', 'לא בוצעה שמירה כדי לא לדרוס דיווח קיים. יש לפתוח את הדיווח מחדש כדי לערוך אותו.');
    } else formError('#entry-error', error.message);
  } finally { entryBusy = false; $('#save-entry').disabled = false; }
});

function invalidateReport() {
  reportGeneration++;
  reportMeta = null;
  $('#report-output').value = '';
  $('#report-output').hidden = true;
  $('#report-placeholder').hidden = false;
  $('#copy-report').disabled = true;
  $('#download-report').disabled = true;
  $('#generate-report').disabled = false;
  $('#generate-report').innerHTML = `${icon('spark')}הפקת דוח`;
  $('#report-preview-description').textContent = 'מוכן להעתקה ולשיתוף';
  const date = $('#report-date').value;
  $('#report-range').textContent = validDate(date) ? rangeLabel(date, $('#report-period').value) : 'יש לבחור תאריך';
}

async function generateReport() {
  const date = $('#report-date').value;
  const period = $('#report-period').value;
  if (!validDate(date)) { $('#report-date').reportValidity(); toast('יש לבחור תאריך לדוח.'); return; }
  const generation = ++reportGeneration;
  $('#generate-report').disabled = true;
  $('#generate-report').textContent = 'מפיקים את הדוח…';
  try {
    const text = await api(`/api/report?date=${encodeURIComponent(date)}&period=${encodeURIComponent(period)}`);
    if (generation !== reportGeneration) return;
    $('#report-output').value = text;
    $('#report-output').hidden = false;
    $('#report-placeholder').hidden = true;
    $('#copy-report').disabled = false;
    $('#download-report').disabled = false;
    $('#report-preview-description').textContent = rangeLabel(date, period);
    reportMeta = { date, period };
    toast('הדוח מוכן');
  } catch (error) { if (generation === reportGeneration) toast(error.message); }
  finally { if (generation === reportGeneration) { $('#generate-report').disabled = false; $('#generate-report').innerHTML = `${icon('spark')}הפקת דוח`; } }
}

$('#generate-report').addEventListener('click', generateReport);
$('#report-period').addEventListener('change', invalidateReport);
$('#report-date').addEventListener('change', invalidateReport);
$('#copy-report').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#report-output').value); toast('הדוח הועתק. אפשר להדביק אותו בשיחה עם מודל AI.'); }
  catch { $('#report-output').focus(); $('#report-output').select(); toast('הטקסט סומן. לחצו Ctrl+C להעתקה או הורידו את הקובץ.'); }
});
$('#download-report').addEventListener('click', () => {
  if (!reportMeta) return;
  const url = URL.createObjectURL(new Blob(['\uFEFF', $('#report-output').value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `OwnTracker-${reportMeta.period}-${reportMeta.date}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]');
  if (close) { $(`#${close.dataset.close}`).close(); return; }
  const edit = event.target.closest('[data-edit]');
  if (edit) { openChange(Number(edit.dataset.edit)); return; }
  const entry = event.target.closest('[data-entry-change]');
  if (entry) { void openEntry(Number(entry.dataset.entryChange), entry.dataset.entryDate); return; }
  const suggestion = event.target.closest('[data-suggestion]');
  if (suggestion) { openChange(null, suggestion.dataset.suggestion); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'new-change') openChange();
  if (action === 'new-entry') void openEntry();
  if (action === 'view-report') {
    $('#report-date').value = state.anchor;
    $('#report-period').value = state.period;
    invalidateReport();
    location.hash = 'reports';
    void generateReport();
  }
});
$('#tracker-periods').addEventListener('click', event => {
  const period = event.target.closest('[data-period]')?.dataset.period;
  if (period) { state.period = period; renderTracker(); }
});
function movePeriod(direction) {
  const next = shiftPeriod(state.anchor, state.period, direction);
  if (next < '1900-01-07' || next > '9998-12-25') return;
  state.anchor = next;
  renderTracker();
}
$('#previous-period').addEventListener('click', () => movePeriod(-1));
$('#next-period').addEventListener('click', () => movePeriod(1));
$('#jump-today').addEventListener('click', () => { state.anchor = state.today; renderTracker(); });
$('#tracker-date').addEventListener('change', event => { if (validDate(event.target.value) && event.target.checkValidity()) { state.anchor = event.target.value; renderTracker(); } });
$('#change-filters').addEventListener('click', event => { const filter = event.target.closest('[data-filter]')?.dataset.filter; if (filter) { state.filter = filter; renderChanges(); } });
$('#change-search').addEventListener('input', event => { state.search = event.target.value.trim(); renderChanges(); });
$('#retry-load').addEventListener('click', () => { void refresh().catch(() => {}); });
window.addEventListener('hashchange', route);
// Refresh after returning to the app, without changing an open form.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) void refresh().catch(() => {});
});
$('#report-date').value = state.today;
$('#report-date').required = true;
invalidateReport();
window.addEventListener('online', () => { if (!refreshInFlight && !document.querySelector('dialog[open]')) void refresh().catch(() => {}); });
if (cloud) {
  setInterval(() => {
    if (signedInUser && !refreshInFlight && document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) void refresh().catch(() => {});
  }, 20000);
  cloud.subscribe(setAuthState);
  void cloud.initialize().then(setAuthState).catch(error => { setAuthState(null); formError('#auth-error', error.message); });
} else {
  void refresh().catch(() => {});
}
