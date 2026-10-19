/*
 * Vendored from unpdf 1.8.1 dist/index.cjs.
 * Bundled PDF.js 6.1.200. See THIRD_PARTY_NOTICES.md for provenance.
 *
 * MIT License
 *
 * Copyright (c) 2023-PRESENT Johann Schopplich
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---
 *
 * Bundled PDF.js 6.1.200
 * Copyright Mozilla Foundation
 * Source: https://github.com/mozilla/pdf.js/tree/v6.1.200
 *
 *
 *                                  Apache License
 *                            Version 2.0, January 2004
 *                         http://www.apache.org/licenses/
 *
 *    TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
 *
 *    1. Definitions.
 *
 *       "License" shall mean the terms and conditions for use, reproduction,
 *       and distribution as defined by Sections 1 through 9 of this document.
 *
 *       "Licensor" shall mean the copyright owner or entity authorized by
 *       the copyright owner that is granting the License.
 *
 *       "Legal Entity" shall mean the union of the acting entity and all
 *       other entities that control, are controlled by, or are under common
 *       control with that entity. For the purposes of this definition,
 *       "control" means (i) the power, direct or indirect, to cause the
 *       direction or management of such entity, whether by contract or
 *       otherwise, or (ii) ownership of fifty percent (50%) or more of the
 *       outstanding shares, or (iii) beneficial ownership of such entity.
 *
 *       "You" (or "Your") shall mean an individual or Legal Entity
 *       exercising permissions granted by this License.
 *
 *       "Source" form shall mean the preferred form for making modifications,
 *       including but not limited to software source code, documentation
 *       source, and configuration files.
 *
 *       "Object" form shall mean any form resulting from mechanical
 *       transformation or translation of a Source form, including but
 *       not limited to compiled object code, generated documentation,
 *       and conversions to other media types.
 *
 *       "Work" shall mean the work of authorship, whether in Source or
 *       Object form, made available under the License, as indicated by a
 *       copyright notice that is included in or attached to the work
 *       (an example is provided in the Appendix below).
 *
 *       "Derivative Works" shall mean any work, whether in Source or Object
 *       form, that is based on (or derived from) the Work and for which the
 *       editorial revisions, annotations, elaborations, or other modifications
 *       represent, as a whole, an original work of authorship. For the purposes
 *       of this License, Derivative Works shall not include works that remain
 *       separable from, or merely link (or bind by name) to the interfaces of,
 *       the Work and Derivative Works thereof.
 *
 *       "Contribution" shall mean any work of authorship, including
 *       the original version of the Work and any modifications or additions
 *       to that Work or Derivative Works thereof, that is intentionally
 *       submitted to Licensor for inclusion in the Work by the copyright owner
 *       or by an individual or Legal Entity authorized to submit on behalf of
 *       the copyright owner. For the purposes of this definition, "submitted"
 *       means any form of electronic, verbal, or written communication sent
 *       to the Licensor or its representatives, including but not limited to
 *       communication on electronic mailing lists, source code control systems,
 *       and issue tracking systems that are managed by, or on behalf of, the
 *       Licensor for the purpose of discussing and improving the Work, but
 *       excluding communication that is conspicuously marked or otherwise
 *       designated in writing by the copyright owner as "Not a Contribution."
 *
 *       "Contributor" shall mean Licensor and any individual or Legal Entity
 *       on behalf of whom a Contribution has been received by Licensor and
 *       subsequently incorporated within the Work.
 *
 *    2. Grant of Copyright License. Subject to the terms and conditions of
 *       this License, each Contributor hereby grants to You a perpetual,
 *       worldwide, non-exclusive, no-charge, royalty-free, irrevocable
 *       copyright license to reproduce, prepare Derivative Works of,
 *       publicly display, publicly perform, sublicense, and distribute the
 *       Work and such Derivative Works in Source or Object form.
 *
 *    3. Grant of Patent License. Subject to the terms and conditions of
 *       this License, each Contributor hereby grants to You a perpetual,
 *       worldwide, non-exclusive, no-charge, royalty-free, irrevocable
 *       (except as stated in this section) patent license to make, have made,
 *       use, offer to sell, sell, import, and otherwise transfer the Work,
 *       where such license applies only to those patent claims licensable
 *       by such Contributor that are necessarily infringed by their
 *       Contribution(s) alone or by combination of their Contribution(s)
 *       with the Work to which such Contribution(s) was submitted. If You
 *       institute patent litigation against any entity (including a
 *       cross-claim or counterclaim in a lawsuit) alleging that the Work
 *       or a Contribution incorporated within the Work constitutes direct
 *       or contributory patent infringement, then any patent licenses
 *       granted to You under this License for that Work shall terminate
 *       as of the date such litigation is filed.
 *
 *    4. Redistribution. You may reproduce and distribute copies of the
 *       Work or Derivative Works thereof in any medium, with or without
 *       modifications, and in Source or Object form, provided that You
 *       meet the following conditions:
 *
 *       (a) You must give any other recipients of the Work or
 *           Derivative Works a copy of this License; and
 *
 *       (b) You must cause any modified files to carry prominent notices
 *           stating that You changed the files; and
 *
 *       (c) You must retain, in the Source form of any Derivative Works
 *           that You distribute, all copyright, patent, trademark, and
 *           attribution notices from the Source form of the Work,
 *           excluding those notices that do not pertain to any part of
 *           the Derivative Works; and
 *
 *       (d) If the Work includes a "NOTICE" text file as part of its
 *           distribution, then any Derivative Works that You distribute must
 *           include a readable copy of the attribution notices contained
 *           within such NOTICE file, excluding those notices that do not
 *           pertain to any part of the Derivative Works, in at least one
 *           of the following places: within a NOTICE text file distributed
 *           as part of the Derivative Works; within the Source form or
 *           documentation, if provided along with the Derivative Works; or,
 *           within a display generated by the Derivative Works, if and
 *           wherever such third-party notices normally appear. The contents
 *           of the NOTICE file are for informational purposes only and
 *           do not modify the License. You may add Your own attribution
 *           notices within Derivative Works that You distribute, alongside
 *           or as an addendum to the NOTICE text from the Work, provided
 *           that such additional attribution notices cannot be construed
 *           as modifying the License.
 *
 *       You may add Your own copyright statement to Your modifications and
 *       may provide additional or different license terms and conditions
 *       for use, reproduction, or distribution of Your modifications, or
 *       for any such Derivative Works as a whole, provided Your use,
 *       reproduction, and distribution of the Work otherwise complies with
 *       the conditions stated in this License.
 *
 *    5. Submission of Contributions. Unless You explicitly state otherwise,
 *       any Contribution intentionally submitted for inclusion in the Work
 *       by You to the Licensor shall be under the terms and conditions of
 *       this License, without any additional terms or conditions.
 *       Notwithstanding the above, nothing herein shall supersede or modify
 *       the terms of any separate license agreement you may have executed
 *       with Licensor regarding such Contributions.
 *
 *    6. Trademarks. This License does not grant permission to use the trade
 *       names, trademarks, service marks, or product names of the Licensor,
 *       except as required for reasonable and customary use in describing the
 *       origin of the Work and reproducing the content of the NOTICE file.
 *
 *    7. Disclaimer of Warranty. Unless required by applicable law or
 *       agreed to in writing, Licensor provides the Work (and each
 *       Contributor provides its Contributions) on an "AS IS" BASIS,
 *       WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
 *       implied, including, without limitation, any warranties or conditions
 *       of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
 *       PARTICULAR PURPOSE. You are solely responsible for determining the
 *       appropriateness of using or redistributing the Work and assume any
 *       risks associated with Your exercise of permissions under this License.
 *
 *    8. Limitation of Liability. In no event and under no legal theory,
 *       whether in tort (including negligence), contract, or otherwise,
 *       unless required by applicable law (such as deliberate and grossly
 *       negligent acts) or agreed to in writing, shall any Contributor be
 *       liable to You for damages, including any direct, indirect, special,
 *       incidental, or consequential damages of any character arising as a
 *       result of this License or out of the use or inability to use the
 *       Work (including but not limited to damages for loss of goodwill,
 *       work stoppage, computer failure or malfunction, or any and all
 *       other commercial damages or losses), even if such Contributor
 *       has been advised of the possibility of such damages.
 *
 *    9. Accepting Warranty or Additional Liability. While redistributing
 *       the Work or Derivative Works thereof, You may choose to offer,
 *       and charge a fee for, acceptance of support, warranty, indemnity,
 *       or other liability obligations and/or rights consistent with this
 *       License. However, in accepting such obligations, You may act only
 *       on Your own behalf and on Your sole responsibility, not on behalf
 *       of any other Contributor, and only if You agree to indemnify,
 *       defend, and hold each Contributor harmless for any liability
 *       incurred by, or claims asserted against, such Contributor by reason
 *       of your accepting any such warranty or additional liability.
 *
 *    END OF TERMS AND CONDITIONS
 */
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region src/_internal/dommatrix-polyfill.ts
function polyfillDOMMatrix() {
  if (typeof globalThis.DOMMatrix !== "undefined") return;
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      if (Array.isArray(init) && init.length === 6) {
        this.a = init[0];
        this.b = init[1];
        this.c = init[2];
        this.d = init[3];
        this.e = init[4];
        this.f = init[5];
      } else {
        this.a = 1;
        this.b = 0;
        this.c = 0;
        this.d = 1;
        this.e = 0;
        this.f = 0;
      }
    }
    translateSelf(tx, ty = 0) {
      this.e = this.a * tx + this.c * ty + this.e;
      this.f = this.b * tx + this.d * ty + this.f;
      return this;
    }
    scaleSelf(sx, sy = sx) {
      this.a *= sx;
      this.b *= sx;
      this.c *= sy;
      this.d *= sy;
      return this;
    }
  };
}
//#endregion
//#region src/_internal/env.ts
/**
* Stubs browser globals that PDF.js expects at the module level
* in non-browser environments.
*
* @remarks
* Must be called before importing any PDF.js module, since PDF.js
* accesses these globals at parse time (top-level constants).
*/
function stubBrowserGlobals() {
  polyfillDOMMatrix();
}
//#endregion
//#region src/utils.ts
let resolvedModule;
const isNode = globalThis.process?.release?.name === "node";
const isBrowser = typeof window !== "undefined";
/**
* Returns a `PDFDocumentProxy` instance from a given binary data.
*
* Applies the following defaults:
* - `useSystemFonts: true`
*
* In Node.js environments, additionally applies:
* - `disableFontFace: true`
* - `standardFontDataUrl` resolved from the local `pdfjs-dist` package
* - `cMapUrl` and `cMapPacked` resolved from the local `pdfjs-dist` package
*/
async function getDocumentProxy(data, options = {}) {
  const { getDocument } = await getResolvedPDFJS();
  let nodeDefaults = {};
  if (isNode) try {
    const base = {}.resolve("pdfjs-dist/package.json");
    nodeDefaults = {
      disableFontFace: true,
      standardFontDataUrl: new URL("./standard_fonts/", base).href,
      cMapUrl: new URL("./cmaps/", base).href,
      cMapPacked: true
    };
  } catch {}
  return await getDocument({
    data,
    useSystemFonts: true,
    ...nodeDefaults,
    ...options
  }).promise;
}
/**
* Runs an operation on a `PDFDocumentProxy` resolved from either binary data
* or an existing proxy. Documents created here are destroyed once the
* operation settles - caller-supplied proxies keep their lifecycle with the
* caller.
*/
async function withDocument(data, operation, options) {
  const pdf = isPDFDocumentProxy(data) ? data : await getDocumentProxy(data, options);
  try {
    return await operation(pdf);
  } finally {
    if (pdf !== data) await pdf.loadingTask.destroy();
  }
}
async function getResolvedPDFJS() {
  if (!resolvedModule) await resolvePDFJSImport();
  return resolvedModule;
}
async function resolvePDFJSImport(pdfjsResolver, { reload = false } = {}) {
  if (resolvedModule && !reload) return;
  stubBrowserGlobals();
  if (pdfjsResolver) try {
    resolvedModule = await interopDefault(pdfjsResolver());
    return;
  } catch (error) {
    throw new Error(`PDF.js could not be resolved: ${error}`);
  }
  try {
    resolvedModule = await import("unpdf/pdfjs");
  } catch (error) {
    throw new Error(`Serverless PDF.js bundle could not be resolved: ${error}`);
  }
}
function isPDFDocumentProxy(data) {
  return typeof data === "object" && data !== null && "_pdfInfo" in data;
}
async function interopDefault(m) {
  const resolved = await m;
  return resolved.default || resolved;
}
//#endregion
//#region src/_internal/canvas.ts
let resolvedCanvasModule;
/**
* Derived from the PDF.js project by the Mozilla Foundation.
* @see https://github.com/mozilla/pdf.js/blob/b8de9a372f9bbf7e33adb362eeae5ef1919dba73/src/display/canvas_factory.js#L18
* @license Apache-2.0
*/
var BaseCanvasFactory = class {
  #enableHWA = false;
  constructor({ enableHWA = false } = {}) {
    this.#enableHWA = enableHWA;
  }
  create(width, height) {
    const canvas = this._createCanvas(width, height);
    return {
      canvas,
      context: canvas.getContext("2d", { willReadFrequently: !this.#enableHWA })
    };
  }
  reset({ canvas }, width, height) {
    if (!canvas) throw new Error("Canvas is not specified");
    canvas.width = width;
    canvas.height = height;
  }
  destroy(context) {
    if (!context.canvas) throw new Error("Canvas is not specified");
    context.canvas.width = 0;
    context.canvas.height = 0;
    context.canvas = void 0;
    context.context = void 0;
  }
  _createCanvas(width, height) {
    throw new Error("Not implemented");
  }
};
/**
* Derived from the PDF.js project by the Mozilla Foundation.
* @see https://github.com/mozilla/pdf.js/blob/b8de9a372f9bbf7e33adb362eeae5ef1919dba73/src/display/canvas_factory.js#L18
* @license Apache-2.0
*/
var DOMCanvasFactory = class extends BaseCanvasFactory {
  constructor({ ownerDocument = globalThis.document, enableHWA = false } = {}) {
    super({ enableHWA });
    this._document = ownerDocument;
  }
  _createCanvas(width, height) {
    const canvas = this._document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
};
var NodeCanvasFactory = class extends BaseCanvasFactory {
  constructor({ enableHWA = false } = {}) {
    super({ enableHWA });
  }
  _createCanvas(width, height) {
    if (!resolvedCanvasModule) throw new Error("@napi-rs/canvas module is not resolved");
    return resolvedCanvasModule.createCanvas(width, height);
  }
};
async function resolveCanvasModule(canvasImport) {
  resolvedCanvasModule ??= await interopDefault(canvasImport());
  globalThis[Symbol.for("unpdf.canvasModule")] = resolvedCanvasModule;
}
/**
* Injects `DOMMatrix`, `ImageData` and `Path2D` constructors from the
* `@napi-rs/canvas` package into the global scope. This is necessary for
* Node.js environments that do not support these constructors natively.
*
* @remarks
* `DOMMatrix` is always set because {@link stubBrowserGlobals} may have
* installed a minimal stub to allow PDF.js to import - the real
* `@napi-rs/canvas` implementation must take precedence for rendering.
*/
function injectCanvasConstructors() {
  if (!resolvedCanvasModule) return;
  globalThis.DOMMatrix = resolvedCanvasModule.DOMMatrix;
  if (typeof globalThis.ImageData === "undefined") globalThis.ImageData = resolvedCanvasModule.ImageData;
  if (typeof globalThis.Path2D === "undefined") globalThis.Path2D = resolvedCanvasModule.Path2D;
}
//#endregion
//#region src/image.ts
/**
* Extracts images from a specific page of a PDF document, including necessary metadata,
* such as width, height, and calculated color channels.
*
* @example
* const imagesData = await extractImages(pdf, pageNum)
*
* for (const imgData of imagesData) {
*   const imageIndex = totalImagesProcessed + 1
*   await sharp(imgData.data, {
*     raw: { width: imgData.width, height: imgData.height, channels: imgData.channels }
*   })
*     .png()
*     .toFile(`${imageIndex}.png`)
* }
*/
async function extractImages$1(data, pageNumber) {
  return await withDocument(data, async (pdf) => {
    if (pageNumber < 1 || pageNumber > pdf.numPages) throw new Error(`Invalid page number. Must be between 1 and ${pdf.numPages}.`);
    const page = await pdf.getPage(pageNumber);
    const operatorList = await page.getOperatorList();
    const { OPS } = await getResolvedPDFJS();
    const images = [];
    for (let i = 0; i < operatorList.fnArray.length; i++) {
      if (operatorList.fnArray[i] !== OPS.paintImageXObject) continue;
      const imageKey = operatorList.argsArray[i][0];
      const image = await new Promise((resolve) => (imageKey.startsWith("g_") ? page.commonObjs : page.objs).get(imageKey, resolve));
      if (!image || !image.data || !image.width || !image.height) continue;
      const { width, height, data } = image;
      const calculatedChannels = data.length / (width * height);
      if (![
        1,
        3,
        4
      ].includes(calculatedChannels)) continue;
      const channels = calculatedChannels;
      images.push({
        data,
        width,
        height,
        channels,
        key: imageKey
      });
    }
    return images;
  });
}
async function renderPageAsImage$1(data, pageNumber, options = {}) {
  const CanvasFactory = await createIsomorphicCanvasFactory(options.canvasImport);
  return await withDocument(data, async (pdf) => {
    if (pageNumber < 1 || pageNumber > pdf.numPages) throw new Error(`Invalid page number. Must be between 1 and ${pdf.numPages}.`);
    const page = await pdf.getPage(pageNumber);
    const defaultViewport = page.getViewport({ scale: 1 });
    let scale = options.scale || 1;
    if (options.width) scale = options.width / defaultViewport.width;
    else if (options.height) scale = options.height / defaultViewport.height;
    const viewport = page.getViewport({ scale: Math.max(0, scale) });
    const canvasFactory = new CanvasFactory();
    const drawingContext = canvasFactory.create(viewport.width, viewport.height);
    try {
      await page.render({
        canvas: drawingContext.canvas,
        canvasContext: drawingContext.context,
        viewport
      }).promise;
      const { canvas } = drawingContext;
      if (options.toDataURL) return canvas.toDataURL();
      if ("encode" in canvas) {
        const buffer = await canvas.encode("png");
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      }
      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve);
      });
      if (!blob) throw new Error("Failed to encode canvas to a PNG blob.");
      return await blob.arrayBuffer();
    } finally {
      canvasFactory.destroy(drawingContext);
    }
  }, { CanvasFactory });
}
async function createIsomorphicCanvasFactory(canvasImport) {
  if (isBrowser) return DOMCanvasFactory;
  if (isNode) {
    if (!canvasImport) throw new Error("Parameter \"canvasImport\" is required in Node.js environment.");
    await resolveCanvasModule(canvasImport);
    injectCanvasConstructors();
    return NodeCanvasFactory;
  }
  throw new Error("Unsupported environment for canvas creation.");
}
//#endregion
//#region src/links.ts
async function extractLinks$1(data) {
  return await withDocument(data, async (pdf) => {
    const pageLinks = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => getPageLinks(pdf, i + 1)));
    return {
      totalPages: pdf.numPages,
      links: pageLinks.flat()
    };
  });
}
async function getPageLinks(document, pageNumber) {
  const annotations = await (await document.getPage(pageNumber)).getAnnotations();
  const links = [];
  for (const annotation of annotations) if (annotation.subtype === "Link" && annotation.url) links.push(annotation.url);
  return links;
}
//#endregion
//#region src/meta.ts
const XMP_DATE_PROPERTIES = [
  "xmp:createdate",
  "xmp:modifydate",
  "xmp:metadatadate",
  "xap:createdate",
  "xap:modifydate",
  "xap:metadatadate"
];
async function getMeta$1(data, options = {}) {
  return await withDocument(data, async (pdf) => {
    const meta = await pdf.getMetadata();
    const info = meta?.info || {};
    if (options.parseDates) {
      const { PDFDateString } = await getResolvedPDFJS();
      if (info?.CreationDate) info.CreationDate = PDFDateString.toDateObject(info?.CreationDate);
      if (info?.ModDate) info.ModDate = PDFDateString.toDateObject(info?.ModDate);
      if (meta.metadata) meta.metadata = new Proxy(meta.metadata, { get(target, prop) {
        if (prop === "get") return (name) => {
          const value = target.get(name);
          if (XMP_DATE_PROPERTIES.includes(name) && value) return parseISODateString(value);
          return value;
        };
        return target[prop];
      } });
    }
    return {
      info,
      metadata: meta?.metadata || {}
    };
  });
}
function parseISODateString(isoDateString) {
  if (!isoDateString) return;
  const parsedDate = Date.parse(isoDateString);
  if (!Number.isNaN(parsedDate)) return new Date(parsedDate);
}
//#endregion
//#region src/text.ts
async function extractTextItems$1(data) {
  return await withDocument(data, async (pdf) => {
    const items = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => getPageTextItems(pdf, i + 1)));
    return {
      totalPages: pdf.numPages,
      items
    };
  });
}
async function getPageTextItems(document, pageNumber) {
  const content = await (await document.getPage(pageNumber)).getTextContent();
  const styles = content.styles;
  return content.items.filter((item) => item.str != null).map((item) => {
    const [_a, _b, c, d, e, f] = item.transform;
    return {
      str: item.str,
      x: e,
      y: f,
      width: item.width,
      height: item.height,
      fontSize: Math.hypot(c, d),
      fontFamily: styles[item.fontName]?.fontFamily ?? "",
      dir: item.dir,
      hasEOL: item.hasEOL
    };
  });
}
async function extractText$1(data, options = {}) {
  const { mergePages = false } = options;
  return await withDocument(data, async (pdf) => {
    const texts = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => getPageText(pdf, i + 1)));
    return {
      totalPages: pdf.numPages,
      text: mergePages ? normalizeMergedText(texts) : texts
    };
  });
}
async function getPageText(document, pageNumber) {
  return (await (await document.getPage(pageNumber)).getTextContent()).items.filter((item) => item.str != null).map((item) => item.str + (item.hasEOL ? "\n" : "")).join("");
}
/**
* Collapses whitespace without destroying the line structure: `hasEOL` and
* page-join line breaks survive, but at most one blank line remains.
*/
function normalizeMergedText(texts) {
  return texts.join("\n").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
}
//#endregion
//#region src/config.ts
/**
* By default, unpdf will use the latest version of PDF.js compiled for
* serverless environments. If you want to use a different version, you can
* provide a custom resolver function.
*
* @example
* // Use the official PDF.js build (make sure to install it first)
* import { definePDFJSModule } from 'unpdf'
*
* await definePDFJSModule(() => import('pdfjs-dist'))
*/
async function definePDFJSModule(pdfjs) {
  await resolvePDFJSImport(pdfjs, { reload: true });
}
/** @deprecated Use `definePDFJSModule` instead. Will be removed in v2. */
async function configureUnPDF(options) {
  await resolvePDFJSImport(options.pdfjs, { reload: true });
}
//#endregion
//#region src/index.ts
const getMeta = async (...args) => {
  await resolvePDFJSImport();
  return await getMeta$1(...args);
};
const extractText = async (...args) => {
  await resolvePDFJSImport();
  return await extractText$1(...args);
};
const extractTextItems = async (...args) => {
  await resolvePDFJSImport();
  return await extractTextItems$1(...args);
};
const extractImages = async (...args) => {
  await resolvePDFJSImport();
  return await extractImages$1(...args);
};
const renderPageAsImage = async (...args) => {
  await resolvePDFJSImport();
  return await renderPageAsImage$1(...args);
};
const extractLinks = async (...args) => {
  await resolvePDFJSImport();
  return await extractLinks$1(...args);
};
//#endregion
exports.configureUnPDF = configureUnPDF;
exports.createIsomorphicCanvasFactory = createIsomorphicCanvasFactory;
exports.definePDFJSModule = definePDFJSModule;
exports.extractImages = extractImages;
exports.extractLinks = extractLinks;
exports.extractText = extractText;
exports.extractTextItems = extractTextItems;
exports.getDocumentProxy = getDocumentProxy;
exports.getMeta = getMeta;
exports.getResolvedPDFJS = getResolvedPDFJS;
exports.renderPageAsImage = renderPageAsImage;
exports.resolvePDFJSImport = resolvePDFJSImport;
