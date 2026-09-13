// mediaText.js
// Text extraction for received documents, so their content lands in the RAG
// memory instead of a "[media] pdf" placeholder.
//   - PDF / docx / plain text: native extraction (pdf-parse, mammoth, fs)
//   - Images: OCR via tesseract.js (opt-in: downloads language data on first use)
//   - Audio/video: not supported (would need a transcription model)

import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse/lib/pdf-parse.js'; // lib entry: avoids the package's debug auto-run
import mammoth from 'mammoth';
import { createWorker } from 'tesseract.js';

const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.log', '.xml', '.html'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff'];
const MAX_FILE_BYTES = 25 * 1024 * 1024;

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
      const text = (pdf.text || '').trim();
      return { text, kind: text ? 'pdf' : 'pdf-no-text' }; // pdf-no-text: scanned PDF, rasterization out of scope
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
      const worker = await createWorker(ocrLang);
      try {
        const { data } = await worker.recognize(filePath);
        return { text: (data.text || '').trim(), kind: 'ocr' };
      } finally {
        await worker.terminate();
      }
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
