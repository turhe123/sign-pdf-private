// smoke.spec.js — tool-specific checks for Private PDF Signer, on the fictional fixtures in tests/fixtures/
// (contract.pdf, rotated.pdf, encrypted.pdf and signature.png come from tests/make-fixtures.js).
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

// Count image XObjects per page of a PDF file, using the page's own copy of pdf-lib.
async function imagesPerPage(page, filePath) {
  const b64 = fs.readFileSync(filePath).toString('base64');
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const { PDFDocument, PDFName, PDFDict } = window.PDFLib;
    const doc = await PDFDocument.load(bytes);
    return doc.getPages().map((p) => {
      const xo = p.node.Resources() && p.node.Resources().lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xo) return 0;
      return xo.entries().filter(([, ref]) => {
        const obj = doc.context.lookup(ref);
        return obj && obj.dict && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image';
      }).length;
    });
  }, b64);
}

async function drawScribble(page) {
  const box = await page.locator('#sig-pad').boundingBox();
  const y0 = box.y + box.height * 0.55;
  await page.mouse.move(box.x + 20, y0);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(box.x + 20 + i * ((box.width - 40) / 30), y0 + Math.sin(i / 2) * 30);
  }
  await page.mouse.up();
}

async function openPdf(page, name) {
  await page.setInputFiles('#file-input', fixture(name));
  await expect(page.locator('#viewer')).toBeVisible();
  await expect(page.locator('#page-label')).toContainText('Page 1 of');
}

// Ink pixels (alpha > 0) in a tray image, read back through a canvas.
async function trayInk(page) {
  return page.locator('#tray img').first().evaluate((img) => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let ink = 0, clear = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) ink++; else clear++; }
    return { w: img.naturalWidth, h: img.naturalHeight, ink, clear };
  });
}

async function saveAndGetDownload(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save-pdf')]);
  const file = await download.path();
  return { download, file, bytes: fs.readFileSync(file) };
}

test.describe('Private PDF Signer smoke', () => {
  test('drawing on the signature pad and pressing Use shows a signature preview', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('#tray img')).toHaveCount(0);
    await drawScribble(page);
    await page.click('#use-sig');
    const preview = page.locator('#tray img').first();
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(20);
    const ink = await trayInk(page);
    expect(ink.ink).toBeGreaterThan(50);
    expect(ink.clear, 'exported PNG keeps a transparent background').toBeGreaterThan(0);
    // Cropped to the ink: the scribble spans most of the pad's width but not its full height.
    expect(ink.w / ink.h).toBeGreaterThan(2);
  });

  test('dragging the signature onto page 1 and saving produces a PDF with an embedded image on page 1', async ({ page }) => {
    await page.goto('./');
    await openPdf(page, 'contract.pdf');
    await drawScribble(page);
    await page.click('#use-sig');
    await expect(page.locator('#tray img')).toHaveCount(1);
    // Drag the tray item onto the page…
    await page.locator('.tray__place').first().dragTo(page.locator('#stage'), { targetPosition: { x: 120, y: 160 } });
    const placement = page.locator('.placement--image');
    await expect(placement).toHaveCount(1);
    // …then drag the placed signature to a new spot with the pointer.
    const before = await placement.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 80, { steps: 8 });
    await page.mouse.up();
    const after = await placement.boundingBox();
    expect(after.x - before.x).toBeGreaterThan(40);
    expect(after.y - before.y).toBeGreaterThan(50);
    await expect(page.locator('#placement-count')).toHaveText('1 item on 1 page');

    const { download, bytes, file } = await saveAndGetDownload(page);
    expect(download.suggestedFilename()).toBe('contract_signed.pdf');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(fs.statSync(fixture('contract.pdf')).size);
    const images = await imagesPerPage(page, file);
    expect(images[0]).toBeGreaterThanOrEqual(1);
    expect(images[1]).toBe(0);
    await expect(page.locator('#results .result')).toBeVisible();
    await expect(page.locator('#download-link')).toHaveText('Download contract_signed.pdf');
  });

  test('the saved PDF keeps the same page count as the sample', async ({ page }) => {
    await page.goto('./');
    await openPdf(page, 'sample.pdf');
    const original = await page.evaluate(async (data) => {
      const doc = await window.PDFLib.PDFDocument.load(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      return doc.getPageCount();
    }, fs.readFileSync(fixture('sample.pdf')).toString('base64'));
    expect(original).toBe(2);
    await drawScribble(page);
    await page.click('#use-sig');
    // Sign page 2 and stamp the date there too.
    await page.click('#next-page');
    await expect(page.locator('#page-label')).toHaveText('Page 2 of 2');
    await page.locator('.tray__place').first().click();
    await page.click('#add-date');
    await expect(page.locator('.placement')).toHaveCount(2);
    const { download, file } = await saveAndGetDownload(page);
    expect(download.suggestedFilename()).toBe('sample_signed.pdf');
    const images = await imagesPerPage(page, file);
    expect(images.length).toBe(original);
    expect(images[1]).toBeGreaterThanOrEqual(1);
  });

  test('typed signature mode produces a signature image too', async ({ page }) => {
    await page.goto('./');
    await page.click('#tab-type');
    await expect(page.locator('#panel-type')).toBeVisible();
    await page.fill('#type-name', 'Sam Rivera');
    await page.locator('label.type-style', { hasText: 'Italic' }).click();
    await page.locator('label.check', { hasText: 'Black' }).click();
    await page.click('#use-sig');
    await expect(page.locator('#tray img')).toHaveCount(1);
    const ink = await trayInk(page);
    expect(ink.w).toBeGreaterThan(100);
    expect(ink.ink).toBeGreaterThan(200);
    expect(ink.clear).toBeGreaterThan(0);

    // And it ends up in the PDF.
    await openPdf(page, 'contract.pdf');
    await page.locator('.tray__place').first().click();
    const { file } = await saveAndGetDownload(page);
    expect((await imagesPerPage(page, file))[0]).toBeGreaterThanOrEqual(1);
  });

  test('works with touch at 390px wide', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, acceptDownloads: true });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const touchDrag = async (points) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] });
      for (const p of points.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await page.goto('./');
    await openPdf(page, 'contract.pdf');
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(1);

    // Draw with a finger: the page must not scroll while drawing.
    await page.locator('#sig-pad').scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const pad = await page.locator('#sig-pad').boundingBox();
    const pts = [];
    for (let i = 0; i <= 24; i++) pts.push({ x: pad.x + 20 + i * ((pad.width - 40) / 24), y: pad.y + pad.height * 0.5 + Math.sin(i / 2) * 25 + i });
    await touchDrag(pts);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    // The pad backing store is scaled by devicePixelRatio.
    const padPx = await page.locator('#sig-pad').evaluate((c) => c.width / c.getBoundingClientRect().width);
    expect(padPx).toBeCloseTo(2, 1);
    await page.locator('#use-sig').tap();
    await expect(page.locator('#tray img')).toHaveCount(1);

    // Tap the tray item to place it, then drag it with a finger.
    await page.locator('.tray__place').first().tap();
    const placement = page.locator('.placement--image');
    await expect(placement).toHaveCount(1);
    await placement.scrollIntoViewIfNeeded();
    const b = await placement.boundingBox();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    await touchDrag([{ x: cx, y: cy }, { x: cx - 20, y: cy + 10 }, { x: cx - 40, y: cy + 30 }, { x: cx - 50, y: cy + 40 }]);
    const moved = await placement.boundingBox();
    expect(b.x - moved.x).toBeGreaterThan(30);
    expect(moved.y - b.y).toBeGreaterThan(25);

    // Resize with the corner handle.
    const handle = await placement.locator('.placement__handle').boundingBox();
    const hx = handle.x + handle.width / 2, hy = handle.y + handle.height / 2;
    await touchDrag([{ x: hx, y: hy }, { x: hx + 15, y: hy }, { x: hx + 30, y: hy }]);
    expect((await placement.boundingBox()).width).toBeGreaterThan(moved.width + 15);

    expect(await overflow()).toBeLessThanOrEqual(1);
    await page.locator('#save-pdf').scrollIntoViewIfNeeded();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#save-pdf').tap()]);
    expect(download.suggestedFilename()).toBe('contract_signed.pdf');
    const images = await imagesPerPage(page, await download.path());
    expect(images).toHaveLength(2);
    expect(images[0]).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#download-link')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(1);
    await context.close();
  });

  test('rotated pages: the signature lands where it was placed', async ({ page }) => {
    await page.goto('./');
    await openPdf(page, 'rotated.pdf');
    // /Rotate 90 on a portrait page shows as landscape.
    const aspect = await page.locator('#stage').evaluate((s) => s.clientWidth / s.clientHeight);
    expect(aspect).toBeGreaterThan(1.2);
    await page.click('#tab-upload');
    await page.setInputFiles('#sig-upload', fixture('signature.png'));
    await expect(page.locator('#upload-preview')).toBeVisible();
    await page.click('#use-sig');
    await page.locator('.tray__place').first().click();
    // Move it to the top-left area with Shift+arrow nudges (10 pt each).
    const placement = page.locator('.placement--image');
    await placement.focus();
    for (let i = 0; i < 40; i++) await page.keyboard.press('Shift+ArrowLeft');
    for (let i = 0; i < 40; i++) await page.keyboard.press('Shift+ArrowUp');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown');
    const stageBox = await page.locator('#stage').boundingBox();
    const pb = await placement.boundingBox();
    const region = { x: (pb.x - stageBox.x) / stageBox.width, y: (pb.y - stageBox.y) / stageBox.height, w: pb.width / stageBox.width, h: pb.height / stageBox.height };
    expect(region.x).toBeLessThan(0.1);
    expect(region.y).toBeLessThan(0.15);
    const { file } = await saveAndGetDownload(page);

    // Re-open the signed file in the tool and look for the blue ink on the rendered page.
    await page.setInputFiles('#file-input', file);
    await expect(page.locator('.placement')).toHaveCount(0);
    await expect.poll(async () => page.locator('#page-canvas').evaluate((c, r) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let inside = 0, outside = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (!(d[i + 2] > 110 && d[i + 2] - d[i] > 60)) continue;
          const fx = x / c.width, fy = y / c.height;
          if (fx >= r.x - 0.01 && fx <= r.x + r.w + 0.01 && fy >= r.y - 0.01 && fy <= r.y + r.h + 0.01) inside++; else outside++;
        }
      }
      return inside > 200 && outside < inside * 0.05;
    }, region)).toBe(true);
  });

  test('keyboard: Delete removes a placement and the date stamp is written as text', async ({ page }) => {
    await page.goto('./');
    await openPdf(page, 'contract.pdf');
    await page.click('#add-date');
    const date = page.locator('.placement--text');
    await expect(date).toHaveCount(1);
    await expect(date).toBeFocused();
    await expect(date.locator('text')).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
    await page.click('#add-date');
    await expect(date).toHaveCount(2);
    await page.keyboard.press('Delete');
    await expect(date).toHaveCount(1);
    const { file } = await saveAndGetDownload(page);
    const text = await page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const doc = await window.PDFLib.PDFDocument.load(bytes);
      const fonts = doc.getPage(0).node.Resources().lookup(window.PDFLib.PDFName.of('Font'));
      return fonts.entries().map(([, ref]) => String(doc.context.lookup(ref).get(window.PDFLib.PDFName.of('BaseFont'))));
    }, fs.readFileSync(file).toString('base64'));
    expect(text).toContain('/Helvetica');
  });

  test('rejects wrong file types, also when mixed with a PDF, and encrypted PDFs', async ({ page }) => {
    await page.goto('./');
    await page.setInputFiles('#file-input', fixture('sample.png'));
    await expect(page.locator('#results .alert--error')).toContainText('is not a PDF');
    await expect(page.locator('#viewer')).toBeHidden();

    await page.locator('#file-input').evaluate((el) => el.setAttribute('multiple', ''));
    await page.setInputFiles('#file-input', [fixture('sample.txt'), fixture('contract.pdf')]);
    await expect(page.locator('#viewer')).toBeVisible();
    await expect(page.locator('#results .alert--error')).toContainText('Skipped "sample.txt"');

    await page.setInputFiles('#file-input', fixture('encrypted.pdf'));
    await expect(page.locator('#results .alert--error')).toContainText('encrypted or password-protected');
  });

  test('saving with nothing placed shows an error, and Use with an empty pad too', async ({ page }) => {
    await page.goto('./');
    await page.click('#use-sig');
    await expect(page.locator('#results .alert--error')).toContainText('Draw your signature');
    await openPdf(page, 'contract.pdf');
    await page.click('#save-pdf');
    await expect(page.locator('#results .alert--error')).toContainText('Place a signature');
  });

  test('remember on this device is off by default and restores the signature when on', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('#remember')).not.toBeChecked();
    await drawScribble(page);
    await page.click('#use-sig');
    expect(await page.evaluate(() => localStorage.getItem('sign-pdf-private:signature'))).toBeNull();
    await page.check('#remember');
    await page.reload();
    await expect(page.locator('#remember')).toBeChecked();
    await expect(page.locator('#tray img')).toHaveCount(1);
    await page.uncheck('#remember');
    expect(await page.evaluate(() => localStorage.getItem('sign-pdf-private:signature'))).toBeNull();
  });

  test('__demo signs the fictional contract on page 2', async ({ page }) => {
    await page.goto('./');
    await page.evaluate(() => window.__demo());
    await expect(page.locator('#page-label')).toHaveText('Page 2 of 2');
    await expect(page.locator('.placement')).toHaveCount(2);
    await expect(page.locator('#download-link')).toHaveText('Download contract_signed.pdf');
  });
});
