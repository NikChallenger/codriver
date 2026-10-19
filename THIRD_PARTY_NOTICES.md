# Third-Party Notices

CoDriver vendors selected third-party code so the plugin builds and extracts PDF text without downloading packages or runtime resources.

## unpdf

- Source: https://github.com/unjs/unpdf/tree/v1.8.1
- Version: 1.8.1
- Tag commit: 4bc3080080febbcd62ad67d59f43cf535e75c4b7
- License: MIT
- Published wrapper: https://unpkg.com/unpdf@1.8.1/dist/index.cjs
- Upstream wrapper SHA-256: e1df8b63320a7705cb852a92bc8899e335392b7570c7e3690fcf78135428de84
- Vendored wrapper: src/vendor/unpdf/index.js
- Local wrapper adaptations: prepend provenance and retained license comments; replace two en dashes in upstream comments with ASCII hyphens; normalize leading tabs to two spaces so the indented runtime bundle passes whitespace checks. Runtime behavior is unchanged.
- License texts: src/vendor/unpdf/LICENSE (also retained in the wrapper and generated main.js).

### Bundled PDF.js

- Source: https://github.com/mozilla/pdf.js/tree/v6.1.200
- Version: 6.1.200
- License: Apache-2.0
- Published serverless bundle: https://unpkg.com/unpdf@1.8.1/dist/pdfjs.mjs
- Decoded bundle SHA-256: 6c826bd6198f20a1ac5c7bf99649cee30a0cc5d0a0730f15f238d5523dcd30b8
- Decoded bundle size: 1,676,063 bytes
- Vendored asset: src/vendor/unpdf/pdfjs.mjs.base64
- Local asset adaptation: Base64 encoding only; decoded bytes are unchanged. The no-registry build embeds this module and its worker in main.js; extraction loads it from a local data URL.
- Version evidence: published module version and tagged package.json pin (~6.1.200). The v1.8.1 README still mentions 5.6.205; it is not the version of the vendored artifact.

The first-party PDF bridge explicitly disables eval support and worker fetching and provides no external font, CMap or WASM resource URLs. It destroys its owned document loading task after successful or failed text extraction. Native PDF rendering and optional canvas packages are not used by CoDriver.

## jsdiff

- Package: diff
- Project: kpdecker/jsdiff
- Version source: v9.0.0 (retained; not upgraded to unreleased 10.0.0)
- Source: https://github.com/kpdecker/jsdiff/tree/v9.0.0
- Tag commit: ed13aca03aa25735fafc0645d1185e7a1c68fd8c
- License: BSD-3-Clause
- Vendored files: src/vendor/jsdiff/structuredPatch.js and src/vendor/jsdiff/LICENSE

CoDriver retains an adapted minimal CommonJS subset, not a byte-identical upstream distribution. Its line tokenizer and equality options derive from src/diff/line.ts; the bounded Myers algorithm and component construction derive from src/diff/base.ts; structuredPatch hunk construction derives from src/patch/create.ts. The local diffTokenArrays entry point reuses the algorithm for inline text tokens and joins component values as strings. TypeScript types, class scaffolding, unused diff modes, patch parsing/application and patch formatting are omitted. The retained full BSD-3-Clause license is included in the generated main.js bundle. Upstream 9.0.0 parity checks cover the integration's structuredPatch outputs; existing proposal tests cover inline and unified rendering and bounded fallback behavior.
