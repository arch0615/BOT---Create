// Validates transcribed CIE (Carta d'Identità Elettronica) data and writes cards.csv.
// Usage: node build-csv.js [cards.json] [cards.csv]
const fs = require('fs');
const path = require('path');

// Values for fields that are not printed on the card. Adjust them to the form's dropdown options.
const DOCUMENT_TYPE = "Carta d'identità elettronica";
const ISSUING_BODY = 'Comune';

const inFile = process.argv[2] || path.join(__dirname, 'cards.json');
const outFile = process.argv[3] || path.join(__dirname, 'cards.csv');

const cards = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const comuni = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'comuni.json'), 'utf8'));

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

function findComune(name, sigla) {
  return comuni.find((c) => norm(c.nome) === norm(name) && (!sigla || c.sigla === sigla));
}

// --- MRZ (ICAO 9303, TD1) -------------------------------------------------
function mrzCheckDigit(s) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const v = ch === '<' ? 0 : /\d/.test(ch) ? +ch : ch.charCodeAt(0) - 55;
    sum += v * weights[i % 3];
  }
  return String(sum % 10);
}

function parseMrz([l1, l2, l3], errors) {
  if (![l1, l2, l3].every((l) => l && l.length === 30)) {
    errors.push('MRZ lines must be 30 characters each');
    return null;
  }
  const docNumber = l1.slice(5, 14).replace(/</g, '');
  const checks = [
    ['document number', l1.slice(5, 14), l1[14]],
    ['birth date', l2.slice(0, 6), l2[6]],
    ['expiry date', l2.slice(8, 14), l2[14]],
    ['composite', l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29), l2[29]],
  ];
  for (const [label, data, digit] of checks) {
    if (mrzCheckDigit(data) !== digit) errors.push(`MRZ check digit failed: ${label}`);
  }
  const [surname, given = ''] = l3.split('<<');
  return {
    docNumber,
    birth: l2.slice(0, 6), // YYMMDD
    sex: l2[7],
    expiry: l2.slice(8, 14),
    nationality: l2.slice(15, 18),
    surname: surname.replace(/</g, ' ').trim(),
    name: given.replace(/</g, ' ').trim(),
  };
}

// --- Codice Fiscale --------------------------------------------------------
const CF_MONTHS = 'ABCDEHLMPRST';
const CF_ODD = {
  0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};

function cfCheckChar(first15) {
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = first15[i];
    if (i % 2 === 0) sum += CF_ODD[ch];
    else sum += /\d/.test(ch) ? +ch : ch.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26));
}

function cfNamePart(s, isFirstName) {
  const letters = norm(s).replace(/\d/g, '');
  const cons = letters.replace(/[AEIOU]/g, '');
  const vow = letters.replace(/[^AEIOU]/g, '');
  if (isFirstName && cons.length >= 4) return cons[0] + cons[2] + cons[3];
  return (cons + vow + 'XXX').slice(0, 3);
}

function checkTaxId(cf, card, birthComune, errors) {
  if (!/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/.test(cf)) {
    errors.push('Tax ID has an invalid format');
    return;
  }
  if (cfCheckChar(cf.slice(0, 15)) !== cf[15]) errors.push('Tax ID check character is wrong');
  const [d, m, y] = card.birth_date.split('.');
  const day = String(+d + (card.sex === 'F' ? 40 : 0)).padStart(2, '0');
  const expected =
    cfNamePart(card.surname, false) + cfNamePart(card.name, true) + y.slice(2) + CF_MONTHS[+m - 1] + day;
  if (cf.slice(0, 11) !== expected) errors.push(`Tax ID does not match name/birth date/sex (expected ${expected}...)`);
  if (birthComune && cf.slice(11, 15) !== birthComune.codiceCatastale) {
    errors.push(`Tax ID birthplace code ${cf.slice(11, 15)} does not match ${birthComune.nome} (${birthComune.codiceCatastale})`);
  }
}

// --- Residence address -----------------------------------------------------
// "VIA MARTIRI DELLA LIBERAZIONE, N. 179 INT. 3 CHIAVARI (GE)" -> street / number / comune / province
function parseResidence(raw, errors) {
  const m = raw.trim().match(/^(.*)\s*\(([A-Z]{2})\)$/);
  if (!m) {
    errors.push('Residence: province "(XX)" not found');
    return null;
  }
  const sigla = m[2];
  let rest = m[1].trim();
  // The comune is at the end; take the longest comune name of that province that matches.
  const candidates = comuni
    .filter((c) => c.sigla === sigla && norm(rest).endsWith(norm(c.nome)))
    .sort((a, b) => b.nome.length - a.nome.length);
  const comune = candidates[0];
  if (!comune) {
    errors.push(`Residence: comune not recognised in province ${sigla}`);
    return null;
  }
  // Drop as many trailing words as the comune name has.
  const words = rest.split(/\s+/);
  const nameWords = comune.nome.split(/[\s-]+/).length;
  rest = words.slice(0, words.length - nameWords).join(' ');

  const addr =
    rest.match(/^(.*?),\s*(?:N\.?\s*)?(\d+[A-Z]?(?:\/\w+)?(?:\s+.*)?)$/) ||
    rest.match(/^(.*\D)\s+(?:N\.?\s*)?(\d+[A-Z]?(?:\/\w+)?(?:\s+.*)?)$/);
  if (!addr) errors.push('Residence: house number not found');
  return {
    street: addr ? addr[1].trim() : rest,
    number: addr ? addr[2].trim() : '',
    comune,
    sigla,
  };
}

// --- Helpers -----------------------------------------------------------------
const toSlash = (d) => d.replace(/\./g, '/'); // DD.MM.YYYY -> DD/MM/YYYY
const toYYMMDD = (d) => {
  const [dd, mm, yyyy] = d.split('.');
  return yyyy.slice(2) + mm + dd;
};
const isPast = (d) => {
  const [dd, mm, yyyy] = d.split('.');
  return new Date(+yyyy, +mm - 1, +dd) < new Date();
};

// --- Main --------------------------------------------------------------------
const HEADERS = [
  'Tax ID', 'First name', 'Last name', 'Birthday', 'Nation', 'Province', 'Comune', 'Gender',
  'Province of residence', 'City of residence', 'Address', 'House number', 'ZIP Code (CAP)',
  'Document type', 'Issuing body', 'Document number', 'Place of issue', 'Issue date',
  'Expiration date', 'Telephone', 'Status', 'Notes', 'Front image', 'Back image',
];

const rows = [];
let reviewCount = 0;

for (const card of cards) {
  const errors = [];
  const notes = card.notes ? [card.notes] : [];

  // Birthplace: "COMUNE (XX)" for Italy, "CITY (COUNTRY)" for births abroad.
  const bp = card.birth_place.match(/^(.*?)\s*\(([^)]+)\)$/);
  let nation = '', birthProv = '', birthComuneName = '', birthComune = null;
  if (bp && /^[A-Z]{2}$/.test(bp[2])) {
    nation = 'ITALIA';
    birthProv = bp[2];
    birthComune = findComune(bp[1], birthProv);
    birthComuneName = birthComune ? birthComune.nome : bp[1];
    if (!birthComune) errors.push(`Birthplace comune "${bp[1]} (${birthProv})" not found`);
  } else if (bp) {
    nation = bp[2];
    birthProv = 'EE';
    birthComuneName = bp[1];
  } else {
    errors.push('Birthplace not in "COMUNE (XX)" format');
  }

  const mrz = parseMrz(card.mrz, errors);
  if (mrz) {
    if (mrz.docNumber !== card.document_number) errors.push(`Document number differs from MRZ (${mrz.docNumber})`);
    if (mrz.birth !== toYYMMDD(card.birth_date)) errors.push('Birth date differs from MRZ');
    if (mrz.expiry !== toYYMMDD(card.expiry_date)) errors.push('Expiry date differs from MRZ');
    if (mrz.sex !== card.sex) errors.push('Sex differs from MRZ');
    if (norm(mrz.surname) !== norm(card.surname)) errors.push(`Surname differs from MRZ (${mrz.surname})`);
    if (norm(mrz.name) !== norm(card.name)) errors.push(`Name differs from MRZ (${mrz.name})`);
  }

  checkTaxId(card.tax_id, card, birthComune, errors);

  const res = parseResidence(card.residence, errors);
  let cap = card.cap || '';
  if (res && !cap) {
    if (res.comune.cap.length === 1) cap = res.comune.cap[0];
    else errors.push(`${res.comune.nome} has several CAPs (${res.comune.cap[0]}-${res.comune.cap.at(-1)}); set "cap" in cards.json`);
  }
  if (res && cap && !res.comune.cap.includes(cap)) errors.push(`CAP ${cap} does not belong to ${res.comune.nome}`);

  const issuing = findComune(card.issuing_comune);
  if (!issuing) errors.push(`Issuing comune "${card.issuing_comune}" not found`);
  if (isPast(card.expiry_date)) errors.push('Document is expired');

  const status = errors.length || card.notes ? 'NEEDS REVIEW' : 'OK';
  if (status !== 'OK') reviewCount++;

  rows.push([
    card.tax_id, card.name, card.surname, toSlash(card.birth_date), nation, birthProv, birthComuneName, card.sex,
    res ? res.sigla : '', res ? res.comune.nome : '', res ? res.street : '', res ? res.number : '', cap,
    DOCUMENT_TYPE, ISSUING_BODY, card.document_number, issuing ? issuing.nome : card.issuing_comune,
    toSlash(card.issue_date), toSlash(card.expiry_date), '', status, [...errors, ...notes].join('; '),
    card.front_image, card.back_image,
  ]);

  console.log(`${status.padEnd(12)} ${card.surname} ${card.name}${errors.length ? '\n  - ' + errors.join('\n  - ') : ''}`);
}

const csvCell = (v) => (/[",\n;]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
const csv = [HEADERS, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
fs.writeFileSync(outFile, '﻿' + csv, 'utf8'); // BOM so Excel reads accents correctly

console.log(`\nWrote ${rows.length} rows to ${outFile} (${reviewCount} need review)`);
