import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // jSquash loads its .wasm files via `new URL(..., import.meta.url)`; pre-bundling breaks that.
  optimizeDeps: {
    exclude: ['@jsquash/avif', '@jsquash/webp', '@jsquash/jxl', '@jsquash/jpeg', '@jsquash/png', '@jsquash/oxipng'],
  },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
