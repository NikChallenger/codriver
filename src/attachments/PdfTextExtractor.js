const unpdf = require("../vendor/unpdf/index");
const { UNPDF_PDFJS_MODULE_BASE64 } = require("../generated/vendorAssets");

let pdfJsModulePromise = null;
let unpdfConfiguredPromise = null;

async function extractPdfText(arrayBuffer) {
  await configureUnpdf();

  const pdf = await unpdf.getDocumentProxy(new Uint8Array(arrayBuffer));
  const result = await unpdf.extractText(pdf, { mergePages: true });

  return {
    totalPages: result.totalPages ?? 0,
    text: typeof result.text === "string" ? result.text : String(result.text ?? "")
  };
}

async function configureUnpdf() {
  if (!unpdfConfiguredPromise) {
    unpdfConfiguredPromise = unpdf.definePDFJSModule(loadPdfJsModule);
  }

  return unpdfConfiguredPromise;
}

async function loadPdfJsModule() {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import(createModuleUrl(UNPDF_PDFJS_MODULE_BASE64));
  }

  return pdfJsModulePromise;
}

function createModuleUrl(base64Source) {
  return `data:text/javascript;base64,${base64Source}`;
}

module.exports = {
  extractPdfText
};
