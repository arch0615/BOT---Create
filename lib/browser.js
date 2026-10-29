require('dotenv').config();
const { addExtra } = require('puppeteer-extra');
const puppeteerCore = require('puppeteer-core');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sms = require('./sms');

let _capsolverKey = process.env.CAPSOLVER_API_KEY || '';

async function solvePageCaptcha(page, targetUrl, runtimeKey) {
  const apiKey = runtimeKey || _capsolverKey;
  if (!apiKey) return false;

  const sitekey = await page.evaluate(() => {
    const el = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey]');
    if (el) return el.getAttribute('data-sitekey');
    const iframe = document.querySelector('iframe[src*="recaptcha"]');
    if (iframe) {
      const m = iframe.src.match(/[?&]k=([A-Za-z0-9_-]+)/);
      if (m) return m[1];
    }
    return null;
  });

  if (!sitekey) {
    debugLog('[CapSolver] No reCAPTCHA sitekey found on page');
    return false;
  }

  console.log('🧩 [CapSolver] reCAPTCHA detected. Extracting sitekey...');
  debugLog(`[CapSolver] sitekey=${sitekey} url=${targetUrl}`);

  let taskId;
  try {
    const createRes = await fetch('https://api.capsolver.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: 'ReCaptchaV2TaskProxyLess',
          websiteURL: targetUrl,
          websiteKey: sitekey,
        },
      }),
    });
    const createData = await createRes.json();
    if (createData.errorId && createData.errorId !== 0) {
      debugLog(`[CapSolver] createTask error: ${createData.errorDescription || JSON.stringify(createData)}`);
      return false;
    }
    taskId = createData.taskId;
    debugLog(`[CapSolver] taskId=${taskId}`);
  } catch (err) {
    debugLog(`[CapSolver] createTask request failed: ${err.message}`);
    return false;
  }

  const maxWait = 60000;
  const pollInterval = 4000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, pollInterval));
    console.log('⏳ [CapSolver] Waiting for solve token...');
    try {
      const pollRes = await fetch('https://api.capsolver.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      const pollData = await pollRes.json();
      if (pollData.status === 'ready') {
        const token = pollData.solution && pollData.solution.gRecaptchaResponse;
        if (!token) {
          debugLog('[CapSolver] status ready but no gRecaptchaResponse in solution');
          return false;
        }
        console.log('🎉 [CapSolver] Puzzle solved successfully!');
        debugLog('[CapSolver] Injecting token into page');

        await page.evaluate((tkn) => {
          const ta = document.querySelector('textarea#g-recaptcha-response, [name="g-recaptcha-response"]');
          if (ta) {
            ta.value = tkn;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, token);

        return true;
      }
      if (pollData.errorId && pollData.errorId !== 0) {
        debugLog(`[CapSolver] solve error: ${pollData.errorDescription || JSON.stringify(pollData)}`);
        return false;
      }
    } catch (err) {
      debugLog(`[CapSolver] poll error: ${err.message}`);
    }
  }

  debugLog('[CapSolver] Timed out waiting for solve token');
  return false;
}

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

  // Use a temporary user data dir to avoid profile lock conflicts
  const os = require('os');
  const userDataDir = path.join(os.tmpdir(), `cie-chrome-${Date.now()}`);
  debugLog(`Chrome user data dir: ${userDataDir}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,
      defaultViewport: null,
      userDataDir,
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
        '--disable-blink-features=AutomationControlled',
        '--lang=it-IT',
        '--no-sandbox',
        ...(data.proxyUrl ? [`--proxy-server=${data.proxyUrl}`] : []),
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
  // Pre-emptive CapSolver attempt before filling fields
  const pageUrl = page.url();
  const capKey = data.capsolverKey || _capsolverKey;
  const earlyCapSolve = await solvePageCaptcha(page, pageUrl, capKey);
  if (earlyCapSolve) {
    debugLog('CapSolver solved reCAPTCHA early (pre-fill)');
  }

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

    // If checkbox click didn't auto-solve, try CapSolver before asking human
    if (!autoSolved) {
      debugLog('Checkbox did not auto-pass — attempting CapSolver…');
      const capSolved = await solvePageCaptcha(page, page.url(), capKey);
      if (capSolved) {
        autoSolved = true;
        debugLog('CapSolver resolved the reCAPTCHA challenge');
        log('🧩 CapSolver solved the CAPTCHA — continuing…');
      }
    }

    // Only ask the human if both automatic attempts failed.
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

  // Safety-net CapSolver attempt before Avanti (in case early solve expired or checkbox failed)
  const preAvantiToken = await page.evaluate(() => {
    const t = document.querySelector('[name="g-recaptcha-response"], textarea#g-recaptcha-response');
    return !!(t && t.value && t.value.length > 0);
  });
  if (!preAvantiToken) {
    debugLog('No reCAPTCHA token before Avanti — trying CapSolver as safety net');
    const safetySolve = await solvePageCaptcha(page, page.url(), capKey);
    if (safetySolve) {
      debugLog('CapSolver safety-net solved reCAPTCHA before Avanti');
      log('🧩 CapSolver solved CAPTCHA before submit');
    }
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

  // --- Protezione Account: "Mail o Cellulare" field (recovery email only) ---
  // The phone number is now entered in the verification modal that appears after clicking Registrati.
  let smsResult = null;
  const useSms = !!data.fiveSimToken;

  const recoveryField = await inputByLabel(page, 'mail.*cellulare|cellulare|protezione');
  const fallbackValue = data.recoveryEmail || '';
  if (fallbackValue) {
    log(`Filling recovery email: ${fallbackValue}`);
    if (recoveryField) {
      await moveCursorTo(page, recoveryField);
      await randWait(100, 300);
      await humanType(page, recoveryField, fallbackValue);
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
  log('Registrati clicked — waiting for SMS verification modal…');

  // =====================================================================
  // VERIFICATION MODAL — "VERIFICA DEL TUO ACCOUNT"
  // After clicking Registrati, a modal/overlay appears asking for a phone
  // number. We detect it by waiting for a NEW visible input whose
  // placeholder contains "Cellulare" (the modal's phone field) that was
  // not on the page before.
  // =====================================================================
  debugLog('=== VERIFICATION MODAL (phone + SMS code) ===');

  // Wait for the verification modal to appear.
  // The modal may be in the main page, an iframe, or an overlay. We check everything.
  let verificationDetected = false;

  // Give the modal a moment to start rendering after the Registrati click.
  await wait(3000);

  // First, dump page state for debugging.
  const debugDump = await page.evaluate(() => {
    const allText = document.body.innerText.substring(0, 500);
    const iframes = document.querySelectorAll('iframe');
    const dialogs = document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"]');
    const overlays = document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="dialog"], [class*="popup"]');
    const inputs = [];
    for (const inp of document.querySelectorAll('input')) {
      if (inp.type === 'hidden') continue;
      inputs.push({ placeholder: inp.placeholder, type: inp.type, visible: inp.offsetParent !== null, name: inp.name });
    }
    return { textSnippet: allText, iframeCount: iframes.length, dialogCount: dialogs.length, overlayCount: overlays.length, inputs };
  });
  debugLog(`Page state after Registrati: iframes=${debugDump.iframeCount} dialogs=${debugDump.dialogCount} overlays=${debugDump.overlayCount} inputs=${JSON.stringify(debugDump.inputs)}`);
  debugLog(`Page text: ${debugDump.textSnippet.substring(0, 300)}`);

  // Strategy 1: Check main page DOM (text, placeholder, dialog/modal elements)
  const mainPageHasModal = await page.evaluate(() => {
    const text = document.body.innerText || document.body.textContent || '';
    if (/verifica del tuo account/i.test(text)) return 'text-match';
    if (/ci sei quasi/i.test(text)) return 'ci-sei-quasi';
    for (const inp of document.querySelectorAll('input')) {
      if (inp.offsetParent === null || inp.type === 'hidden') continue;
      const ph = (inp.placeholder || '').trim().toLowerCase();
      if (ph === 'cellulare' || ph.includes('cellulare')) return 'cellulare-input';
    }
    // Check for dialog/modal overlay elements
    const modal = document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"], [class*="modal"]:not([style*="display: none"]):not([style*="display:none"])');
    if (modal) return 'modal-element';
    return null;
  });

  if (mainPageHasModal) {
    verificationDetected = true;
    debugLog(`Verification modal found via: ${mainPageHasModal}`);
    log('📱 SMS verification modal detected');
  }

  // Strategy 2: Check all iframes
  if (!verificationDetected) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const found = await frame.evaluate(() => {
          const text = (document.body.innerText || document.body.textContent || '').toLowerCase();
          if (text.includes('verifica') || text.includes('cellulare') || text.includes('ci sei quasi')) return true;
          for (const inp of document.querySelectorAll('input')) {
            if (inp.offsetParent !== null && /cellulare/i.test(inp.placeholder || '')) return true;
          }
          return false;
        });
        if (found) {
          verificationDetected = true;
          debugLog(`Verification modal found in iframe: ${frame.url()}`);
          log('📱 SMS verification modal detected (in iframe)');
          break;
        }
      } catch {}
    }
  }

  // Strategy 3: Poll for up to 20 more seconds in case the modal is slow to render
  if (!verificationDetected) {
    debugLog('Modal not found yet — polling for 20s…');
    log('⏳ Waiting for verification modal…');
    try {
      await page.waitForFunction(() => {
        const text = (document.body.innerText || document.body.textContent || '').toLowerCase();
        if (text.includes('verifica del tuo account') || text.includes('ci sei quasi')) return true;
        for (const inp of document.querySelectorAll('input')) {
          if (inp.offsetParent === null || inp.type === 'hidden') continue;
          if (/cellulare/i.test(inp.placeholder || '')) return true;
        }
        return false;
      }, { timeout: 20000, polling: 500 });
      verificationDetected = true;
      log('📱 SMS verification modal detected');
      debugLog('Verification modal found via polling');
    } catch {
      debugLog('Verification modal not found after polling');
      const pageText = await page.evaluate(() => (document.body.innerText || '').toLowerCase());
      if (pageText.includes('registrazione completata') || pageText.includes('complimenti') || pageText.includes('la tua casella')) {
        log('✅ Registration completed without SMS verification');
        debugLog('Registration succeeded without SMS modal');
      } else {
        log('⚠️ Verification modal not detected — page may need manual intervention');
        debugLog(`Page text: ${pageText.substring(0, 300)}`);
      }
    }
  }

  if (verificationDetected) {
    await randWait(500, 1000);

    // Resolve the 5sim token: settings > env > none
    const smsToken = data.fiveSimToken || process.env.FIVE_SIM_TOKEN || '';
    let smsCompleted = false;

    if (smsToken) {
      // Pre-check 5sim balance
      try {
        log('📱 Checking 5sim balance…');
        const balance = await sms.getBalance(smsToken);
        const balanceNum = parseFloat(balance);
        debugLog(`5sim balance: ${balanceNum} RUB`);
        if (balanceNum < 1) {
          log(`❌ 5sim balance too low (${balanceNum} RUB) — please top up at 5sim.net`);
        } else {
          log(`📱 5sim balance: ${balanceNum} RUB`);

          // --- Helper: detect which screen the verification modal is showing ---
          async function detectVerificationScreen() {
            return page.evaluate(() => {
              const text = document.body.innerText.toLowerCase();
              const hasPhoneInput = !!document.querySelector('input[name="cellulare_challenge"]') &&
                document.querySelector('input[name="cellulare_challenge"]').offsetParent !== null;
              const hasCodeText = text.includes('codice') || text.includes('inserisci il codice');
              const hasVerifyModal = text.includes('verifica del tuo account') || text.includes('ci sei quasi');
              const completed = text.includes('registrazione completata') || text.includes('complimenti') || text.includes('la tua casella');
              if (completed) return 'completed';
              if (hasPhoneInput && hasVerifyModal) return 'phone-input';
              if (hasCodeText) return 'code-input';
              if (hasVerifyModal) return 'phone-input';
              return 'unknown';
            });
          }

          // --- Helper: navigate back from code-input screen to phone-input screen ---
          async function navigateBackToPhoneInput() {
            debugLog('Attempting to navigate back to phone input screen…');

            // Dump page state for debugging
            const pageState = await page.evaluate(() => {
              const links = [];
              for (const el of document.querySelectorAll('a, button, span, div')) {
                const txt = (el.textContent || '').trim();
                if (txt.length > 0 && txt.length < 50 && el.offsetParent !== null) {
                  links.push({ tag: el.tagName, text: txt.substring(0, 40) });
                }
              }
              return { links: links.slice(0, 30), text: document.body.innerText.substring(0, 500) };
            });
            debugLog(`Page links: ${JSON.stringify(pageState.links)}`);
            debugLog(`Page text: ${pageState.text.substring(0, 200)}`);

            // Strategy 1: Look for a back/change/retry link or button
            const backBtn = await page.evaluateHandle(() => {
              const patterns = /indietro|riprova|modifica|back|cambia|torna|altro numero|reinvia|riinvia|← |‹/i;
              for (const el of document.querySelectorAll('a, button, span, div, p')) {
                const txt = (el.textContent || '').trim();
                if (patterns.test(txt) && el.offsetParent !== null && txt.length < 60) return el;
              }
              // Look for any clickable element with an arrow or back icon
              for (const el of document.querySelectorAll('a[href], button, [role="button"], [onclick]')) {
                const cls = (el.className || '').toLowerCase();
                if (/back|prev|return|close/i.test(cls) && el.offsetParent !== null) return el;
              }
              return null;
            });
            const backEl = backBtn.asElement();
            if (backEl) {
              const backText = await backEl.evaluate((el) => el.textContent.trim().substring(0, 30));
              log(`📱 Clicking "${backText}" to go back…`);
              await backEl.click();
              await randWait(1500, 2500);
              const screen = await detectVerificationScreen();
              if (screen === 'phone-input') {
                debugLog('Successfully navigated back to phone input');
                return true;
              }
              debugLog(`After clicking back, screen is: ${screen}`);
            }

            // Strategy 2: Try clicking a close/X button on the code dialog and re-triggering
            const closeBtn = await page.evaluateHandle(() => {
              for (const el of document.querySelectorAll('button, a, span, div')) {
                const txt = (el.textContent || '').trim();
                const cls = (el.className || '').toLowerCase();
                if ((/^[x×✕✖]$/i.test(txt) || /close|chiudi/i.test(cls + ' ' + txt)) && el.offsetParent !== null) return el;
              }
              return null;
            });
            const closeEl = closeBtn.asElement();
            if (closeEl) {
              log('📱 Closing verification dialog to restart…');
              await closeEl.click();
              await randWait(1500, 2500);

              // Re-click Registrati to re-open the modal
              log('📱 Re-clicking Registrati to reopen modal…');
              const regBtn2 = await page.evaluateHandle(() => {
                for (const b of document.querySelectorAll('button, input[type=submit], a[role=button], [type=button]')) {
                  if (/registrati/i.test(b.textContent || b.value) && b.offsetParent !== null) return b;
                }
                return null;
              });
              const regEl2 = regBtn2.asElement();
              if (regEl2) {
                await regEl2.click();
                await randWait(2000, 3000);
                const screen = await detectVerificationScreen();
                if (screen === 'phone-input') {
                  debugLog('Reopened modal successfully');
                  return true;
                }
                debugLog(`After reopening, screen is: ${screen}`);
              }
            }

            // Strategy 3: Reload the page and redo consent + Registrati
            log('📱 Navigating back to restart verification…');
            try {
              await page.goBack({ waitUntil: 'networkidle2' });
              await randWait(2000, 3000);
              // Click Registrati again
              const regBtn3 = await page.evaluateHandle(() => {
                for (const b of document.querySelectorAll('button, input[type=submit], a[role=button], [type=button]')) {
                  if (/registrati/i.test(b.textContent || b.value) && b.offsetParent !== null) return b;
                }
                return null;
              });
              const regEl3 = regBtn3.asElement();
              if (regEl3) {
                await regEl3.click();
                await randWait(2000, 3000);
              }
              const screen = await detectVerificationScreen();
              debugLog(`After page.goBack + Registrati, screen is: ${screen}`);
              return screen === 'phone-input';
            } catch (navErr) {
              debugLog(`goBack failed: ${navErr.message}`);
            }

            return false;
          }

          // --- Helper: type phone into the cellulare_challenge input ---
          async function typePhoneNumber(phone) {
            const phoneInput = await page.evaluateHandle(() => {
              const byName = document.querySelector('input[name="cellulare_challenge"]');
              if (byName && byName.offsetParent !== null) return byName;
              for (const inp of document.querySelectorAll('input')) {
                if (inp.offsetParent === null || inp.type === 'hidden') continue;
                const name = (inp.name || '').toLowerCase();
                const ph = (inp.placeholder || '').toLowerCase();
                const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
                if (/cellulare|telefono|phone/i.test(name + ' ' + ph + ' ' + aria)) return inp;
              }
              return null;
            });
            const phoneEl = phoneInput.asElement();
            if (!phoneEl) throw new Error('Could not find Cellulare input');

            await moveCursorTo(page, phoneEl);
            await randWait(100, 300);
            await phoneEl.click();
            await randWait(50, 150);
            // Clear field: Ctrl+A then Backspace
            await page.keyboard.down('Control');
            await page.keyboard.press('a');
            await page.keyboard.up('Control');
            await randWait(50, 100);
            await page.keyboard.press('Backspace');
            await randWait(50, 100);
            // Fallback: if value still present, force-clear via JS
            const leftover = await phoneEl.evaluate(el => el.value);
            if (leftover) {
              await phoneEl.evaluate(el => {
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              });
              await randWait(50, 100);
            }
            await humanType(page, phoneEl, phone);
            return true;
          }

          // --- Helper: click the AVANTI button in the modal ---
          async function clickModalAvanti() {
            const modalAvanti = await page.evaluateHandle(() => {
              for (const b of document.querySelectorAll('button, input[type=submit], a[role=button], [type=button]')) {
                if (/avanti/i.test(b.textContent || b.value) && b.offsetParent !== null) return b;
              }
              return null;
            });
            const modalAvantiEl = modalAvanti.asElement();
            if (modalAvantiEl) {
              await moveCursorTo(page, modalAvantiEl);
              await randWait(200, 400);
              await modalAvantiEl.click();
            } else {
              await clickButton(page, 'avanti');
            }
          }

          // Retry loop: up to 5 different numbers with different operators each time
          const MAX_SMS_ATTEMPTS = 5;
          const triedOperators = [];
          for (let attempt = 1; attempt <= MAX_SMS_ATTEMPTS && !smsCompleted; attempt++) {
            smsResult = null;
            try {
              // Before each attempt, make sure we're on the phone-input screen
              const currentScreen = await detectVerificationScreen();
              debugLog(`Attempt ${attempt}: current screen = ${currentScreen}`);

              if (currentScreen === 'completed') {
                log('✅ Registration already completed!');
                smsCompleted = true;
                break;
              }

              if (currentScreen === 'code-input' && attempt > 1) {
                log(`📱 On code entry screen — navigating back to phone input…`);
                const wentBack = await navigateBackToPhoneInput();
                if (!wentBack) {
                  log('❌ Could not navigate back to phone input screen');
                  break;
                }
                await randWait(500, 1000);
              }

              if (currentScreen !== 'phone-input' && attempt === 1 && currentScreen !== 'code-input') {
                debugLog(`Unexpected screen "${currentScreen}" — waiting for phone input…`);
                await wait(3000);
              }

              log(`📱 Attempt ${attempt}/${MAX_SMS_ATTEMPTS}: getting virtual number…`);
              smsResult = await sms.get5SimCode('libero', 'italy', smsToken, log, triedOperators);
              const phone = smsResult.phone.replace(/^\+?39/, '');
              log(`📱 Got number → typing ${phone}`);

              await typePhoneNumber(phone);
              debugLog(`Typed phone ${phone} (attempt ${attempt})`);
              log('📱 Phone number entered');

              await randWait(400, 800);

              // Click "AVANTI"
              log('📱 Clicking Avanti…');
              await clickModalAvanti();
              debugLog('Clicked Avanti in verification modal');

              // Wait for SMS code entry view
              log('⏳ Waiting for SMS code entry field…');
              await randWait(1000, 2000);
              try {
                await page.waitForFunction(() => {
                  const text = document.body.innerText.toLowerCase();
                  return text.includes('codice') || (text.includes('inserisci') && text.includes('sms'));
                }, { timeout: 15000 });
                debugLog('SMS code entry view detected');
                log('📱 SMS code entry field appeared');
              } catch {
                debugLog('SMS code view not detected — continuing anyway');
                await wait(3000);
              }

              // Wait for the code from 5sim
              log(`🔄 Waiting for SMS code (attempt ${attempt})…`);
              const code = await smsResult.waitForCode();
              log(`🎉 Got SMS code: ${code}`);

              // Find and type the code — specifically target the code input, NOT cellulare_challenge
              await wait(1500);
              const codeHandle = await page.evaluateHandle(() => {
                // Explicitly skip the phone input
                for (const inp of document.querySelectorAll('input')) {
                  if (inp.name === 'cellulare_challenge') continue;
                  if (inp.offsetParent === null || inp.type === 'hidden') continue;
                  const ph = (inp.placeholder || '').toLowerCase();
                  const lbl = inp.closest('label');
                  const lt = lbl ? lbl.textContent.toLowerCase() : '';
                  const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
                  const name = (inp.name || '').toLowerCase();
                  if (/codice|verif|code|otp|sms/i.test(ph + ' ' + lt + ' ' + aria + ' ' + name)) return inp;
                }
                // Fallback: visible empty text input that is NOT the phone field
                for (const inp of document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"], input:not([type])')) {
                  if (inp.name === 'cellulare_challenge') continue;
                  if (inp.name === 'emailsecondaria') continue;
                  if (inp.offsetParent !== null && !inp.value && inp.type !== 'hidden') return inp;
                }
                return null;
              });

              const codeEl = codeHandle.asElement();
              if (codeEl) {
                log('✍️ Entering verification code…');
                await moveCursorTo(page, codeEl);
                await randWait(100, 300);
                await humanType(page, codeEl, code);
                await randWait(500, 1000);

                await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
                await wait(800);
                log('📱 Confirming verification code…');
                await clickButton(page, 'conferma|verifica|avanti|registrati|invia');

                // Wait and verify the code was accepted
                await randWait(2000, 3000);
                const afterSubmit = await detectVerificationScreen();
                debugLog(`After code submit, screen is: ${afterSubmit}`);

                if (afterSubmit === 'completed') {
                  await smsResult.finish();
                  smsCompleted = true;
                  log('✅ SMS verification complete — registration successful!');
                } else if (afterSubmit === 'code-input') {
                  // Still on code page — code was likely wrong or expired
                  throw new Error('Verification code was not accepted — still on code entry screen');
                } else if (afterSubmit === 'phone-input') {
                  throw new Error('Returned to phone input — number may have been rejected');
                } else {
                  // Unknown state — check for success indicators
                  const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
                  if (pageText.includes('errore') || pageText.includes('non valido') || pageText.includes('errato')) {
                    throw new Error('Verification code rejected by the site');
                  }
                  // Assume success if no error
                  await smsResult.finish();
                  smsCompleted = true;
                  log('✅ Verification code submitted');
                }
              } else {
                throw new Error('Could not find code input field (not the phone field)');
              }

            } catch (err) {
              debugLog(`SMS attempt ${attempt} failed: ${err.stack}`);
              if (smsResult) {
                if (smsResult.operator) triedOperators.push(smsResult.operator);
                try { await smsResult.cancel(); } catch {}
                smsResult = null;
              }

              if (attempt < MAX_SMS_ATTEMPTS) {
                log(`⚠️ Attempt ${attempt} failed: ${err.message} — trying a new number…`);
                await randWait(1000, 2000);
              } else {
                log(`❌ All ${MAX_SMS_ATTEMPTS} SMS attempts failed: ${err.message}`);
              }
            }
          }
        }
      } catch (err) {
        log(`❌ 5sim error: ${err.message}`);
        debugLog(`5sim balance check error: ${err.stack}`);
      }
    }

    // If no token or 5sim failed, wait for manual completion
    if (!smsCompleted) {
      if (!smsToken) {
        log('⚠️ No 5sim token — please enter phone number manually in the browser.');
      } else {
        log('⚠️ 5sim failed — please complete SMS verification manually in the browser.');
      }
      debugLog('Waiting for manual phone verification (up to 3 min)');
      try {
        await page.waitForFunction(() => {
          const text = document.body.innerText.toLowerCase();
          const modalGone = !document.querySelector('[name="cellulare_challenge"]') || document.querySelector('[name="cellulare_challenge"]').offsetParent === null;
          const completed = text.includes('registrazione completata') || text.includes('complimenti') || text.includes('la tua casella');
          return completed || (modalGone && !text.includes('verifica del tuo account'));
        }, { timeout: 180000, polling: 2000 });
        log('✅ Verification completed');
      } catch {
        log('⏰ Verification timed out after 3 minutes');
      }
    }

    // Wait for post-verification page to settle
    try {
      await randWait(2000, 3000);
      const finalText = await page.evaluate(() => document.body.innerText.toLowerCase());
      if (finalText.includes('registrazione completata') || finalText.includes('complimenti') || finalText.includes('la tua casella')) {
        log('✅ Registration completed successfully!');
      } else {
        debugLog(`Final page text: ${finalText.substring(0, 300)}`);
      }
    } catch (evalErr) {
      debugLog(`Post-verification page check failed (page may have navigated): ${evalErr.message}`);
    }
  }

  log('Registration complete.');

  // Kill-switch: auto-close browser after success
  if (browser) {
    debugLog('Kill-switch: closing browser after successful registration');
    try { await browser.close(); } catch {}
  }

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

    // Kill-switch: auto-close browser after failure
    if (browser) {
      debugLog('Kill-switch: closing browser after failure');
      try { await browser.close(); } catch {}
    }
    cleanupCursor();
    return;
  }

  cleanupCursor();
}

module.exports = { register, findChrome };
