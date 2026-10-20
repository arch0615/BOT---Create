// Local OCR for CIE card images: Tesseract.js (offline language data) + Jimp preprocessing.
const path = require('path');
const { Jimp } = require('jimp');
const Tesseract = require('tesseract.js');
const { parseMrz } = require('./mrz');

const MRZ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';
const FRONT_WORDS =
  /REPUBBLICA|MINISTERO|INTERNO|ITALIANA|COGNOME|SURNAME|IDENTIT|EMISSIONE|SCADENZA|MUNICIPALITY|NASCITA|TITOLARE|CITTADINANZA|STATURA/;

function threshold(img, t) {
  const d = img.bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] < t ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  return img;
}

// Crop by fractions of the image, greyscale, scale to `width`, optionally binarise.
async function region(src, { x = 0, y = 0, w = 1, h = 1 }, width, thr) {
  const img = src.clone();
  const W = img.bitmap.width;
  const H = img.bitmap.height;
  img.crop({ x: Math.round(x * W), y: Math.round(y * H), w: Math.round(w * W), h: Math.round(h * H) });
  img.greyscale().resize({ w: width });
  if (thr) threshold(img, thr);
  return img.getBuffer('image/png');
}

class OcrEngine {
  constructor({ langPath = path.join(__dirname, '..', 'tessdata'), cachePath } = {}) {
    this.langPath = langPath;
    this.cachePath = cachePath;
    this.text = null;
    this.mrz = null;
  }

  async init() {
    const opts = { langPath: this.langPath, cachePath: this.cachePath, gzip: true, errorHandler: () => {} };
    [this.text, this.mrz] = await Promise.all([
      Tesseract.createWorker('ita', 1, opts),
      Tesseract.createWorker('mrz', 1, opts),
    ]);
    await this.mrz.setParameters({ tessedit_char_whitelist: MRZ_CHARS, tessedit_pageseg_mode: '6' });
  }

  async terminate() {
    await Promise.all([this.text && this.text.terminate(), this.mrz && this.mrz.terminate()]);
    this.text = this.mrz = null;
  }

  async ocrText(buf, psm) {
    await this.text.setParameters({ tessedit_pageseg_mode: psm });
    return (await this.text.recognize(buf)).data.text;
  }

  async ocrMrz(img, thresholds = [110, 90, 130]) {
    const texts = [];
    for (const t of thresholds) {
      texts.push((await this.mrz.recognize(await region(img, { y: 0.55, h: 0.45 }, 1300, t))).data.text);
    }
    return texts;
  }

  async readBack(img) {
    const mrzTexts = await this.ocrMrz(img, [110, 90, 130]);
    const infoTexts = [];
    for (const t of [120, 140, 100, 0]) {
      infoTexts.push(await this.ocrText(await region(img, { w: 0.8, h: 0.45 }, 2400, t), '6'));
    }
    return { mrzTexts, infoTexts };
  }

  // Automatic page segmentation (PSM 3) often finds no text at all on card photos, so the front is
  // read as one block (PSM 6) and as sparse text (PSM 11), each with and without binarisation.
  async readFront(img, firstText) {
    const texts = [firstText || (await this.ocrText(await region(img, {}, 2000, 0), '6'))];
    texts.push(await this.ocrText(await region(img, {}, 1600, 130), '6'));
    texts.push(await this.ocrText(await region(img, {}, 1600, 0), '11'));
    texts.push(await this.ocrText(await region(img, {}, 2000, 130), '11'));
    return { texts };
  }

  // Reads one image: detects the side (and rotation) and returns the raw OCR texts.
  // A CIE back always has an MRZ; a landscape image without one is taken to be a front.
  async readImage(file) {
    const original = await Jimp.read(file);
    const rotations = [0, 180, 90, 270].filter((deg) => {
      const portrait = original.bitmap.width < original.bitmap.height;
      return portrait ? deg === 90 || deg === 270 : deg === 0 || deg === 180; // cards are landscape
    });

    let fallback = null;
    for (const deg of rotations) {
      const img = deg ? original.clone().rotate(deg) : original;
      const mrz = parseMrz(await this.ocrMrz(img, [110]));
      if (mrz && (mrz.confirmed.dates || mrz.confirmed.documentNumber)) {
        return { side: 'back', rotation: deg, ...(await this.readBack(img)) };
      }
      for (const t of [0, 130]) {
        const text = await this.ocrText(await region(img, {}, 2000, t), '6');
        if (FRONT_WORDS.test(text.toUpperCase())) {
          return { side: 'front', rotation: deg, ...(await this.readFront(img, t ? null : text)) };
        }
      }
      if (!fallback) fallback = { img, deg };
    }
    if (!fallback) return { side: 'unknown', rotation: 0 };
    return { side: 'front', rotation: fallback.deg, uncertain: true, ...(await this.readFront(fallback.img)) };
  }
}

module.exports = { OcrEngine };
