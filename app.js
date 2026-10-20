// app.js — Private PDF Signer. Everything runs on this device; no network requests except the page's own files.
// pdfjs-dist renders the visible page, pdf-lib (in worker.js) writes the signatures into a copy of the PDF.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const results = $('results');
const emptyNote = $('empty-note');
const viewer = $('viewer');
const stageWrap = $('stage-wrap');
const stage = $('stage');
const pageCanvas = $('page-canvas');
const layer = $('layer');
const pageLabel = $('page-label');
const prevBtn = $('prev-page');
const nextBtn = $('next-page');
const saveBtn = $('save-pdf');
const dateBtn = $('add-date');
const countLabel = $('placement-count');
const tray = $('tray');
const trayEmpty = $('tray-empty');
const rememberBox = $('remember');

const INK = { blue: '#1d3fae', black: '#16181d' };
const INK_RGB = { blue: [0x1d / 255, 0x3f / 255, 0xae / 255], black: [0x16 / 255, 0x18 / 255, 0x1d / 255] };
const TYPE_FONTS = {
  script: '400 {px}px "Segoe Script", "Brush Script MT", "Snell Roundhand", "Apple Chancery", "URW Chancery L", cursive',
  hand: '400 {px}px "Bradley Hand", "Lucida Handwriting", "Segoe Print", "Chalkboard SE", "Comic Sans MS", cursive',
  italic: 'italic 400 {px}px "Palatino Linotype", "Book Antiqua", Palatino, Georgia, "Times New Roman", serif',
};
const STORE_KEY = 'sign-pdf-private:signature';
const DATE_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

const state = {
  file: null,        // File
  bytes: null,       // Uint8Array of the original PDF
  pdf: null,         // pdfjs document
  pageCount: 0,
  pageIndex: 0,
  pageDims: [],      // display size in points per page (rotation applied)
  placements: [],    // { id, page, kind: 'image'|'text', x, y, w, h, aspect, sigId?, text?, color? }
  selected: null,
  sigs: new Map(),   // id → { id, bytes, url, width, height }
  trayIds: [],
  resultUrl: null,
};
let uid = 0;
const nextId = (p) => `${p}${++uid}`;

// ---------- Messages ----------
function clearAlerts() { results.querySelectorAll('.alert').forEach((a) => a.remove()); }
function showAlert(message, kind = 'error') {
  const el = document.createElement('div');
  el.className = `alert alert--${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  results.prepend(el);
  el.scrollIntoView({ block: 'nearest' });
  return el;
}
const showError = (m) => showAlert(m, 'error');

// ---------- Worker ----------
let worker = null;
let jobSeq = 0;
const jobs = new Map();
function runJob(type, payload, onProgress) {
  if (!worker) {
    worker = new Worker('./worker.js');
    worker.onmessage = (e) => {
      const job = jobs.get(e.data.id);
      if (!job) return;
      if (e.data.type === 'progress') { job.onProgress?.(e.data.value); return; }
      jobs.delete(e.data.id);
      if (e.data.type === 'done') job.resolve(e.data);
      else { const err = new Error(e.data.message); err.name = e.data.name || 'Error'; job.reject(err); }
    };
    worker.onerror = (e) => {
      for (const job of jobs.values()) job.reject(new Error(e.message || 'The PDF worker stopped unexpectedly.'));
      jobs.clear();
      worker = null;
    };
  }
  const id = ++jobSeq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, ...payload });
  });
}

// ---------- pdf.js ----------
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdfjs-dist/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs-dist/pdf.worker.min.mjs';
      return lib;
    });
  }
  return pdfjsPromise;
}

// ---------- Opening a PDF ----------
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

async function handleFiles(files) {
  clearAlerts();
  // Trust the name or type first; otherwise sniff the header (files saved without an extension).
  const looksPdf = await Promise.all(files.map(async (f) => isPdf(f)
    || (!f.type && (await f.slice(0, 1024).text().catch(() => '')).includes('%PDF-'))));
  const pdfs = files.filter((f, i) => looksPdf[i]);
  const others = files.filter((f, i) => !looksPdf[i]);
  if (others.length) {
    const names = others.map((f) => `"${f.name}"`).join(', ');
    showError(pdfs.length
      ? `Skipped ${names}: not a PDF. Only PDF files can be signed.`
      : `${names} ${others.length > 1 ? 'are not PDFs' : 'is not a PDF'}. Choose a .pdf file to sign.`);
  }
  if (!pdfs.length) return;
  if (pdfs.length > 1) showAlert(`One PDF at a time: opened "${pdfs[0].name}".`, 'ok');
  await openPdf(pdfs[0]);
}

async function openPdf(file) {
  const busy = document.createElement('div');
  busy.className = 'alert loading';
  busy.setAttribute('role', 'status');
  busy.innerHTML = '<span class="spinner" aria-hidden="true"></span> <span></span>';
  busy.lastChild.textContent = `Opening ${file.name}…`;
  results.querySelector('.result-card')?.remove();
  results.append(busy);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    if (!head.includes('%PDF-')) throw Object.assign(new Error('not-pdf'), { name: 'NotPdf' });
    const [lib, info] = await Promise.all([loadPdfjs(), runJob('inspect', { bytes: bytes.slice() })]);
    if (info.encrypted) throw Object.assign(new Error('encrypted'), { name: 'PasswordException' });
    const pdf = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    if (state.pdf) state.pdf.destroy();
    Object.assign(state, {
      file, bytes, pdf, pageCount: pdf.numPages, pageIndex: 0, pageDims: [], placements: [], selected: null,
    });
    $('doc-name').textContent = file.name;
    $('doc-info').textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'} · ${formatBytes(file.size)}`;
    $('out-name').textContent = outputName();
    zone.hidden = true;
    emptyNote.hidden = true;
    viewer.hidden = false;
    lastWidth = 0;
    await renderPage();
    updateCount();
  } catch (err) {
    if (err.name === 'PasswordException' || /password|encrypt/i.test(err.message)) {
      showError(`"${file.name}" is encrypted or password-protected, which is not supported. Remove the protection in the app that created it, then try again.`);
    } else if (err.name === 'NotPdf' || err.name === 'InvalidPDFException') {
      showError(`"${file.name}" does not look like a valid PDF. It may be damaged or a different file type.`);
    } else {
      console.warn(err);
      showError(`Could not open "${file.name}": ${err.message || 'unknown error'}.`);
    }
  } finally {
    busy.remove();
  }
}

function outputName() {
  const base = (state.file?.name || 'document.pdf').replace(/\.pdf$/i, '') || 'document';
  return `${base}_signed.pdf`;
}

// ---------- Rendering the visible page ----------
let renderTask = null;
let renderSeq = 0;
let lastWidth = 0;

async function renderPage() {
  if (!state.pdf) return;
  const seq = ++renderSeq;
  const index = state.pageIndex;
  if (renderTask) { renderTask.cancel(); renderTask = null; }
  const page = await state.pdf.getPage(index + 1);
  if (seq !== renderSeq) return;
  const base = page.getViewport({ scale: 1 });
  state.pageDims[index] = { w: base.width, h: base.height };
  const avail = Math.max(120, stageWrap.clientWidth);
  const maxH = Math.max(420, window.innerHeight - 120);
  const cssW = Math.floor(Math.min(avail, maxH * (base.width / base.height)));
  lastWidth = stageWrap.clientWidth;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const viewport = page.getViewport({ scale: (cssW / base.width) * dpr });
  stage.style.width = `${cssW}px`;
  stage.style.aspectRatio = `${base.width} / ${base.height}`;

  // Render off-screen, then swap in, so the old page doesn't flash blank.
  const off = document.createElement('canvas');
  off.width = Math.floor(viewport.width);
  off.height = Math.floor(viewport.height);
  const ctx = off.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, off.width, off.height);
  renderTask = page.render({ canvasContext: ctx, viewport });
  try {
    await renderTask.promise;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return;
    throw err;
  } finally {
    page.cleanup();
  }
  if (seq !== renderSeq) return;
  renderTask = null;
  pageCanvas.width = off.width;
  pageCanvas.height = off.height;
  pageCanvas.getContext('2d').drawImage(off, 0, 0);
  pageCanvas.setAttribute('aria-label', `Page ${index + 1} of ${state.pageCount}`);
  pageLabel.textContent = `Page ${index + 1} of ${state.pageCount}`;
  prevBtn.disabled = index === 0;
  nextBtn.disabled = index >= state.pageCount - 1;
  stage.dataset.page = String(index + 1);
  renderPlacements();
}

function goToPage(i) {
  if (!state.pdf || i < 0 || i >= state.pageCount || i === state.pageIndex) return;
  state.pageIndex = i;
  state.selected = null;
  renderPage().catch(renderFailed);
}
const renderFailed = (err) => { console.warn(err); showError(`Could not render this page: ${err.message}`); };

prevBtn.addEventListener('click', () => goToPage(state.pageIndex - 1));
nextBtn.addEventListener('click', () => goToPage(state.pageIndex + 1));
$('open-other').addEventListener('click', () => input.click());

new ResizeObserver(() => {
  if (!state.pdf || viewer.hidden) return;
  if (Math.abs(stageWrap.clientWidth - lastWidth) < 4) return;
  clearTimeout(renderPage.t);
  renderPage.t = setTimeout(() => renderPage().catch(renderFailed), 120);
}).observe(stageWrap);

// ---------- Placements ----------
const dims = () => state.pageDims[state.pageIndex] || { w: 612, h: 792 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function fitPlacement(p) {
  p.w = clamp(p.w, 0.02, 1);
  const d = state.pageDims[p.page] || dims();
  p.h = (p.w * d.w) / (p.aspect * d.h);
  if (p.h > 1) { p.h = 1; p.w = (p.aspect * d.h) / d.w; }
  p.x = clamp(p.x, 0, 1 - p.w);
  p.y = clamp(p.y, 0, 1 - p.h);
}

function addPlacement(p, center) {
  if (!state.pdf) {
    showError('Open a PDF first, then click your signature to place it.');
    return null;
  }
  clearAlerts();
  p.id = nextId('p');
  p.page = state.pageIndex;
  fitPlacement(p);
  if (center) {
    p.x = center.x - p.w / 2;
    p.y = center.y - p.h / 2;
  } else {
    // Cascade new placements so they don't stack exactly on top of each other.
    const onPage = state.placements.filter((q) => q.page === p.page).length;
    p.x = 0.5 - p.w / 2 + (onPage % 5) * 0.03;
    p.y = p.y + (onPage % 5) * 0.03;
  }
  fitPlacement(p);
  state.placements.push(p);
  state.selected = p.id;
  renderPlacements();
  updateCount();
  layer.querySelector(`[data-id="${p.id}"]`)?.focus({ preventScroll: true });
  return p;
}

function placeSignature(sigId, center) {
  const sig = state.sigs.get(sigId);
  if (!sig) return null;
  const d = dims();
  const aspect = sig.width / sig.height;
  let w = 0.3;
  if ((w * d.w) / aspect > 0.14 * d.h) w = (0.14 * d.h * aspect) / d.w;
  return addPlacement({ kind: 'image', sigId, aspect, w, x: 0, y: 0.62 }, center);
}

function todayText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let measureCtx = null;
function textAspect(text) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = `100px ${DATE_FONT}`;
  return measureCtx.measureText(text).width / 115;
}

function addDate(center) {
  const text = todayText();
  const d = dims();
  const aspect = textAspect(text);
  const h = 16 / d.h; // about 14 pt type
  return addPlacement({ kind: 'text', text, color: penColor(), aspect, w: (h * d.h * aspect) / d.w, x: 0, y: 0.8 }, center);
}
dateBtn.addEventListener('click', () => addDate());

function placementLabel(p) {
  return p.kind === 'text' ? `Date ${p.text}` : 'Signature';
}

function renderPlacements() {
  layer.replaceChildren();
  for (const p of state.placements) {
    if (p.page !== state.pageIndex) continue;
    const el = document.createElement('div');
    el.className = `placement placement--${p.kind}`;
    el.dataset.id = p.id;
    el.tabIndex = 0;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-roledescription', 'placed item');
    el.setAttribute('aria-label', `${placementLabel(p)} on page ${p.page + 1}. Arrow keys move, plus and minus resize, Delete removes.`);
    if (p.kind === 'image') {
      const img = document.createElement('img');
      img.src = state.sigs.get(p.sigId).url;
      img.alt = '';
      img.draggable = false;
      el.append(img);
    } else {
      const ns = 'http://www.w3.org/2000/svg';
      const vbW = p.aspect * 115;
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${vbW} 115`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', '0');
      t.setAttribute('y', '93');
      t.setAttribute('font-size', '100');
      t.setAttribute('font-family', DATE_FONT);
      t.setAttribute('fill', rgbCss(p.color));
      t.setAttribute('textLength', String(vbW));
      t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
      t.textContent = p.text;
      svg.append(t);
      el.append(svg);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'placement__del';
    del.setAttribute('aria-label', `Remove ${placementLabel(p).toLowerCase()}`);
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); removePlacement(p.id); });
    const handle = document.createElement('span');
    handle.className = 'placement__handle';
    handle.setAttribute('aria-hidden', 'true');
    el.append(del, handle);
    layoutPlacement(el, p);
    el.classList.toggle('is-selected', state.selected === p.id);
    wirePlacement(el, p);
    layer.append(el);
  }
}

const rgbCss = ([r, g, b]) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

function layoutPlacement(el, p) {
  el.style.left = `${p.x * 100}%`;
  el.style.top = `${p.y * 100}%`;
  el.style.width = `${p.w * 100}%`;
  el.style.height = `${p.h * 100}%`;
}

function select(id) {
  state.selected = id;
  layer.querySelectorAll('.placement').forEach((el) => el.classList.toggle('is-selected', el.dataset.id === id));
}

function removePlacement(id) {
  const i = state.placements.findIndex((p) => p.id === id);
  if (i < 0) return;
  state.placements.splice(i, 1);
  if (state.selected === id) state.selected = null;
  renderPlacements();
  updateCount();
  const rest = layer.querySelector('.placement');
  if (rest) rest.focus({ preventScroll: true }); else stage.focus?.();
}

function wirePlacement(el, p) {
  el.addEventListener('focus', () => select(p.id));
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.target.closest('.placement__del')) return;
    e.preventDefault();
    select(p.id);
    el.focus({ preventScroll: true });
    const mode = e.target.classList.contains('placement__handle') ? 'resize' : 'move';
    const rect = stage.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, px: p.x, py: p.y, pw: p.w };
    el.setPointerCapture(e.pointerId);
    el.classList.add('is-dragging');
    const move = (ev) => {
      ev.preventDefault();
      const fx = (ev.clientX - start.x) / rect.width;
      const fy = (ev.clientY - start.y) / rect.height;
      if (mode === 'move') {
        p.x = clamp(start.px + fx, 0, 1 - p.w);
        p.y = clamp(start.py + fy, 0, 1 - p.h);
      } else {
        p.w = clamp(start.pw + fx, 0.03, 1 - p.x);
        fitPlacement(p);
        if (p.y + p.h > 1) { p.h = 1 - p.y; p.w = (p.h * p.aspect * dims().h) / dims().w; }
      }
      layoutPlacement(el, p);
    };
    const end = () => {
      el.classList.remove('is-dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });
  el.addEventListener('keydown', (e) => {
    const d = dims();
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      p.x = clamp(p.x + moves[e.key][0] / d.w, 0, 1 - p.w);
      p.y = clamp(p.y + moves[e.key][1] / d.h, 0, 1 - p.h);
      layoutPlacement(el, p);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removePlacement(p.id);
    } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      e.preventDefault();
      const grow = e.key === '+' || e.key === '=' ? 1.05 : 1 / 1.05;
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      p.w *= grow;
      fitPlacement(p);
      p.x = clamp(cx - p.w / 2, 0, 1 - p.w);
      p.y = clamp(cy - p.h / 2, 0, 1 - p.h);
      layoutPlacement(el, p);
    } else if (e.key === 'Escape') {
      select(null);
      el.blur();
    }
  });
}

stage.addEventListener('pointerdown', (e) => { if (e.target === stage || e.target === layer || e.target === pageCanvas) select(null); });

// Drag a tray item onto the page (HTML5 drag and drop, desktop).
stage.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('application/x-signature')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  stage.classList.add('is-dragover');
});
stage.addEventListener('dragleave', () => stage.classList.remove('is-dragover'));
stage.addEventListener('drop', (e) => {
  const id = e.dataTransfer.getData('application/x-signature');
  stage.classList.remove('is-dragover');
  if (!id) return;
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  placeSignature(id, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
});

function updateCount() {
  const n = state.placements.length;
  const pages = new Set(state.placements.map((p) => p.page)).size;
  countLabel.textContent = n ? `${n} item${n === 1 ? '' : 's'} on ${pages} page${pages === 1 ? '' : 's'}` : 'Nothing placed yet';
}

// ---------- Saving ----------
async function save({ download = true } = {}) {
  clearAlerts();
  if (!state.pdf) { showError('Open a PDF first.'); return null; }
  if (!state.placements.length) { showError('Place a signature or date on a page before saving.'); return null; }
  results.querySelector('.result-card')?.remove();
  const box = document.createElement('div');
  box.className = 'result-card saving';
  box.innerHTML = '<p class="result__info" role="status">Writing your signature into the PDF…</p><div class="progress" role="progressbar" aria-label="Saving progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>';
  results.append(box);
  const bar = box.querySelector('.progress');
  const setProgress = (v) => {
    const pct = Math.floor(v * 100);
    bar.setAttribute('aria-valuenow', String(pct));
    bar.firstChild.style.width = `${pct}%`;
  };
  saveBtn.disabled = true;
  try {
    const images = {};
    for (const p of state.placements) if (p.kind === 'image') images[p.sigId] = state.sigs.get(p.sigId).bytes;
    const placements = state.placements.map(({ page, kind, x, y, w, h, sigId, text, color }) => ({ page, kind, x, y, w, h, sigId, text, color }));
    const res = await runJob('sign', { bytes: state.bytes.slice(), placements, images }, setProgress);
    const blob = new Blob([res.bytes], { type: 'application/pdf' });
    const name = outputName();
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = URL.createObjectURL(blob);
    box.className = 'result result-card';
    box.innerHTML = `
      <svg class="result__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.5 17 19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div class="result__meta"><div class="result__name"></div><div class="result__info"></div></div>
      <a class="btn btn--primary result__download" id="download-link"></a>`;
    box.querySelector('.result__name').textContent = name;
    const n = state.placements.length;
    box.querySelector('.result__info').textContent = `${state.pageCount} page${state.pageCount === 1 ? '' : 's'} · ${n} item${n === 1 ? '' : 's'} placed · ${formatBytes(blob.size)} · visual signature`;
    const link = box.querySelector('a');
    link.href = state.resultUrl;
    link.download = name;
    link.textContent = `Download ${name}`;
    box.scrollIntoView({ block: 'nearest' });
    if (download) {
      downloadBlob(blob, name);
      toast('Signed PDF saved to your device');
    }
    return blob;
  } catch (err) {
    box.remove();
    console.warn(err);
    showError(/encrypt/i.test(err.message)
      ? 'This PDF is encrypted, which is not supported. Remove the protection first.'
      : `Could not save the signed PDF: ${err.message}`);
    return null;
  } finally {
    saveBtn.disabled = false;
  }
}
saveBtn.addEventListener('click', () => save());

// ---------- Signature: tabs ----------
const tabs = [...document.querySelectorAll('[role="tab"]')];
let activeTab = 'draw';
function activateTab(tab, focus) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
  activeTab = tab.id.replace('tab-', '');
  $('pen-colors').hidden = activeTab === 'upload';
  if (focus) tab.focus();
  if (activeTab === 'draw') sizePad();
  if (activeTab === 'type') renderTyped();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => activateTab(t));
  t.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (dir) { e.preventDefault(); activateTab(tabs[(i + dir + tabs.length) % tabs.length], true); }
    if (e.key === 'Home') { e.preventDefault(); activateTab(tabs[0], true); }
    if (e.key === 'End') { e.preventDefault(); activateTab(tabs[tabs.length - 1], true); }
  });
});

const penColor = () => INK_RGB[document.querySelector('input[name="pen"]:checked').value];
const penCss = () => INK[document.querySelector('input[name="pen"]:checked').value];
document.querySelectorAll('input[name="pen"]').forEach((r) => r.addEventListener('change', () => { redrawPad(); renderTyped(); }));

// ---------- Signature: draw pad ----------
const padBox = $('pad');
const pad = $('sig-pad');
const padHint = $('pad-hint');
const padCtx = pad.getContext('2d');
const strokes = []; // arrays of {x, y} in CSS pixels
let current = null;
const LINE = 2.6;

function sizePad() {
  const r = pad.getBoundingClientRect();
  if (!r.width) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (pad.width !== w || pad.height !== h) {
    pad.width = w;
    pad.height = h;
  }
  redrawPad();
}
new ResizeObserver(() => sizePad()).observe(padBox);

function strokePath(ctx, pts) {
  ctx.beginPath();
  if (pts.length === 1) {
    ctx.arc(pts[0].x, pts[0].y, LINE / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function drawStrokes(ctx, scale) {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = LINE;
  ctx.strokeStyle = ctx.fillStyle = penCss();
  for (const s of strokes) strokePath(ctx, s);
  ctx.restore();
}

function redrawPad() {
  padCtx.clearRect(0, 0, pad.width, pad.height);
  drawStrokes(padCtx, pad.width / (pad.getBoundingClientRect().width || 1));
  padHint.hidden = strokes.length > 0;
}

function padPoint(e) {
  const r = pad.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

pad.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  e.preventDefault();
  pad.setPointerCapture(e.pointerId);
  current = [padPoint(e)];
  strokes.push(current);
  redrawPad();
});
pad.addEventListener('pointermove', (e) => {
  if (!current) return;
  e.preventDefault();
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of (events.length ? events : [e])) {
    const pt = padPoint(ev);
    const prev = current[current.length - 1];
    if (Math.hypot(pt.x - prev.x, pt.y - prev.y) >= 0.8) current.push(pt);
  }
  redrawPad();
});
const endStroke = (e) => { if (current) { e.preventDefault(); current = null; } };
pad.addEventListener('pointerup', endStroke);
pad.addEventListener('pointercancel', endStroke);
// Older iOS Safari still scrolls on touch without this, even with touch-action: none.
pad.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
pad.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

$('clear-pad').addEventListener('click', () => { strokes.length = 0; redrawPad(); });

// Crop a canvas to the bounds of its non-transparent pixels.
function cropToInk(src, margin = 6) {
  const { width: w, height: h } = src;
  const data = src.getContext('2d').getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const cw = maxX - minX + 1 + margin * 2, ch = maxY - minY + 1 + margin * 2;
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d').drawImage(src, minX, minY, maxX - minX + 1, maxY - minY + 1, margin, margin, maxX - minX + 1, maxY - minY + 1);
  return out;
}

function exportDrawn() {
  if (!strokes.length) return null;
  const r = pad.getBoundingClientRect();
  const scale = 3; // export sharper than the screen, independent of devicePixelRatio
  const c = document.createElement('canvas');
  c.width = Math.round(r.width * scale);
  c.height = Math.round(r.height * scale);
  drawStrokes(c.getContext('2d'), scale);
  return cropToInk(c, 8);
}

// ---------- Signature: type ----------
const typeName = $('type-name');
const typeCanvas = $('type-canvas');
const typeStyle = () => document.querySelector('input[name="type-style"]:checked').value;

function typedCanvas(text, px) {
  const font = TYPE_FONTS[typeStyle()].replace('{px}', px);
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width + px * 0.8);
  c.height = Math.ceil(px * 1.7);
  ctx.font = font;
  ctx.fillStyle = penCss();
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, px * 0.4, px * 1.15);
  return c;
}

function renderTyped() {
  const text = typeName.value.trim() || typeName.placeholder;
  const dpr = window.devicePixelRatio || 1;
  const box = typeCanvas.parentElement.getBoundingClientRect();
  const w = Math.max(1, Math.round((box.width || 280) * dpr)), h = Math.round(90 * dpr);
  typeCanvas.width = w;
  typeCanvas.height = h;
  const ctx = typeCanvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const src = cropToInk(typedCanvas(text, 64), 4);
  if (!src) return;
  const s = Math.min((w * 0.94) / src.width, (h * 0.9) / src.height);
  ctx.globalAlpha = typeName.value.trim() ? 1 : 0.35;
  ctx.drawImage(src, (w - src.width * s) / 2, (h - src.height * s) / 2, src.width * s, src.height * s);
}
typeName.addEventListener('input', renderTyped);
document.querySelectorAll('input[name="type-style"]').forEach((r) => r.addEventListener('change', renderTyped));
typeName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useSignature(); } });

function exportTyped() {
  const text = typeName.value.trim();
  if (!text) return null;
  return cropToInk(typedCanvas(text, 120), 8);
}

// ---------- Signature: upload ----------
const uploadInput = $('sig-upload');
const removeWhite = $('remove-white');
let uploadedBitmap = null;

async function loadUpload() {
  const file = uploadInput.files[0];
  if (!file) return;
  clearAlerts();
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    showError(`"${file.name}" is not a PNG, JPG or WebP image.`);
    uploadInput.value = '';
    return;
  }
  try {
    uploadedBitmap = await createImageBitmap(file);
    updateUploadPreview();
  } catch {
    uploadedBitmap = null;
    showError(`Could not read the image "${file.name}".`);
  }
}
uploadInput.addEventListener('change', loadUpload);
removeWhite.addEventListener('change', () => updateUploadPreview());

function processedUpload() {
  if (!uploadedBitmap) return null;
  const max = 1600;
  const s = Math.min(1, max / Math.max(uploadedBitmap.width, uploadedBitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(uploadedBitmap.width * s));
  c.height = Math.max(1, Math.round(uploadedBitmap.height * s));
  const ctx = c.getContext('2d');
  ctx.drawImage(uploadedBitmap, 0, 0, c.width, c.height);
  if (removeWhite.checked) {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum >= 235) d[i + 3] = 0;
      else if (lum > 190) d[i + 3] = Math.round(d[i + 3] * ((235 - lum) / 45));
    }
    ctx.putImageData(img, 0, 0);
  }
  return cropToInk(c, 4);
}

function updateUploadPreview() {
  const c = processedUpload();
  const wrap = $('upload-preview-wrap');
  if (!c) { wrap.hidden = true; return; }
  $('upload-preview').src = c.toDataURL('image/png');
  wrap.hidden = false;
}

// ---------- Tray ----------
const canvasToPng = (c) => new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the image'))), 'image/png'));

async function addSigFromBlob(blob, width, height) {
  const id = nextId('s');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sig = { id, bytes, url: URL.createObjectURL(blob), width, height };
  state.sigs.set(id, sig);
  state.trayIds.unshift(id);
  if (state.trayIds.length > 6) state.trayIds.length = 6;
  renderTray();
  return sig;
}

function renderTray() {
  tray.replaceChildren();
  state.trayIds.forEach((id, i) => {
    const sig = state.sigs.get(id);
    const li = document.createElement('li');
    li.className = 'tray__item';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tray__place';
    btn.draggable = true;
    btn.setAttribute('aria-label', `Place signature ${i + 1} on the current page`);
    btn.title = 'Place on the page';
    const img = document.createElement('img');
    img.src = sig.url;
    img.alt = `Signature ${i + 1}`;
    img.draggable = false;
    btn.append(img);
    btn.addEventListener('click', () => placeSignature(id));
    btn.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-signature', id);
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setDragImage(img, 20, 20);
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'tray__del';
    del.setAttribute('aria-label', `Remove signature ${i + 1} from the tray`);
    del.textContent = '×';
    del.addEventListener('click', () => {
      state.trayIds = state.trayIds.filter((t) => t !== id);
      renderTray();
    });
    li.append(btn, del);
    tray.append(li);
  });
  trayEmpty.hidden = state.trayIds.length > 0;
}

async function useSignature({ quiet = false } = {}) {
  clearAlerts();
  let canvas = null;
  if (activeTab === 'draw') {
    canvas = exportDrawn();
    if (!canvas) { showError('Draw your signature on the pad first.'); return null; }
  } else if (activeTab === 'type') {
    canvas = exportTyped();
    if (!canvas) { showError('Type your name first.'); typeName.focus(); return null; }
  } else {
    canvas = processedUpload();
    if (!canvas) { showError(uploadedBitmap ? 'The image looks empty after removing the white background. Untick that option and try again.' : 'Choose a signature image first.'); return null; }
  }
  const blob = await canvasToPng(canvas);
  const sig = await addSigFromBlob(blob, canvas.width, canvas.height);
  if (rememberBox.checked) remember(canvas.toDataURL('image/png'), canvas.width, canvas.height);
  else lastSig = { url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
  if (!quiet) toast(state.pdf ? 'Added to the tray: click it to place it on the page' : 'Added to the tray. Open a PDF to place it');
  return sig;
}
$('use-sig').addEventListener('click', () => useSignature());

// ---------- Remember on this device (opt-in) ----------
let lastSig = null; // in memory only, unless the user opts in
function remember(url, width, height) {
  lastSig = { url, width, height };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(lastSig)); } catch { showError('This browser blocked local storage, so the signature can only be kept for this visit.'); }
}
rememberBox.addEventListener('change', () => {
  if (rememberBox.checked) {
    if (lastSig) remember(lastSig.url, lastSig.width, lastSig.height);
    toast('Your next signature will be remembered on this device');
  } else {
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    toast('Removed the saved signature from this device');
  }
});

async function restoreRemembered() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { /* ignore */ }
  if (!saved || !/^data:image\/png;base64,/.test(saved.url)) return;
  rememberBox.checked = true;
  lastSig = saved;
  const bin = atob(saved.url.slice(saved.url.indexOf(',') + 1));
  const blob = new Blob([Uint8Array.from(bin, (ch) => ch.charCodeAt(0))], { type: 'image/png' });
  await addSigFromBlob(blob, saved.width, saved.height);
}

// ---------- Startup ----------
wireDropzone(zone, input, handleFiles);
renderTray();
renderTyped();
restoreRemembered().catch(() => {});
window.addEventListener('beforeunload', () => { if (state.pdf) state.pdf.destroy(); });

// Called by the factory's screenshot script: opens the fictional contract and signs page 2.
window.__demo = async () => {
  const get = async (name, type) => new File([await (await fetch(`./tests/fixtures/${name}`)).blob()], name, { type });
  const contract = await get('contract.pdf', 'application/pdf');
  await handleFiles([contract]);
  goToPage(1);
  await new Promise((r) => setTimeout(r, 50));
  await renderPage();
  activateTab($('tab-upload'));
  const dt = new DataTransfer();
  dt.items.add(await get('signature.png', 'image/png'));
  uploadInput.files = dt.files;
  await loadUpload();
  const sig = await useSignature({ quiet: true });
  // Sam Rivera's signature line on page 2 is at x 330–540 pt, y 150 pt from the bottom of a 612×792 page.
  const p = placeSignature(sig.id);
  Object.assign(p, { w: 190 / 612, x: 336 / 612 });
  fitPlacement(p);
  p.y = (792 - 150) / 792 - p.h + 0.004;
  const d = addDate();
  Object.assign(d, { x: 334 / 612, y: (792 - 110) / 792 });
  fitPlacement(d);
  state.selected = p.id;
  renderPlacements();
  await save({ download: false });
  layer.querySelector('.placement')?.scrollIntoView({ block: 'center' });
};

export { handleFiles, downloadBlob };
