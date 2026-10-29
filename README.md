# Image Converter

Batch-convert images to **AVIF, WebP, JPEG XL, JPEG (MozJPEG) and PNG (OxiPNG)** entirely in the browser.
Nothing is uploaded: decoding and encoding run locally in a pool of Web Workers using WebAssembly codecs from [jSquash](https://github.com/jamsinclair/jSquash).

## Features
- Drag & drop files or whole folders, file/folder picker, clipboard paste
- Parallel conversion (one worker per CPU thread, minus one for the UI)
- Native browser decoding first (fast), WASM fallback — reads JPEG XL even in browsers without JXL support
- Quality, lossless, encoder effort (Fastest / Balanced / Smallest), optional max width/height
- Per-file download, ZIP download, or save straight into a folder (Chromium browsers)
- Settings remembered between visits; light & dark mode; responsive down to phone size

## Develop
```bash
npm install
npm run dev
```

## Build
```bash
npm run build   # static site in dist/ — host anywhere
```

## Live
https://iammichaelbuck.github.io/imageconverter/ — deployed automatically from `main` via GitHub Actions.
