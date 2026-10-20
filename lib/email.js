// Builds email addresses from the holder's name plus a random 5-digit number,
// e.g. marco.branchetti48213@example.com. Only the address text is created, not a mailbox.
const crypto = require('crypto');

const FORMATS = {
  'name.surname': (n, s) => `${n}.${s}`,
  namesurname: (n, s) => `${n}${s}`,
  'surname.name': (n, s) => `${s}.${n}`,
  'n.surname': (n, s) => `${n[0]}.${s}`,
};

// Lowercase ASCII letters only: accents removed, apostrophes and spaces dropped (D'ANGELO -> dangelo).
const slug = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

const isValidDomain = (d) => /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(String(d || '').toLowerCase());

// '' when the first name or surname is not known yet.
function username(fields, format = 'name.surname') {
  const first = slug(String(fields.name || '').split(/\s+/)[0]); // first given name only
  const last = slug(fields.surname);
  if (!first || !last) return '';
  return (FORMATS[format] || FORMATS['name.surname'])(first, last);
}

// `taken` holds addresses already in use (lowercase); the new one is added to it.
// `keepDigits` reuses the number of a previous address (e.g. after a name correction) if still free.
function generate(fields, { domain, format, digits = 5 }, taken = new Set(), keepDigits = '') {
  if (!isValidDomain(domain)) throw new Error('Set a valid email domain in Settings first');
  const base = username(fields, format);
  if (!base) return '';
  for (let attempt = 0; attempt < 1000; attempt++) {
    const n =
      attempt === 0 && new RegExp(`^\\d{${digits}}$`).test(keepDigits)
        ? keepDigits
        : String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
    const email = `${base}${n}@${domain.toLowerCase()}`;
    if (!taken.has(email)) {
      taken.add(email);
      return email;
    }
  }
  throw new Error('Could not find a free address');
}

const digitsOf = (email) => (String(email || '').match(/(\d{5})@/) || [])[1] || '';

module.exports = { generate, username, isValidDomain, digitsOf, FORMATS };
