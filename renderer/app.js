/* global api */
const $ = (sel) => document.querySelector(sel);

const state = { cards: [], fields: [], settings: {}, selected: null, filter: 'all', busy: false };
const WIDE = new Set(['address', 'tax_id']);
const STATUS_TAG = { check: 'Check', missing: 'Missing', edited: 'Edited', generated: 'Generated', default: 'Default' };
const STATE_LABEL = { ok: 'Ready', review: 'To check', error: 'Incomplete' };

// Secret fields (password) are masked except while being edited.
function maskSecret(input, def) {
  if (!def.secret) return;
  input.type = 'password';
  input.addEventListener('focus', () => (input.type = 'text'));
  input.addEventListener('blur', () => (input.type = 'password'));
}

function manualPlaceholder(input, def, short) {
  if (def.key === 'email' || def.key === 'recovery_email') input.placeholder = 'name@example.com';
  else if (def.manual) input.placeholder = short ? 'Add' : 'Add manually';
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

let toastTimer = null;
function toast(message, action) {
  const t = $('#toast');
  t.replaceChildren(message);
  if (action) t.append(el('button', { text: action.label, onclick: action.run }));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 8000 : 4500);
}

const displayName = (c) => [c.fields.surname, c.fields.name].filter(Boolean).join(' ') || 'Unreadable card';
const visibleCards = () => state.cards.filter((c) => state.filter === 'all' || (state.filter === 'ok' ? c.state === 'ok' : c.state !== 'ok'));

// --- Sidebar --------------------------------------------------------------------------------------
function renderList() {
  const list = $('#card-list');
  const cards = visibleCards();
  list.replaceChildren(
    ...cards.map((c) =>
      el(
        'li',
        { tabindex: '0', class: c.id === state.selected ? 'selected' : '', 'data-id': c.id, onclick: () => select(c.id), onkeydown: (e) => e.key === 'Enter' && select(c.id) },
        el('span', { class: `state-dot state-${c.state}`, title: STATE_LABEL[c.state] }),
        el('span', { class: 'name', text: displayName(c) }),
        el('span', { class: 'meta', text: `${c.fields.document_number || 'No document number'} · ${STATE_LABEL[c.state]}` })
      )
    )
  );
  if (!cards.length && state.cards.length) list.append(el('li', { class: 'empty-list', text: 'No cards in this view' }));

  const ok = state.cards.filter((c) => c.state === 'ok').length;
  const setAll = (sel, v) => document.querySelectorAll(sel).forEach((n) => (n.textContent = v));
  setAll('.count-all', state.cards.length);
  setAll('.count-ok', ok);
  setAll('.count-review', state.cards.length - ok);
  $('#summary').textContent = state.cards.length
    ? `${state.cards.length} card${state.cards.length === 1 ? '' : 's'} · ${ok} ready · ${state.cards.length - ok} to check`
    : 'No cards yet';
  $('#btn-export').disabled = !state.cards.length || state.busy;
  $('#btn-add').disabled = state.busy;
  $('#btn-clear').hidden = !state.cards.length || state.busy;
  $('#btn-clear-all').disabled = !state.cards.length || state.busy;
}

// --- Card view ------------------------------------------------------------------------------------
const imageCache = new Map();
async function showImage(box, file, label) {
  box.replaceChildren();
  if (!file) {
    box.textContent = `${label} image missing`;
    return;
  }
  if (!imageCache.has(file)) imageCache.set(file, await api.imageData(file));
  const src = imageCache.get(file);
  if (!src) {
    box.textContent = 'Image file not found';
    return;
  }
  box.append(el('img', { src, alt: `${label} of the card`, title: `${file}\nClick to enlarge`, onclick: () => openLightbox(src) }));
}

function fieldMessage(card, key) {
  const { errors, warnings } = card.validation;
  if (errors[key]) return { cls: 'error', text: errors[key] };
  if (warnings[key]) return { cls: 'warning', text: warnings[key] };
  return null;
}

function fieldClass(card, key) {
  const st = card.status[key];
  if (card.validation.errors[key]) return 'has-error';
  if (card.reviewed && (st === 'check' || st === 'missing') && card.fields[key]) return '';
  return st === 'check' || st === 'missing' ? `st-${st}` : '';
}

function renderForm(card) {
  const form = $('#fields');
  const groups = new Map();
  for (const def of state.fields) {
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push(def);
  }
  form.replaceChildren(
    ...[...groups.entries()].map(([group, defs]) =>
      el(
        'fieldset',
        {},
        el('legend', { text: group }),
        ...defs.map((def) => {
          const st = card.status[def.key];
          const id = `f-${def.key}`;
          const input = el('input', { id, name: def.key, value: card.fields[def.key] || '', spellcheck: 'false' });
          manualPlaceholder(input, def, false);
          maskSecret(input, def);
          if (/date/.test(def.key)) input.placeholder = 'DD/MM/YYYY';
          if (def.key === 'sex') input.placeholder = 'M / F';
          input.addEventListener('change', () => saveField(card.id, def.key, input.value));
          const showTag = STATUS_TAG[st] && !(card.reviewed && st !== 'edited');
          const msg = fieldMessage(card, def.key);
          return el(
            'div',
            { class: `field ${WIDE.has(def.key) ? 'wide' : ''} ${fieldClass(card, def.key)}`, 'data-key': def.key },
            el(
              'label',
              { for: id },
              def.label,
              showTag ? el('span', { class: `tag st-${st}`, text: STATUS_TAG[st] }) : null,
              // Emails are generated automatically; this only rolls new digits (e.g. address taken at the provider).
              def.key === 'email' && card.fields.email && st === 'generated'
                ? el('button', {
                    type: 'button',
                    class: 'mini-btn',
                    text: 'New address',
                    title: 'Same name, new random digits',
                    onclick: () => newAddress(card.id),
                  })
                : null
            ),
            input,
            msg ? el('span', { class: `msg ${msg.cls}`, text: msg.text }) : null
          );
        })
      )
    )
  );
}

function renderCard() {
  const card = state.cards.find((c) => c.id === state.selected);
  $('#empty').hidden = !!card;
  $('#card-view').hidden = !card;
  if (!card) return;

  $('#card-title').textContent = displayName(card);
  $('#card-sub').textContent = [card.fields.document_number, card.fields.tax_id].filter(Boolean).join(' · ') || ' ';
  const pill = $('#card-state');
  pill.className = `pill ${card.state}`;
  pill.textContent = STATE_LABEL[card.state];

  const reviewedBtn = $('#btn-reviewed');
  reviewedBtn.textContent = card.reviewed ? 'Undo reviewed' : 'Mark as reviewed';
  reviewedBtn.className = `btn ${!card.reviewed && card.state === 'review' ? 'primary' : ''}`;
  reviewedBtn.disabled = card.state === 'error' && !card.reviewed;
  reviewedBtn.title = reviewedBtn.disabled ? 'Fill in or correct the fields marked in red first' : 'Confirms you have compared the highlighted fields with the images';

  $('#btn-login').disabled = !card.fields.email || !card.fields.password;

  const idx = state.cards.indexOf(card);
  $('#btn-prev').disabled = idx <= 0;
  $('#btn-next').disabled = idx >= state.cards.length - 1;

  $('#notes').replaceChildren(...(card.notes || []).map((n) => el('li', { text: n })));
  renderForm(card);
  showImage($('#img-front'), card.front, 'Front');
  showImage($('#img-back'), card.back, 'Back');
}

function select(id) {
  state.selected = id;
  renderList();
  renderCard();
  $('#detail').scrollTop = 0;
}

function replaceCard(updated) {
  const i = state.cards.findIndex((c) => c.id === updated.id);
  if (i >= 0) state.cards[i] = updated;
}

async function saveField(id, key, value) {
  const updated = await api.updateCard(id, { [key]: value });
  replaceCard(updated);
  renderList();
  // Re-render the form but keep focus where the user is typing.
  const active = document.activeElement && document.activeElement.name;
  renderCard();
  if (active) {
    const next = document.querySelector(`#fields input[name="${active}"]`);
    if (next) next.focus();
  }
}

// --- Actions -------------------------------------------------------------------------------------
async function processPaths(paths) {
  if (!paths.length || state.busy) return;
  state.busy = true;
  renderList();
  $('#progress').hidden = false;
  try {
    const r = await api.processImages(paths);
    await reload(r.firstId || state.selected);
    const parts = [];
    if (r.added) parts.push(`${r.added} card${r.added === 1 ? '' : 's'} added`);
    if (r.skipped) parts.push(`${r.skipped} image${r.skipped === 1 ? '' : 's'} already in the list`);
    if (r.unknown.length) parts.push(`not recognised as a CIE: ${r.unknown.join(', ')}`);
    toast(parts.join(' · ') || 'No images found');
  } catch (err) {
    toast(`Processing failed: ${err.message}`);
  } finally {
    state.busy = false;
    $('#progress').hidden = true;
    renderList();
  }
}

async function reload(selectId) {
  const s = await api.getSession();
  state.cards = s.cards;
  state.fields = s.fields;
  state.csvOrder = s.csvOrder;
  state.settings = s.settings;
  state.selected = state.cards.some((c) => c.id === selectId) ? selectId : state.cards[0] ? state.cards[0].id : null;
  renderList();
  renderCard();
  if (state.view === 'table') renderTable();
}

// --- Table view ----------------------------------------------------------------------------------
// One row per card, one editable cell per CSV column (same order as the exported file).
const COL_WIDTH = {
  tax_id: 175, name: 130, surname: 140, birth_date: 108, nation: 90, birth_province: 64, birth_comune: 150, sex: 54,
  res_province: 64, res_city: 160, address: 280, house_number: 110, cap: 76, document_type: 210, issuing_body: 110,
  document_number: 112, place_of_issue: 160, issue_date: 108, expiry_date: 108, telephone: 140,
  email: 300, username: 200, password: 150, recovery_email: 260,
};
const SHORT_LABEL = { birth_province: 'Prov.', res_province: 'Res. prov.', house_number: 'House no.', cap: 'CAP' };

function cellTitle(card, key) {
  const msg = fieldMessage(card, key);
  const st = card.status[key];
  const parts = [];
  if (msg) parts.push(msg.text);
  if (!card.reviewed && st === 'check') parts.push('Read by OCR, not confirmed: compare with the card image');
  if (st === 'missing' && !card.fields[key]) parts.push('Could not be read from the image');
  if (st === 'edited') parts.push('Edited by you');
  if (st === 'generated') parts.push('Generated automatically (name + 5 random digits)');
  if (st === 'default') parts.push('Default from Settings. Type a value to override it for this card');
  return parts.join('\n');
}

function cellClass(card, key) {
  const cls = fieldClass(card, key);
  if (cls) return cls;
  const st = card.status[key];
  if (st === 'default') return 'st-default';
  return st === 'edited' || st === 'generated' ? 'st-edited' : '';
}

function renderTableHead() {
  const defs = state.csvOrder.map((k) => state.fields.find((d) => d.key === k));
  $('#grid-head').replaceChildren(
    el(
      'tr',
      {},
      el('th', { class: 'sticky-col c-open', text: '' }),
      el('th', { class: 'sticky-col c-state', text: 'Status' }),
      el('th', { class: 'c-reviewed', text: 'Reviewed', title: 'Tick when you have compared the highlighted fields with the images' }),
      ...defs.map((d) => {
        const th = el('th', { text: SHORT_LABEL[d.key] || d.label, title: d.label });
        th.style.minWidth = `${COL_WIDTH[d.key] || 120}px`;
        return th;
      })
    )
  );
}

function updateRow(tr, card) {
  const pill = tr.querySelector('.pill');
  pill.className = `pill ${card.state}`;
  pill.textContent = STATE_LABEL[card.state];
  const box = tr.querySelector('input[type=checkbox]');
  box.checked = !!card.reviewed;
  box.disabled = card.state === 'error' && !card.reviewed;
  box.title = box.disabled ? 'Fill in or correct the red cells first' : 'Reviewed';
  for (const td of tr.querySelectorAll('td[data-key]')) {
    const key = td.dataset.key;
    td.className = cellClass(card, key);
    td.title = cellTitle(card, key);
    const input = td.querySelector('input');
    if (document.activeElement !== input) input.value = card.fields[key] || '';
  }
}

function pictureIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ['circle', { cx: 9, cy: 10, r: 2 }],
    ['path', { d: 'm21 16-5-5-9 9' }],
  ]) {
    const node = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}

function buildRow(card) {
  const tr = el('tr', { 'data-id': card.id });
  tr.append(
    el(
      'td',
      { class: 'sticky-col c-open' },
      el(
        'button',
        {
          class: 'row-open',
          title: 'Open with images',
          'aria-label': `Open ${displayName(card)} with images`,
          onclick: () => {
            setView('cards');
            select(card.id);
          },
        },
        pictureIcon()
      )
    ),
    el('td', { class: 'sticky-col c-state' }, el('span', { class: 'pill' }))
  );
  const box = el('input', { type: 'checkbox', 'aria-label': `Reviewed: ${displayName(card)}` });
  box.addEventListener('change', async () => {
    const updated = await api.updateCard(card.id, {}, box.checked);
    replaceCard(updated);
    updateRow(tr, updated);
    renderList();
  });
  tr.append(el('td', { class: 'c-reviewed' }, box));

  for (const key of state.csvOrder) {
    const def = state.fields.find((d) => d.key === key);
    const input = el('input', { value: card.fields[key] || '', spellcheck: 'false', 'aria-label': `${def.label}, ${displayName(card)}` });
    if (/date/.test(key)) input.placeholder = 'DD/MM/YYYY';
    manualPlaceholder(input, def, true);
    maskSecret(input, def);
    input.style.width = `${COL_WIDTH[key] || 120}px`;
    input.addEventListener('change', async () => {
      const updated = await api.updateCard(card.id, { [key]: input.value });
      replaceCard(updated);
      updateRow(tr, updated);
      renderList();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const rows = [...$('#grid-body').children];
      const next = rows[rows.indexOf(tr) + (e.shiftKey ? -1 : 1)];
      const target = next && next.querySelector(`td[data-key="${key}"] input`);
      if (target) target.focus();
      else input.blur();
    });
    input.addEventListener('focus', () => input.select());
    tr.append(el('td', { 'data-key': key }, input));
  }
  updateRow(tr, card);
  return tr;
}

function renderTable() {
  if (!state.csvOrder) return;
  if (!$('#grid-head').children.length) renderTableHead();
  const cards = visibleCards();
  $('#grid-body').replaceChildren(...cards.map(buildRow));
  $('#grid').hidden = !state.cards.length;
  $('#table-empty').hidden = !!state.cards.length;
}

function setView(view) {
  state.view = view;
  try {
    localStorage.setItem('view', view);
  } catch {
    // storage unavailable: the view just isn't remembered
  }
  $('#cards-view').hidden = view !== 'cards';
  $('#table-view').hidden = view !== 'table';
  for (const [id, v] of [['#view-cards', 'cards'], ['#view-table', 'table']]) {
    $(id).classList.toggle('active', view === v);
    $(id).setAttribute('aria-selected', String(view === v));
  }
  if (view === 'table') renderTable();
  else renderCard();
}

$('#view-cards').addEventListener('click', () => setView('cards'));
$('#view-table').addEventListener('click', () => setView('table'));

function move(delta) {
  const i = state.cards.findIndex((c) => c.id === state.selected);
  const next = state.cards[i + delta];
  if (next) select(next.id);
}

function openLightbox(src) {
  const lb = $('#lightbox');
  $('#lightbox-img').src = src;
  lb.classList.remove('zoomed');
  lb.hidden = false;
}

// --- Wiring --------------------------------------------------------------------------------------
async function addImages() {
  processPaths(await api.pickImages());
}
$('#btn-add').addEventListener('click', addImages);
$('#btn-add-empty').addEventListener('click', addImages);

$('#btn-export').addEventListener('click', async () => {
  const r = await api.exportCsv();
  if (!r) return;
  const msg = r.review
    ? `Exported ${r.count} cards. ${r.review} still need checking (marked NEEDS REVIEW in the file).`
    : `Exported ${r.count} cards.`;
  toast(msg, { label: 'Show file', run: () => api.reveal(r.path) });
});

$('#btn-login').addEventListener('click', async () => {
  const card = state.cards.find((c) => c.id === state.selected);
  if (!card) return;
  try {
    await api.openLogin(card.id);
  } catch (err) {
    toast(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
});

$('#btn-reviewed').addEventListener('click', async () => {
  const card = state.cards.find((c) => c.id === state.selected);
  if (!card) return;
  replaceCard(await api.updateCard(card.id, {}, !card.reviewed));
  renderList();
  renderCard();
  // Moving on to the next card that still needs attention saves a click.
  if (!card.reviewed) {
    const next = state.cards.find((c) => c.state !== 'ok' && c.id !== card.id);
    if (next) setTimeout(() => select(next.id), 250);
  }
});

$('#btn-prev').addEventListener('click', () => move(-1));
$('#btn-next').addEventListener('click', () => move(1));
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowUp') move(-1);
  if (e.altKey && e.key === 'ArrowDown') move(1);
  if (e.key === 'Escape') $('#lightbox').hidden = true;
});

$('#btn-delete').addEventListener('click', async () => {
  const card = state.cards.find((c) => c.id === state.selected);
  if (!card || !confirm(`Remove ${displayName(card)} from the list? The image files are not deleted.`)) return;
  const i = state.cards.indexOf(card);
  await api.deleteCard(card.id);
  const neighbour = state.cards[i + 1] || state.cards[i - 1];
  await reload(neighbour && neighbour.id);
});

$('#btn-clear').addEventListener('click', async () => {
  if (await api.clearCards()) await reload(null);
});

$('#btn-clear-all').addEventListener('click', async () => {
  if (await api.clearCards()) await reload(null);
});

document.querySelectorAll('.filter').forEach((b) =>
  b.addEventListener('click', () => {
    state.filter = b.dataset.filter;
    document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('active', x.dataset.filter === state.filter));
    renderList();
    if (state.view === 'table') renderTable();
  })
);

// Mirrors lib/email.js so the settings dialog can show a live example.
function previewEmail() {
  const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  const sample = state.cards[0] ? state.cards[0].fields : { name: 'Marco', surname: 'Rossi' };
  const n = slug(String(sample.name || 'marco').split(/\s+/)[0]) || 'marco';
  const s = slug(sample.surname) || 'rossi';
  const user = { 'name.surname': `${n}.${s}`, namesurname: `${n}${s}`, 'surname.name': `${s}.${n}`, 'n.surname': `${n[0]}.${s}` }[$('#set-format').value];
  const domain = $('#set-domain').value.trim().toLowerCase() || 'your-domain';
  $('#set-preview').textContent = `Example: ${user}48213@${domain}`;
}

let afterSettings = null;
function openSettings(focusDomain, then) {
  $('#set-doctype').value = state.settings.documentType || '';
  $('#set-issuer').value = state.settings.issuingBody || '';
  $('#set-domain').value = state.settings.emailDomain || '';
  $('#set-format').value = state.settings.emailFormat || 'name.surname';
  $('#set-password').value = state.settings.defaultPassword || '';
  $('#set-password').type = 'password';
  $('#set-password-show').textContent = 'Show';
  $('#set-recovery').value = state.settings.defaultRecoveryEmail || '';
  $('#set-openai-key').value = state.settings.openaiApiKey || '';
  $('#set-openai-key').type = 'password';
  $('#set-openai-show').textContent = 'Show';
  previewEmail();
  afterSettings = then || null;
  $('#settings').showModal();
  if (focusDomain) $('#set-domain').focus();
}
$('#set-domain').addEventListener('input', previewEmail);
$('#set-password-show').addEventListener('click', () => {
  const input = $('#set-password');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#set-password-show').textContent = input.type === 'password' ? 'Show' : 'Hide';
});
$('#set-openai-show').addEventListener('click', () => {
  const input = $('#set-openai-key');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#set-openai-show').textContent = input.type === 'password' ? 'Show' : 'Hide';
});
$('#set-format').addEventListener('change', previewEmail);
$('#btn-settings').addEventListener('click', () => openSettings(false));
$('#settings').addEventListener('close', async () => {
  const then = afterSettings;
  afterSettings = null;
  if ($('#settings').returnValue !== 'save') return;
  try {
    await api.setSettings({
      documentType: $('#set-doctype').value.trim(),
      issuingBody: $('#set-issuer').value.trim(),
      emailDomain: $('#set-domain').value.trim(),
      emailFormat: $('#set-format').value,
      defaultPassword: $('#set-password').value,
      defaultRecoveryEmail: $('#set-recovery').value.trim(),
      openaiApiKey: $('#set-openai-key').value.trim(),
    });
  } catch (err) {
    toast(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return;
  }
  await reload(state.selected);
  if (then) then();
  else toast('Settings saved and applied to all cards');
});

async function newAddress(id) {
  const r = await api.regenerateEmail(id);
  replaceCard(r.card);
  renderList();
  renderCard();
  toast(r.changed ? `New address: ${r.card.fields.email}` : 'Could not create a new address');
}

$('#lightbox').addEventListener('click', (e) => {
  const lb = $('#lightbox');
  if (e.target.tagName === 'IMG' && !lb.classList.contains('zoomed')) lb.classList.add('zoomed');
  else lb.hidden = true;
});

// Drag and drop of files or folders anywhere in the window.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (state.busy) return;
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop-overlay').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  processPaths(paths);
});

api.onProgress(({ done, total, file }) => {
  $('#progress-bar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $('#progress-label').textContent = file ? `Reading ${file}` : 'Matching fronts and backs…';
  $('#progress-count').textContent = `${Math.min(done + 1, total)} of ${total}`;
});

let savedView = 'cards';
try {
  savedView = localStorage.getItem('view') === 'table' ? 'table' : 'cards';
} catch {
  // storage unavailable: start in the cards view
}
setView(savedView);
reload(null);
