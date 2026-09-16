# Third-Party Notices

CoDriver vendors selected third-party code so the plugin can build without downloading dependencies from `registry.npmjs.org`.

## unpdf

- Source: https://github.com/unjs/unpdf
- Version: 1.4.0
- License: MIT
- Vendored files:
  - `src/vendor/unpdf/index.js`
  - `src/vendor/unpdf/pdfjs.mjs.base64`
  - `src/vendor/unpdf/LICENSE`

## jsdiff

- Package: `diff`
- Project: `kpdecker/jsdiff`
- Version source: `v9.0.0`
- Repository: <https://github.com/kpdecker/jsdiff>
- License: BSD-3-Clause
- Vendored files: `src/vendor/jsdiff/`

CoDriver vendors a minimal CommonJS subset used for proposal diff computation. The original BSD-3-Clause license text is retained in `src/vendor/jsdiff/LICENSE`, and the generated `main.js` bundle includes the vendored source notice.
