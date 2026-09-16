// mediaText.js
// Text extraction for received documents, so their content lands in the RAG
// memory instead of a "[media] pdf" placeholder.
//   - PDF / docx / plain text: native extraction (pdf-parse, mammoth, fs)
//   - Scanned PDFs: two-pass OCR — a cheap low-DPI pass classifies each page,
//     then only text pages get full-resolution OCR; picture pages go to the
//     vision model (MEDIA_VISION_MODEL, Ollama) for a one-line description
//   - Images: OCR via tesseract.js (opt-in: downloads language data on first use)
//   - Audio/video: not supported (would need a transcription model)

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fetch from 'node-fetch';
import pdfParse from 'pdf-parse/lib/pdf-parse.js'; // lib entry: avoids the package's debug auto-run
import mammoth from 'mammoth';
import { createWorker } from 'tesseract.js';

const execFileAsync = promisify(execFile);

const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.log', '.xml', '.html'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff'];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// Scanned PDFs are rasterized then OCR'd page by page — this bounds the work
const MAX_PDF_OCR_PAGES = parseInt(process.env.MEDIA_PDF_OCR_PAGES || '30', 10);
const PDF_OCR_DPI = parseInt(process.env.MEDIA_PDF_OCR_DPI || '150', 10);
// Quick classification pass: low DPI keeps it several times faster
const PDF_PREVIEW_DPI = parseInt(process.env.MEDIA_PDF_PREVIEW_DPI || '72', 10);
// A page counts as "text" when the quick pass finds at least this many words
const PDF_TEXT_PAGE_WORDS = parseInt(process.env.MEDIA_PDF_TEXT_WORDS || '40', 10);
// Picture pages described by a vision model (Ollama /api/chat) — empty: off
const VISION_MODEL = process.env.MEDIA_VISION_MODEL || '';
const MAX_VISION_PAGES = parseInt(process.env.MEDIA_VISION_PAGES || '12', 10);
// Language data is downloaded on first OCR and cached outside the app dir
const TESSDATA_DIR = path.join(os.tmpdir(), 'tessdata');

// One tesseract worker for any number of images (creating one per page would
// reload the language model each time). Returns one entry per input image
// ('' when nothing was recognized) so callers can keep page alignment.
async function ocrImages(imagePaths, ocrLang) {
  fs.mkdirSync(TESSDATA_DIR, { recursive: true });
  const worker = await createWorker(ocrLang, 1, { cachePath: TESSDATA_DIR });
  try {
    const parts = [];
    for (const imagePath of imagePaths) {
      const { data } = await worker.recognize(imagePath);
      parts.push((data.text || '').trim());
    }
    return parts;
  } finally {
    await worker.terminate();
  }
}

// Render PDF pages to PNGs for the OCR (pdftoppm, poppler-utils). Scanned
// magazines are image pages with a watermark text layer — pdf-parse alone
// only sees the watermark. `dpi` trades speed for detail.
async function rasterizePdfPages(filePath, dpi = PDF_OCR_DPI) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-ocr-'));
  try {
    await execFileAsync('pdftoppm', ['-png', '-r', String(dpi), filePath, path.join(tmpDir, 'page')]);
    const pages = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.png'))
      .sort((a, b) => parseInt(a.match(/(\d+)\.png$/)?.[1] || '0', 10) - parseInt(b.match(/(\d+)\.png$/)?.[1] || '0', 10))
      .slice(0, MAX_PDF_OCR_PAGES)
      .map(f => path.join(tmpDir, f));
    return { tmpDir, pages };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

// Render a single page at full resolution (pdftoppm -f/-l page range)
async function rasterizePdfPage(filePath, pageNumber, dpi = PDF_OCR_DPI) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-ocr-page-'));
  try {
    await execFileAsync('pdftoppm', ['-png', '-r', String(dpi), '-f', String(pageNumber), '-l', String(pageNumber), filePath, path.join(tmpDir, 'page')]);
    const png = fs.readdirSync(tmpDir).find(f => f.endsWith('.png'));
    if (!png) throw new Error(`pdftoppm produced no image for page ${pageNumber}`);
    return { tmpDir, pagePath: path.join(tmpDir, png) };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

// Words of 2+ real characters — ads/graph pages yield mostly punctuation noise
export function countRealWords(text) {
  return (text.match(/[A-Za-zÀ-ÿ0-9]{2,}/g) || []).length;
}

// Split quick-pass results into text pages (worth a full-res OCR) and picture
// pages (better served by an image description than by OCR noise)
export function classifyPages(pageTexts, minWords = PDF_TEXT_PAGE_WORDS) {
  const textPages = [];
  const imagePages = [];
  (pageTexts || []).forEach((text, i) => {
    (countRealWords(text) >= minWords ? textPages : imagePages).push(i);
  });
  return { textPages, imagePages };
}

// One-line description of a picture page through a vision model (Ollama chat
// API with base64 images). Returns '' when no model is configured.
async function describeImage(imagePath) {
  if (!VISION_MODEL) return '';
  const visionUrl = process.env.VISION_URL || process.env.LLM_URL || 'http://localhost:11434/api/chat';
  const response = await fetch(visionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      stream: false,
      messages: [{
        role: 'user',
        content: 'Décris cette page de document en une ou deux phrases utiles pour une recherche : sujet, type de contenu (photo, publicité, graphique…), titres ou texte visible.',
        images: [fs.readFileSync(imagePath).toString('base64')]
      }]
    })
  });
  if (!response.ok) throw new Error(`Vision API error (${response.status})`);
  const data = await response.json();
  return (data.message?.content || '').trim();
}

/**
 * Extract the readable text of a downloaded media file.
 * @param {string} filePath
 * @param {{ocrEnabled?: boolean, ocrLang?: string}} [opts]
 * @returns {Promise<{text: string, kind: string}>} kind explains why text may be empty
 */
export async function extractTextFromFile(filePath, { ocrEnabled = false, ocrLang = 'eng+fra' } = {}) {
  if (!fs.existsSync(filePath)) return { text: '', kind: 'missing' };
  if (fs.statSync(filePath).size > MAX_FILE_BYTES) return { text: '', kind: 'too-large' };

  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === '.pdf') {
      const pdf = await pdfParse(fs.readFileSync(filePath));
      let text = (pdf.text || '').trim();
      let kind = text ? 'pdf' : 'pdf-no-text';
      // Image-only pages (scanned magazine): the text layer holds just the
      // watermark — run the two-pass OCR. Pass 1 (low DPI) classifies pages;
      // pass 2 OCRs only the text pages at full resolution and describes the
      // picture pages with the vision model instead of OCR-ing them.
      const sparse = text.length < (pdf.numpages || 1) * 20;
      if (sparse && ocrEnabled) {
        const quick = await rasterizePdfPages(filePath, PDF_PREVIEW_DPI);
        try {
          const quickTexts = await ocrImages(quick.pages, ocrLang);
          const { textPages, imagePages } = classifyPages(quickTexts);

          const pageParts = [];
          for (const i of textPages) {
            const full = await rasterizePdfPage(filePath, i + 1);
            try {
              const [pageText] = await ocrImages([full.pagePath], ocrLang);
              if (pageText) pageParts.push(`[page ${i + 1}] ${pageText}`);
            } finally {
              fs.rmSync(full.tmpDir, { recursive: true, force: true });
            }
          }

          let described = 0;
          for (const i of imagePages.slice(0, MAX_VISION_PAGES)) {
            try {
              const description = await describeImage(quick.pages[i]);
              if (description) {
                pageParts.push(`[page ${i + 1} — image] ${description}`);
                described++;
              }
            } catch (err) {
              console.error(`❌ Vision description failed for page ${i + 1}:`, err.message);
            }
          }

          const ocrText = pageParts.join('\n').trim();
          if (ocrText.length > text.length) {
            text = ocrText;
            kind = described ? 'pdf-ocr+vision' : 'pdf-ocr';
          }
        } finally {
          fs.rmSync(quick.tmpDir, { recursive: true, force: true });
        }
      }
      return { text, kind };
    }
    if (ext === '.docx') {
      const { value } = await mammoth.extractRawText({ path: filePath });
      return { text: (value || '').trim(), kind: 'docx' };
    }
    if (TEXT_EXTENSIONS.includes(ext)) {
      return { text: fs.readFileSync(filePath, 'utf8').trim(), kind: 'text' };
    }
    if (IMAGE_EXTENSIONS.includes(ext)) {
      if (!ocrEnabled) return { text: '', kind: 'image-ocr-disabled' };
      const [text] = await ocrImages([filePath], ocrLang);
      return { text: text || '', kind: 'ocr' };
    }
    return { text: '', kind: 'unsupported' };
  } catch (err) {
    console.error(`❌ Text extraction failed for ${path.basename(filePath)}:`, err.message);
    return { text: '', kind: 'error' };
  }
}

// Sidecar file: the extracted text is saved next to the media as <name>.txt so
// the content stays readable without re-running the (slow) OCR. The header
// records the method — "ocr" kinds mean tesseract, not a native text layer.
export function writeExtractedTextFile(filePath, text, kind) {
  if (!text || !text.trim()) return null;
  const outPath = `${filePath}.txt`;
  const viaOcr = kind === 'pdf-ocr' || kind === 'pdf-ocr+vision' || kind === 'ocr';
  const header = [
    `# Texte extrait de ${path.basename(filePath)}`,
    `# Méthode : ${viaOcr ? `OCR tesseract (${kind})` : kind}`,
    `# Caractères : ${text.length}`,
    '',
  ].join('\n');
  fs.writeFileSync(outPath, `${header}---\n${text}\n`, 'utf8');
  return outPath;
}

/**
 * Split text into overlapping chunks for the vector index.
 * @param {string} text
 * @param {{size?: number, overlap?: number, maxChunks?: number}} [opts]
 * @returns {string[]}
 */
export function chunkText(text, { size = 900, overlap = 150, maxChunks = 60 } = {}) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < maxChunks) {
    chunks.push(clean.slice(start, start + size));
    if (start + size >= clean.length) break;
    start += size - overlap;
  }
  return chunks;
}
