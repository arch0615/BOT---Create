const puppeteer = require('puppeteer-core');
const fs = require('fs');

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

async function typeField(page, labelRe, value, opts) {
  if (!value) return;
  const el = await inputByLabel(page, labelRe);
  if (!el) return;
  await el.click({ clickCount: 3 });
  await el.type(value, { delay: opts?.delay || 20 });
}

async function clickButton(page, textRe) {
  await page.evaluate((re) => {
    for (const b of document.querySelectorAll('button, input[type=submit]')) {
      if (new RegExp(re, 'i').test(b.textContent || b.value)) { b.click(); return; }
    }
  }, textRe);
}

async function selectRadio(page, labelText) {
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

async function pickAutocomplete(page, value) {
  await wait(1500);
  await page.evaluate((v) => {
    const selectors = '[role=option], [role=listbox] li, ul[class*=auto] li, ul[class*=suggest] li, li[class*=option], [class*=menu] li, [class*=listbox] li';
    for (const el of document.querySelectorAll(selectors)) {
      if (el.textContent.trim().toLowerCase().includes(v.toLowerCase()) && el.offsetParent !== null) {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.click();
        return;
      }
    }
    for (const el of document.querySelectorAll('li, div[role=option]')) {
      if (el.textContent.trim().toLowerCase().includes(v.toLowerCase()) && el.offsetParent !== null) {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.click();
        return;
      }
    }
  }, value);
}

async function register(data, onStatus) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Google Chrome not found. Install it or set CHROME_PATH.');

  const log = (msg) => onStatus && onStatus(msg);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });

  const page = (await browser.pages())[0];
  await page.goto('https://registrazione.libero.it/', { waitUntil: 'networkidle2' });

  // --- Step 1: Username + Password ---
  log('Filling username and password…');
  const inputs = await page.$$('input');
  let filledUser = false;
  for (const inp of inputs) {
    const type = await inp.evaluate((el) => el.type);
    const visible = await inp.evaluate((el) => el.offsetParent !== null);
    if (!visible) continue;
    if (type === 'password') {
      await inp.type(data.password, { delay: 20 });
    } else if (['text', 'email', ''].includes(type) && !filledUser) {
      await inp.type(data.username, { delay: 20 });
      filledUser = true;
    }
  }

  log('Solve the CAPTCHA and click Avanti. Waiting…');
  await page.waitForFunction(
    () => !document.querySelector('input[type=password]') && /cognome|informazioni personali/i.test(document.body.innerText),
    { timeout: 300000 }
  );
  await wait(1000);

  // --- Step 2: Personal info ---
  log('Filling personal info…');
  await typeField(page, '^nome$', data.name);
  await typeField(page, 'cognome', data.surname);
  await typeField(page, 'data.*nascita', data.birthDate);

  if (data.city) {
    const cityEl = await inputByLabel(page, 'citt');
    if (cityEl) {
      await cityEl.click({ clickCount: 3 });
      await cityEl.type(data.city, { delay: 80 });
      await pickAutocomplete(page, data.city);
    }
  }

  if (data.sex) {
    await selectRadio(page, data.sex === 'M' ? 'Uomo' : 'Donna');
  }

  await wait(1000);
  await clickButton(page, 'avanti');
  log('Page 2 done, moving to page 3…');

  // --- Step 3: Security & Privacy ---
  await page.waitForFunction(
    () => /sicurezza|protezione account/i.test(document.body.innerText),
    { timeout: 30000 }
  );
  await wait(1000);

  log('Filling recovery email and consents…');
  await typeField(page, 'mail.*cellulare', data.recoveryEmail);
  await selectRadio(page, 'Presto il consenso');
  await wait(500);
  await clickButton(page, 'registrati');

  log('Registration submitted.');
}

module.exports = { register, findChrome };
