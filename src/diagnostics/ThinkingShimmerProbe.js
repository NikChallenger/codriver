const MAX_DIAGNOSTIC_STRING_LENGTH = 120;

function createThinkingShimmerRuntimeDetail(environment = globalThis, isMobileApp = false) {
  const navigatorObject = environment?.navigator;
  const userAgent = typeof navigatorObject?.userAgent === "string"
    ? navigatorObject.userAgent
    : "";

  return {
    platform: isMobileApp ? "mobile" : "desktop",
    documentVisibility: readBoundedString(environment?.document?.visibilityState),
    documentHidden: readBooleanOrNull(environment?.document?.hidden),
    reducedMotion: readMediaMatch(environment, "(prefers-reduced-motion: reduce)"),
    cssSupport: {
      backgroundClipText: readCssSupport(environment?.CSS, "background-clip", "text"),
      webkitBackgroundClipText: readCssSupport(environment?.CSS, "-webkit-background-clip", "text"),
      webkitTextFillTransparent: readCssSupport(environment?.CSS, "-webkit-text-fill-color", "transparent")
    },
    runtime: {
      androidMajor: readVersionMajor(userAgent, /\bAndroid\s+(\d+)/i),
      chromiumMajor: readVersionMajor(userAgent, /\b(?:Chrome|Chromium)\/(\d+)/i),
      webViewMarker: /(?:^|[;\s])wv(?:[;)\s]|$)/i.test(userAgent),
      devicePixelRatio: readRoundedNumber(environment?.devicePixelRatio)
    }
  };
}

function captureThinkingShimmerSnapshot(element, environment = globalThis) {
  const computedStyle = readComputedStyle(environment, element);
  const animations = readAnimations(element);
  const animation = animations[0] ?? null;
  const bounds = readBounds(element);

  return {
    connected: readBooleanOrNull(element?.isConnected),
    dimensions: {
      width: bounds ? readRoundedNumber(bounds.width) : null,
      height: bounds ? readRoundedNumber(bounds.height) : null
    },
    computedStyle: {
      animationName: readBoundedString(computedStyle?.animationName),
      animationDuration: readBoundedString(computedStyle?.animationDuration),
      animationIterationCount: readBoundedString(computedStyle?.animationIterationCount),
      animationPlayState: readBoundedString(computedStyle?.animationPlayState),
      backgroundClip: readBoundedString(computedStyle?.backgroundClip),
      webkitBackgroundClip: readBoundedString(computedStyle?.webkitBackgroundClip),
      webkitTextFillColor: readBoundedString(computedStyle?.webkitTextFillColor),
      backgroundImageApplied: hasAppliedBackgroundImage(computedStyle?.backgroundImage),
      backgroundPosition: readBoundedString(computedStyle?.backgroundPosition),
      display: readBoundedString(computedStyle?.display),
      visibility: readBoundedString(computedStyle?.visibility),
      opacity: readBoundedString(computedStyle?.opacity)
    },
    animation: {
      count: animations.length,
      currentTimeMs: readRoundedNumber(animation?.currentTime),
      playState: readBoundedString(animation?.playState)
    }
  };
}

function compareThinkingShimmerSnapshots(initialSnapshot, sampledSnapshot, elapsedMs) {
  const initialTime = initialSnapshot?.animation?.currentTimeMs;
  const sampledTime = sampledSnapshot?.animation?.currentTimeMs;
  const timeDelta = Number.isFinite(initialTime) && Number.isFinite(sampledTime)
    ? readRoundedNumber(sampledTime - initialTime)
    : null;
  const initialPosition = initialSnapshot?.computedStyle?.backgroundPosition ?? "";
  const sampledPosition = sampledSnapshot?.computedStyle?.backgroundPosition ?? "";

  return {
    elapsedMs: readRoundedNumber(elapsedMs),
    currentTimeDeltaMs: timeDelta,
    currentTimeAdvanced: Number.isFinite(timeDelta) ? timeDelta > 0 : null,
    backgroundPositionChanged: initialPosition && sampledPosition
      ? initialPosition !== sampledPosition
      : null,
    remainedConnected: sampledSnapshot?.connected
  };
}

function readComputedStyle(environment, element) {
  const reader = environment?.getComputedStyle;
  if (typeof reader !== "function" || !element) {
    return null;
  }

  try {
    return reader.call(environment, element);
  } catch {
    return null;
  }
}

function readAnimations(element) {
  if (!element || typeof element.getAnimations !== "function") {
    return [];
  }

  try {
    const animations = element.getAnimations();
    return Array.isArray(animations) ? animations : Array.from(animations ?? []);
  } catch {
    return [];
  }
}

function readBounds(element) {
  if (!element || typeof element.getBoundingClientRect !== "function") {
    return null;
  }

  try {
    return element.getBoundingClientRect();
  } catch {
    return null;
  }
}

function readMediaMatch(environment, query) {
  if (typeof environment?.matchMedia !== "function") {
    return null;
  }

  try {
    return Boolean(environment.matchMedia(query)?.matches);
  } catch {
    return null;
  }
}

function readCssSupport(cssObject, property, value) {
  if (typeof cssObject?.supports !== "function") {
    return null;
  }

  try {
    return Boolean(cssObject.supports(property, value));
  } catch {
    return null;
  }
}

function readVersionMajor(userAgent, pattern) {
  const match = pattern.exec(userAgent);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function readBooleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function readRoundedNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : null;
}

function readBoundedString(value) {
  return typeof value === "string"
    ? value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)
    : "";
}

function hasAppliedBackgroundImage(value) {
  return typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() !== "none";
}

module.exports = {
  captureThinkingShimmerSnapshot,
  compareThinkingShimmerSnapshots,
  createThinkingShimmerRuntimeDetail
};
