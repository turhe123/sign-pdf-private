// worker.js — PDF work off the main thread with pdf-lib (classic worker).
// Messages in:  { id, type: 'inspect', bytes }  →  { id, type: 'done', pages, encrypted }
//               { id, type: 'sign', bytes, placements, images }  →  progress…, { id, type: 'done', bytes }
// Placements use page-relative fractions of the page *as displayed* (rotation applied, origin top-left).
importScripts('./vendor/pdf-lib/pdf-lib.min.js');

const { PDFDocument, StandardFonts, rgb, degrees } = self.PDFLib;

const normRotation = (angle) => (((Math.round(angle / 90) * 90) % 360) + 360) % 360;

// Map a point given in display points (top-left origin, rotation applied) to PDF user space.
function toPdf(dx, dy, rot, box) {
  const { x: cx, y: cy, width: W, height: H } = box;
  switch (rot) {
    case 90: return { x: cx + dy, y: cy + dx };
    case 180: return { x: cx + W - dx, y: cy + dy };
    case 270: return { x: cx + W - dy, y: cy + H - dx };
    default: return { x: cx + dx, y: cy + H - dy };
  }
}

async function inspect(bytes) {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return { pages: doc.getPageCount(), encrypted: false };
  } catch (err) {
    if (err && (err.name === 'EncryptedPDFError' || /encrypt/i.test(err.message))) return { pages: 0, encrypted: true };
    throw err;
  }
}

async function sign(bytes, placements, images, progress) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  progress(0.15);
  const pages = doc.getPages();
  const embedded = new Map();
  let font = null;
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const page = pages[p.page];
    if (!page) continue;
    const rot = normRotation(page.getRotation().angle);
    const box = page.getCropBox();
    const Dw = rot % 180 ? box.height : box.width;
    const Dh = rot % 180 ? box.width : box.height;
    const dx = p.x * Dw, dy = p.y * Dh, dw = p.w * Dw, dh = p.h * Dh;
    if (p.kind === 'image') {
      let img = embedded.get(p.sigId);
      if (!img) { img = await doc.embedPng(images[p.sigId]); embedded.set(p.sigId, img); }
      // pdf-lib rotates around the anchor, so anchor at the image's displayed bottom-left corner.
      const at = toPdf(dx, dy + dh, rot, box);
      page.drawImage(img, { x: at.x, y: at.y, width: dw, height: dh, rotate: degrees(rot) });
    } else {
      if (!font) font = await doc.embedFont(StandardFonts.Helvetica);
      let size = dh / 1.15;
      const width = font.widthOfTextAtSize(p.text, size);
      if (width > dw * 1.02) size *= dw / width;
      const at = toPdf(dx, dy + size * 0.93, rot, box);
      const [r, g, b] = p.color;
      page.drawText(p.text, { x: at.x, y: at.y, size, font, color: rgb(r, g, b), rotate: degrees(rot) });
    }
    progress(0.15 + 0.6 * ((i + 1) / placements.length));
  }
  const out = await doc.save();
  progress(1);
  return out;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  const progress = (value) => self.postMessage({ id, type: 'progress', value });
  try {
    if (type === 'inspect') {
      const info = await inspect(e.data.bytes);
      self.postMessage({ id, type: 'done', ...info });
    } else if (type === 'sign') {
      const out = await sign(e.data.bytes, e.data.placements, e.data.images, progress);
      self.postMessage({ id, type: 'done', bytes: out }, [out.buffer]);
    } else {
      throw new Error(`Unknown task: ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', name: err && err.name, message: (err && err.message) || String(err) });
  }
};
