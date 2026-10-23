const { addExtra } = require('puppeteer-extra');
const puppeteerCore = require('puppeteer-core');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sms = require('./sms');

const DEBUG_LOG = path.join(__dirname, '..', 'registration-debug.log');
function debugLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(`[register] ${msg}`);
  try { fs.appendFileSync(DEBUG_LOG, line); } catch {}
}

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

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
async function humanType(page, el, text, { minDelay = 50, maxDelay = 180 } = {}) {
  await el.click();
  await randWait(100, 250);
  for (const ch of text) {
    await page.keyboard.type(ch);
    await randWait(minDelay, maxDelay);
  }
}

// --- Interaction helpers -------------------------------------------------------------
async function inputByLabel(page, labelRe) {
  const handle = await page.evaluateHandle((re) => {
    const regex = new RegExp(re, 'i');
    for (const lbl of document.querySelectorAll('label')) {
      if (regex.test(lbl.textContent.trim())) {
        const inp = lbl.querySelector('input, select, textarea');
        if (inp) return inp;
        if (lbl.htmlFor) return document.getElementById(lbl.htmlFor);
      }
    }
    for (const inp of document.querySelectorAll('input')) {
      if (regex.test(inp.placeholder || '')) return inp;
      if (regex.test(inp.getAttribute('aria-label') || '')) return inp;
      if (regex.test(inp.name || '')) return inp;
    }
    return null;
  }, labelRe);
  const isNull = await handle.evaluate((el) => el === null);
  return isNull ? null : handle;
}

async function typeField(page, labelRe, value) {
  if (!value) return;
  const el = await inputByLabel(page, labelRe);
  if (!el) {
    console.log(`typeField: no input found for "${labelRe}"`);
    return;
  }
  await moveCursorTo(page, el);
  await randWait(100, 300);
  await el.click({ clickCount: 3 });
  await randWait(80, 200);
  await humanType(page, el, value);
}

async function clickButton(page, textRe) {
  const btn = await page.evaluateHandle((re) => {
    for (const b of document.querySelectorAll('button, input[type=submit], a[role=button], [type=button], a.btn, a[class*=button], div[role=button], span[role=button]')) {
      if (new RegExp(re, 'i').test(b.textContent || b.value)) return b;
    }
    return null;
  }, textRe);
  if (btn && await btn.evaluate((el) => !!el && el.offsetParent !== null)) {
    await moveCursorTo(page, btn);
    await randWait(200, 500);
    await btn.click();
    return true;
  }
  return false;
}

async function selectRadio(page, labelText) {
  const target = await page.evaluateHandle((txt) => {
    const t = txt.toLowerCase();
    for (const l of document.querySelectorAll('label')) {
      if (l.textContent.trim().toLowerCase() === t || l.textContent.trim().toLowerCase().includes(t)) return l;
    }
    for (const r of document.querySelectorAll('input[type=radio]')) {
      const parent = r.closest('label, div, span, li');
      if (parent && parent.textContent.trim().toLowerCase().includes(t)) return parent;
    }
    for (const el of document.querySelectorAll('span, div, p')) {
      if (el.textContent.trim().toLowerCase() === t && el.offsetParent !== null) return el;
    }
    return null;
  }, labelText);
  const isNull = await target.evaluate((el) => el === null);
  if (!isNull) {
    await moveCursorTo(page, target);
    await randWait(100, 300);
    await page.evaluate((txt) => {
      const t = txt.toLowerCase();
      for (const l of document.querySelectorAll('label')) {
        if (l.textContent.trim().toLowerCase().includes(t)) {
          const r = l.querySelector('input[type=radio]');
          if (r && !r.checked) r.click();
          else if (!r) l.click();
          return;
        }
      }
      for (const r of document.querySelectorAll('input[type=radio]')) {
        const parent = r.closest('label, div, span, li');
        if (parent && parent.textContent.trim().toLowerCase().includes(t)) {
          if (!r.checked) r.click();
          return;
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

  const log = (msg) => { onStatus && onStatus(msg); debugLog(msg); };
  try { fs.writeFileSync(DEBUG_LOG, ''); } catch {}
  debugLog('=== REGISTRATION START ===');
  debugLog(`Data keys: ${Object.keys(data).join(', ')}`);
  initCursor();

  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  debugLog(`User-Agent: ${ua}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,
      defaultViewport: null,
      args: [
        '--start-maximized',
        '--no-first-run',
        '--no-default-browser-check',
        '--test-type',
        '--disable-infobars',
        '--disable-save-password-bubble',
        '--disable-features=PasswordManagerOnboarding,CredentialManagerPasswordSaving,AutofillServerCommunication,TranslateUI',
        '--disable-component-extensions-with-background-pages',
        '--disable-translate',
        '--disable-popup-blocking',
        '--lang=it-IT',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  } catch (launchErr) {
    debugLog(`❌ Browser launch failed: ${launchErr.stack}`);
    log(`Error: Chrome failed to launch — ${launchErr.message}`);
    cleanupCursor();
    throw launchErr;
  }

  try {

  const page = (await browser.pages())[0];

  // Force a known-good, high-reputation desktop Chrome UA before any navigation.
  const appliedUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  await page.setUserAgent(appliedUA);
  debugLog(`User-Agent applied: ${appliedUA}`);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });

  // Forward browser console and errors to our terminal for debugging.
  page.on('console', (msg) => debugLog(`🌐 BROWSER: ${msg.text()}`));
  page.on('pageerror', (err) => debugLog(`❌ PAGE ERROR: ${err.message}`));

  // Strip the webdriver flag entirely (not just set it false, which is itself detectable).
  await page.evaluateOnNewDocument(() => {
    try { delete Navigator.prototype.webdriver; } catch {}
    try { delete navigator.__proto__.webdriver; } catch {}
    Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it'] });
  });

  log('Navigating to registration page…');
  await page.goto('https://registrazione.libero.it/', { waitUntil: 'networkidle0', timeout: 30000 });

  // Verify the page actually reached Libero.
  const pageTitle = await page.title();
  debugLog(`🌐 Page loaded with title: "${pageTitle}"`);
  log(`Page title: "${pageTitle}"`);

  // Verify the page actually loaded content (not a blank white screen).
  try {
    await page.waitForSelector('body', { visible: true, timeout: 10000 });
    const bodyInfo = await page.evaluate(() => ({
      children: document.body.children.length,
      textLen: document.body.innerText.trim().length,
      html: document.documentElement.outerHTML.length,
    }));
    debugLog(`Body stats — children: ${bodyInfo.children}, text: ${bodyInfo.textLen} chars, html: ${bodyInfo.html} chars`);

    if (bodyInfo.textLen < 10) {
      debugLog('Page body has no text — waiting 5s and retrying…');
      await wait(5000);
      const retryInfo = await page.evaluate(() => ({
        children: document.body.children.length,
        textLen: document.body.innerText.trim().length,
      }));
      debugLog(`Retry body stats — children: ${retryInfo.children}, text: ${retryInfo.textLen} chars`);
      if (retryInfo.textLen < 10) {
        debugLog('Page still blank after retry. Taking screenshot.');
        try { await page.screenshot({ path: path.join(__dirname, '..', 'debug-blank-page.png'), fullPage: true }); } catch {}
        log('Warning: page appears blank — check debug-blank-page.png');
      }
    }
  } catch (e) {
    debugLog(`Body wait failed: ${e.message}`);
  }

  // Dismiss any Google Translate bar that may have appeared.
  try {
    await page.evaluate(() => {
      const bar = document.querySelector('.goog-te-banner-frame, #goog-gt-tt, .skiptranslate');
      if (bar) bar.remove();
      document.body.style.top = '0px';
      document.documentElement.style.top = '0px';
    });
  } catch {}

  await randWait(800, 1500);

  // --- Cookie consent ---
  const acceptBtn = await page.evaluateHandle(() => {
    for (const b of document.querySelectorAll('button')) {
      if (/accetta e chiudi/i.test(b.textContent.trim())) return b;
    }
    return null;
  });
  if (acceptBtn && await acceptBtn.evaluate((el) => !!el)) {
    log('Accepting cookie consent…');
    await moveCursorTo(page, acceptBtn);
    await randWait(200, 500);
    await acceptBtn.click();
    await randWait(800, 1500);
  }

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
      await humanType(page, inp, data.password, { minDelay: 75, maxDelay: 220 });
    } else if (['text', 'email', ''].includes(type) && !filledUser) {
      await moveCursorTo(page, inp);
      await randWait(150, 400);
      await humanType(page, inp, data.username, { minDelay: 75, maxDelay: 220 });
      filledUser = true;
      // Human hesitation after the username before moving to the password field.
      await randWait(600, 1500);
    }
  }

  await randWait(300, 600);

  // --- reCAPTCHA handling (only prompt the human if genuinely required) ---
  const hasTokenFn = () => {
    const t = document.querySelector('[name="g-recaptcha-response"], textarea#g-recaptcha-response');
    return !!(t && t.value && t.value.length > 0);
  };
  const captchaState = await page.evaluate(() => {
    const widget = document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]');
    const t = document.querySelector('[name="g-recaptcha-response"], textarea#g-recaptcha-response');
    return { present: !!widget, hasToken: !!(t && t.value && t.value.length > 0) };
  });

  if (captchaState.present && !captchaState.hasToken) {
    debugLog('reCAPTCHA present and unsolved — attempting to tick the checkbox automatically…');

    // Try to click the "Non sono un robot" checkbox inside the anchor iframe.
    let autoSolved = false;
    try {
      const anchorFrame = page.frames().find((f) => /recaptcha/i.test(f.url()) && /\/anchor/i.test(f.url()));
      if (anchorFrame) {
        const checkbox = await anchorFrame.$('#recaptcha-anchor, .recaptcha-checkbox');
        if (checkbox) {
          try { await moveCursorTo(page, checkbox); } catch {}
          await randWait(200, 500);
          await checkbox.click();
          debugLog('Clicked reCAPTCHA checkbox');
        } else {
          debugLog('Anchor frame found but checkbox element not located');
        }
      } else {
        debugLog('reCAPTCHA anchor frame not found');
      }

      // Give it a few seconds to pass silently (token appears when solved).
      await page.waitForFunction(hasTokenFn, { timeout: 8000, polling: 300 });
      autoSolved = true;
      debugLog('reCAPTCHA passed automatically');
      log('reCAPTCHA passed automatically — continuing…');
    } catch {
      debugLog('reCAPTCHA did not auto-pass (likely a challenge appeared)');
    }

    // Only ask the human if the automatic attempt failed.
    if (!autoSolved) {
      log('⚠️ reCAPTCHA needs a manual solve — please complete it, then the bot will continue.');
      debugLog('Waiting up to 120s for manual solve');
      try {
        await page.waitForFunction(hasTokenFn, { timeout: 120000, polling: 500 });
        debugLog('reCAPTCHA solved manually');
        log('CAPTCHA solved — continuing…');
      } catch {
        debugLog('reCAPTCHA wait timed out after 120s');
        log('CAPTCHA not solved after 2 minutes — trying to continue anyway…');
      }
    }
    await randWait(500, 1000);
  } else if (captchaState.hasToken) {
    debugLog('reCAPTCHA already solved (token present) — skipping');
  } else {
    debugLog('No reCAPTCHA on this page — skipping');
  }

  log('Clicking Avanti…');
  debugLog('=== PAGE 1 → PAGE 2 TRANSITION ===');

  // Find the primary action button by its exact "Avanti" text.
  const avantiBtn1 = await page.evaluateHandle(() => {
    const candidates = document.querySelectorAll('button, input[type=submit], a[role=button], [type=button]');
    // Prefer an exact, visible text match first.
    for (const b of candidates) {
      const label = (b.textContent || b.value || '').trim();
      if (label.toLowerCase() === 'avanti' && b.offsetParent !== null) return b;
    }
    // Fallback: contains "Avanti".
    for (const b of candidates) {
      if (/avanti/i.test(b.textContent || b.value) && b.offsetParent !== null) return b;
    }
    return null;
  });
  const avantiEl1 = avantiBtn1.asElement();
  if (avantiEl1) {
    // Move the physical cursor smoothly to the button center.
    await moveCursorTo(page, avantiEl1);
    // Human-like hesitation hover once the cursor reaches the button.
    await randWait(250, 500);
    // Explicit mouse down / up at the button's center.
    const box = await avantiEl1.boundingBox();
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await randWait(40, 90);
      await page.mouse.up();
    } else {
      await avantiEl1.click();
    }
  } else {
    await clickButton(page, 'avanti');
  }

  // --- Wait for page 2 to render (strict: wait for a real page-2 element) ---
  log('Waiting for page 2 to load…');
  debugLog('Waiting for page 2 structural element (Nome input / Informazioni personali)…');
  try {
    await page.waitForFunction(() => {
      const text = document.body.innerText.toLowerCase();
      if (text.includes('informazioni personali')) return true;
      // Look for a visible "Nome" field by placeholder, label, aria-label, or name.
      const re = /\bnome\b/i;
      for (const inp of document.querySelectorAll('input')) {
        if (inp.offsetParent === null) continue;
        if (re.test(inp.placeholder || '') || re.test(inp.getAttribute('aria-label') || '') || re.test(inp.name || '')) return true;
      }
      for (const lbl of document.querySelectorAll('label')) {
        if (re.test(lbl.textContent || '')) {
          const inp = lbl.querySelector('input') || (lbl.htmlFor && document.getElementById(lbl.htmlFor));
          if (inp && inp.offsetParent !== null) return true;
        }
      }
      return false;
    }, { timeout: 15000, polling: 300 });
    debugLog('Page 2 structural element detected');
  } catch {
    debugLog('Page 2 element not found after 15s — waiting extra 5s');
    await wait(5000);
  }
  await randWait(500, 1000);

  debugLog(`URL: ${page.url()}`);
  log(`Page URL: ${page.url()}`);

  // Save a debug screenshot.
  try {
    const shotPath = path.join(__dirname, '..', 'debug-page2.png');
    await page.screenshot({ path: shotPath, fullPage: true });
    debugLog(`Screenshot saved to ${shotPath}`);
  } catch (e) { debugLog(`Screenshot error: ${e.message}`); }

  // Search ALL frames (main + iframes) for the form inputs.
  let workFrame = null;
  const allFrames = page.frames();
  debugLog(`Total frames: ${allFrames.length}`);

  for (const frame of allFrames) {
    try {
      const inputs = await frame.evaluate(() =>
        [...document.querySelectorAll('input')]
          .filter(el => el.offsetParent !== null && el.type !== 'hidden')
          .map(el => ({
            ph: el.placeholder || '',
            name: el.name || '',
            type: el.type || '',
            id: el.id || '',
            ariaLabel: el.getAttribute('aria-label') || '',
          }))
      );
      const frameLabel = frame === page.mainFrame() ? 'MAIN' : frame.url().slice(0, 100);
      debugLog(`Frame [${frameLabel}]: ${inputs.length} visible inputs`);
      for (const inp of inputs) {
        debugLog(`  placeholder="${inp.ph}" name="${inp.name}" type="${inp.type}" id="${inp.id}" aria="${inp.ariaLabel}"`);
      }
      // Pick the frame that has form-like text inputs (at least 2 non-password text inputs).
      const textInputs = inputs.filter(i => i.type !== 'password' && i.type !== 'checkbox' && i.type !== 'radio' && i.type !== 'submit');
      if (textInputs.length >= 2 && !workFrame) {
        workFrame = frame;
        debugLog(`>>> Will use this frame for filling`);
      }
    } catch (e) {
      debugLog(`Frame enumeration error: ${e.message}`);
    }
  }

  if (!workFrame) {
    // If still no frame found, wait longer (maybe CAPTCHA was being solved).
    log('No form inputs found yet, waiting 10 more seconds…');
    debugLog('No inputs found, extra 10s wait…');
    await wait(10000);
    for (const frame of page.frames()) {
      try {
        const count = await frame.evaluate(() =>
          [...document.querySelectorAll('input')].filter(el => el.offsetParent !== null && el.type !== 'hidden' && el.type !== 'password').length
        );
        if (count >= 2) { workFrame = frame; debugLog(`Found ${count} inputs on retry`); break; }
      } catch {}
    }
  }

  if (!workFrame) {
    const err = 'Could not find form inputs on any frame — see registration-debug.log and debug-page2.png';
    log(`Error: ${err}`);
    throw new Error(err);
  }

  // --- Step 2: Personal info ---
  debugLog(`Data: name="${data.name}" surname="${data.surname}" birth="${data.birthDate}" sex="${data.sex}" city="${data.city}"`);
  log(`Filling: name="${data.name}" surname="${data.surname}" birth="${data.birthDate}"`);

  // Find a visible input by matching placeholder, label text, aria-label, or name attribute.
  async function findInput(pattern) {
    const handle = await workFrame.evaluateHandle((pat) => {
      const re = new RegExp(pat, 'i');
      for (const inp of document.querySelectorAll('input')) {
        if (inp.offsetParent !== null && re.test((inp.placeholder || '').trim())) return inp;
      }
      for (const lbl of document.querySelectorAll('label')) {
        if (re.test(lbl.textContent.trim())) {
          const inp = lbl.querySelector('input, select, textarea') || (lbl.htmlFor && document.getElementById(lbl.htmlFor));
          if (inp && inp.offsetParent !== null) return inp;
        }
      }
      for (const inp of document.querySelectorAll('input')) {
        if (inp.offsetParent !== null && re.test(inp.getAttribute('aria-label') || '')) return inp;
        if (inp.offsetParent !== null && re.test(inp.name || '')) return inp;
      }
      return null;
    }, pattern);
    return handle.asElement();
  }

  async function fillByPattern(pattern, value, label) {
    if (!value) { log(`Skipping ${label}: no value`); debugLog(`Skip ${label}: empty`); return; }
    try {
      const el = await findInput(pattern);
      if (!el) {
        log(`${label}: input not found (/${pattern}/)`);
        debugLog(`${label}: NOT FOUND for /${pattern}/`);
        return;
      }
      log(`Filling ${label}…`);
      debugLog(`Filling ${label} with "${value}"…`);
      await moveCursorTo(page, el);
      await randWait(100, 300);
      await humanType(page, el, value);
      debugLog(`${label}: OK`);
      log(`${label} done`);
    } catch (err) {
      log(`${label} FAILED: ${err.message}`);
      debugLog(`${label} ERROR: ${err.stack}`);
    }
  }

  await fillByPattern('^nome', data.name, 'Nome');
  await randWait(200, 500);
  await fillByPattern('cognome', data.surname, 'Cognome');
  await randWait(200, 500);
  await fillByPattern('nascita', data.birthDate, 'Data di nascita');
  await randWait(300, 600);

  // Gender radio — pick from card data, or random if not available.
  {
    const sex = data.sex || (Math.random() < 0.5 ? 'M' : 'F');
    const genderText = sex === 'M' ? 'Uomo' : 'Donna';
    log(`Selecting gender: ${genderText}…`);
    debugLog(`Gender: ${genderText} (source: ${data.sex ? 'card' : 'random'})`);

    // Find the visible label / span that says "Donna" or "Uomo".
    const genderEl = await workFrame.evaluateHandle((target) => {
      const t = target.toLowerCase();
      // Strategy 1: exact-text match on small leaf elements.
      for (const el of document.querySelectorAll('label, span, div, p')) {
        const txt = el.textContent.trim().toLowerCase();
        if (txt === t && el.offsetParent !== null && txt.length < 15) return el;
      }
      // Strategy 2: a label / span containing the word inside a radio group.
      for (const el of document.querySelectorAll('label, span')) {
        if (el.textContent.trim().toLowerCase().includes(t) && el.offsetParent !== null && el.textContent.trim().length < 20) return el;
      }
      // Strategy 3: closest clickable parent of a radio input.
      for (const r of document.querySelectorAll('input[type=radio]')) {
        const parent = r.closest('label') || r.parentElement;
        if (parent && parent.textContent.trim().toLowerCase().includes(t)) return parent;
      }
      return null;
    }, genderText);

    const gEl = genderEl.asElement();
    if (gEl) {
      await moveCursorTo(page, gEl);
      await randWait(200, 400);
      await gEl.click();
      debugLog(`Clicked visible element for ${genderText}`);
    } else {
      debugLog(`No visible element found for ${genderText}`);
    }

    // Also programmatically check the underlying radio and fire events (covers hidden-input frameworks).
    await workFrame.evaluate((target) => {
      const t = target.toLowerCase();
      for (const r of document.querySelectorAll('input[type=radio]')) {
        const wrapper = r.closest('label, div, span, li, fieldset');
        if (wrapper && wrapper.textContent.trim().toLowerCase().includes(t) && !r.checked) {
          r.checked = true;
          r.click();
          r.dispatchEvent(new Event('change', { bubbles: true }));
          r.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
      }
      // Last resort: match by value.
      const val = t === 'uomo' ? 'M' : 'F';
      for (const r of document.querySelectorAll('input[type=radio]')) {
        if ((r.value || '').toUpperCase() === val && !r.checked) {
          r.checked = true;
          r.click();
          r.dispatchEvent(new Event('change', { bubbles: true }));
          r.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
      }
    }, genderText);

    await randWait(400, 800);

    // Verify the error is gone.
    const stillError = await workFrame.evaluate(() => {
      for (const el of document.querySelectorAll('span, div, p')) {
        if (/campo obbligatorio/i.test(el.textContent.trim()) && el.offsetParent !== null) return true;
      }
      return false;
    });
    if (stillError) {
      debugLog('WARNING: "Campo obbligatorio" still present after gender click');
      log('Gender error persists — retrying with direct radio click');
      await workFrame.evaluate((target) => {
        const t = target.toLowerCase();
        const radios = document.querySelectorAll('input[type=radio]');
        for (const r of radios) {
          const parent = r.closest('label, div, span, li, fieldset, form');
          if (parent && parent.textContent.trim().toLowerCase().includes(t)) {
            r.focus();
            r.checked = true;
            r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            r.dispatchEvent(new Event('change', { bubbles: true }));
            r.dispatchEvent(new Event('input', { bubbles: true }));
            break;
          }
        }
      }, genderText);
      await randWait(300, 500);
    }
    debugLog('Gender selection complete');
  }

  // City with autocomplete.
  if (data.city) {
    await fillByPattern('residenza|citt', data.city, 'Città');
    await pickAutocomplete(workFrame === page ? page : workFrame, data.city);
    await randWait(300, 600);
  }

  // =====================================================================
  // PAGE 3 — Sicurezza e Privacy
  // =====================================================================
  await randWait(500, 1200);
  log('Clicking Avanti on page 2…');
  debugLog('=== PAGE 2 → PAGE 3 (Sicurezza e Privacy) ===');
  await clickButton(page, 'avanti');

  log('Waiting for page 3…');
  debugLog('Waiting for SPA step change (looking for Sicurezza/Consensi)…');
  try {
    await page.waitForFunction(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('sicurezza') || text.includes('consensi') || text.includes('presto il consenso') || text.includes('protezione account');
    }, { timeout: 15000 });
    debugLog('Page 3 content detected via text match');
  } catch {
    debugLog('Page 3 text not found after 15s — extra wait');
    await wait(5000);
  }
  await randWait(500, 1000);
  debugLog(`URL: ${page.url()}`);

  // --- Protezione Account: "Mail o Cellulare" field ---
  let smsResult = null;
  const useSms = !!data.fiveSimToken;

  if (useSms) {
    try {
      log('Getting 5sim virtual number…');
      smsResult = await sms.get5SimCode('libero', 'italy', data.fiveSimToken);
      const phone = smsResult.phone.replace(/^\+?39/, '');
      log(`📱 Got number: ${smsResult.phone} → typing ${phone}`);

      const phoneEl = await inputByLabel(page, 'mail.*cellulare|cellulare|protezione');
      if (phoneEl) {
        await moveCursorTo(page, phoneEl);
        await randWait(100, 300);
        await humanType(page, phoneEl, phone);
        debugLog(`Typed phone ${phone} into Mail o Cellulare`);
      } else {
        debugLog('"Mail o Cellulare" label not found, trying placeholder selector');
        await page.waitForSelector('input[placeholder*="Mail o Cellulare"], input[placeholder*="mail"], input[placeholder*="cellulare"]', { visible: true, timeout: 10000 });
        const inp = await page.$('input[placeholder*="Mail o Cellulare"], input[placeholder*="mail"], input[placeholder*="cellulare"]');
        if (inp) {
          await moveCursorTo(page, inp);
          await randWait(100, 300);
          await humanType(page, inp, phone);
          debugLog(`Typed phone ${phone} via placeholder selector`);
        } else {
          throw new Error('Could not find "Mail o Cellulare" input');
        }
      }
    } catch (err) {
      log(`5sim error: ${err.message} — using recovery email instead`);
      debugLog(`5sim buy failed: ${err.stack}`);
      if (smsResult) { await smsResult.cancel(); smsResult = null; }
      // Fall through to recovery-email path below.
    }
  }

  // If no 5sim, or 5sim failed, fill with recovery email.
  if (!smsResult) {
    const fallbackValue = data.recoveryEmail || '';
    if (fallbackValue) {
      log(`Filling recovery email: ${fallbackValue}`);
      const el = await inputByLabel(page, 'mail.*cellulare|cellulare|protezione');
      if (el) {
        await moveCursorTo(page, el);
        await randWait(100, 300);
        await humanType(page, el, fallbackValue);
      } else {
        const inp = await page.$('input[placeholder*="Mail o Cellulare"], input[placeholder*="mail"], input[placeholder*="cellulare"]');
        if (inp) {
          await moveCursorTo(page, inp);
          await randWait(100, 300);
          await humanType(page, inp, fallbackValue);
        }
      }
    } else {
      log('No recovery email configured — field left empty');
    }
  }
  await randWait(400, 800);

  // --- Consensi: click every "Presto il consenso" radio with cursor movement ---
  log('Selecting consent options…');
  const consentLabels = await page.$$eval(
    'label, span, div',
    (els) => els
      .filter((el) => el.textContent.trim().toLowerCase() === 'presto il consenso' && el.offsetParent !== null)
      .map((_, i) => i)
  );
  debugLog(`Found ${consentLabels.length} "Presto il consenso" elements`);

  for (let ci = 0; ci < consentLabels.length; ci++) {
    const handle = await page.evaluateHandle((idx) => {
      let count = 0;
      for (const el of document.querySelectorAll('label, span, div')) {
        if (el.textContent.trim().toLowerCase() === 'presto il consenso' && el.offsetParent !== null) {
          if (count === idx) return el;
          count++;
        }
      }
      return null;
    }, ci);
    const el = handle.asElement();
    if (!el) continue;

    // Scroll element into view, move cursor, click.
    await page.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }), el);
    await randWait(300, 600);
    await moveCursorTo(page, el);
    await randWait(200, 400);
    await el.click();

    // Also fire change on the underlying radio.
    await page.evaluate((idx) => {
      let count = 0;
      for (const el of document.querySelectorAll('label, span, div')) {
        if (el.textContent.trim().toLowerCase() === 'presto il consenso' && el.offsetParent !== null) {
          if (count === idx) {
            const radio = el.querySelector('input[type=radio]');
            if (radio && !radio.checked) {
              radio.checked = true;
              radio.click();
              radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return;
          }
          count++;
        }
      }
    }, ci);
    await randWait(300, 600);
  }
  debugLog('Consent radios handled');

  // --- Scroll to bottom and click Registrati ---
  log('Scrolling to bottom…');
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
  await wait(1500);

  // Let any validation animations settle.
  await randWait(500, 1000);

  log('Clicking Registrati…');
  const regBtn = await page.evaluateHandle(() => {
    for (const b of document.querySelectorAll('button, input[type=submit], a[role=button], [type=button]')) {
      if (/registrati/i.test(b.textContent || b.value)) return b;
    }
    return null;
  });
  const regEl = regBtn.asElement();
  if (regEl) {
    await page.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }), regEl);
    await randWait(300, 600);
    await moveCursorTo(page, regEl);
    await randWait(400, 800);
    await regEl.click();
    debugLog('Clicked Registrati');
  } else {
    debugLog('Registrati button not found, trying Avanti / Submit fallback');
    await clickButton(page, 'avanti|registrati|submit|invia');
  }
  log('Registration submitted.');

  // =====================================================================
  // VERIFICATION PAGE — "VERIFICA DEL TUO ACCOUNT" (SMS code entry)
  // =====================================================================
  if (smsResult) {
    debugLog('=== VERIFICATION PAGE (SMS code) ===');
    log('Waiting for verification page…');
    try {
      await page.waitForFunction(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('verifica') || text.includes('codice') || text.includes('sms') || text.includes('cellulare');
      }, { timeout: 15000 });
      debugLog('Verification page content detected');
    } catch {
      debugLog('Verification page text not found after 15s — extra wait');
      await wait(5000);
    }
    await randWait(500, 1000);
    debugLog(`URL: ${page.url()}`);

    try {
      log('Waiting for SMS code…');
      const code = await smsResult.waitForCode();
      log(`🎉 Got code: ${code}`);

      // Find the code / OTP input on the new page.
      await wait(2000);
      const codeHandle = await page.evaluateHandle(() => {
        for (const inp of document.querySelectorAll('input')) {
          const ph = (inp.placeholder || '').toLowerCase();
          const lbl = inp.closest('label');
          const lt = lbl ? lbl.textContent.toLowerCase() : '';
          const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
          if (/codice|verif|code|otp|sms/i.test(ph + ' ' + lt + ' ' + aria) && inp.offsetParent !== null) return inp;
        }
        for (const inp of document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"], input:not([type])')) {
          if (inp.offsetParent !== null && !inp.value && inp.type !== 'hidden') return inp;
        }
        return null;
      });

      const codeEl = codeHandle.asElement();
      if (codeEl) {
        log('Entering verification code…');
        await moveCursorTo(page, codeEl);
        await randWait(100, 300);
        await humanType(page, codeEl, code);
        await randWait(500, 1000);

        // Scroll & click the confirm button.
        await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
        await wait(800);
        await clickButton(page, 'conferma|verifica|avanti|registrati|invia');
        log('Verification code submitted');
      } else {
        log('Could not find code input field');
        debugLog('Code input NOT FOUND on verification page');
      }

      await smsResult.finish();
      log('✅ SMS verification complete');
    } catch (err) {
      log(`SMS verification failed: ${err.message}`);
      debugLog(`SMS verify error: ${err.stack}`);
      await smsResult.cancel();
    }
  }

  log('Registration complete.');

  } catch (err) {
    debugLog(`❌ CRITICAL SCRIPT FAILURE at: ${err.stack}`);
    log(`Error: ${err.message}`);
    console.error('❌ CRITICAL SCRIPT FAILURE:', err);

    // Take a screenshot of the crash state for diagnosis.
    try {
      const pages = await browser.pages();
      if (pages.length > 0) {
        const shotPath = path.join(__dirname, '..', 'debug-crash.png');
        await pages[0].screenshot({ path: shotPath, fullPage: true });
        debugLog(`Crash screenshot saved to ${shotPath}`);
      }
    } catch {}

    // Keep the browser window open so we can visually inspect the state.
    debugLog('Browser left open for inspection — close it manually when done.');
    log('Browser left open for inspection.');
    cleanupCursor();
    return;
  }

  cleanupCursor();
}

module.exports = { register, findChrome };
