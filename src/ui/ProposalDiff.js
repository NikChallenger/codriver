const { diffTokenArrays, structuredPatch } = require("../vendor/jsdiff/structuredPatch");

const DEFAULT_DIFF_TIMEOUT_MS = 150;
const DEFAULT_MAX_EDIT_LENGTH = 4096;
const DEFAULT_MAX_LINE_PAIR_PRODUCT = 40000;
const DEFAULT_TEXT_CHANGE_CONTEXT_LINES = 2;

function createInlineDiff(before, after) {
  const beforeTokens = tokenizeDiffText(before);
  const afterTokens = tokenizeDiffText(after);

  if (beforeTokens.length === 0 && afterTokens.length === 0) {
    return {
      beforeTokens: [],
      afterTokens: []
    };
  }

  if (beforeTokens.length * afterTokens.length > DEFAULT_MAX_LINE_PAIR_PRODUCT) {
    return {
      beforeTokens: beforeTokens.map((value) => ({ type: "removed", value })),
      afterTokens: afterTokens.map((value) => ({ type: "added", value }))
    };
  }

  const changes = diffTokenArrays(beforeTokens, afterTokens, {
    timeout: DEFAULT_DIFF_TIMEOUT_MS,
    maxEditLength: DEFAULT_MAX_EDIT_LENGTH
  });
  if (!changes) {
    return {
      beforeTokens: beforeTokens.map((value) => ({ type: "removed", value })),
      afterTokens: afterTokens.map((value) => ({ type: "added", value }))
    };
  }

  const beforeDiff = [];
  const afterDiff = [];

  for (const change of changes) {
    if (change.added) {
      appendInlineTokens(afterDiff, "added", change.value);
      continue;
    }

    if (change.removed) {
      appendInlineTokens(beforeDiff, "removed", change.value);
      continue;
    }

    for (const value of tokenizeDiffText(change.value)) {
      const token = { type: "equal", value };
      beforeDiff.push(token);
      afterDiff.push(token);
    }
  }

  return {
    beforeTokens: beforeDiff,
    afterTokens: afterDiff
  };
}

function createUnifiedDiffRows(before, after, options = {}) {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  const oldStartLineNumber = normalizeStartLineNumber(options.oldStartLineNumber);
  const newStartLineNumber = normalizeStartLineNumber(options.newStartLineNumber);

  if (beforeLines.length === 0 && afterLines.length === 0) {
    return [];
  }

  const maxLinePairProduct = options.maxLinePairProduct ?? DEFAULT_MAX_LINE_PAIR_PRODUCT;
  if (beforeLines.length * afterLines.length > maxLinePairProduct) {
    return createFallbackUnifiedDiffRows(beforeLines, afterLines, oldStartLineNumber, newStartLineNumber);
  }

  const patch = structuredPatch(
    "current",
    "proposed",
    String(before),
    String(after),
    undefined,
    undefined,
    {
      context: options.context ?? Number.MAX_SAFE_INTEGER,
      timeout: options.timeout ?? DEFAULT_DIFF_TIMEOUT_MS,
      maxEditLength: options.maxEditLength ?? DEFAULT_MAX_EDIT_LENGTH
    }
  );

  if (!patch) {
    return createFallbackUnifiedDiffRows(beforeLines, afterLines, oldStartLineNumber, newStartLineNumber);
  }

  const rows = createUnifiedRowsFromPatch(patch, {
    includeNoNewlineMetadata: hasTrailingNewline(before) !== hasTrailingNewline(after),
    oldStartLineNumber,
    newStartLineNumber
  });
  if (rows.length > 0) {
    return rows;
  }

  if (String(before) === String(after)) {
    return beforeLines.map((content, index) => createEqualRow(
      oldStartLineNumber + index,
      newStartLineNumber + index,
      content
    ));
  }

  return createFallbackUnifiedDiffRows(beforeLines, afterLines, oldStartLineNumber, newStartLineNumber);
}

function createUnifiedRowsFromPatch(patch, options = {}) {
  const rows = [];
  for (const hunk of patch.hunks ?? []) {
    let oldLineNumber = hunk.oldStart + options.oldStartLineNumber - 1;
    let newLineNumber = hunk.newStart + options.newStartLineNumber - 1;
    for (const line of hunk.lines ?? []) {
      if (line.startsWith("\\ ")) {
        if (options.includeNoNewlineMetadata) {
          rows.push(createMetaRow(line.slice(2)));
        }
        continue;
      }

      const marker = line.slice(0, 1);
      const content = line.slice(1);
      if (marker === "-") {
        rows.push(createRemovedRow(oldLineNumber, content));
        oldLineNumber += 1;
        continue;
      }

      if (marker === "+") {
        rows.push(createAddedRow(newLineNumber, content));
        newLineNumber += 1;
        continue;
      }

      rows.push(createEqualRow(oldLineNumber, newLineNumber, content));
      oldLineNumber += 1;
      newLineNumber += 1;
    }
  }

  return rows;
}

function createUnifiedTextChangeRows(currentContent, changes, options = {}) {
  const normalizedChanges = normalizeTextChanges(changes);
  if (normalizedChanges.length === 0) {
    return null;
  }

  const ranges = findTextChangeRanges(String(currentContent), normalizedChanges);
  if (!ranges) {
    return null;
  }

  const windows = createTextChangeWindows(
    String(currentContent),
    ranges,
    options.context ?? DEFAULT_TEXT_CHANGE_CONTEXT_LINES
  );
  if (windows.length === 0) {
    return null;
  }

  return windows.flatMap((window) => {
    const beforeSnippet = String(currentContent).slice(window.start, window.end);
    let afterSnippet = beforeSnippet;
    for (const range of window.ranges.slice().reverse()) {
      const localStart = range.start - window.start;
      const localEnd = range.end - window.start;
      afterSnippet = [
        afterSnippet.slice(0, localStart),
        range.after,
        afterSnippet.slice(localEnd)
      ].join("");
    }

    return createUnifiedDiffRows(beforeSnippet, afterSnippet, {
      ...options,
      oldStartLineNumber: window.oldStartLineNumber,
      newStartLineNumber: window.newStartLineNumber,
      context: Number.MAX_SAFE_INTEGER
    });
  });
}

function createFallbackUnifiedDiffRows(beforeLines, afterLines, oldStartLineNumber, newStartLineNumber) {
  return [
    ...beforeLines.map((content, index) => createRemovedRow(oldStartLineNumber + index, content)),
    ...afterLines.map((content, index) => createAddedRow(newStartLineNumber + index, content))
  ];
}

function createEqualRow(oldLineNumber, newLineNumber, content) {
  return {
    type: "equal",
    oldLineNumber,
    newLineNumber,
    marker: " ",
    content
  };
}

function createRemovedRow(oldLineNumber, content) {
  return {
    type: "removed",
    oldLineNumber,
    newLineNumber: null,
    marker: "-",
    content
  };
}

function createAddedRow(newLineNumber, content) {
  return {
    type: "added",
    oldLineNumber: null,
    newLineNumber,
    marker: "+",
    content
  };
}

function createMetaRow(content) {
  return {
    type: "meta",
    oldLineNumber: null,
    newLineNumber: null,
    marker: "\\",
    content
  };
}

function appendInlineTokens(target, type, value) {
  for (const token of tokenizeDiffText(value)) {
    target.push({ type, value: token });
  }
}

function tokenizeDiffText(text) {
  return String(text).match(/\s+|[^\s]+/g) ?? [];
}

function hasTrailingNewline(value) {
  return String(value).endsWith("\n") || String(value).endsWith("\r");
}

function splitDiffLines(text) {
  const value = String(text);
  if (value.length === 0) {
    return [];
  }

  return value.split(/\r\n|\n|\r/);
}

function normalizeStartLineNumber(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function normalizeTextChanges(changes) {
  if (!Array.isArray(changes)) {
    return [];
  }

  return changes
    .map((change) => {
      if (!change || typeof change.before !== "string" || typeof change.after !== "string") {
        return null;
      }

      return {
        before: change.before,
        after: change.after,
        contextBefore: typeof change.contextBefore === "string" ? change.contextBefore : "",
        contextAfter: typeof change.contextAfter === "string" ? change.contextAfter : ""
      };
    })
    .filter(Boolean);
}

function findTextChangeRanges(content, changes) {
  const ranges = changes.map((change) => findTextChangeRange(content, change));
  if (ranges.some((range) => !range)) {
    const fallbackRanges = findIdenticalExactReplacementRanges(content, changes);
    if (fallbackRanges) {
      return fallbackRanges;
    }

    return null;
  }

  const sortedRanges = ranges.slice().sort((left, right) => left.start - right.start);
  for (let index = 1; index < sortedRanges.length; index += 1) {
    if (sortedRanges[index].start < sortedRanges[index - 1].end) {
      return null;
    }
  }

  return sortedRanges;
}

function findTextChangeRange(content, change) {
  if (change.before.length === 0) {
    return null;
  }

  const matches = findTextMatches(content, change.before)
    .filter((start) => matchesContext(content, start, change.before, change.contextBefore, change.contextAfter));
  if (matches.length !== 1) {
    return null;
  }

  return {
    start: matches[0],
    end: matches[0] + change.before.length,
    before: change.before,
    after: change.after
  };
}

function findIdenticalExactReplacementRanges(content, changes) {
  if (!canUseIdenticalExactReplacementFallback(changes)) {
    return null;
  }

  const before = changes[0].before;
  const after = changes[0].after;
  const matches = findTextMatches(content, before);
  if (matches.length !== changes.length) {
    return null;
  }

  return matches.map((start) => ({
    start,
    end: start + before.length,
    before,
    after
  }));
}

function canUseIdenticalExactReplacementFallback(changes) {
  if (changes.length < 2 || changes[0].before.length === 0) {
    return false;
  }

  const first = changes[0];
  return changes.every((change) => (
    change.before === first.before &&
    change.after === first.after &&
    !change.contextBefore &&
    !change.contextAfter
  ));
}

function matchesContext(content, start, before, contextBefore, contextAfter) {
  if (contextBefore) {
    if (start < contextBefore.length) {
      return false;
    }

    if (content.slice(start - contextBefore.length, start) !== contextBefore) {
      return false;
    }
  }

  const end = start + before.length;
  return !contextAfter || content.slice(end, end + contextAfter.length) === contextAfter;
}

function findTextMatches(content, searchText) {
  const matches = [];
  let startIndex = 0;

  while (startIndex <= content.length) {
    const matchIndex = content.indexOf(searchText, startIndex);
    if (matchIndex === -1) {
      break;
    }

    matches.push(matchIndex);
    startIndex = matchIndex + Math.max(searchText.length, 1);
  }

  return matches;
}

function createTextChangeWindows(content, ranges, contextLines) {
  const lines = getLineRanges(content);
  const normalizedContextLines = Math.max(0, Math.floor(Number(contextLines) || 0));
  const windows = [];

  for (const range of ranges) {
    const startLineIndex = getLineIndexForOffset(lines, range.start);
    const endLineIndex = getLineIndexForOffset(lines, Math.max(range.start, range.end - 1));
    const contextStartLineIndex = Math.max(0, startLineIndex - normalizedContextLines);
    const contextEndLineIndex = Math.min(lines.length - 1, endLineIndex + normalizedContextLines);
    const start = lines[contextStartLineIndex]?.start ?? 0;
    const end = lines[contextEndLineIndex]?.end ?? content.length;
    const previousWindow = windows[windows.length - 1];

    if (previousWindow && start <= previousWindow.end) {
      previousWindow.end = Math.max(previousWindow.end, end);
      previousWindow.endLineIndex = Math.max(previousWindow.endLineIndex, contextEndLineIndex);
      previousWindow.ranges.push(range);
      continue;
    }

    windows.push({
      start,
      end,
      startLineIndex: contextStartLineIndex,
      endLineIndex: contextEndLineIndex,
      ranges: [range]
    });
  }

  let lineDelta = 0;
  return windows.map((window) => {
    const result = {
      ...window,
      oldStartLineNumber: window.startLineIndex + 1,
      newStartLineNumber: window.startLineIndex + lineDelta + 1
    };

    lineDelta += window.ranges.reduce((total, range) => (
      total + countLineBreaks(range.after) - countLineBreaks(range.before)
    ), 0);
    return result;
  });
}

function getLineRanges(content) {
  if (content.length === 0) {
    return [{ start: 0, end: 0 }];
  }

  const lines = [];
  let start = 0;
  while (start < content.length) {
    const newlineIndex = content.indexOf("\n", start);
    const end = newlineIndex === -1 ? content.length : newlineIndex + 1;
    lines.push({ start, end });

    if (newlineIndex === -1) {
      break;
    }

    start = end;
  }

  return lines;
}

function getLineIndexForOffset(lines, offset) {
  for (let index = 0; index < lines.length; index += 1) {
    if (offset < lines[index].end) {
      return index;
    }
  }

  return Math.max(0, lines.length - 1);
}

function countLineBreaks(value) {
  return (String(value).match(/\r\n|\n|\r/g) ?? []).length;
}
module.exports = {
  createInlineDiff,
  createUnifiedDiffRows,
  createUnifiedTextChangeRows
};
