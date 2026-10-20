// Runs the OCR pipeline on the sample cards and compares every field with the verified
// transcription in cards.json.  Usage: node test/accuracy.js [--fresh]
// Raw OCR is cached in test/.ocr-cache.json so parsing changes can be re-tested quickly.
const fs = require('fs');
const path = require('path');
const { OcrEngine } = require('../lib/ocr');
const { extractCard } = require('../lib/extract');
const { parseResidenceLine } = require('../lib/address');
const comuniDb = require('../lib/comuni');

const root = path.join(__dirname, '..');
const cacheFile = path.join(__dirname, '.ocr-cache.json');
const cards = JSON.parse(fs.readFileSync(path.join(root, 'cards.json'), 'utf8'));

function expectedFields(c) {
  const res = parseResidenceLine(c.residence);
  const [, bName, bProv] = c.birth_place.match(/^(.*?)\s*\((\w\w)\)$/);
  return {
    tax_id: c.tax_id,
    name: c.name,
    surname: c.surname,
    birth_date: c.birth_date.replace(/\./g, '/'),
    nation: 'ITALIA',
    birth_province: bProv,
    birth_comune: comuniDb.findByName(bName, bProv).nome,
    sex: c.sex,
    res_province: res.sigla,
    res_city: res.comune.nome,
    address: res.street,
    house_number: res.number,
    cap: c.cap || (res.comune.cap.length === 1 ? res.comune.cap[0] : ''),
    document_number: c.document_number,
    place_of_issue: comuniDb.findByName(c.issuing_comune).nome,
    issue_date: c.issue_date.replace(/\./g, '/'),
    expiry_date: c.expiry_date.replace(/\./g, '/'),
  };
}

(async () => {
  let cache = {};
  if (fs.existsSync(cacheFile) && !process.argv.includes('--fresh')) cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

  let engine = null;
  const read = async (file) => {
    if (cache[file]) return cache[file];
    if (!engine) {
      engine = new OcrEngine({ cachePath: path.join(__dirname, '.tess-cache') });
      await engine.init();
    }
    const t0 = Date.now();
    const r = await engine.readImage(path.join(root, 'ID cards', file));
    r.ms = Date.now() - t0;
    cache[file] = r;
    return r;
  };

  const totals = {};
  let wrongOk = 0;
  for (const c of cards) {
    const front = await read(c.front_image);
    const back = await read(c.back_image);
    const sides = `${front.side}/${back.side}`;
    const { fields, status, notes } = extractCard(front, back);
    const exp = expectedFields(c);
    const lines = [];
    for (const [k, v] of Object.entries(exp)) {
      const t = (totals[k] = totals[k] || { right: 0, ok: 0, n: 0 });
      t.n++;
      const right = fields[k] === v;
      if (right) t.right++;
      if (status[k] === 'ok') t.ok++;
      if (!right && status[k] === 'ok') wrongOk++;
      if (!right || status[k] !== 'ok')
        lines.push(`   ${right ? ' ' : 'X'} ${k.padEnd(16)} [${status[k]}] got "${fields[k]}"${right ? '' : ` want "${v}"`}`);
    }
    console.log(`${c.surname} (${sides}, ${front.ms || '-'}+${back.ms || '-'}ms)`);
    lines.forEach((l) => console.log(l));
    notes.forEach((n) => console.log('   note: ' + n));
  }
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  if (engine) await engine.terminate();

  console.log('\nfield             correct  marked ok');
  let right = 0, n = 0;
  for (const [k, t] of Object.entries(totals)) {
    console.log(`${k.padEnd(18)}${String(t.right).padStart(3)}/${t.n}    ${String(t.ok).padStart(3)}/${t.n}`);
    right += t.right;
    n += t.n;
  }
  console.log(`\nOverall: ${right}/${n} fields correct; ${wrongOk} wrong values were marked ok (must be 0)`);
})();
