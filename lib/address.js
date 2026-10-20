// Parses the CIE residence line, e.g. "VIA MARTIRI DELLA LIBERAZIONE, N. 179 INT. 3 CHIAVARI (GE)".
const comuniDb = require('./comuni');

const TOPONYMS = [
  'VIA', 'VIALE', 'V.LE', 'PIAZZA', 'P.ZZA', 'PIAZZALE', 'CORSO', 'C.SO', 'STRADA', 'STR.', 'LOCALITA', 'LOCALITÀ',
  'LOC.', 'FRAZIONE', 'FRAZ.', 'VICOLO', 'VIC.', 'LARGO', 'CONTRADA', 'C.DA', 'BORGO', 'SALITA', 'CALLE', 'SESTIERE',
  'CAMPO', 'RIONE', 'PODERE', 'BORGATA', 'TRAVERSA', 'REGIONE', 'PASSEGGIATA', 'LUNGOMARE', 'LUNGOTEVERE', 'VIOTTOLO',
  'CASCINA', 'GALLERIA', 'PIAZZETTA', 'RAMPA', 'SCALINATA', 'STRADELLA', 'VIA LE', 'BELVEDERE', 'BASTIONI',
];
const TOPONYM_RE = new RegExp(`(^|[^A-Z])(${TOPONYMS.map((t) => t.replace(/\./g, '\\.')).join('|')})\\s`, 'i');

const knownSigle = () => new Set(comuniDb.load().map((c) => c.sigla));

function cleanLine(line) {
  return String(line || '')
    .toUpperCase()
    .replace(/[{[]/g, '(')
    .replace(/[}\]]/g, ')')
    .replace(/;/g, ',')
    .replace(/([A-Z]{2,})\.(\d)/g, '$1,$2') // "COLLIO.6" -> "COLLIO,6"
    .replace(/\s+/g, ' ')
    .trim();
}

// "1S5" -> "155" when the token is clearly meant to be a number
const fixNumberToken = (t) => (/^\d[\dSOIL]*[A-Z]?$/.test(t) ? t.replace(/S/g, '5').replace(/[OD]/g, '0').replace(/[IL]/g, '1') : t);

function splitStreetNumber(rest) {
  rest = rest
    .replace(/[,\s]+$/, '')
    // "N. 12", "N/12", "N:12", "N12" and common misreads of "N:" before the house number
    .replace(/[,\s]+(?:N|NR|NN|F1|FL|M)[.:/?°]*\s*(?=\d)/, ', ');
  const m =
    rest.match(/^(.*?),\s*(?:N[.:/]?\s*)?(\d\S*(?:\s+.*)?)$/) || rest.match(/^(.*\D)\s+(?:N[.:/]?\s*)?(\d\S*(?:\s+.*)?)$/);
  if (!m) return { street: rest.trim(), number: '' };
  let [first, ...more] = m[2].trim().split(/\s+/);
  first = fixNumberToken(first.replace(/[,.]$/, ''));
  const number = [first, ...more]
    .join(' ')
    .replace(/\bINT[.:,]?\s*(\w)/, 'INT. $1')
    .replace(/\s+/g, ' ');
  return { street: m[1].replace(/[,\s]+$/, '').trim(), number };
}

// Returns { street, number, comune, sigla, score } or null.
function parseResidenceLine(line) {
  let text = cleanLine(line);
  const t = text.search(TOPONYM_RE);
  const hasToponym = t >= 0;
  if (hasToponym) text = text.slice(t).replace(/^[^A-Z]+/, '');

  const provMatches = [...text.matchAll(/\(\s*([A-Z0-9]{2})\s*\)/g)];
  const last = provMatches.at(-1);
  const body = (last ? text.slice(0, last.index) : text).trim();
  const ocrSigla = last ? last[1] : '';

  let match = null;
  let siglaOk = false;
  if (knownSigle().has(ocrSigla)) {
    match = comuniDb.matchAtEnd(body, { sigla: ocrSigla, minScore: 0.75 });
    siglaOk = !!match;
  }
  if (!match) match = comuniDb.matchAtEnd(body, { minScore: 0.85 });
  if (!match) return null;

  const split = splitStreetNumber(body.slice(0, body.length - match.cut));
  const street = split.street.replace(/[.,;:\s]+$/, '');
  const { number } = split;
  if (street.length < 3) return null;
  const parens = (street.match(/\(/g) || []).length - (street.match(/\)/g) || []).length;
  const junk =
    (street.match(/[^A-Z0-9 '.,()\-/ÀÈÉÌÒÙ]/g) || []).length + (/,\s*\S{1,3}$/.test(street) ? 1 : 0) + Math.abs(parens);
  const score = match.score + (siglaOk ? 0.3 : 0) + (number ? 0.2 : 0) + (hasToponym ? 0.2 : 0) - junk * 0.25;
  return {
    street, number, comune: match.comune, sigla: match.comune.sigla, score, junk, hasToponym, exactComune: match.score === 1,
  };
}

// Lower is better: a line starting with a street word (VIA, PIAZZA…) beats one without, then clean beats noisy.
const tier = (r) => (r.hasToponym ? 0 : 2) + (r.junk > 0 ? 1 : 0);

// Picks the most plausible residence across several OCR passes.
function findResidence(texts) {
  const results = new Map();
  for (const text of texts) {
    let best = null;
    for (const line of String(text || '').split('\n')) {
      if (!/[A-Z]{3}/i.test(line) || /RESIDEN|NASCITA|FISCAL|GENITORI|PADRE|COGNOME|NOME DE/i.test(line)) continue;
      const r = parseResidenceLine(line);
      if (r && (!best || tier(r) < tier(best) || (tier(r) === tier(best) && r.score > best.score))) best = r;
    }
    if (!best) continue;
    const key = [best.street, best.number, best.comune.nome].join('|');
    const entry = results.get(key) || { ...best, votes: 0, total: 0 };
    entry.votes++;
    entry.total += best.score;
    results.set(key, entry);
  }
  // A clean reading beats any number of noisy ones; then the most (score-weighted) votes win.
  const ranked = [...results.values()].sort((a, b) => tier(a) - tier(b) || b.total - a.total);
  if (!ranked.length) return null;
  // "unanimous": no other well-formed reading (street word, no junk) disagrees with the winner.
  return { ...ranked[0], unanimous: ranked.filter((r) => tier(r) === 0).length <= 1 };
}

module.exports = { parseResidenceLine, findResidence, splitStreetNumber };
