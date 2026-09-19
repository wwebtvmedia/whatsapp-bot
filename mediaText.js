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
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

const execFileAsync = promisify(execFile);

const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.log', '.xml', '.html'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff'];
const MAX_FILE_BYTES = parseInt(process.env.MEDIA_MAX_FILE_BYTES || '', 10) || 25 * 1024 * 1024;
// Scanned PDFs are rasterized then OCR'd page by page — this bounds the work
const MAX_PDF_OCR_PAGES = parseInt(process.env.MEDIA_PDF_OCR_PAGES || '30', 10);
// 300 dpi is what newspaper-size body text (8-9pt) needs to come out readable;
// 150 dpi only gets the headlines. Cost: roughly 3-4x slower per page.
const PDF_OCR_DPI = parseInt(process.env.MEDIA_PDF_OCR_DPI || '300', 10);
// Quick classification pass: low DPI keeps it several times faster. 100 dpi
// is the floor where newsprint columns still OCR to ~30+ words per page.
const PDF_PREVIEW_DPI = parseInt(process.env.MEDIA_PDF_PREVIEW_DPI || '100', 10);
// A page counts as "text" when the quick pass finds at least this many words.
// Calibrated on a scanned FT: real text pages score 30-110 at 100 dpi, picture
// pages under 15. Bias towards false positives — re-OCR costs seconds, a
// misclassified article page loses its whole text.
const PDF_TEXT_PAGE_WORDS = parseInt(process.env.MEDIA_PDF_TEXT_WORDS || '20', 10);
// Picture pages described by a vision model (Ollama /api/chat) — empty: off
const VISION_MODEL = process.env.MEDIA_VISION_MODEL || '';
const MAX_VISION_PAGES = parseInt(process.env.MEDIA_VISION_PAGES || '6', 10);
// Vision calls must never hang the ingestion: bounded generation + hard timeout
const VISION_TIMEOUT_MS = parseInt(process.env.MEDIA_VISION_TIMEOUT_MS || '120000', 10);
// Language data is downloaded on first OCR and cached outside the app dir
const TESSDATA_DIR = path.join(os.tmpdir(), 'tessdata');

// One tesseract worker for any number of images (creating one per page would
// reload the language model each time). Returns one entry per input image
// ('' when nothing was recognized) so callers can keep page alignment.
async function ocrImages(imagePaths, ocrLang) {
  fs.mkdirSync(TESSDATA_DIR, { recursive: true });
  const worker = await createWorker(ocrLang, 1, { cachePath: TESSDATA_DIR });
  try {
    // Keep wide spaces so table-ish lines and column gaps survive as-is
    await worker.setParameters({ preserve_interword_spaces: '1' });
    const parts = [];
    for (const imagePath of imagePaths) {
      const { data } = await worker.recognize(imagePath);
      parts.push((formatParagraphs(data.blocks) || data.text || '').trim());
    }
    return parts;
  } finally {
    await worker.terminate();
  }
}

// Rebuild the page the way it was printed. Tesseract often merges narrow
// newspaper columns into wide blocks, so the reconstruction works at LINE
// level: wide lines (headlines, section bars) act as band separators, narrow
// lines are clustered into columns by x-overlap (the gutter), then read
// column by column, top to bottom. Lines close together reform paragraphs.
// Without usable bboxes it falls back to natural block order.
export function formatParagraphs(blocks) {
  if (!Array.isArray(blocks)) return '';
  const lines = [];
  for (const block of blocks) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        const text = (line.text || '').replace(/\s+$/, '');
        if (text) lines.push({ text, bbox: line.bbox || null });
      }
    }
  }
  if (!lines.length) return '';

  const pageWidth = Math.max(...lines.map(l => l.bbox?.[2] || 0));
  const layoutReady = pageWidth > 0 && lines.every(l => Array.isArray(l.bbox) && l.bbox.length >= 4);
  if (!layoutReady) return lines.map(l => l.text).join('\n');

  const wide = lines.filter(l => l.bbox[2] - l.bbox[0] >= pageWidth * 0.55)
    .sort((a, b) => a.bbox[1] - b.bbox[1]);
  const narrow = lines.filter(l => !wide.includes(l));
  const columns = detectColumns(narrow);

  const ordered = [];
  let bandTop = 0;
  for (const separator of wide) {
    // -15px tolerance: columns often start flush under the headline baseline
    ordered.push(...readColumnBands(columns, bandTop - 15, separator.bbox[1]));
    ordered.push(separator);
    bandTop = separator.bbox[3];
  }
  ordered.push(...readColumnBands(columns, bandTop - 15, Infinity));
  return ordered.map(l => l.text).join('\n\n');
}

// Cluster narrow lines into columns: two lines share a column when their
// x-ranges overlap (a gutter means no overlap). Columns keep insertion order.
function detectColumns(lines) {
  const columns = [];
  for (const line of [...lines].sort((a, b) => a.bbox[0] - b.bbox[0])) {
    const column = columns.find(c => line.bbox[0] < c.x1 - 5);
    if (column) {
      column.lines.push(line);
      column.x1 = Math.max(column.x1, line.bbox[2]);
    } else {
      columns.push({ x0: line.bbox[0], x1: line.bbox[2], lines: [line] });
    }
  }
  return columns;
}

// Inside a vertical band, read each column top-down (columns left to right),
// rebuilding paragraphs from the vertical gap between consecutive lines
function readColumnBands(columns, top, bottom) {
  const out = [];
  for (const column of columns) {
    const colLines = column.lines
      .filter(l => l.bbox[1] >= top && l.bbox[1] < bottom)
      .sort((a, b) => a.bbox[1] - b.bbox[1]);
    let paragraph = '';
    let prevBottom = null;
    for (const line of colLines) {
      const [x0, y0, , y1] = line.bbox;
      const lineGapThreshold = (y1 - y0) * 0.9;
      const sameParagraph = prevBottom !== null && y0 - prevBottom <= lineGapThreshold;
      if (sameParagraph) paragraph += ' ' + line.text;
      else {
        if (paragraph) out.push({ text: paragraph });
        paragraph = line.text;
      }
      prevBottom = y1;
    }
    if (paragraph) out.push({ text: paragraph });
  }
  return out;
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

// Split a rasterized page into vertical column bands by finding gutters
// (near-empty pixel columns). Tesseract merges narrow newspaper columns into
// its lines — no post-processing can undo that — so the page must be cut
// BEFORE the OCR: each band is then OCR'd separately, and the text comes out
// column by column. Pages without clear gutters stay whole.
export async function findColumnCuts(pngPath, { whiteRatio = 0.08, minGutterRatio = 0.006, minBandRatio = 0.05 } = {}) {
  const { data, info } = await sharp(pngPath).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const step = height > 1200 ? 2 : 1; // sample every other row: plenty for gutters
  const rows = Math.ceil(height / step);

  const ink = new Float64Array(width);
  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x] < 128) ink[x]++;
    }
  }

  const whiteThreshold = rows * whiteRatio;
  const minGutter = Math.max(6, Math.round(width * minGutterRatio));
  const margin = Math.round(width * 0.05); // never cut inside the page margins

  const cuts = [0];
  let runStart = -1;
  for (let x = margin; x < width - margin; x++) {
    const white = ink[x] <= whiteThreshold;
    if (white && runStart < 0) runStart = x;
    if (runStart >= 0 && (!white || x === width - margin - 1)) {
      if (x - runStart >= minGutter) cuts.push(Math.round((runStart + x) / 2));
      runStart = -1;
    }
  }
  cuts.push(width);

  // keep the cuts that leave bands wide enough to hold a real column, and
  // drop bands that contain no ink at all (page margins misdetected as cuts)
  const bands = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const left = cuts[i];
    const w = cuts[i + 1] - left;
    if (w < width * minBandRatio || w > width * (1 - minBandRatio)) continue;
    let bandInk = 0;
    for (let x = left; x < left + w; x++) bandInk += ink[x];
    if (bandInk > 0) bands.push({ left, width: w });
  }
  // a single band spanning the whole page = no real split
  if (bands.length <= 1) return null;
  return bands;
}

// Cut a page image into its column bands (files alongside the original) and
// return their paths in reading order; null result means "keep whole page".
export async function splitImageColumns(pngPath, bands) {
  const cuts = bands || await findColumnCuts(pngPath);
  if (!cuts) return null;
  const { height } = await sharp(pngPath).metadata();
  const out = [];
  for (let i = 0; i < cuts.length; i++) {
    const outPath = pngPath.replace(/\.png$/i, `-col${i}.png`);
    await sharp(pngPath).extract({ left: cuts[i].left, top: 0, width: cuts[i].width, height })
      .png().toFile(outPath);
    out.push(outPath);
  }
  return out;
}

// Words of 2+ real characters — ads/graph pages yield mostly punctuation noise
export function countRealWords(text) {
  return (text.match(/[A-Za-zÀ-ÿ0-9]{2,}/g) || []).length;
}

// Drop OCR garbage lines (garbled graphic zones, stock tables). A scanned page
// mixes clean article lines and noise, so the filter is per LINE: kept when a
// few 4+ char words are present AND most tokens are not artifacts. Real text
// lines score 0.6+, garbled ones under 0.2.
export function cleanOcrText(text) {
  return (text || '').split('\n')
    .filter(line => {
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (!words.length) return true;
      const real = (line.match(/[A-Za-zÀ-ÿ0-9]{4,}/g) || []).length;
      return real >= 3 && real / words.length >= 0.3;
    })
    .join('\n');
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
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    body: JSON.stringify({
      model: VISION_MODEL,
      stream: false,
      options: { num_predict: 80 },
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

// A table of contents with fewer entries than this is indistinguishable from
// cover-page teasers ("BIG INTERVIEW P.38") — don't split on it.
const TOC_MIN_ENTRIES = 4;

/**
 * Parse a magazine-style table of contents into {title, page} entries.
 * Two line shapes are trusted, everything else is noise:
 *   - explicit page marker: "CONSEIL : BIBORG … 86DB. P.16" / "Titre page 12".
 *     The marker may sit mid-line: pdftotext -layout merges TOC columns, so
 *     "AVEC LES MARQUES »   P.6   (text from the neighbouring column)" is a
 *     valid entry and only the text before the marker is the title.
 *   - dot leaders:          "Titre ........ 12"
 * @param {string} text
 * @param {{maxPage?: number}} [opts] clamp to the real page count
 * @returns {{title: string, page: number}[]}
 */
export function parseTocEntries(text, { maxPage = 999 } = {}) {
  const marker = /(?:\b[Pp]\.|\b[Pp]age\b)\s*(\d{1,3})|[.…·]{3,}\s*(\d{1,3})\s*$/;
  const entries = [];
  const seenPages = new Set();

  for (const rawLine of (text || '').split('\n')) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const match = marker.exec(line);
    if (!match) continue;
    const page = parseInt(match[1] || match[2], 10);
    if (page < 1 || page > maxPage || seenPages.has(page)) continue;

    const title = line.slice(0, match.index)
      // strip trailing dot leaders and dashes, but keep a sentence-ending dot
      .replace(/(?:[.…·]{2,}|[—–-])+\s*$/, '')
      .trim();
    // titles that are just a number or too short are usually page furniture
    if (title.length < 4 || /^\d+$/.test(title)) continue;

    seenPages.add(page);
    entries.push({ title, page });
  }

  // a real table of contents is ordered; tolerate unsorted input, reject chaos
  entries.sort((a, b) => a.page - b.page);
  return entries;
}

/**
 * Give every article at least one chunk, share the rest proportionally to
 * text length, then trim the largest allocations until the budget holds.
 * @param {{text: string}[]} articles
 * @param {number} maxChunks
 * @returns {number[]}
 */
export function allocateChunkBudget(articles, maxChunks) {
  const total = articles.reduce((sum, a) => sum + a.text.length, 0) || 1;
  const budget = articles.map(a => Math.max(1, Math.round(maxChunks * a.text.length / total)));
  let sum = budget.reduce((a, b) => a + b, 0);
  while (sum > maxChunks) {
    const idx = budget.indexOf(Math.max(...budget));
    if (budget[idx] <= 1) break;
    budget[idx]--;
    sum--;
  }
  return budget;
}

/**
 * Split a PDF into its articles using its own table of contents. Returns null
 * when no reliable TOC is found — callers fall back to plain whole-document
 * chunking. Page texts are prefixed with "[page N]" so indexed chunks can
 * quote a page like the OCR path does.
 *
 * The cover page usually carries 2-4 teasers with page numbers ("INTERVIEW
 * P.38") that would wreck a naive parse, so the head pages are scored
 * individually (layout-preserving extraction) and only the page(s) carrying
 * the densest TOC — plus adjacent pages of at least half that density — feed
 * the parser.
 * @param {string} filePath
 * @param {{headPages?: number}} [opts]
 * @returns {Promise<{title: string, startPage: number, endPage: number, text: string}[]|null>}
 */
export async function splitPdfByToc(filePath, { headPages = 6 } = {}) {
  try {
    if (path.extname(filePath).toLowerCase() !== '.pdf' || !fs.existsSync(filePath)) return null;

    // full text in page buckets — the article content itself
    const raw = (await execFileAsync('pdftotext', [filePath, '-'])).stdout;
    const pages = raw.split('\f').map(p => p.replace(/\s+$/, ''));
    // pdftotext ends the output with a form feed — the split leaves an empty tail
    if (pages.length > 1 && pages[pages.length - 1] === '') pages.pop();
    const numpages = Math.max(pages.length, 1);

    // layout-preserving extraction of the head pages, scored one page at a time
    const layoutRaw = (await execFileAsync('pdftotext', ['-layout', '-f', '1', '-l', String(headPages), filePath, '-'])).stdout;
    const layoutPages = layoutRaw.split('\f').map(p => p.replace(/\s+$/, ''));
    if (layoutPages.length > 1 && layoutPages[layoutPages.length - 1] === '') layoutPages.pop();
    const perPage = layoutPages.map(t => parseTocEntries(t, { maxPage: numpages }));

    const best = Math.max(...perPage.map(e => e.length), 0);
    if (best < TOC_MIN_ENTRIES) return null;
    // the TOC may span two facing pages; absorb neighbours of half the density
    let lo = perPage.findIndex(e => e.length === best);
    let hi = lo;
    const minKeep = Math.max(2, Math.ceil(best / 2));
    while (lo > 0 && perPage[lo - 1].length >= minKeep) lo--;
    while (hi < perPage.length - 1 && perPage[hi + 1].length >= minKeep) hi++;
    const toc = parseTocEntries(layoutPages.slice(lo, hi + 1).join('\n'), { maxPage: numpages });
    if (toc.length < TOC_MIN_ENTRIES) return null;

    const articles = [];
    for (let i = 0; i < toc.length; i++) {
      const start = toc[i].page;
      const end = (i + 1 < toc.length ? toc[i + 1].page : numpages + 1) - 1;
      if (end < start) continue;
      const text = pages.slice(start - 1, end)
        .map((pageText, j) => `[page ${start + j}] ${pageText}`)
        .join('\n')
        .trim();
      if (text) articles.push({ title: toc[i].title, startPage: start, endPage: end, text });
    }
    return articles.length >= 2 ? articles : null;
  } catch (err) {
    console.error(`❌ TOC split failed for ${path.basename(filePath)}:`, err.message);
    return null;
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
              // columns are cut at the image level: tesseract cannot recover
              // interleaved columns from a whole-page raster
              const bands = await splitImageColumns(full.pagePath);
              const bandTexts = await ocrImages(bands || [full.pagePath], ocrLang);
              const clean = cleanOcrText(bandTexts.filter(Boolean).join('\n\n'));
              if (clean.trim()) pageParts.push(`[page ${i + 1}] ${clean}`);
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
    `# Extracted text from ${path.basename(filePath)}`,
    `# Method: ${viaOcr ? `OCR tesseract (${kind})` : kind}`,
    `# Characters: ${text.length}`,
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
