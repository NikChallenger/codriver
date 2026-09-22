const DIAGNOSTIC_SHARE_FILENAME = "codriver-diagnostics.log";

function createDiagnosticLogFile(content, FileConstructor = globalThis.File) {
  if (typeof FileConstructor !== "function") {
    return null;
  }

  return new FileConstructor([content], DIAGNOSTIC_SHARE_FILENAME, {
    type: "text/plain"
  });
}

function canShareDiagnosticLogFile(navigatorObject, file) {
  if (
    !file ||
    typeof navigatorObject?.share !== "function" ||
    typeof navigatorObject?.canShare !== "function"
  ) {
    return false;
  }

  try {
    return navigatorObject.canShare({ files: [file] }) === true;
  } catch {
    return false;
  }
}

function startDiagnosticLogFileShare(navigatorObject, file, callbacks = {}) {
  let shareResult;
  try {
    shareResult = navigatorObject.share({
      title: "CoDriver diagnostic log",
      files: [file]
    });
  } catch (error) {
    callbacks.onError?.(error);
    return;
  }

  void Promise.resolve(shareResult)
    .then(() => callbacks.onShared?.())
    .catch((error) => {
      if (!isDiagnosticShareCancellation(error)) {
        callbacks.onError?.(error);
      }
    });
}

async function copyDiagnosticLog(navigatorObject, content) {
  if (typeof navigatorObject?.clipboard?.writeText !== "function") {
    return false;
  }

  try {
    await navigatorObject.clipboard.writeText(content);
    return true;
  } catch {
    return false;
  }
}

function isDiagnosticShareCancellation(error) {
  return error?.name === "AbortError";
}

module.exports = {
  DIAGNOSTIC_SHARE_FILENAME,
  canShareDiagnosticLogFile,
  copyDiagnosticLog,
  createDiagnosticLogFile,
  isDiagnosticShareCancellation,
  startDiagnosticLogFileShare
};
