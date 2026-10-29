/// <reference lib="webworker" />
import type { ConvertSettings, JobRequest, JobResponse } from './types';

// Codecs are imported lazily so each worker only loads the WASM it actually needs.
const encoders = {
  avif: () => import('@jsquash/avif/encode.js'),
  webp: () => import('@jsquash/webp/encode.js'),
  jxl: () => import('@jsquash/jxl/encode.js'),
  jpeg: () => import('@jsquash/jpeg/encode.js'),
  png: () => import('@jsquash/oxipng/optimise.js'),
};

const decoders = {
  avif: () => import('@jsquash/avif/decode.js'),
  webp: () => import('@jsquash/webp/decode.js'),
  jxl: () => import('@jsquash/jxl/decode.js'),
  jpeg: () => import('@jsquash/jpeg/decode.js'),
  png: () => import('@jsquash/png/decode.js'),
};

type Sniffed = keyof typeof decoders | 'unknown';

function sniff(b: Uint8Array): Sniffed {
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b[0] === 0xff && b[1] === 0x0a) return 'jxl';
  if (ascii(4, 4) === 'JXL ') return 'jxl';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(4, 4) === 'ftyp' && /avi[fs]/.test(ascii(8, 4))) return 'avif';
  return 'unknown';
}

/** Decode with the browser's native (hardware-accelerated) decoder first, WASM as fallback. */
async function decode(file: File): Promise<ImageBitmap> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const kind = sniff(head);

  if (kind !== 'jxl') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through to WASM decoding.
    }
  }
  if (kind === 'unknown') throw new Error('Unsupported or corrupt image');

  const { default: wasmDecode } = await decoders[kind]();
  const data = (await wasmDecode(await file.arrayBuffer())) as ImageData | null;
  if (!data) throw new Error(`Could not decode ${kind.toUpperCase()}`);
  return createImageBitmap(data);
}

function fit(w: number, h: number, maxW: number, maxH: number) {
  const scale = Math.min(1, maxW ? maxW / w : 1, maxH ? maxH / h : 1);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function rasterize(bitmap: ImageBitmap, s: ConvertSettings): ImageData {
  const { width, height } = fit(bitmap.width, bitmap.height, s.maxWidth, s.maxHeight);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  if (s.format === 'jpeg') {
    // JPEG has no alpha channel: flatten onto white instead of black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

const pick = <T>(s: ConvertSettings, fast: T, balanced: T, small: T) =>
  s.effort === 'fast' ? fast : s.effort === 'small' ? small : balanced;

async function encode(img: ImageData, s: ConvertSettings): Promise<ArrayBuffer> {
  const q = Math.round(s.quality);
  switch (s.format) {
    case 'avif': {
      const { default: enc } = await encoders.avif();
      return enc(img, { quality: q, lossless: s.lossless, speed: pick(s, 9, 6, 3) });
    }
    case 'webp': {
      const { default: enc } = await encoders.webp();
      return enc(img, { quality: s.lossless ? 100 : q, lossless: s.lossless ? 1 : 0, method: pick(s, 1, 4, 6) });
    }
    case 'jxl': {
      const { default: enc } = await encoders.jxl();
      return enc(img, { quality: s.lossless ? 100 : q, lossless: s.lossless, effort: pick(s, 3, 5, 8) });
    }
    case 'jpeg': {
      const { default: enc } = await encoders.jpeg();
      return enc(img, { quality: q, progressive: true, optimize_coding: true, trellis_multipass: s.effort === 'small' });
    }
    case 'png': {
      const { default: optimise } = await encoders.png();
      return optimise(img, { level: pick(s, 1, 2, 4), interlace: false, optimiseAlpha: true });
    }
  }
}

self.onmessage = async (e: MessageEvent<JobRequest>) => {
  const { id, file, settings } = e.data;
  let res: JobResponse;
  try {
    const img = rasterize(await decode(file), settings);
    const buffer = await encode(img, settings);
    res = { id, ok: true, buffer, width: img.width, height: img.height };
  } catch (err) {
    res = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(res, res.ok ? [res.buffer] : []);
};
