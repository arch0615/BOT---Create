// Turns raw OCR of a CIE front + back into form fields, each with a status:
//   ok      - cross-checked (MRZ check digits, Codice Fiscale, ISTAT list, CIE validity rules)
//   check   - read by OCR but not independently confirmed; the user should look at it
//   missing - could not be read
const comuniDb = require('./comuni');
const cf = require('./cf');
const { parseMrz, coerce } = require('./mrz');
const { findResidence } = require('./address');

const { norm, similarity } = comuniDb;

function lines(texts) {
  return texts.flatMap((t) => String(t || '').split('\n')).map((l) => l.trim()).filter(Boolean);
}

function vote(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked.length ? { value: ranked[0][0], votes: ranked[0][1] } : null;
}

const parseDate = (s) => {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 ? d : null;
};

// The MRZ drops accents and apostrophes (D'ANGELO -> DANGELO, NICOLÒ -> NICOLO). If the front shows
// the same letters with an accent or apostrophe, use that spelling; word spacing stays as in the MRZ.
function restoreSpelling(mrzValue, frontLines) {
  const key = norm(mrzValue);
  const found = [];
  for (const line of frontLines) {
    const words = line.toUpperCase().replace(/[^A-ZÀ-Ý' ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 1; j <= Math.min(words.length, i + 4); j++) {
        const cand = words.slice(i, j).join(' ');
        if (norm(cand) === key && /[À-Ý']/.test(cand)) found.push(cand);
      }
    }
  }
  const best = vote(found);
  if (!best) return mrzValue;
  // Re-apply the accented letters / apostrophes onto the MRZ spacing.
  const marked = best.value.replace(/ /g, '');
  let out = '';
  let k = 0;
  for (const ch of mrzValue) {
    if (ch === ' ') {
      out += ' ';
      continue;
    }
    while (marked[k] === "'") out += marked[k++];
    out += marked[k++] || ch;
  }
  return out;
}

// Dates on the front written DD.MM.YYYY (tolerating common digit misreads).
function frontDates(frontLines) {
  const out = [];
  for (const line of frontLines) {
    for (const m of line.toUpperCase().matchAll(/([0-9OISLB]{2})[.,]([0-9OISLB]{2})[.,]([0-9OISLB]{4})/g)) {
      const fixed = coerce(m[1] + m[2] + m[3], 'DDDDDDDD');
      if (!fixed) continue;
      const s = `${fixed.slice(0, 2)}/${fixed.slice(2, 4)}/${fixed.slice(4)}`;
      if (parseDate(s)) out.push(s);
    }
  }
  return out;
}

// A CIE is valid for 3, 5 or 10 years and expires on a birthday of the holder, which on real cards
// falls up to a year before or after that anniversary of the issue date.
function issueDateFits(issue, birth, expiry) {
  const i = parseDate(issue);
  const b = parseDate(birth);
  const e = parseDate(expiry);
  if (!i || !b || !e || i >= e || i <= b || i > new Date()) return false;
  const yearMs = 366 * 24 * 3600 * 1000;
  return [3, 5, 10].some((n) => {
    const anniversary = new Date(i.getFullYear() + n, i.getMonth(), i.getDate());
    return Math.abs(e - anniversary) < yearMs;
  });
}

// Best comune found in a line of OCR text (tries runs of up to 4 words, ignoring noise around it).
// The preferred comune (the residence) gets a bonus: the card is almost always issued there.
// Longer names win ties, so "FIANO ROMANO" beats "FIANO".
function comuneInLine(line, preferred) {
  const words = line.toUpperCase().replace(/[^A-ZÀ-Ý' -]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
  let best = null;
  const consider = (comune, score) => {
    const rank = score + (preferred && comune === preferred ? 0.1 : 0) + comune.key.length * 0.001;
    if (!best || rank > best.rank) best = { comune, score, rank };
  };
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j <= Math.min(words.length, i + 4); j++) {
      const cand = words.slice(i, j).join(' ');
      if (norm(cand).length < 3) continue;
      if (preferred) {
        const s = similarity(norm(cand), preferred.key);
        if (s >= 0.8) consider(preferred, s);
      }
      const m = comuniDb.bestMatch(cand, { minScore: 0.9 });
      if (m) consider(m.comune, m.score);
    }
  }
  return best;
}

function extractCard(front, back, settings = {}) {
  const fields = {};
  const status = {};
  const notes = [];
  const set = (k, v, s) => {
    fields[k] = v || '';
    status[k] = v ? s : 'missing';
  };

  const frontTexts = (front && front.texts) || [];
  const frontLines = lines(frontTexts);
  const backInfo = (back && back.infoTexts) || [];
  const mrz = back ? parseMrz(back.mrzTexts || []) : null;

  // --- MRZ: document number, dates, sex, names --------------------------------------------
  const frontDocNos = frontLines
    .flatMap((l) => [...l.toUpperCase().replace(/\s/g, '').matchAll(/C[A4][0-9OIZSB]{5}[A-Z0-9]{2}/g)].map((m) => m[0]))
    .map((s) => coerce(s, 'LLDDDDDLL'))
    .filter(Boolean);
  if (mrz && mrz.documentNumber) set('document_number', mrz.documentNumber, 'ok');
  else {
    const v = vote(frontDocNos);
    set('document_number', v && v.value, 'check');
  }

  set('birth_date', mrz && mrz.birthDate, 'ok');
  set('expiry_date', mrz && mrz.expiryDate, 'ok');
  set('sex', mrz && mrz.sex, 'ok');

  const nameStatus = mrz && mrz.confirmed.names ? 'ok' : 'check';
  set('surname', mrz && mrz.surname && restoreSpelling(mrz.surname, frontLines), nameStatus);
  set('name', mrz && mrz.name && restoreSpelling(mrz.name, frontLines), nameStatus);
  if (!mrz) notes.push('MRZ (the 3 lines at the bottom of the back) could not be read');

  // --- Codice Fiscale and birthplace --------------------------------------------------------
  const expected = cf.prefix(fields.surname, fields.name, fields.birth_date, fields.sex);
  const cfCandidates = cf.findInText(backInfo, expected);

  const birthTexts = frontLines
    .map((l) => l.toUpperCase().match(/([A-ZÀ-Ý' .-]{2,40}?)\s*[({[]\s*([A-Z0-9]{2})\s*[)}\]]\s*[0-9OIS]{2}[.,]/))
    .filter(Boolean);
  const frontBirth = vote(
    birthTexts
      .map((m) => comuniDb.bestMatch(m[1].replace(/^[^A-Z]*[^A-Z ]\s*/, ''), { minScore: 0.75 }))
      .filter(Boolean)
      .map((m) => m.comune.codiceCatastale)
  );

  let taxId = cfCandidates.length ? cfCandidates[0].cf : '';
  let taxStatus = 'check';
  if (taxId) {
    const agreesWithFront = frontBirth && frontBirth.value === taxId.slice(11, 15);
    // ok when the birthplace code read on the back agrees with the birthplace printed on the front,
    // or when several passes read the full code with a valid check character.
    if (agreesWithFront || cfCandidates[0].score >= 4) taxStatus = 'ok';
    // The front shows a different birthplace whose code gives a valid CF: prefer the one both sides support.
    if (!agreesWithFront && frontBirth) {
      const alt = cfCandidates.find((c) => c.cf.slice(11, 15) === frontBirth.value);
      if (alt) {
        taxId = alt.cf;
        taxStatus = 'ok';
      }
    }
  } else if (expected && frontBirth) {
    const base = expected + frontBirth.value;
    taxId = base + cf.checkChar(base);
    notes.push('Tax ID not readable on the back; computed from the MRZ and the birthplace on the front');
  }
  if (taxId && expected && taxId.slice(0, 11) !== expected) taxStatus = 'check';
  set('tax_id', taxId, taxStatus);

  const birthplace = taxId ? comuniDb.findByBelfiore(taxId.slice(11, 15)) : null;
  if (birthplace) {
    set('birth_comune', birthplace.nome, taxStatus);
    set('birth_province', birthplace.sigla, taxStatus);
    set('nation', 'ITALIA', taxStatus);
  } else {
    if (taxId && taxId[11] === 'Z') notes.push('Born abroad: enter Nation and Comune from the front of the card');
    set('birth_comune', '', 'missing');
    set('birth_province', taxId && taxId[11] === 'Z' ? 'EE' : '', 'check');
    set('nation', '', 'missing');
  }

  // --- Residence ----------------------------------------------------------------------------
  const res = findResidence(backInfo);
  if (res) {
    // ok only for a clean line read the same way by at least 2 passes and no pass disagreeing on the street.
    const clean = res.exactComune && res.hasToponym;
    const s = clean && res.votes >= 2 && res.junk === 0 && res.number && res.unanimous ? 'ok' : 'check';
    set('address', res.street, s);
    set('house_number', res.number, res.number ? s : 'missing');
    set('res_city', res.comune.nome, clean ? 'ok' : 'check');
    set('res_province', res.sigla, clean ? 'ok' : 'check');
    if (res.comune.cap.length === 1) set('cap', res.comune.cap[0], res.exactComune && res.hasToponym ? 'ok' : 'check');
    else {
      set('cap', '', 'missing');
      notes.push(`${res.comune.nome} has several CAPs (${res.comune.cap[0]}–${res.comune.cap.at(-1)}): enter the one for this street`);
    }
  } else {
    for (const k of ['address', 'house_number', 'res_city', 'res_province', 'cap']) set(k, '', 'missing');
    notes.push('Residence address could not be read');
  }

  // --- Issue date ---------------------------------------------------------------------------
  const born = parseDate(fields.birth_date);
  const dates = frontDates(frontLines).filter((d) => {
    const t = parseDate(d);
    return d !== fields.birth_date && d !== fields.expiry_date && t > (born || new Date(1900, 0, 1)) && t <= new Date();
  });
  const fitting = dates.filter((d) => issueDateFits(d, fields.birth_date, fields.expiry_date));
  const issue = vote(fitting) || vote(dates);
  // ok only if every reading that fits the CIE validity rule agrees (8 vs 0 misreads still fit).
  const unanimous = fitting.length >= 2 && new Set(fitting).size === 1;
  set('issue_date', issue && issue.value, unanimous ? 'ok' : 'check');

  // --- Issuing comune -----------------------------------------------------------------------
  const resComune = res && res.comune;
  // The municipality is printed under the "COMUNE DI / MUNICIPALITY" label, above the surname label.
  const issuingVotes = [];
  frontTexts.forEach((text) => {
    const ls = String(text).toUpperCase().split('\n').filter((l) => /[A-Z]{2}/.test(l));
    const label = ls.findIndex((l) => /MU.{0,3}CIP|COMUNE/.test(l));
    const surnameLabel = ls.findIndex((l) => /COGNOME|SURNAME|SUMNAME/.test(l));
    let window = [];
    if (label >= 0) window = ls.slice(label + 1, label + 3);
    else if (surnameLabel > 0) window = ls.slice(Math.max(0, surnameLabel - 2), surnameLabel);
    for (const l of window) {
      const m = comuneInLine(l, resComune);
      if (m) {
        issuingVotes.push(m.comune.nome);
        break;
      }
    }
  });
  const issuing = vote(issuingVotes);
  const issuingOk =
    issuing && new Set(issuingVotes).size === 1 && (issuing.votes >= 2 || (resComune && issuing.value === resComune.nome));
  set('place_of_issue', issuing && issuing.value, issuingOk ? 'ok' : 'check');

  // --- Constants and manual fields ------------------------------------------------------------
  set('document_type', settings.documentType || "Carta d'identità elettronica", 'ok');
  set('issuing_body', settings.issuingBody || 'Comune', 'ok');
  for (const k of ['telephone', 'email', 'password', 'recovery_email']) {
    fields[k] = '';
    status[k] = 'manual';
  }

  return { fields, status, notes };
}

module.exports = { extractCard, issueDateFits };
