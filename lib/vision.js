const fs = require('fs');
const path = require('path');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function imageToBase64(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase().replace('jpg', 'jpeg');
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

async function extractWithVision(apiKey, frontPath, backPath) {
  const images = [];
  if (frontPath) images.push({ type: 'image_url', image_url: { url: imageToBase64(frontPath), detail: 'high' } });
  if (backPath) images.push({ type: 'image_url', image_url: { url: imageToBase64(backPath), detail: 'high' } });
  if (!images.length) return null;

  const prompt = `You are an expert at reading Italian Carta d'Identità Elettronica (CIE) ID cards.
Extract ALL of the following fields from the card image(s). Read carefully — accuracy is critical.

Return ONLY a JSON object with these exact keys (use empty string "" if a field cannot be read):
{
  "surname": "holder's surname (COGNOME), preserve accents and apostrophes",
  "name": "holder's first name (NOME), preserve accents and apostrophes",
  "birth_date": "date of birth in DD/MM/YYYY format",
  "sex": "M or F",
  "birth_comune": "municipality of birth (Luogo di nascita)",
  "birth_province": "2-letter province code for birthplace",
  "nation": "nationality, usually ITALIA",
  "tax_id": "Codice Fiscale (16 characters, alphanumeric)",
  "res_city": "municipality of residence (Comune di residenza)",
  "res_province": "2-letter province code for residence",
  "address": "street name with toponym (e.g. VIA ROMA, PIAZZA GARIBALDI)",
  "house_number": "house/civic number",
  "cap": "5-digit postal code (CAP)",
  "document_number": "CIE document number (e.g. CA12345AB)",
  "issue_date": "date of issue in DD/MM/YYYY format",
  "expiry_date": "expiry date in DD/MM/YYYY format",
  "place_of_issue": "municipality that issued the card"
}

Rules:
- All dates must be DD/MM/YYYY format
- Names should be UPPERCASE with accents preserved (e.g. D'ANGELO, NICOLÒ)
- Document number format: 2 letters + 5 digits + 2 letters (e.g. CA00000AA)
- Read the MRZ (3 lines of machine-readable text on the back) to cross-check names and dates
- The Codice Fiscale is 16 chars printed on the back
- Return ONLY the JSON, no explanation`;

  const body = {
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...images,
        ],
      },
    ],
    max_tokens: 1000,
    temperature: 0,
  };

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.choices[0].message.content.trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('OpenAI returned no JSON');

  return JSON.parse(jsonMatch[0]);
}

module.exports = { extractWithVision };
