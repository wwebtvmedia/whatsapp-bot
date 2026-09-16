// mediaText.js
// Text extraction for received documents, so their content lands in the RAG
// memory instead of a "[media] pdf" placeholder.
//   - PDF / docx / plain text: native extraction (pdf-parse, mammoth, fs)
//   - Images: OCR via tesseract.js (opt-in: downloads language data on first use)
//   - Audio/video: not supported (would need a transcription model)

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
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
// Language data is downloaded on first OCR and cached outside the app dir
const TESSDATA_DIR = path.join(os.tmpdir(), 'tessdata');

// One tesseract worker for any number of images (creating one per page would
// reload the language model each time)
async function ocrImages(imagePaths, ocrLang) {
  fs.mkdirSync(TESSDATA_DIR, { recursive: true });
  const worker = await createWorker(ocrLang, 1, { cachePath: TESSDATA_DIR });
  try {
    const parts = [];
    for (const imagePath of imagePaths) {
      const { data } = await worker.recognize(imagePath);
      const text = (data.text || '').trim();
      if (text) parts.push(text);
    }
    return parts;
  } finally {
    await worker.terminate();
  }
}

// Render PDF pages to PNGs for the OCR (pdftoppm, poppler-utils). Scanned
// magazines are image pages with a watermark text layer — pdf-parse alone
// only sees the watermark.
async function rasterizePdfPages(filePath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-ocr-'));
  try {
    await execFileAsync('pdftoppm', ['-png', '-r', String(PDF_OCR_DPI), filePath, path.join(tmpDir, 'page')]);
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
      // watermark — rasterize the pages and OCR them (same engine as images)
      const sparse = text.length < (pdf.numpages || 1) * 20;
      if (sparse && ocrEnabled) {
        const { tmpDir, pages } = await rasterizePdfPages(filePath);
        try {
          const pageTexts = await ocrImages(pages, ocrLang);
          const ocrText = pageTexts.map((t, i) => `[page ${i + 1}] ${t}`).join('\n').trim();
          if (ocrText.length > text.length) {
            text = ocrText;
            kind = 'pdf-ocr';
          }
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
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
