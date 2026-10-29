export type OutputFormat = 'avif' | 'webp' | 'jxl' | 'jpeg' | 'png';
export type Effort = 'fast' | 'balanced' | 'small';

export interface ConvertSettings {
  format: OutputFormat;
  quality: number; // 1–100
  lossless: boolean;
  effort: Effort;
  maxWidth: number; // 0 = no limit
  maxHeight: number; // 0 = no limit
}

export interface JobRequest {
  id: number;
  file: File;
  settings: ConvertSettings;
}

export type JobResponse =
  | { id: number; ok: true; buffer: ArrayBuffer; width: number; height: number }
  | { id: number; ok: false; error: string };

export const FORMATS: Record<OutputFormat, { label: string; ext: string; mime: string; lossy: boolean; note: string }> = {
  avif: { label: 'AVIF', ext: 'avif', mime: 'image/avif', lossy: true, note: 'Smallest files, slower to encode' },
  webp: { label: 'WebP', ext: 'webp', mime: 'image/webp', lossy: true, note: 'Fast, universally supported' },
  jxl: { label: 'JPEG XL', ext: 'jxl', mime: 'image/jxl', lossy: true, note: 'Next-gen, excellent quality' },
  jpeg: { label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', lossy: true, note: 'MozJPEG, maximum compatibility' },
  png: { label: 'PNG', ext: 'png', mime: 'image/png', lossy: false, note: 'Lossless, optimised with OxiPNG' },
};
