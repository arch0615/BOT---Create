// Italian Codice Fiscale: computation, validation and recovery from noisy OCR.
const { norm } = require('./comuni');

const MONTHS = 'ABCDEHLMPRST';
const ODD = {
  0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};
const PATTERN = /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/;
const SHAPE = 'LLLLLLDDLDDLDDDL';

const TO_DIGIT = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '1', J: '1', Z: '2', S: '5', G: '6', B: '8', A: '4' };
const TO_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 7: 'T', 8: 'B' };

function checkChar(first15) {
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = first15[i];
    sum += i % 2 === 0 ? ODD[ch] : /\d/.test(ch) ? +ch : ch.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26));
}

function namePart(s, isFirstName) {
  const letters = norm(s).replace(/\d/g, '');
  const cons = letters.replace(/[AEIOU]/g, '');
  const vow = letters.replace(/[^AEIOU]/g, '');
  if (isFirstName && cons.length >= 4) return cons[0] + cons[2] + cons[3];
  return (cons + vow + 'XXX').slice(0, 3);
}

// First 11 characters, from surname, name, birth date (DD/MM/YYYY) and sex.
function prefix(surname, name, birthDate, sex) {
  const m = String(birthDate || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!surname || !name || !m || !/^[MF]$/.test(sex)) return '';
  const day = String(+m[1] + (sex === 'F' ? 40 : 0)).padStart(2, '0');
  return namePart(surname, false) + namePart(name, true) + m[3].slice(2) + MONTHS[+m[2] - 1] + day;
}

const isValid = (cf) => PATTERN.test(cf) && checkChar(cf.slice(0, 15)) === cf[15];

function coerceShape(s, shape) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const want = shape[i];
    const ch = s[i];
    if (want === 'D') out += /\d/.test(ch) ? ch : TO_DIGIT[ch] || '?';
    else out += /[A-Z]/.test(ch) ? ch : TO_LETTER[ch] || '?';
  }
  return out;
}

// Looks for the Codice Fiscale in OCR text. If the expected 11-char prefix is known (from the MRZ),
// it is used to locate the code and to repair the prefix; the birthplace code and check character
// still have to come from the OCR. Returns candidate codes, best first.
function findInText(texts, expectedPrefix) {
  const candidates = new Map();
  const add = (cf, score) => candidates.set(cf, (candidates.get(cf) || 0) + score);

  for (const text of texts) {
    for (const rawLine of String(text || '').toUpperCase().split('\n')) {
      const line = rawLine.replace(/[^A-Z0-9]/g, '');
      for (let i = 0; i + 14 <= line.length; i++) {
        const win = line.slice(i, i + 16).padEnd(16, '?');
        const shaped = coerceShape(win, SHAPE);
        if (expectedPrefix) {
          const head = coerceShape(line.slice(i, i + 11), SHAPE);
          let diff = 0;
          for (let k = 0; k < 11; k++) if (head[k] !== expectedPrefix[k]) diff++;
          if (diff > 3) continue;
          const tail = shaped.slice(11);
          const cf = expectedPrefix + tail;
          if (isValid(cf)) add(cf, 3 - diff + 1);
          else if (/^[A-Z]\d{3}$/.test(tail.slice(0, 4))) {
            // Check char misread: keep the birthplace code and recompute it (weak evidence).
            const fixed = expectedPrefix + tail.slice(0, 4);
            add(fixed + checkChar(fixed), 0.5);
          }
        } else if (isValid(shaped)) {
          add(shaped, 1);
        }
      }
    }
  }
  return [...candidates.entries()].sort((a, b) => b[1] - a[1]).map(([cf, score]) => ({ cf, score }));
}

module.exports = { checkChar, prefix, isValid, findInText, namePart };
