// Electron main process: OCR pipeline, session storage and CSV export.
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const resDir = app.isPackaged ? process.resourcesPath : __dirname;
const comuniDb = require('./lib/comuni');
comuniDb.load(path.join(resDir, 'data'));

const { OcrEngine } = require('./lib/ocr');
const { extractCard } = require('./lib/extract');
const { parseMrz } = require('./lib/mrz');
const { extractWithVision } = require('./lib/vision');
const { FIELDS, CSV_ORDER, MANUAL_KEYS, SECRET_KEYS, validate, cardState, toCsv } = require('./lib/record');

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|tiff?)$/i;
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');

let win = null;
let engine = null;
const emailGen = require('./lib/email');

let session = {
  cards: [],
  settings: {
    documentType: "Carta d'identità elettronica",
    issuingBody: 'Comune',
    emailDomain: 'libero.it',
    emailFormat: 'namesurname',
    defaultPassword: 'Cacata0!',
    defaultRecoveryEmail: 'botpotente0@libero.it',
    openaiApiKey: '',
    fiveSimToken: '',
  },
};

// Default password / recovery email from Settings. A card keeps following the default (status
// 'default') until the user types its own value; clearing the cell returns it to the default.
const DEFAULTS = { password: 'defaultPassword', recovery_email: 'defaultRecoveryEmail' };
function applyDefaults(card) {
  for (const [key, setting] of Object.entries(DEFAULTS)) {
    const value = session.settings[setting] || '';
    const followsDefault = !card.fields[key] || card.status[key] === 'default';
    if (!followsDefault) continue;
    card.fields[key] = value;
    card.status[key] = value ? 'default' : 'manual';
  }
}

// Gives a card its generated address (<name>.<surname><5 digits>@<domain>), unless the user typed one.
// The 5 digits are kept when the address is rebuilt (name corrected, domain changed) unless `fresh`.
function autoEmail(card, fresh = false) {
  if (card.fields.email && card.status.email !== 'generated') return false;
  const { emailDomain: domain, emailFormat: format } = session.settings;
  if (!emailGen.isValidDomain(domain)) return false;
  const taken = new Set(session.cards.filter((c) => c !== card).map((c) => c.fields.email).filter(Boolean));
  const email = emailGen.generate(card.fields, { domain, format }, taken, fresh ? '' : emailGen.digitsOf(card.fields.email));
  if (!email || email === card.fields.email) return false;
  card.fields.email = email;
  card.status.email = 'generated';
  syncUsername(card);
  return true;
}

function syncUsername(card) {
  if (card.fields.username && card.status.username === 'edited') return;
  const email = card.fields.email || '';
  const name = email.split('@')[0] || '';
  card.fields.username = name;
  card.status.username = name ? 'generated' : 'manual';
}
let busy = false;

// Passwords are encrypted at rest with the OS key store (DPAPI on Windows), never written in clear.
const ENC_PREFIX = 'enc:';
const canEncrypt = () => safeStorage.isEncryptionAvailable();
const encrypt = (v) => (v && canEncrypt() ? ENC_PREFIX + safeStorage.encryptString(v).toString('base64') : v);
function decrypt(v) {
  if (!v || !String(v).startsWith(ENC_PREFIX)) return v || '';
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64'));
  } catch {
    return ''; // encrypted on another Windows account or PC: cannot be recovered
  }
}

function loadSession() {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    session = { ...session, ...s, settings: { ...session.settings, ...s.settings } };
  } catch {
    // first run or unreadable session: start empty
  }
  if (!session.settings.emailDomain) session.settings.emailDomain = 'libero.it';
  for (const c of session.cards) {
    // Cards saved by an older version lack the newer manual columns.
    for (const k of MANUAL_KEYS) {
      if (!(k in c.fields)) c.fields[k] = '';
      if (!c.status[k]) c.status[k] = 'manual';
    }
    for (const k of SECRET_KEYS) c.fields[k] = decrypt(c.fields[k]);
  }
  session.settings.defaultPassword = decrypt(session.settings.defaultPassword);
  session.settings.openaiApiKey = decrypt(session.settings.openaiApiKey);
  session.settings.fiveSimToken = decrypt(session.settings.fiveSimToken);
  for (const c of session.cards) {
    autoEmail(c); // cards saved before emails were generated automatically
    syncUsername(c);
    applyDefaults(c);
  }
}

function saveSession() {
  fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
  const cards = session.cards.map((c) => {
    const fields = { ...c.fields };
    for (const k of SECRET_KEYS) fields[k] = encrypt(fields[k]);
    return { ...c, fields };
  });
  const settings = { ...session.settings, defaultPassword: encrypt(session.settings.defaultPassword), openaiApiKey: encrypt(session.settings.openaiApiKey), fiveSimToken: encrypt(session.settings.fiveSimToken) };
  fs.writeFileSync(sessionFile(), JSON.stringify({ ...session, settings, cards }));
}

const view = (card) => {
  const { ocr, ...rest } = card;
  return { ...rest, state: cardState(card), validation: validate(card.fields) };
};

async function getEngine() {
  if (!engine) {
    engine = new OcrEngine({ langPath: path.join(resDir, 'tessdata'), cachePath: path.join(app.getPath('userData'), 'ocr-cache') });
    await engine.init();
  }
  return engine;
}

function expandPaths(paths) {
  const out = [];
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) out.push(...expandPaths(fs.readdirSync(p).map((f) => path.join(p, f))));
      else if (IMAGE_EXT.test(p)) out.push(p);
    } catch {
      // skip unreadable entries
    }
  }
  return out;
}

const sortKey = (p) => path.basename(p, path.extname(p));
const byName = (a, b) => sortKey(a.file).localeCompare(sortKey(b.file), undefined, { numeric: true });

// How strongly a front matches a back: both sides print the document number, name and dates.
function pairScore(front, back) {
  const mrz = parseMrz(back.mrzTexts || []);
  if (!mrz) return 0;
  const text = comuniDb.norm((front.texts || []).join(' '));
  const date = (d) => comuniDb.norm(d.replace(/\//g, ''));
  let s = 0;
  if (mrz.documentNumber && text.includes(mrz.documentNumber)) s += 3;
  if (mrz.surname && text.includes(comuniDb.norm(mrz.surname))) s += 2;
  if (mrz.name && text.includes(comuniDb.norm(mrz.name))) s += 1;
  if (mrz.birthDate && text.includes(date(mrz.birthDate))) s += 2;
  if (mrz.expiryDate && text.includes(date(mrz.expiryDate))) s += 2;
  return s;
}

function pairUp(results) {
  const fronts = results.filter((r) => r.side === 'front').sort(byName);
  const backs = results.filter((r) => r.side === 'back').sort(byName);
  const pairs = [];

  // 1. Content match, strongest first.
  const scored = [];
  fronts.forEach((f, i) => backs.forEach((b, j) => scored.push({ i, j, s: pairScore(f, b) })));
  scored.sort((a, b) => b.s - a.s);
  const usedF = new Set();
  const usedB = new Set();
  for (const { i, j, s } of scored) {
    if (s < 3 || usedF.has(i) || usedB.has(j)) continue;
    usedF.add(i);
    usedB.add(j);
    pairs.push([fronts[i], backs[j]]);
  }

  // 2. Whatever is left: neighbours in file-name order.
  const restF = fronts.filter((_, i) => !usedF.has(i));
  const restB = backs.filter((_, j) => !usedB.has(j));
  while (restF.length || restB.length) pairs.push([restF.shift() || null, restB.shift() || null]);

  const order = (p) => (p[0] || p[1]).file;
  return pairs.sort((a, b) => byName({ file: order(a) }, { file: order(b) }));
}

function buildCard([front, back]) {
  const { fields, status, notes } = extractCard(front, back, session.settings);
  if (!front) notes.unshift('Front image missing');
  if (!back) notes.unshift('Back image missing');
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    front: front ? front.file : null,
    back: back ? back.file : null,
    fields,
    status,
    notes,
    reviewed: false,
    ocr: { front, back },
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'CIE Reader',
    backgroundColor: '#f6f7f9',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// --- IPC ----------------------------------------------------------------------------------------
ipcMain.handle('session:get', () => ({
  cards: session.cards.map(view),
  settings: session.settings,
  fields: FIELDS,
  csvOrder: CSV_ORDER,
  busy,
}));

ipcMain.handle('images:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select ID card images (front and back)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('images:process', (_e, paths) => processFiles(paths));

const displayName = (c) => [c.fields.surname, c.fields.name].filter(Boolean).join(' ') || 'card';

const VISION_FIELDS = [
  'surname', 'name', 'birth_date', 'sex', 'birth_comune', 'birth_province',
  'nation', 'tax_id', 'res_city', 'res_province', 'address', 'house_number',
  'cap', 'document_number', 'issue_date', 'expiry_date', 'place_of_issue',
];

function enhanceWithVision(card, vision) {
  for (const key of VISION_FIELDS) {
    const visionVal = (vision[key] || '').trim();
    if (!visionVal) continue;
    const currentVal = card.fields[key] || '';
    const currentStatus = card.status[key];
    if (currentStatus === 'ok' && currentVal) continue;
    if (currentStatus === 'missing' || !currentVal) {
      card.fields[key] = visionVal;
      card.status[key] = 'check';
      continue;
    }
    if (currentStatus === 'check') {
      card.fields[key] = visionVal;
      card.status[key] = 'check';
    }
  }
}

async function processFiles(paths) {
  if (busy) throw new Error('Already processing images');
  const known = new Set(session.cards.flatMap((c) => [c.front, c.back]).filter(Boolean));
  const files = expandPaths(paths).filter((f) => !known.has(f));
  const skipped = expandPaths(paths).length - files.length;
  if (!files.length) return { added: 0, skipped, unknown: [] };

  busy = true;
  try {
    const ocr = await getEngine();
    const results = [];
    for (let i = 0; i < files.length; i++) {
      win.webContents.send('progress', { done: i, total: files.length, file: path.basename(files[i]) });
      try {
        results.push({ file: files[i], ...(await ocr.readImage(files[i])) });
      } catch (err) {
        results.push({ file: files[i], side: 'unknown', error: String(err.message || err) });
      }
    }
    win.webContents.send('progress', { done: files.length, total: files.length });

    const unknown = results.filter((r) => r.side === 'unknown').map((r) => path.basename(r.file));
    const cards = pairUp(results.filter((r) => r.side !== 'unknown')).map(buildCard);

    const apiKey = session.settings.openaiApiKey;
    if (apiKey) {
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        win.webContents.send('progress', { done: files.length + i, total: files.length + cards.length, file: `AI reading ${displayName(c)}…` });
        try {
          const vision = await extractWithVision(apiKey, c.front, c.back);
          if (vision) enhanceWithVision(c, vision);
        } catch (err) {
          c.notes.push(`AI vision: ${err.message}`);
        }
      }
    }

    session.cards.push(...cards);
    for (const c of cards) {
      autoEmail(c);
      applyDefaults(c);
    }
    saveSession();
    return { added: cards.length, skipped, unknown, firstId: cards[0] && cards[0].id };
  } finally {
    busy = false;
  }
}

ipcMain.handle('card:update', (_e, id, changes, reviewed) => {
  const card = session.cards.find((c) => c.id === id);
  if (!card) throw new Error('Card not found');
  for (const [k, v] of Object.entries(changes || {})) {
    if (!(k in card.fields)) continue;
    let value = String(v);
    if (k === 'tax_id' || k === 'document_number') value = value.toUpperCase().trim();
    else if (k === 'email' || k === 'recovery_email') value = value.toLowerCase().trim();
    if (value !== card.fields[k]) {
      card.fields[k] = value;
      card.status[k] = 'edited';
    }
  }
  if (typeof reviewed === 'boolean') card.reviewed = reviewed;
  // A corrected (or newly typed) name rebuilds the generated email; clearing the email regenerates it.
  if (changes && ('name' in changes || 'surname' in changes || changes.email === '')) {
    if (changes.email === '') card.status.email = 'manual';
    autoEmail(card);
  }
  // Sync username from email when email changes, or when username is cleared.
  if (changes && ('email' in changes || changes.username === '')) {
    if (changes.username === '') card.status.username = 'manual';
    syncUsername(card);
  }
  // Clearing the password or recovery email puts the card back on the default from Settings.
  if (changes && Object.keys(DEFAULTS).some((k) => changes[k] === '')) applyDefaults(card);
  saveSession();
  return view(card);
});

ipcMain.handle('card:delete', (_e, id) => {
  session.cards = session.cards.filter((c) => c.id !== id);
  saveSession();
});

ipcMain.handle('cards:clear', async () => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Remove all', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Remove all cards from the list?',
    detail: 'The image files are not deleted. Edits you have made to the extracted data will be lost.',
  });
  if (r.response !== 0) return false;
  session.cards = [];
  saveSession();
  return true;
});

ipcMain.handle('settings:set', (_e, settings) => {
  if (settings.emailDomain && !emailGen.isValidDomain(settings.emailDomain)) throw new Error('Email domain is not valid');
  const recovery = String(settings.defaultRecoveryEmail ?? session.settings.defaultRecoveryEmail).toLowerCase().trim();
  if (recovery && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recovery)) throw new Error('Default recovery email is not valid');
  session.settings = {
    ...session.settings,
    ...settings,
    emailDomain: String(settings.emailDomain || session.settings.emailDomain).toLowerCase(),
    defaultRecoveryEmail: recovery,
  };
  for (const c of session.cards) {
    c.fields.document_type = session.settings.documentType;
    c.fields.issuing_body = session.settings.issuingBody;
    autoEmail(c); // new domain / format applies to generated addresses, keeping their digits
    syncUsername(c);
    applyDefaults(c); // new defaults apply to every card that has not been given its own value
  }
  saveSession();
  return session.settings;
});

// "New address" on one card: same username, new random digits (e.g. when the address is taken).
ipcMain.handle('emails:regenerate', (_e, id) => {
  const card = session.cards.find((c) => c.id === id);
  if (!card) throw new Error('Card not found');
  const changed = autoEmail(card, true);
  saveSession();
  return { changed, card: view(card) };
});

ipcMain.handle('csv:export', async () => {
  if (!session.cards.length) return null;
  const r = await dialog.showSaveDialog(win, {
    title: 'Export CSV',
    defaultPath: path.join(app.getPath('documents'), `cards-${new Date().toISOString().slice(0, 10)}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, toCsv(session.cards), 'utf8');
  return { path: r.filePath, count: session.cards.length, review: session.cards.filter((c) => cardState(c) !== 'ok').length };
});

ipcMain.handle('login:open', async (_e, id) => {
  const card = session.cards.find((c) => c.id === id);
  if (!card) throw new Error('Card not found');

  const email = card.fields.email || '';
  const password = card.fields.password || '';
  const username = card.fields.username || email.split('@')[0];

  if (!username) throw new Error('No email address on this card');
  if (!password) throw new Error('No password on this card');

  const { register } = require('./lib/browser');
  register(
    { username, password, name: card.fields.name, surname: card.fields.surname, birthDate: card.fields.birth_date, sex: card.fields.sex, city: card.fields.res_city, recoveryEmail: card.fields.recovery_email || session.settings.defaultRecoveryEmail, fiveSimToken: session.settings.fiveSimToken },
    (msg) => win.webContents.send('progress', { done: 0, total: 0, file: msg })
  ).catch((err) => {
    console.error('Registration error:', err);
    win.webContents.send('progress', { done: 0, total: 0, file: `Error: ${err.message}` });
  });

  return { email };
});

ipcMain.handle('file:reveal', (_e, p) => shell.showItemInFolder(p));

ipcMain.handle('image:data', (_e, p) => {
  try {
    const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg').replace('tif', 'tiff');
    return `data:image/${ext};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch {
    return null;
  }
});

// Development smoke test: CIE_SMOKE=<image folder> processes the folder in a fresh session,
// saves screenshots and the CSV next to the session file, then quits.
async function smokeTest(dir) {
  const out = path.join(app.getPath('userData'), 'smoke');
  fs.mkdirSync(out, { recursive: true });
  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 1200));
    fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
  };
  await shot('0-empty.png');
  const r = await processFiles([dir]);
  console.log('SMOKE processed', JSON.stringify(r));
  // A card saved by an older version (no account columns) must get them back on load.
  delete session.cards[0].fields.email;
  delete session.cards[0].status.email;
  saveSession();
  loadSession();
  console.log('SMOKE migration (email restored and generated):', session.cards[0].status.email === 'generated', session.cards[0].fields.email);
  await win.webContents.executeJavaScript('reload(null)');
  await shot('1-first-card.png');
  await win.webContents.executeJavaScript(
    'select((state.cards.find((c) => c.state === "error") || state.cards[0]).id)'
  );
  await shot('2-card-incomplete.png');
  await win.webContents.executeJavaScript('document.querySelector("#detail").scrollTop = 99999');
  await shot('3-card-incomplete-bottom.png');
  await win.webContents.executeJavaScript('setView("table")');
  await shot('4-table.png');
  // Edit a cell and tick "Reviewed" through the UI, as a user would.
  const edit = await win.webContents.executeJavaScript(`(async () => {
    const row = [...document.querySelectorAll('#grid-body tr')].find((tr) => tr.querySelector('td.has-error'));
    const td = row.querySelector('td.has-error');
    const input = td.querySelector('input');
    input.value = td.dataset.key === 'cap' ? '30174' : td.dataset.key.includes('date') ? '01/01/2020' : '7';
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 500));
    const box = document.querySelector('#grid-body tr input[type=checkbox]:not(:disabled):not(:checked)');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 500));
    return { key: td.dataset.key, cls: td.className, value: input.value };
  })()`);
  console.log('SMOKE table edit', JSON.stringify(edit));
  const account = await win.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector('#grid-body tr');
    const values = { email: ' Test.User@Example.com ', password: 'S3cret!pass', recovery_email: 'not-an-email' };
    for (const [k, v] of Object.entries(values)) {
      const input = row.querySelector('td[data-key="' + k + '"] input');
      input.value = v;
      input.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 300));
    }
    const cell = (k) => row.querySelector('td[data-key="' + k + '"]');
    return {
      email: cell('email').querySelector('input').value,
      passwordType: cell('password').querySelector('input').type,
      recoveryClass: cell('recovery_email').className,
      recoveryTitle: cell('recovery_email').title,
    };
  })()`);
  console.log('SMOKE account', JSON.stringify(account));
  const raw = fs.readFileSync(sessionFile(), 'utf8');
  console.log('SMOKE password stored in clear:', raw.includes('S3cret!pass'), '| encrypted marker present:', raw.includes('"password":"enc:'));
  await win.webContents.executeJavaScript('document.querySelector("#table-wrap").scrollLeft = 99999');
  await shot('6-table-account.png');
  const gen = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const emails = state.cards.map((c) => c.fields.email + ' [' + c.status.email + ']');
    // Correcting a name in the table rebuilds the generated email with the same digits.
    const row = document.querySelectorAll('#grid-body tr')[1];
    const before = row.querySelector('td[data-key="email"] input').value;
    const nameInput = row.querySelector('td[data-key="name"] input');
    nameInput.value = 'ARMANDINO';
    nameInput.dispatchEvent(new Event('change'));
    await wait(500);
    const afterName = row.querySelector('td[data-key="email"] input').value;
    await api.setSettings({ ...state.settings, emailDomain: 'Example.it' });
    await reload(state.selected);
    const afterDomain = state.cards[1].fields.email;
    await api.setSettings({ ...state.settings, emailDomain: 'libero.it' });
    await reload(state.selected);
    const r = await api.regenerateEmail(state.cards[1].id);
    await reload(state.selected);
    return { emails, before, afterName, afterDomain, newAddress: r.card.fields.email };
  })()`);
  console.log('SMOKE generate', JSON.stringify(gen, null, 1));
  const defaults = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const pick = () => state.cards.slice(0, 3).map((c) => c.fields.password + ' [' + c.status.password + '] / ' + c.fields.recovery_email + ' [' + c.status.recovery_email + ']');
    await api.setSettings({ ...state.settings, defaultPassword: 'Default#2026', defaultRecoveryEmail: 'Office@Example.com' });
    await reload(state.selected);
    const applied = pick();
    await api.setSettings({ ...state.settings, defaultPassword: 'Changed#2027' });
    await reload(state.selected);
    const changed = pick();
    // Clear card 0's own password in the table: it must fall back to the default.
    const input = document.querySelector('#grid-body tr td[data-key="password"] input');
    input.value = '';
    input.dispatchEvent(new Event('change'));
    await wait(500);
    await reload(state.selected);
    const cleared = pick();
    let badRecovery = '';
    try { await api.setSettings({ ...state.settings, defaultRecoveryEmail: 'nope' }); } catch (e) { badRecovery = 'rejected'; }
    return { applied, changed, cleared, badRecovery };
  })()`);
  console.log('SMOKE defaults', JSON.stringify(defaults, null, 1));
  const raw2 = fs.readFileSync(sessionFile(), 'utf8');
  console.log('SMOKE default password stored in clear:', raw2.includes('Changed#2027') || raw2.includes('Default#2026'));
  await win.webContents.executeJavaScript('document.querySelector("#table-wrap").scrollLeft = 99999');
  await shot('9-table-defaults.png');
  await win.webContents.executeJavaScript('document.querySelector("#table-wrap").scrollLeft = 99999');
  await shot('7-table-generated.png');
  await win.webContents.executeJavaScript('openSettings(false)');
  await shot('8-settings.png');
  await win.webContents.executeJavaScript('document.querySelector("#settings").close()');
  await win.webContents.executeJavaScript('document.querySelector("#table-wrap").scrollLeft = 900');
  await shot('5-table-scrolled.png');
  fs.writeFileSync(path.join(out, 'cards.csv'), toCsv(session.cards), 'utf8');
  console.log('SMOKE states', session.cards.map((c) => `${c.fields.surname}:${cardState(c)}`).join(' '));
  console.log('SMOKE output', out);
  app.quit();
}

app.whenReady().then(() => {
  if (process.env.CIE_SMOKE) app.setPath('userData', path.join(app.getPath('temp'), 'cie-reader-smoke'));
  if (process.env.CIE_SMOKE) fs.rmSync(sessionFile(), { force: true });
  loadSession();
  createWindow();
  if (process.env.CIE_SMOKE) win.webContents.once('did-finish-load', () => smokeTest(process.env.CIE_SMOKE));
});

app.on('window-all-closed', async () => {
  if (engine) await engine.terminate().catch(() => {});
  app.quit();
});
