// Field definitions, validation of (possibly hand-edited) card data, and CSV export.
const path = require('path');
const comuniDb = require('./comuni');
const cf = require('./cf');
const { issueDateFits } = require('./extract');

const FIELDS = [
  { key: 'tax_id', label: 'Tax ID', group: 'Person' },
  { key: 'name', label: 'First name', group: 'Person' },
  { key: 'surname', label: 'Last name', group: 'Person' },
  { key: 'birth_date', label: 'Birthday', group: 'Person' },
  { key: 'sex', label: 'Gender', group: 'Person' },
  { key: 'nation', label: 'Nation', group: 'Birthplace' },
  { key: 'birth_province', label: 'Province', group: 'Birthplace' },
  { key: 'birth_comune', label: 'Comune', group: 'Birthplace' },
  { key: 'res_province', label: 'Province of residence', group: 'Residence' },
  { key: 'res_city', label: 'City of residence', group: 'Residence' },
  { key: 'address', label: 'Address', group: 'Residence' },
  { key: 'house_number', label: 'House number', group: 'Residence' },
  { key: 'cap', label: 'ZIP Code (CAP)', group: 'Residence' },
  { key: 'document_type', label: 'Document type', group: 'Document' },
  { key: 'issuing_body', label: 'Issuing body', group: 'Document' },
  { key: 'document_number', label: 'Document number', group: 'Document' },
  { key: 'place_of_issue', label: 'Place of issue', group: 'Document' },
  { key: 'issue_date', label: 'Issue date', group: 'Document' },
  { key: 'expiry_date', label: 'Expiration date', group: 'Document' },
  { key: 'telephone', label: 'Telephone', group: 'Contact & account', optional: true, manual: true },
  { key: 'email', label: 'Email', group: 'Contact & account', optional: true, manual: true },
  { key: 'password', label: 'Password', group: 'Contact & account', optional: true, manual: true, secret: true },
  { key: 'recovery_email', label: 'Recovery email', group: 'Contact & account', optional: true, manual: true },
];
const MANUAL_KEYS = FIELDS.filter((d) => d.manual).map((d) => d.key);
const SECRET_KEYS = FIELDS.filter((d) => d.secret).map((d) => d.key);

// CSV column order as requested for the form bot.
const CSV_ORDER = [
  'tax_id', 'name', 'surname', 'birth_date', 'nation', 'birth_province', 'birth_comune', 'sex',
  'res_province', 'res_city', 'address', 'house_number', 'cap', 'document_type', 'issuing_body',
  'document_number', 'place_of_issue', 'issue_date', 'expiry_date', 'telephone', 'email', 'password', 'recovery_email',
];

function parseDate(s) {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 ? d : null;
}

// Returns { errors: {key: msg}, warnings: {key: msg} } for the current field values.
function validate(f) {
  const errors = {};
  const warnings = {};
  for (const def of FIELDS) if (!def.optional && !String(f[def.key] || '').trim()) errors[def.key] = 'Required';

  for (const k of ['birth_date', 'issue_date', 'expiry_date']) {
    if (f[k] && !parseDate(f[k])) errors[k] = 'Use DD/MM/YYYY';
  }
  if (f.sex && !/^[MF]$/.test(f.sex)) errors.sex = 'Use M or F';

  const exp = parseDate(f.expiry_date);
  if (exp && exp < new Date()) errors.expiry_date = 'Document is expired';
  if (parseDate(f.issue_date) && parseDate(f.birth_date) && exp && !issueDateFits(f.issue_date, f.birth_date, f.expiry_date)) {
    warnings.issue_date = 'Unusual for a CIE: the expiry is normally about 3, 5 or 10 years after issue';
  }

  if (f.tax_id) {
    const code = f.tax_id.toUpperCase();
    if (!cf.isValid(code)) errors.tax_id = 'Not a valid Codice Fiscale (format or check character)';
    else {
      const expected = cf.prefix(f.surname, f.name, f.birth_date, f.sex);
      if (expected && code.slice(0, 11) !== expected) {
        errors.tax_id = `Does not match name / birthday / gender (expected ${expected}…)`;
      }
      const bp = comuniDb.findByBelfiore(code.slice(11, 15));
      if (bp && f.birth_comune && comuniDb.norm(bp.nome) !== comuniDb.norm(f.birth_comune)) {
        warnings.birth_comune = `The Tax ID says born in ${bp.nome} (${bp.sigla})`;
      }
    }
  }

  if (f.nation === 'ITALIA' && f.birth_comune && !comuniDb.findByName(f.birth_comune, f.birth_province)) {
    warnings.birth_comune = `Not a comune of province ${f.birth_province || '?'} in the ISTAT list`;
  }
  const city = f.res_city && comuniDb.findByName(f.res_city, f.res_province);
  if (f.res_city && !city) warnings.res_city = `Not a comune of province ${f.res_province || '?'} in the ISTAT list`;
  if (f.cap && !/^\d{5}$/.test(f.cap)) errors.cap = 'CAP must be 5 digits';
  else if (city && f.cap && !city.cap.includes(f.cap)) warnings.cap = `Not a CAP of ${city.nome}`;

  if (f.document_number && !/^C[A-Z]\d{5}[A-Z]{2}$/.test(f.document_number)) {
    warnings.document_number = 'CIE numbers look like CA12345AB';
  }
  if (f.place_of_issue && !comuniDb.findByName(f.place_of_issue)) warnings.place_of_issue = 'Not in the ISTAT list of comuni';
  if (f.telephone && !/^\+?[\d\s./-]{6,20}$/.test(f.telephone)) warnings.telephone = 'Does not look like a phone number';
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (f.email && !EMAIL.test(f.email)) errors.email = 'Not a valid email address';
  if (f.recovery_email && !EMAIL.test(f.recovery_email)) errors.recovery_email = 'Not a valid email address';
  else if (f.recovery_email && f.email && f.recovery_email.toLowerCase() === f.email.toLowerCase()) {
    warnings.recovery_email = 'Same as the main email';
  }
  if (f.password && /^\s|\s$/.test(f.password)) warnings.password = 'Starts or ends with a space';
  return { errors, warnings };
}

// Overall card state: 'error' (blocking problems), 'review' (unconfirmed OCR fields), or 'ok'.
function cardState(card) {
  const { errors, warnings } = validate(card.fields);
  if (Object.keys(errors).length) return 'error';
  if (card.reviewed) return 'ok';
  const unconfirmed = FIELDS.some((d) => ['check', 'missing'].includes(card.status[d.key]));
  return unconfirmed || Object.keys(warnings).length ? 'review' : 'ok';
}

function toCsv(cards) {
  const headers = [...CSV_ORDER.map((k) => FIELDS.find((d) => d.key === k).label), 'Status', 'Notes', 'Front image', 'Back image'];
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = cards.map((c) => {
    const state = cardState(c);
    const { errors, warnings } = validate(c.fields);
    const notes = [
      ...Object.entries(errors).map(([k, m]) => `${FIELDS.find((d) => d.key === k).label}: ${m}`),
      ...Object.entries(warnings).map(([k, m]) => `${FIELDS.find((d) => d.key === k).label}: ${m}`),
      ...(c.notes || []),
    ];
    return [
      ...CSV_ORDER.map((k) => c.fields[k]),
      state === 'ok' ? 'OK' : 'NEEDS REVIEW',
      notes.join('; '),
      c.front ? path.basename(c.front) : '',
      c.back ? path.basename(c.back) : '',
    ];
  });
  // BOM so Excel opens accented characters correctly.
  return '﻿' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { FIELDS, CSV_ORDER, MANUAL_KEYS, SECRET_KEYS, validate, cardState, toCsv };
