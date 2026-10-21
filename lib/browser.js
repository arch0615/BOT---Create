const { addExtra } = require('puppeteer-extra');
const puppeteerCore = require('puppeteer-core');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawn } = require('child_process');
const fs = require('fs');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome() {
  for (const p of CHROME_PATHS) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return null;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const randWait = (min, max) => wait(min + Math.random() * (max - min));

// --- System cursor via PowerShell ----------------------------------------------------
let cursorProc = null;
let lastCX = 500, lastCY = 400;

function initCursor() {
  if (cursorProc && !cursorProc.killed) return;
  cursorProc = spawn('powershell.exe', [
    '-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; while ($null -ne ($line = [Console]::In.ReadLine())) { $p = $line.Split(","); [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$p[0],[int]$p[1]) }',
  ], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  cursorProc.on('exit', () => { cursorProc = null; });
}

function setCursorPos(x, y) {
  initCursor();
  cursorProc.stdin.write(`${Math.round(x)},${Math.round(y)}\n`);
}

function cleanupCursor() {
  if (cursorProc) { cursorProc.stdin.end(); cursorProc = null; }
}

async function viewportOffset(page) {
  return page.evaluate(() => ({
    x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
    y: window.screenY + (window.outerHeight - window.innerHeight),
  }));
}

async function moveCursorTo(page, el) {
  const box = await el.boundingBox();
  if (!box) return;
  const off = await viewportOffset(page);
  const tx = off.x + box.x + box.width / 2;
  const ty = off.y + box.y + box.height / 2;

  const steps = 25;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    setCursorPos(lastCX + (tx - lastCX) * ease, lastCY + (ty - lastCY) * ease);
    await wait(12);
  }
  lastCX = tx;
  lastCY = ty;
  await randWait(80, 200);
}

// --- Human-like typing ---------------------------------------------------------------
async function humanType(el, text) {
  for (const ch of text) {
    await el.type(ch);
    await randWait(50, 180);
  }
}

// --- Interaction helpers -------------------------------------------------------------
async function inputByLabel(page, labelRe) {
  return page.evaluateHandle((re) => {
    for (const lbl of document.querySelectorAll('label')) {
      if (new RegExp(re, 'i').test(lbl.textContent.trim())) {
        const inp = lbl.querySelector('input');
        if (inp) return inp;
        if (lbl.htmlFor) return document.getElementById(lbl.htmlFor);
      }
    }
    for (const inp of document.querySelectorAll('input')) {
      if (new RegExp(re, 'i').test(inp.placeholder || '')) return inp;
    }
    return null;
  }, labelRe);
}

async function typeField(page, labelRe, value) {
  if (!value) return;
  const el = await inputByLabel(page, labelRe);
  if (!el) return;
  await moveCursorTo(page, el);
  await randWait(100, 300);
  await el.click({ clickCount: 3 });
  await randWait(80, 200);
  await humanType(el, value);
}

async function clickButton(page, textRe) {
  const btn = await page.evaluateHandle((re) => {
    for (const b of document.querySelectorAll('button, input[type=submit]')) {
      if (new RegExp(re, 'i').test(b.textContent || b.value)) return b;
    }
    return null;
  }, textRe);
  if (btn) {
    await moveCursorTo(page, btn);
    await randWait(200, 500);
    await btn.click();
  }
}

async function selectRadio(page, labelText) {
  const label = await page.evaluateHandle((txt) => {
    for (const l of document.querySelectorAll('label')) {
      if (l.textContent.trim().toLowerCase() === txt.toLowerCase()) return l;
    }
    return null;
  }, labelText);
  if (label) {
    await moveCursorTo(page, label);
    await randWait(100, 300);
    await page.evaluate((txt) => {
      for (const l of document.querySelectorAll('label')) {
        if (l.textContent.trim().toLowerCase() === txt.toLowerCase()) {
          const r = l.querySelector('input[type=radio]');
          if (r && !r.checked) r.click();
          else if (!r) l.click();
        }
      }
    }, labelText);
  }
}

async function pickAutocomplete(page, value) {
  await randWait(1200, 2000);
  const opt = await page.evaluateHandle((v) => {
    const selectors = '[role=option], [role=listbox] li, ul[class*=auto] li, ul[class*=suggest] li, li[class*=option], [class*=menu] li, [class*=listbox] li';
    for (const el of document.querySelectorAll(selectors)) {
      if (el.textContent.trim().toLowerCase().includes(v.toLowerCase()) && el.offsetParent !== null) return el;
    }
    for (const el of document.querySelectorAll('li, div[role=option]')) {
      if (el.textContent.trim().toLowerCase().includes(v.toLowerCase()) && el.offsetParent !== null) return el;
    }
    return null;
  }, value);
  if (opt) {
    await moveCursorTo(page, opt);
    await randWait(100, 250);
    await opt.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.click();
    });
  }
}

// --- Registration flow ---------------------------------------------------------------
async function register(data, onStatus) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Google Chrome not found. Install it or set CHROME_PATH.');

  const log = (msg) => onStatus && onStatus(msg);
  initCursor();

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = (await browser.pages())[0];
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.goto('https://registrazione.libero.it/', { waitUntil: 'networkidle2' });
  await randWait(800, 1500);

  // --- Step 1: Username + Password ---
  log('Filling username and password…');
  const inputs = await page.$$('input');
  let filledUser = false;
  for (const inp of inputs) {
    const type = await inp.evaluate((el) => el.type);
    const visible = await inp.evaluate((el) => el.offsetParent !== null);
    if (!visible) continue;
    if (type === 'password') {
      await moveCursorTo(page, inp);
      await randWait(150, 400);
      await humanType(inp, data.password);
    } else if (['text', 'email', ''].includes(type) && !filledUser) {
      await moveCursorTo(page, inp);
      await randWait(150, 400);
      await humanType(inp, data.username);
      filledUser = true;
    }
  }

  log('Waiting for CAPTCHA to be solved…');
  await page.waitForFunction(
    () => {
      try {
        const resp = document.querySelector('textarea[name="g-recaptcha-response"]');
        if (resp && resp.value.length > 0) return true;
      } catch {}
      const checked = document.querySelector('.recaptcha-checkbox-checked, .rc-anchor-checked');
      if (checked) return true;
      return false;
    },
    { timeout: 300000 }
  );
  await randWait(600, 1200);
  log('CAPTCHA solved! Clicking Avanti…');
  await clickButton(page, 'avanti');

  await page.waitForFunction(
    () => !document.querySelector('input[type=password]') && /cognome|informazioni personali/i.test(document.body.innerText),
    { timeout: 30000 }
  );
  await randWait(1000, 2000);

  // --- Step 2: Personal info ---
  log('Filling personal info…');
  await typeField(page, '^nome$', data.name);
  await randWait(200, 500);
  await typeField(page, 'cognome', data.surname);
  await randWait(200, 500);
  await typeField(page, 'data.*nascita', data.birthDate);
  await randWait(300, 600);

  if (data.city) {
    const cityEl = await inputByLabel(page, 'citt');
    if (cityEl) {
      await moveCursorTo(page, cityEl);
      await randWait(100, 300);
      await cityEl.click({ clickCount: 3 });
      await randWait(80, 200);
      await humanType(cityEl, data.city);
      await pickAutocomplete(page, data.city);
    }
  }

  await randWait(300, 600);
  if (data.sex) {
    await selectRadio(page, data.sex === 'M' ? 'Uomo' : 'Donna');
  }

  await randWait(500, 1200);
  await clickButton(page, 'avanti');
  log('Page 2 done, moving to page 3…');

  // --- Step 3: Security & Privacy ---
  await page.waitForFunction(
    () => /sicurezza|protezione account/i.test(document.body.innerText),
    { timeout: 30000 }
  );
  await randWait(800, 1500);

  log('Filling recovery email and consents…');
  await typeField(page, 'mail.*cellulare', data.recoveryEmail);
  await randWait(300, 700);
  await selectRadio(page, 'Presto il consenso');
  await randWait(400, 800);
  await clickButton(page, 'registrati');

  log('Registration submitted.');
  cleanupCursor();
}

module.exports = { register, findChrome };
