// Lookup and fuzzy matching over the ISTAT list of Italian comuni (data/comuni.json).
const fs = require('fs');
const path = require('path');

let comuni = null;
let byBelfiore = null;

function load(dataDir = path.join(__dirname, '..', 'data')) {
  if (comuni) return comuni;
  comuni = JSON.parse(fs.readFileSync(path.join(dataDir, 'comuni.json'), 'utf8'));
  for (const c of comuni) c.key = norm(c.nome);
  byBelfiore = new Map(comuni.map((c) => [c.codiceCatastale, c]));
  return comuni;
}

// Uppercase, no accents, letters and digits only.
function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const similarity = (a, b) => (a.length || b.length ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 1);

function findByName(name, sigla) {
  load();
  const key = norm(name);
  return comuni.find((c) => c.key === key && (!sigla || c.sigla === sigla)) || null;
}

function findByBelfiore(code) {
  load();
  return byBelfiore.get(code) || null;
}

// Best fuzzy match for an OCR'd comune name. Returns { comune, score } or null.
function bestMatch(text, { sigla, minScore = 0.75 } = {}) {
  load();
  const key = norm(text);
  if (key.length < 2) return null;
  let best = null;
  for (const c of comuni) {
    if (sigla && c.sigla !== sigla) continue;
    const score = similarity(key, c.key);
    if (!best || score > best.score) best = { comune: c, score };
  }
  return best && best.score >= minScore ? best : null;
}

// Finds the comune whose name ends the given text, tolerating OCR errors.
// Returns { comune, score, cut } where `cut` is the number of characters of `text` taken by the name.
function matchAtEnd(text, { sigla, minScore = 0.8 } = {}) {
  load();
  const upper = String(text || '').toUpperCase();
  let best = null;
  for (const c of comuni) {
    if (sigla && c.sigla !== sigla) continue;
    // Try suffixes of the text with roughly the same number of letters as the comune name.
    for (let start = upper.length - 1; start >= 0; start--) {
      if (start > 0 && /[A-Z0-9À-Ü']/.test(upper[start - 1])) continue; // only start at a word boundary
      const tail = norm(upper.slice(start));
      if (tail.length > c.key.length + 2) break;
      if (tail.length < c.key.length - 2) continue;
      const score = similarity(tail, c.key);
      const better =
        !best || score > best.score || (score === best.score && c.key.length > best.comune.key.length);
      if (score >= minScore && better) best = { comune: c, score, cut: upper.length - start };
    }
  }
  return best;
}

module.exports = { load, norm, similarity, levenshtein, findByName, findByBelfiore, bestMatch, matchAtEnd };
