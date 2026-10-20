// Tolerant parser for the TD1 MRZ (3 x 30 chars) printed on the back of the Italian CIE.
// OCR output is noisy, so every field is decoded with position-aware character fixes and only
// accepted when its ICAO check digit matches. Several OCR passes are combined by voting.

const TO_DIGIT = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', G: '6', B: '8', A: '4' };
const TO_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 8: 'B' };

const asDigit = (ch) => (/\d/.test(ch) ? ch : TO_DIGIT[ch] || null);
const asLetter = (ch) => (/[A-Z]/.test(ch) ? ch : TO_LETTER[ch] || null);

function checkDigit(s) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const v = ch === '<' ? 0 : /\d/.test(ch) ? +ch : ch.charCodeAt(0) - 55;
    sum += v * weights[i % 3];
  }
  return String(sum % 10);
}

// Applies a pattern like 'LLDDDDDLLD' (L = letter, D = digit) to a string; null if impossible.
function coerce(s, pattern) {
  if (s.length !== pattern.length) return null;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = pattern[i] === 'D' ? asDigit(s[i]) : asLetter(s[i]);
    if (!ch) return null;
    out += ch;
  }
  return out;
}

function validDate(yymmdd) {
  const m = +yymmdd.slice(2, 4);
  const d = +yymmdd.slice(4, 6);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

const cleanLines = (text) =>
  String(text || '')
    .toUpperCase()
    .split('\n')
    .map((l) => l.replace(/[^A-Z0-9<]/g, ''))
    .filter((l) => l.length >= 10);

// Line 1: "C<ITA" + document number (9) + check digit, e.g. C<ITACA28955IS1<<<...
function findDocNumbers(lines) {
  const found = [];
  for (const line of lines) {
    let idx = line.indexOf('ITA');
    if (idx < 0) idx = line.search(/[I1][T7]A/);
    if (idx < 0 || idx > 6) continue;
    const win = line.slice(idx + 3, idx + 3 + 11);
    // The window may contain one spurious character, so also try dropping each one.
    const variants = [win.slice(0, 10)];
    for (let i = 0; i < Math.min(win.length, 10); i++) variants.push((win.slice(0, i) + win.slice(i + 1)).slice(0, 10));
    for (const v of variants) {
      const c = coerce(v, 'LLDDDDDLLD');
      if (c && checkDigit(c.slice(0, 9)) === c[9]) {
        found.push(c.slice(0, 9));
        break;
      }
    }
  }
  return found;
}

// Line 2: birth date (6) + check + sex + expiry (6) + check + nationality (3)
function findDatesLine(lines) {
  const found = [];
  for (const line of lines) {
    for (let i = 0; i + 18 <= line.length; i++) {
      const win = line.slice(i, i + 18);
      const birth = coerce(win.slice(0, 7), 'DDDDDDD');
      const expiry = coerce(win.slice(8, 15), 'DDDDDDD');
      const sex = win[7] === 'M' || win[7] === 'F' ? win[7] : win[7] === 'H' || win[7] === 'N' ? 'M' : null;
      if (!birth || !expiry || !sex) continue;
      if (checkDigit(birth.slice(0, 6)) !== birth[6] || checkDigit(expiry.slice(0, 6)) !== expiry[6]) continue;
      if (!validDate(birth.slice(0, 6)) || !validDate(expiry.slice(0, 6))) continue;
      const nat = coerce(win.slice(15, 18), 'LLL');
      found.push({ birth: birth.slice(0, 6), sex, expiry: expiry.slice(0, 6), nationality: nat || '' });
      break;
    }
  }
  return found;
}

// Line 3: SURNAME<<GIVEN<NAMES<<<<
function findNames(lines) {
  const found = [];
  for (const raw of lines) {
    const line = raw.replace(/^[^A-Z]+/, '');
    const m = line.match(/^([A-Z]+(?:<[A-Z]+)*)<<([A-Z]+(?:<[A-Z]+)*)/);
    if (!m) continue;
    if (/\d/.test(m[1] + m[2]) || m[1].length < 2 || m[2].length < 2) continue;
    found.push({ surname: m[1].replace(/</g, ' '), name: m[2].replace(/</g, ' ') });
  }
  return found;
}

function vote(items, key = JSON.stringify) {
  const counts = new Map();
  for (const it of items) {
    const k = key(it);
    const entry = counts.get(k) || { item: it, n: 0 };
    entry.n++;
    counts.set(k, entry);
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n);
  return ranked.length ? { value: ranked[0].item, votes: ranked[0].n, total: items.length, alternatives: ranked.length } : null;
}

// Readings that differ only by a stray separator ("AR MANDO" vs "ARMANDO") count as one group;
// within the winning group the most common spelling wins, ties going to fewer spaces.
function voteNames(items) {
  const groups = new Map();
  for (const it of items) {
    const key = (it.surname + '|' + it.name).replace(/ /g, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length);
  if (!ranked.length) return null;
  const counts = new Map();
  for (const it of ranked[0]) counts.set(JSON.stringify(it), (counts.get(JSON.stringify(it)) || 0) + 1);
  const best = [...counts.entries()]
    .map(([k, n]) => ({ it: JSON.parse(k), n }))
    .sort((a, b) => b.n - a.n || (a.it.surname + a.it.name).split(' ').length - (b.it.surname + b.it.name).split(' ').length)[0];
  return { value: best.it, votes: ranked[0].length, total: items.length, alternatives: ranked.length };
}

const fullYear = (yy, isBirth) => {
  const now = new Date().getFullYear() % 100;
  return (isBirth ? (+yy > now ? 1900 : 2000) : 2000) + +yy;
};
const mrzDateToDisplay = (yymmdd, isBirth) =>
  `${yymmdd.slice(4, 6)}/${yymmdd.slice(2, 4)}/${fullYear(yymmdd.slice(0, 2), isBirth)}`;

// texts: OCR outputs of the MRZ area (one per preprocessing pass).
function parseMrz(texts) {
  const lines = texts.flatMap(cleanLines);
  const doc = vote(findDocNumbers(lines), (x) => x);
  const dates = vote(findDatesLine(lines));
  const names = voteNames(findNames(lines));
  if (!doc && !dates && !names) return null;
  return {
    documentNumber: doc ? doc.value : '',
    birthDate: dates ? mrzDateToDisplay(dates.value.birth, true) : '',
    expiryDate: dates ? mrzDateToDisplay(dates.value.expiry, false) : '',
    sex: dates ? dates.value.sex : '',
    nationality: dates ? dates.value.nationality : '',
    surname: names ? names.value.surname : '',
    name: names ? names.value.name : '',
    // A field is "confirmed" when its check digits passed (doc/dates) or 2+ passes agree (names).
    confirmed: {
      documentNumber: !!doc,
      dates: !!dates,
      names: !!names && (names.votes >= 2 || names.alternatives === 1),
    },
  };
}

module.exports = { parseMrz, checkDigit, coerce };
