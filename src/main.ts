import '@fontsource-variable/dm-sans';
import './style.css';
import { downloadZip } from 'client-zip';
import { WorkerPool } from './pool';
import { FORMATS, type ConvertSettings, type Effort, type OutputFormat } from './types';

type Status = 'pending' | 'working' | 'done' | 'error';

interface Item {
  id: number;
  file: File;
  status: Status;
  key?: string; // settings the current result was produced with
  blob?: Blob;
  outName?: string;
  width?: number;
  height?: number;
  error?: string;
  el: HTMLLIElement;
}

const DEFAULT_QUALITY: Record<OutputFormat, number> = { avif: 60, webp: 80, jxl: 80, jpeg: 82, png: 100 };
const INPUT_EXT = /\.(jpe?g|png|webp|avif|jxl|gif|bmp|ico|tiff?|heic|heif|svg)$/i;
const STORAGE_KEY = 'imageconverter:settings';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const els = {
  formats: $<HTMLDivElement>('#formats'),
  quality: $<HTMLInputElement>('#quality'),
  qualityValue: $<HTMLOutputElement>('#quality-value'),
  qualitySection: $<HTMLElement>('#quality-section'),
  lossless: $<HTMLInputElement>('#lossless'),
  losslessSection: $<HTMLElement>('#lossless-section'),
  effort: $<HTMLDivElement>('#effort'),
  maxWidth: $<HTMLInputElement>('#max-width'),
  maxHeight: $<HTMLInputElement>('#max-height'),
  autostart: $<HTMLInputElement>('#autostart'),
  engineInfo: $<HTMLParagraphElement>('#engine-info'),
  dropzone: $<HTMLDivElement>('#dropzone'),
  fileInput: $<HTMLInputElement>('#file-input'),
  folderInput: $<HTMLInputElement>('#folder-input'),
  pickFolder: $<HTMLButtonElement>('#pick-folder'),
  toolbar: $<HTMLDivElement>('#toolbar'),
  sumCount: $<HTMLElement>('#sum-count'),
  sumSizes: $<HTMLElement>('#sum-sizes'),
  progressBar: $<HTMLDivElement>('#progress-bar'),
  convertBtn: $<HTMLButtonElement>('#convert-btn'),
  cancelBtn: $<HTMLButtonElement>('#cancel-btn'),
  zipBtn: $<HTMLButtonElement>('#zip-btn'),
  folderBtn: $<HTMLButtonElement>('#folder-btn'),
  clearBtn: $<HTMLButtonElement>('#clear-btn'),
  list: $<HTMLUListElement>('#file-list'),
  rowTemplate: $<HTMLTemplateElement>('#row-template'),
};

// ---------- Settings ----------

const state = {
  format: 'avif' as OutputFormat,
  quality: { ...DEFAULT_QUALITY },
  lossless: false,
  effort: 'balanced' as Effort,
  maxWidth: 0,
  maxHeight: 0,
  autostart: true,
};

try {
  Object.assign(state, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
} catch {
  /* storage unavailable or corrupt: use defaults */
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function currentSettings(): ConvertSettings {
  const lossless = state.format === 'png' || (state.lossless && state.format !== 'jpeg');
  return {
    format: state.format,
    quality: lossless ? 100 : state.quality[state.format],
    lossless,
    effort: state.effort,
    maxWidth: state.maxWidth,
    maxHeight: state.maxHeight,
  };
}

const settingsKey = (s: ConvertSettings) => JSON.stringify(s);

function renderSettings() {
  els.formats.innerHTML = '';
  for (const [id, f] of Object.entries(FORMATS) as [OutputFormat, (typeof FORMATS)[OutputFormat]][]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'format';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(state.format === id));
    b.innerHTML = `<span class="format-name">${f.label}</span><span class="format-note">${f.note}</span>`;
    b.onclick = () => {
      state.format = id;
      onSettingsChanged();
    };
    els.formats.append(b);
  }

  const s = currentSettings();
  const showQuality = state.format !== 'png' && !s.lossless;
  els.qualitySection.classList.toggle('disabled', !showQuality);
  els.quality.disabled = !showQuality;
  els.quality.value = String(state.quality[state.format]);
  els.qualityValue.textContent = showQuality ? String(state.quality[state.format]) : '—';
  els.losslessSection.hidden = state.format === 'jpeg' || state.format === 'png';
  els.lossless.checked = state.lossless;
  for (const b of els.effort.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.value === state.effort));
  }
  els.maxWidth.value = state.maxWidth ? String(state.maxWidth) : '';
  els.maxHeight.value = state.maxHeight ? String(state.maxHeight) : '';
  els.autostart.checked = state.autostart;
}

function onSettingsChanged() {
  saveSettings();
  renderSettings();
  updateSummary();
}

els.quality.addEventListener('input', () => {
  state.quality[state.format] = Number(els.quality.value);
  els.qualityValue.textContent = els.quality.value;
});
els.quality.addEventListener('change', onSettingsChanged);
els.lossless.addEventListener('change', () => {
  state.lossless = els.lossless.checked;
  onSettingsChanged();
});
els.effort.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  state.effort = b.dataset.value as Effort;
  onSettingsChanged();
});
for (const [input, key] of [
  [els.maxWidth, 'maxWidth'],
  [els.maxHeight, 'maxHeight'],
] as const) {
  input.addEventListener('change', () => {
    state[key] = Math.max(0, Math.floor(Number(input.value) || 0));
    onSettingsChanged();
  });
}
els.autostart.addEventListener('change', () => {
  state.autostart = els.autostart.checked;
  saveSettings();
});

// ---------- File intake ----------

const items: Item[] = [];
let nextId = 1;

function isImage(f: File) {
  return f.type.startsWith('image/') || INPUT_EXT.test(f.name);
}

function addFiles(files: Iterable<File>) {
  let added = 0;
  for (const file of files) {
    if (!isImage(file)) continue;
    const el = elsRow(file);
    const item: Item = { id: nextId++, file, status: 'pending', el };
    el.querySelector<HTMLButtonElement>('.remove')!.onclick = () => removeItem(item);
    el.querySelector<HTMLButtonElement>('.download')!.onclick = () => item.blob && saveBlob(item.blob, item.outName!);
    items.push(item);
    els.list.append(el);
    renderItem(item);
    added++;
  }
  if (!added) return;
  updateSummary();
  if (state.autostart) convertAll();
}

function elsRow(file: File): HTMLLIElement {
  const el = els.rowTemplate.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  const img = el.querySelector('img')!;
  const ext = file.name.split('.').pop()?.toUpperCase().slice(0, 4) ?? '';
  el.querySelector('.ext')!.textContent = ext;
  el.querySelector('.name')!.textContent = file.webkitRelativePath || file.name;
  // Thumbnail of the original (if the browser can display it natively).
  const url = URL.createObjectURL(file);
  img.src = url;
  img.onload = () => el.querySelector('.thumb')!.classList.add('loaded');
  img.onerror = () => img.remove();
  (el as any)._thumbUrl = url;
  return el;
}

function removeItem(item: Item) {
  const i = items.indexOf(item);
  if (i >= 0) items.splice(i, 1);
  URL.revokeObjectURL((item.el as any)._thumbUrl);
  item.el.remove();
  updateSummary();
}

async function readEntry(entry: FileSystemEntry, out: File[]) {
  if (entry.isFile) {
    out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns results in chunks; keep reading until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      await Promise.all(batch.map((e) => readEntry(e, out)));
    }
  }
}

async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files];
  const out: File[] = [];
  await Promise.all(entries.map((e) => readEntry(e, out)));
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

els.dropzone.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('#pick-folder')) return;
  els.fileInput.click();
});
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    els.fileInput.click();
  }
});
els.pickFolder.addEventListener('click', (e) => {
  e.stopPropagation();
  els.folderInput.click();
});
for (const input of [els.fileInput, els.folderInput]) {
  input.addEventListener('change', () => {
    addFiles(input.files ?? []);
    input.value = '';
  });
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer) addFiles(await filesFromDataTransfer(e.dataTransfer));
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) addFiles(files.map((f, i) => (f.name === 'image.png' ? rename(f, `pasted-${Date.now()}-${i}.png`) : f)));
});

const rename = (f: File, name: string) => new File([f], name, { type: f.type, lastModified: f.lastModified });

// ---------- Conversion ----------

const pool = new WorkerPool();
let runToken = 0;
let startedAt = 0;
let finishedAt = 0;

els.engineInfo.textContent = `Running ${pool.size} parallel WebAssembly worker${pool.size > 1 ? 's' : ''} on your ${navigator.hardwareConcurrency || '?'}-thread CPU.`;

function needsWork(item: Item, key: string) {
  return item.status !== 'working' && !(item.status === 'done' && item.key === key);
}

async function convertAll() {
  const settings = currentSettings();
  const key = settingsKey(settings);
  const todo = items.filter((i) => needsWork(i, key));
  if (!todo.length) return;

  const token = ++runToken;
  if (!pool.active) {
    startedAt = performance.now();
    finishedAt = 0;
  }
  const ext = FORMATS[settings.format].ext;
  const mime = FORMATS[settings.format].mime;

  for (const item of todo) {
    item.status = 'working';
    item.error = undefined;
    renderItem(item);
  }
  updateSummary();

  await Promise.all(
    todo.map(async (item) => {
      const res = await pool.run(item.file, settings);
      if (!items.includes(item)) return; // removed meanwhile
      if (res.ok) {
        Object.assign(item, {
          status: 'done',
          key,
          blob: new Blob([res.buffer], { type: mime }),
          outName: replaceExt(item.file.name, ext),
          width: res.width,
          height: res.height,
        });
      } else {
        Object.assign(item, { status: res.error === 'Cancelled' ? 'pending' : 'error', error: res.error, blob: undefined });
      }
      renderItem(item);
      updateSummary();
    }),
  );
  if (token === runToken && !pool.active) {
    finishedAt = performance.now();
    updateSummary();
  }
}

function replaceExt(name: string, ext: string) {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

els.convertBtn.addEventListener('click', () => convertAll());
els.cancelBtn.addEventListener('click', () => {
  runToken++;
  pool.cancel();
});
els.clearBtn.addEventListener('click', () => {
  runToken++;
  pool.cancel();
  for (const item of [...items]) removeItem(item);
});

// ---------- Output ----------

/** Unique output names (avoids collisions like photo.jpg + photo.png → photo.avif). */
function uniqueNames(done: Item[]) {
  const seen = new Map<string, number>();
  return done.map((item) => {
    const path = item.file.webkitRelativePath ? replaceExt(item.file.webkitRelativePath, item.outName!.split('.').pop()!) : item.outName!;
    const lower = path.toLowerCase();
    const n = seen.get(lower) ?? 0;
    seen.set(lower, n + 1);
    if (!n) return { item, name: path };
    const dot = path.lastIndexOf('.');
    return { item, name: `${path.slice(0, dot)} (${n + 1})${path.slice(dot)}` };
  });
}

function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

els.zipBtn.addEventListener('click', async () => {
  const done = items.filter((i) => i.status === 'done');
  if (!done.length) return;
  els.zipBtn.disabled = true;
  els.zipBtn.textContent = 'Zipping…';
  try {
    const files = uniqueNames(done).map(({ item, name }) => ({ name, input: item.blob!, lastModified: new Date() }));
    const zip = await downloadZip(files).blob();
    saveBlob(zip, `converted-${FORMATS[state.format].ext}-${done.length}.zip`);
  } finally {
    els.zipBtn.textContent = 'Download ZIP';
    updateSummary();
  }
});

const canPickDir = 'showDirectoryPicker' in window;
els.folderBtn.hidden = !canPickDir;
els.folderBtn.addEventListener('click', async () => {
  const done = items.filter((i) => i.status === 'done');
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await (window as any).showDirectoryPicker({ mode: 'readwrite', id: 'imageconverter-out' });
  } catch {
    return; // user cancelled
  }
  els.folderBtn.disabled = true;
  els.folderBtn.textContent = 'Saving…';
  try {
    for (const { item, name } of uniqueNames(done)) {
      const parts = name.split('/');
      let d = dir;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const fh = await d.getFileHandle(parts.at(-1)!, { create: true });
      const w = await fh.createWritable();
      await w.write(item.blob!);
      await w.close();
    }
    els.folderBtn.textContent = `Saved ${done.length} ✓`;
    setTimeout(() => {
      els.folderBtn.textContent = 'Save to folder';
    }, 2500);
  } catch (err) {
    alert(`Saving failed: ${err instanceof Error ? err.message : err}`);
    els.folderBtn.textContent = 'Save to folder';
  } finally {
    updateSummary();
  }
});

// ---------- Rendering ----------

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function savings(from: number, to: number) {
  const pct = Math.round((1 - to / from) * 100);
  return pct >= 0 ? `−${pct}%` : `+${-pct}%`;
}

function renderItem(item: Item) {
  const { el } = item;
  el.dataset.status = item.status;
  const details = el.querySelector('.details')!;
  const result = el.querySelector('.result')!;
  const dl = el.querySelector<HTMLButtonElement>('.download')!;
  details.textContent = fmtBytes(item.file.size) + (item.width ? ` · ${item.width}×${item.height}` : '');

  switch (item.status) {
    case 'pending':
      result.innerHTML = `<span class="status muted">Queued</span>`;
      break;
    case 'working':
      result.innerHTML = `<span class="status"><span class="spinner"></span>Converting</span>`;
      break;
    case 'error':
      result.innerHTML = `<span class="status error" title="${escapeHtml(item.error ?? '')}">Failed</span>`;
      break;
    case 'done': {
      const size = item.blob!.size;
      const bigger = size > item.file.size;
      result.innerHTML = `<span class="out-size">${fmtBytes(size)}</span><span class="saving ${bigger ? 'worse' : ''}">${savings(item.file.size, size)}</span>`;
      break;
    }
  }
  dl.hidden = item.status !== 'done';
  if (item.outName) dl.title = `Download ${item.outName}`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function updateSummary() {
  const total = items.length;
  els.toolbar.hidden = total === 0;
  document.body.classList.toggle('has-files', total > 0);
  if (!total) return;

  const key = settingsKey(currentSettings());
  const done = items.filter((i) => i.status === 'done');
  const working = items.filter((i) => i.status === 'working').length;
  const errors = items.filter((i) => i.status === 'error').length;
  const outdated = items.filter((i) => needsWork(i, key)).length;
  const inBytes = done.reduce((a, i) => a + i.file.size, 0);
  const outBytes = done.reduce((a, i) => a + i.blob!.size, 0);

  els.sumCount.textContent =
    `${done.length} / ${total} converted` + (errors ? ` · ${errors} failed` : '') + (working ? ` · ${working} in progress` : '');
  const elapsed = startedAt ? ((finishedAt || performance.now()) - startedAt) / 1000 : 0;
  els.sumSizes.textContent = done.length
    ? `${fmtBytes(inBytes)} → ${fmtBytes(outBytes)} (${savings(inBytes, outBytes)})` + (finishedAt ? ` · ${elapsed.toFixed(1)}s` : '')
    : '';
  els.progressBar.style.width = `${(done.length / total) * 100}%`;
  els.progressBar.classList.toggle('active', working > 0);

  els.convertBtn.disabled = outdated === 0;
  const anyDoneOutdated = done.some((i) => i.key !== key);
  els.convertBtn.textContent = outdated ? (anyDoneOutdated ? `Reconvert ${outdated}` : `Convert ${outdated}`) : 'Convert';
  els.cancelBtn.hidden = working === 0;
  els.zipBtn.disabled = done.length === 0 || working > 0;
  els.folderBtn.disabled = done.length === 0 || working > 0;
}

renderSettings();
updateSummary();
