// make-fixtures.js — generates the small, fictional fixtures used by __demo and smoke.spec.js.
//   node tests/make-fixtures.js
// Uses only Node built-ins and the vendored pdf-lib. All names and text are invented.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, StandardFonts, rgb, degrees } = require('../vendor/pdf-lib/pdf-lib.min.js');

const out = (name) => path.join(__dirname, 'fixtures', name);

async function contract() {
  const doc = await PDFDocument.create();
  doc.setTitle('Service Contract (demo)');
  doc.setAuthor('Harbor Legal Demo');
  doc.setProducer('Private PDF Signer fixtures');
  doc.setCreator('Private PDF Signer fixtures');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.11, 0.14);
  const grey = rgb(0.45, 0.47, 0.52);

  const write = (page, lines, y, size = 11, gap = 16) => {
    for (const line of lines) { page.drawText(line, { x: 72, y, size, font, color: ink }); y -= gap; }
    return y;
  };
  const heading = (page, text, y) => { page.drawText(text, { x: 72, y, size: 13, font: bold, color: ink }); return y - 22; };

  // Page 1
  let p = doc.addPage([612, 792]);
  p.drawText('SERVICE CONTRACT', { x: 72, y: 712, size: 22, font: bold, color: ink });
  p.drawText('Demo document for testing only. Not a real agreement.', { x: 72, y: 690, size: 10, font, color: grey });
  let y = 650;
  y = write(p, [
    'This Service Contract is made between Harbor Legal Demo ("Client")',
    'and Sam Rivera, an independent freelancer ("Contractor").',
  ], y);
  y -= 14;
  y = heading(p, '1. Services', y);
  y = write(p, [
    'The Contractor will design and deliver a set of sample illustrations',
    'for the Client\'s fictional newsletter, as described in Schedule A.',
  ], y);
  y -= 14;
  y = heading(p, '2. Fees and payment', y);
  y = write(p, [
    'The Client will pay a flat fee of 1,200.00 in the demo currency within',
    '30 days of receiving each invoice. No payment is ever actually due.',
  ], y);
  y -= 14;
  y = heading(p, '3. Term', y);
  write(p, [
    'This contract starts on the date of the last signature below and',
    'ends when the services are delivered or either party ends it in writing.',
  ], y);
  p.drawText('Page 1 of 2', { x: 72, y: 40, size: 9, font, color: grey });

  // Page 2, with the signature lines at the bottom
  p = doc.addPage([612, 792]);
  y = 712;
  y = heading(p, '4. Confidentiality', y);
  y = write(p, [
    'Each party keeps the other party\'s non-public information private',
    'and uses it only to perform this contract.',
  ], y);
  y -= 14;
  y = heading(p, '5. Ownership', y);
  y = write(p, [
    'On full payment, the Client owns the delivered illustrations. The',
    'Contractor may show them in a portfolio unless asked not to.',
  ], y);
  y -= 14;
  y = heading(p, '6. Entire agreement', y);
  write(p, [
    'This document is the whole agreement between the parties and can only',
    'be changed in writing signed by both parties.',
  ], y);

  for (const [x, who] of [[72, 'Harbor Legal Demo (Client)'], [330, 'Sam Rivera (Contractor)']]) {
    p.drawLine({ start: { x, y: 150 }, end: { x: x + 210, y: 150 }, thickness: 0.8, color: ink });
    p.drawText('Signature', { x, y: 136, size: 9, font, color: grey });
    p.drawText(who, { x, y: 122, size: 10, font, color: ink });
    p.drawLine({ start: { x, y: 92 }, end: { x: x + 120, y: 92 }, thickness: 0.8, color: ink });
    p.drawText('Date', { x, y: 78, size: 9, font, color: grey });
  }
  p.drawText('Page 2 of 2', { x: 72, y: 40, size: 9, font, color: grey });
  fs.writeFileSync(out('contract.pdf'), await doc.save());
}

async function rotated() {
  // A portrait page stored with /Rotate 90, so it shows as landscape.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.setRotation(degrees(90));
  p.drawText('Rotated demo page', { x: 300, y: 72, size: 18, font, rotate: degrees(90) });
  fs.writeFileSync(out('rotated.pdf'), await doc.save());
}

function encrypted() {
  // A tiny hand-written PDF whose trailer declares an /Encrypt dictionary.
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    '<< /Filter /Standard /V 1 /R 2 /O (0123456789abcdef0123456789abcdef) /U (0123456789abcdef0123456789abcdef) /P -4 >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(out('encrypted.pdf'), body, 'latin1');
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function signature() {
  // A made-up looping scribble in dark blue ink on a transparent background.
  const W = 480, H = 160;
  const px = Buffer.alloc(W * H * 4);
  const dot = (cx, cy, r) => {
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
      for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const d = Math.hypot(x - cx, y - cy);
        const a = Math.max(0, Math.min(1, r + 0.5 - d));
        if (!a) continue;
        const i = (y * W + x) * 4;
        const prev = px[i + 3] / 255;
        const na = a + prev * (1 - a);
        px[i] = 24; px[i + 1] = 44; px[i + 2] = 140; px[i + 3] = Math.round(na * 255);
      }
    }
  };
  const path = (fn, t0, t1, r) => {
    for (let t = t0; t <= t1; t += 0.0004) { const [x, y] = fn(t); dot(x, y, r); }
  };
  // Main loops
  path((t) => { const u = t * 38; return [40 + 9.4 * u - 20 * Math.sin(u), 84 - (30 - 14 * t) * Math.cos(u) + 8 * Math.sin(t * 7)]; }, 0, 1, 2.4);
  // Underline flourish
  path((t) => [60 + t * 380, 132 - 10 * Math.sin(t * Math.PI) + 4 * t], 0, 1, 1.8);
  // Small cross stroke
  path((t) => [300 + t * 90, 48 + t * 6], 0, 1, 1.8);
  fs.writeFileSync(out('signature.png'), png(W, H, px));
}

(async () => {
  await contract();
  await rotated();
  encrypted();
  signature();
  console.log('fixtures written');
})();
