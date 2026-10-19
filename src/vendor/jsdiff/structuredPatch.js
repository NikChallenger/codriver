/*
 * Minimal CommonJS subset adapted from kpdecker/jsdiff v9.0.0.
 * Source project: https://github.com/kpdecker/jsdiff
 * License: BSD-3-Clause. See src/vendor/jsdiff/LICENSE.
 * Source tag: ed13aca03aa25735fafc0645d1185e7a1c68fd8c.
 *
 * BSD 3-Clause License
 *
 * Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

function diffLines(oldStr, newStr, options = {}) {
  const normalizedOptions = typeof options === "function" ? { callback: options } : { ...options };
  const callback = normalizedOptions.callback;
  const oldTokens = removeEmpty(tokenizeLines(String(oldStr), normalizedOptions));
  const newTokens = removeEmpty(tokenizeLines(String(newStr), normalizedOptions));
  return diffTokenArrays(oldTokens, newTokens, normalizedOptions, callback);
}

function diffTokenArrays(oldTokens, newTokens, options = {}, callback = undefined) {
  const done = (value) => {
    if (callback) {
      setTimeout(() => callback(value), 0);
      return undefined;
    }

    return value;
  };
  const newLen = newTokens.length;
  const oldLen = oldTokens.length;
  let editLength = 1;
  let maxEditLength = newLen + oldLen;
  if (options.maxEditLength != null) {
    maxEditLength = Math.min(maxEditLength, options.maxEditLength);
  }
  const maxExecutionTime = options.timeout ?? Infinity;
  const abortAfterTimestamp = Date.now() + maxExecutionTime;
  const bestPath = [{ oldPos: -1, lastComponent: undefined }];
  let newPos = extractCommon(bestPath[0], newTokens, oldTokens, 0, options);

  if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
    return done(buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
  }

  let minDiagonalToConsider = -Infinity;
  let maxDiagonalToConsider = Infinity;
  const execEditLength = () => {
    for (
      let diagonalPath = Math.max(minDiagonalToConsider, -editLength);
      diagonalPath <= Math.min(maxDiagonalToConsider, editLength);
      diagonalPath += 2
    ) {
      let basePath;
      const removePath = bestPath[diagonalPath - 1];
      const addPath = bestPath[diagonalPath + 1];
      if (removePath) {
        bestPath[diagonalPath - 1] = undefined;
      }

      let canAdd = false;
      if (addPath) {
        const addPathNewPos = addPath.oldPos - diagonalPath;
        canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
      }
      const canRemove = removePath && removePath.oldPos + 1 < oldLen;

      if (!canAdd && !canRemove) {
        bestPath[diagonalPath] = undefined;
        continue;
      }

      if (!canRemove || (canAdd && removePath.oldPos < addPath.oldPos)) {
        basePath = addToPath(addPath, true, false, 0, options);
      } else {
        basePath = addToPath(removePath, false, true, 1, options);
      }

      newPos = extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
      if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
        return done(buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
      }

      bestPath[diagonalPath] = basePath;
      if (basePath.oldPos + 1 >= oldLen) {
        maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
      }
      if (newPos + 1 >= newLen) {
        minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
      }
    }

    editLength += 1;
    return false;
  };

  if (callback) {
    (function exec() {
      setTimeout(() => {
        if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
          callback(undefined);
          return;
        }
        if (!execEditLength()) {
          exec();
        }
      }, 0);
    }());
    return undefined;
  }

  while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
    const ret = execEditLength();
    if (ret) {
      return ret;
    }
  }

  return undefined;
}

function structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader = undefined, newHeader = undefined, options = {}) {
  const optionsObj = typeof options === "function" ? { callback: options } : { ...options };
  if (typeof optionsObj.context === "undefined") {
    optionsObj.context = 4;
  }
  if (optionsObj.newlineIsToken) {
    throw new Error("newlineIsToken may not be used with patch-generation functions, only with diffing functions");
  }

  if (!optionsObj.callback) {
    return diffLinesResultToPatch(
      diffLines(oldStr, newStr, optionsObj),
      oldFileName,
      newFileName,
      oldHeader,
      newHeader,
      optionsObj.context
    );
  }

  const callback = optionsObj.callback;
  diffLines(oldStr, newStr, {
    ...optionsObj,
    callback: (diff) => {
      callback(diffLinesResultToPatch(diff, oldFileName, newFileName, oldHeader, newHeader, optionsObj.context));
    }
  });
  return undefined;
}

function diffLinesResultToPatch(diff, oldFileName, newFileName, oldHeader, newHeader, context) {
  if (!diff) {
    return undefined;
  }

  diff.push({ value: "", lines: [] });
  const hunks = [];
  let oldRangeStart = 0;
  let newRangeStart = 0;
  let curRange = [];
  let oldLine = 1;
  let newLine = 1;

  for (let i = 0; i < diff.length; i += 1) {
    const current = diff[i];
    const lines = current.lines || splitPatchLines(current.value);
    current.lines = lines;
    if (current.added || current.removed) {
      if (!oldRangeStart) {
        const prev = diff[i - 1];
        oldRangeStart = oldLine;
        newRangeStart = newLine;
        if (prev) {
          curRange = context > 0 ? contextLines(prev.lines.slice(-context)) : [];
          oldRangeStart -= curRange.length;
          newRangeStart -= curRange.length;
        }
      }

      for (const line of lines) {
        curRange.push(`${current.added ? "+" : "-"}${line}`);
      }

      if (current.added) {
        newLine += lines.length;
      } else {
        oldLine += lines.length;
      }
      continue;
    }

    if (oldRangeStart) {
      if (lines.length <= context * 2 && i < diff.length - 2) {
        for (const line of contextLines(lines)) {
          curRange.push(line);
        }
      } else {
        const contextSize = Math.min(lines.length, context);
        for (const line of contextLines(lines.slice(0, contextSize))) {
          curRange.push(line);
        }
        hunks.push({
          oldStart: oldRangeStart,
          oldLines: oldLine - oldRangeStart + contextSize,
          newStart: newRangeStart,
          newLines: newLine - newRangeStart + contextSize,
          lines: curRange
        });
        oldRangeStart = 0;
        newRangeStart = 0;
        curRange = [];
      }
    }

    oldLine += lines.length;
    newLine += lines.length;
  }

  for (const hunk of hunks) {
    for (let i = 0; i < hunk.lines.length; i += 1) {
      if (hunk.lines[i].endsWith("\n")) {
        hunk.lines[i] = hunk.lines[i].slice(0, -1);
      } else {
        hunk.lines.splice(i + 1, 0, "\\ No newline at end of file");
        i += 1;
      }
    }
  }

  return {
    oldFileName,
    newFileName,
    oldHeader,
    newHeader,
    hunks
  };
}

function addToPath(path, added, removed, oldPosInc, options) {
  const last = path.lastComponent;
  if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
    return {
      oldPos: path.oldPos + oldPosInc,
      lastComponent: {
        count: last.count + 1,
        added,
        removed,
        previousComponent: last.previousComponent
      }
    };
  }

  return {
    oldPos: path.oldPos + oldPosInc,
    lastComponent: {
      count: 1,
      added,
      removed,
      previousComponent: last
    }
  };
}

function extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
  const newLen = newTokens.length;
  const oldLen = oldTokens.length;
  let oldPos = basePath.oldPos;
  let newPos = oldPos - diagonalPath;
  let commonCount = 0;
  while (
    newPos + 1 < newLen &&
    oldPos + 1 < oldLen &&
    equalsTokens(oldTokens[oldPos + 1], newTokens[newPos + 1], options)
  ) {
    newPos += 1;
    oldPos += 1;
    commonCount += 1;
    if (options.oneChangePerToken) {
      basePath.lastComponent = {
        count: 1,
        previousComponent: basePath.lastComponent,
        added: false,
        removed: false
      };
    }
  }

  if (commonCount && !options.oneChangePerToken) {
    basePath.lastComponent = {
      count: commonCount,
      previousComponent: basePath.lastComponent,
      added: false,
      removed: false
    };
  }
  basePath.oldPos = oldPos;
  return newPos;
}

function equalsTokens(left, right, options) {
  if (options.ignoreWhitespace) {
    if (!options.newlineIsToken || !left.includes("\n")) {
      left = left.trim();
    }
    if (!options.newlineIsToken || !right.includes("\n")) {
      right = right.trim();
    }
  } else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
    if (left.endsWith("\n")) {
      left = left.slice(0, -1);
    }
    if (right.endsWith("\n")) {
      right = right.slice(0, -1);
    }
  }

  if (options.comparator) {
    return options.comparator(left, right);
  }
  return left === right || Boolean(options.ignoreCase && left.toLowerCase() === right.toLowerCase());
}

function buildValues(lastComponent, newTokens, oldTokens) {
  const components = [];
  let nextComponent;
  while (lastComponent) {
    components.push(lastComponent);
    nextComponent = lastComponent.previousComponent;
    delete lastComponent.previousComponent;
    lastComponent = nextComponent;
  }
  components.reverse();

  let newPos = 0;
  let oldPos = 0;
  for (const component of components) {
    if (!component.removed) {
      component.value = newTokens.slice(newPos, newPos + component.count).join("");
      newPos += component.count;
      if (!component.added) {
        oldPos += component.count;
      }
    } else {
      component.value = oldTokens.slice(oldPos, oldPos + component.count).join("");
      oldPos += component.count;
    }
  }

  return components;
}

function tokenizeLines(value, options) {
  if (options.stripTrailingCr) {
    value = value.replace(/\r\n/g, "\n");
  }
  const retLines = [];
  const linesAndNewlines = value.split(/(\n|\r\n)/);
  if (!linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop();
  }

  for (let i = 0; i < linesAndNewlines.length; i += 1) {
    const line = linesAndNewlines[i];
    if (i % 2 && !options.newlineIsToken) {
      retLines[retLines.length - 1] += line;
    } else {
      retLines.push(line);
    }
  }

  return retLines;
}

function splitPatchLines(text) {
  const hasTrailingNewline = text.endsWith("\n");
  const result = text.split("\n").map((line) => `${line}\n`);
  if (hasTrailingNewline) {
    result.pop();
  } else {
    result.push(result.pop().slice(0, -1));
  }
  return result;
}

function contextLines(lines) {
  return lines.map((entry) => ` ${entry}`);
}

function removeEmpty(array) {
  const ret = [];
  for (const item of array) {
    if (item) {
      ret.push(item);
    }
  }
  return ret;
}

module.exports = {
  diffLines,
  diffTokenArrays,
  structuredPatch
};
