# CIE Reader

Desktop app (Windows) that reads Italian electronic ID cards (Carta d'Identità Elettronica) from
photos or scans and exports the holder's data as CSV for the form bot. All OCR runs locally; no
image or data leaves the computer.

## Using the app

1. Install with `dist\CIE Reader Setup 1.0.0.exe`, or run from source with `npm start`.
2. Drop the card images (front and back, any order, or a whole folder) on the window.
   Fronts and backs are paired by content (document number, name and dates), not by file name.
3. Go through the cards in the **To check** list. Fields are coloured:
   - no colour: confirmed by a cross-check (MRZ check digits, Codice Fiscale, ISTAT list of comuni)
   - amber **Check**: read by OCR but not confirmed; compare with the image (click it to enlarge)
   - red **Missing**/error: empty or invalid; must be filled in
   Click **Mark as reviewed** when the card matches the images. Add the telephone number by hand.
   Or switch to **Table** (top right): one row per card, every field editable in place, with the same
   colours (hover a cell for the reason). Enter moves down a column; the picture button opens the card
   with its images; tick **Reviewed** per row.
4. **Export CSV**. Cards that are not yet reviewed are exported with Status `NEEDS REVIEW`.

Settings (gear icon): the Document type and Issuing body values written for every card.

Telephone, Email, Password and Recovery email are entered by hand (in the table or the card form).
The Email is created automatically when a card is extracted: the holder's name plus 5 random digits,
e.g. `marco.branchetti48213@libero.it`. Domain (default `libero.it`) and username format
(name.surname, namesurname, surname.name, n.surname) are in Settings; changing them updates all
generated addresses, keeping their digits. Correcting the name or surname updates the address too.
*New address* (next to Email in the card form) keeps the name and rolls new digits, e.g. when the
address is already taken. Addresses are unique within the list; an address you typed yourself is
never replaced; clearing the Email cell regenerates it. Only the address text is created, not the
mailbox.
The password is masked except while its cell is being edited.

**Account defaults** (Settings): a Default password and a Default recovery email are applied to every
card (grey bar, tag *Default*). Typing a value on a card overrides the default for that card only;
clearing the cell puts the card back on the default. Changing a default updates every card still on it.

The list and your edits are saved automatically in `%APPDATA%\CIE Reader\session.json`.
That file contains personal data; **Remove all cards** clears it. Passwords in it are encrypted with
the Windows account's key (DPAPI), so they can only be read by the same user on the same PC.
The **exported CSV contains passwords in plain text** (the form bot needs them): store it carefully
and delete it when no longer needed.

## How fields are obtained

| Field | Source |
|---|---|
| Document number, birthday, expiry, gender, names | MRZ on the back (ICAO check digits) |
| Accents / apostrophes in names | Front text (the MRZ drops them) |
| Tax ID | First 11 characters computed from the MRZ; birthplace code + check character read on the back |
| Birthplace (nation, province, comune) | Birthplace code in the Tax ID, cross-checked with the front |
| Residence, house number | Back, residence line, matched to the ISTAT list of comuni |
| CAP | ISTAT/CAP list for the comune of residence (comuni with several CAPs must be entered by hand) |
| Place of issue | Front, "COMUNE DI" line |
| Issue date | Front; checked against the CIE validity rule (3/5/10 years, ending on a birthday) |

## Development

```
npm install
npm start            # run the app
npm test             # accuracy test against the hand-checked sample cards (cards.json)
npm test -- --fresh  # same, re-running OCR instead of using test/.ocr-cache.json
npm run dist         # build the Windows installer into dist/
```

When running from a VS Code terminal, unset `ELECTRON_RUN_AS_NODE` first, or Electron starts as plain Node.

`CIE_SMOKE=<folder> npm start` processes a folder in a throw-away session, saves screenshots and the CSV
to `%TEMP%\cie-reader-smoke\smoke`, and quits.

Code layout: `lib/ocr.js` (Tesseract + preprocessing), `lib/mrz.js`, `lib/cf.js`, `lib/address.js`,
`lib/extract.js` (combines the sources and sets each field's status), `lib/record.js` (validation, CSV),
`main.js` / `preload.js` / `renderer/` (Electron app).

## Third-party data

- `tessdata/ita`, `tessdata/eng`: Tesseract language data (Apache-2.0).
- `tessdata/mrz`: MRZ model by DoubangoTelecom/tesseractMRZ (BSD-3-Clause, `licenses/`).
- `data/comuni.json`: matteocontrini/comuni-json. Comuni from ISTAT (CC BY 3.0 IT); the CAP data has
  no stated licence (`licenses/comuni-json-LICENSE.md`).
