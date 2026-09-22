const AUDIO_ATTACHMENT_EXTENSIONS = new Set([
  "m4a",
  "mp3",
  "wav",
  "webm",
  "ogg",
  "flac"
]);

const DEFAULT_MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const DEFAULT_MAX_AUDIO_DURATION_MS = 30 * 60 * 1000;
const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream"]);
const AUDIO_MIME_TYPES = Object.freeze({
  m4a: new Set(["audio/mp4", "audio/m4a", "audio/x-m4a"]),
  mp3: new Set(["audio/mpeg", "audio/mp3", "audio/x-mp3"]),
  wav: new Set(["audio/wav", "audio/wave", "audio/x-wav"]),
  webm: new Set(["audio/webm"]),
  ogg: new Set(["audio/ogg", "application/ogg"]),
  flac: new Set(["audio/flac", "audio/x-flac"])
});

class AudioValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AudioValidationError";
    this.code = code;
  }
}

function inspectAudioBuffer(arrayBuffer, metadata = {}, options = {}) {
  const bytes = toUint8Array(arrayBuffer);
  const extension = normalizeAudioExtension(metadata.extension || getFileExtension(metadata.name));
  const mimeType = String(metadata.mimeType || metadata.type || "").trim().toLowerCase();
  const declaredSize = Number.isFinite(metadata.size) ? metadata.size : bytes.byteLength;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_AUDIO_DURATION_MS;

  if (!AUDIO_ATTACHMENT_EXTENSIONS.has(extension)) {
    throw new AudioValidationError(
      "unsupported-format",
      `CoDriver cannot transcribe .${extension || "unknown"} audio files.`
    );
  }

  if (declaredSize <= 0 || bytes.byteLength <= 0) {
    throw new AudioValidationError("empty-file", "The audio file is empty.");
  }

  if (declaredSize !== bytes.byteLength) {
    throw new AudioValidationError("file-changed", "The audio file changed before it was sent.");
  }

  if (declaredSize > maxBytes) {
    throw new AudioValidationError("file-too-large", `The audio file is larger than ${formatBytes(maxBytes)}.`);
  }

  validateMimeType(extension, mimeType);

  let inspected;
  try {
    inspected = inspectByExtension(extension, bytes);
  } catch (error) {
    if (error instanceof AudioValidationError) {
      throw error;
    }

    throw new AudioValidationError("malformed-audio", "The audio container is malformed or unreadable.");
  }

  if (!Number.isFinite(inspected.durationMs) || inspected.durationMs <= 0) {
    throw new AudioValidationError("duration-unavailable", "The audio duration could not be verified.");
  }

  if (inspected.durationMs > maxDurationMs) {
    throw new AudioValidationError(
      "duration-too-long",
      `The audio recording is longer than ${formatDuration(maxDurationMs)}.`
    );
  }

  return {
    extension,
    mimeType,
    size: declaredSize,
    container: inspected.container,
    codec: inspected.codec,
    fragmented: inspected.fragmented === true,
    durationMs: Math.round(inspected.durationMs)
  };
}

function inspectByExtension(extension, bytes) {
  if (extension === "wav") {
    return inspectWav(bytes);
  }
  if (extension === "flac") {
    return inspectFlac(bytes);
  }
  if (extension === "mp3") {
    return inspectMp3(bytes);
  }
  if (extension === "ogg") {
    return inspectOgg(bytes);
  }
  if (extension === "webm") {
    return inspectWebm(bytes);
  }
  if (extension === "m4a") {
    return inspectM4a(bytes);
  }

  throw new AudioValidationError("unsupported-format", "The audio format is unsupported.");
}

function inspectWav(bytes) {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw mismatchError("WAV");
  }

  let offset = 12;
  let audioFormat = 0;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkSize = readUint32LE(bytes, offset + 4);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + chunkSize;
    if (chunkEnd > bytes.length) {
      throw malformedError();
    }

    if (chunkType === "fmt ") {
      if (chunkSize < 16) {
        throw malformedError();
      }
      audioFormat = readUint16LE(bytes, dataOffset);
      byteRate = readUint32LE(bytes, dataOffset + 8);
    } else if (chunkType === "data") {
      dataSize += chunkSize;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new AudioValidationError("unsupported-codec", "The WAV file must use PCM or IEEE-float audio.");
  }
  if (byteRate <= 0 || dataSize <= 0) {
    throw malformedError();
  }

  return {
    container: "wav",
    codec: audioFormat === 1 ? "pcm" : "ieee-float",
    durationMs: (dataSize / byteRate) * 1000
  };
}

function inspectFlac(bytes) {
  if (ascii(bytes, 0, 4) !== "fLaC") {
    throw mismatchError("FLAC");
  }
  if (bytes.length <= 42 || (bytes[4] & 0x7f) !== 0 || readUint24BE(bytes, 5) !== 34) {
    throw malformedError();
  }

  const streamInfo = 8;
  const packedHigh = readUint32BE(bytes, streamInfo + 10);
  const packedLow = readUint32BE(bytes, streamInfo + 14);
  const sampleRate = packedHigh >>> 12;
  const totalSamplesHigh = packedHigh & 0x0f;
  const totalSamples = totalSamplesHigh * 0x100000000 + packedLow;
  if (sampleRate <= 0 || totalSamples <= 0) {
    throw new AudioValidationError("duration-unavailable", "The FLAC duration could not be verified.");
  }

  return {
    container: "flac",
    codec: "flac",
    durationMs: (totalSamples / sampleRate) * 1000
  };
}

function inspectMp3(bytes) {
  let offset = readId3v2Size(bytes);
  let foundFrame = false;
  let durationSeconds = 0;
  let frameCount = 0;

  while (offset + 4 <= bytes.length) {
    if (isId3v1Tag(bytes, offset) || isPadding(bytes, offset)) {
      break;
    }

    const frame = readMp3Frame(bytes, offset);
    if (!frame) {
      if (!foundFrame) {
        offset += 1;
        continue;
      }
      throw malformedError();
    }

    foundFrame = true;
    frameCount += 1;
    durationSeconds += frame.samplesPerFrame / frame.sampleRate;
    offset += frame.frameLength;
  }

  if (!foundFrame || frameCount < 1 || durationSeconds <= 0) {
    throw mismatchError("MP3");
  }

  return {
    container: "mp3",
    codec: "mpeg-layer-iii",
    durationMs: durationSeconds * 1000
  };
}

function readMp3Frame(bytes, offset) {
  if (offset + 4 > bytes.length) {
    return null;
  }
  const header = readUint32BE(bytes, offset);
  if ((header >>> 21) !== 0x7ff) {
    return null;
  }

  const versionBits = (header >>> 19) & 0x03;
  const layerBits = (header >>> 17) & 0x03;
  const bitrateIndex = (header >>> 12) & 0x0f;
  const sampleRateIndex = (header >>> 10) & 0x03;
  const padding = (header >>> 9) & 0x01;
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return null;
  }

  const mpeg1 = versionBits === 3;
  const bitrateTable = mpeg1
    ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrateKbps = bitrateTable[bitrateIndex - 1];
  const sampleRateBase = [44100, 48000, 32000][sampleRateIndex];
  const sampleRate = versionBits === 3
    ? sampleRateBase
    : (versionBits === 2 ? sampleRateBase / 2 : sampleRateBase / 4);
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  const frameLength = Math.floor(((mpeg1 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding;
  if (frameLength <= 4 || offset + frameLength > bytes.length) {
    return null;
  }

  return { frameLength, sampleRate, samplesPerFrame };
}

function inspectOgg(bytes) {
  const streams = new Map();
  let offset = 0;
  while (offset + 27 <= bytes.length) {
    if (ascii(bytes, offset, 4) !== "OggS" || bytes[offset + 4] !== 0) {
      throw mismatchError("Ogg");
    }

    const granule = readUint64LE(bytes, offset + 6);
    const serial = readUint32LE(bytes, offset + 14);
    const segmentCount = bytes[offset + 26];
    const segmentTableStart = offset + 27;
    const bodyStart = segmentTableStart + segmentCount;
    if (bodyStart > bytes.length) {
      throw malformedError();
    }

    let bodyLength = 0;
    for (let index = 0; index < segmentCount; index += 1) {
      bodyLength += bytes[segmentTableStart + index];
    }
    if (bodyStart + bodyLength > bytes.length) {
      throw malformedError();
    }

    const stream = streams.get(serial) || {
      packetParts: [],
      packetLength: 0,
      codec: "",
      sampleRate: 0,
      preSkip: 0,
      lastGranule: 0,
      mediaBytes: 0
    };
    let bodyOffset = bodyStart;
    for (let index = 0; index < segmentCount; index += 1) {
      const partLength = bytes[segmentTableStart + index];
      const part = bytes.slice(bodyOffset, bodyOffset + partLength);
      bodyOffset += partLength;
      if (!stream.codec) {
        stream.packetParts.push(part);
        stream.packetLength += part.length;
        if (partLength < 255) {
          identifyOggStream(stream, concatBytes(stream.packetParts, stream.packetLength));
          stream.packetParts = [];
          stream.packetLength = 0;
        }
      } else {
        stream.mediaBytes += part.length;
      }
    }
    if (granule >= 0) {
      stream.lastGranule = granule;
    }
    streams.set(serial, stream);
    offset = bodyStart + bodyLength;
  }

  if (offset !== bytes.length || streams.size !== 1) {
    throw new AudioValidationError("unsupported-codec", "The Ogg file must contain one supported audio stream.");
  }

  const stream = streams.values().next().value;
  if (!stream.codec || stream.sampleRate <= 0 || stream.lastGranule <= 0 || stream.mediaBytes <= 0) {
    throw malformedError();
  }
  const samples = Math.max(0, stream.lastGranule - stream.preSkip);
  return {
    container: "ogg",
    codec: stream.codec,
    durationMs: (samples / stream.sampleRate) * 1000
  };
}

function identifyOggStream(stream, packet) {
  if (ascii(packet, 0, 8) === "OpusHead" && packet.length >= 19) {
    stream.codec = "opus";
    stream.sampleRate = 48000;
    stream.preSkip = readUint16LE(packet, 10);
    return;
  }
  if (packet[0] === 1 && ascii(packet, 1, 6) === "vorbis" && packet.length >= 16) {
    stream.codec = "vorbis";
    stream.sampleRate = readUint32LE(packet, 12);
    return;
  }
  if (packet[0] === 0x80 && ascii(packet, 1, 6) === "theora") {
    throw new AudioValidationError("video-not-supported", "Video-bearing media cannot be transcribed as audio.");
  }
  throw new AudioValidationError("unsupported-codec", "The Ogg file must use Opus or Vorbis audio.");
}

function inspectWebm(bytes) {
  const topLevel = readEbmlElements(bytes, 0, bytes.length);
  if (!topLevel.some((element) => element.id === 0x1a45dfa3)) {
    throw mismatchError("WebM");
  }
  const segment = topLevel.find((element) => element.id === 0x18538067);
  if (!segment) {
    throw malformedError();
  }

  const segmentElements = readEbmlElements(bytes, segment.dataStart, segment.dataEnd);
  const info = segmentElements.find((element) => element.id === 0x1549a966);
  const tracks = segmentElements.find((element) => element.id === 0x1654ae6b);
  if (!info || !tracks) {
    throw malformedError();
  }
  const cluster = segmentElements.find((element) => element.id === 0x1f43b675);
  if (!cluster || cluster.dataEnd <= cluster.dataStart) {
    throw malformedError();
  }

  let timecodeScale = 1000000;
  let duration = 0;
  for (const element of readEbmlElements(bytes, info.dataStart, info.dataEnd)) {
    if (element.id === 0x2ad7b1) {
      timecodeScale = readUnsignedInteger(bytes, element.dataStart, element.dataEnd);
    } else if (element.id === 0x4489) {
      duration = readEbmlFloat(bytes, element.dataStart, element.dataEnd);
    }
  }

  let audioCodec = "";
  for (const trackEntry of readEbmlElements(bytes, tracks.dataStart, tracks.dataEnd)) {
    if (trackEntry.id !== 0xae) {
      continue;
    }
    let trackType = 0;
    let codecId = "";
    for (const element of readEbmlElements(bytes, trackEntry.dataStart, trackEntry.dataEnd)) {
      if (element.id === 0x83) {
        trackType = readUnsignedInteger(bytes, element.dataStart, element.dataEnd);
      } else if (element.id === 0x86) {
        codecId = ascii(bytes, element.dataStart, element.dataEnd - element.dataStart);
      }
    }
    if (trackType === 1) {
      throw new AudioValidationError("video-not-supported", "Video-bearing media cannot be transcribed as audio.");
    }
    if (trackType === 2) {
      if (audioCodec) {
        throw new AudioValidationError("unsupported-codec", "The WebM file must contain one supported audio track.");
      }
      audioCodec = codecId;
    }
  }

  if (audioCodec !== "A_OPUS" && audioCodec !== "A_VORBIS") {
    throw new AudioValidationError("unsupported-codec", "The WebM file must use Opus or Vorbis audio.");
  }
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(timecodeScale) || timecodeScale <= 0) {
    throw new AudioValidationError("duration-unavailable", "The WebM duration could not be verified.");
  }

  return {
    container: "webm",
    codec: audioCodec === "A_OPUS" ? "opus" : "vorbis",
    durationMs: (duration * timecodeScale) / 1000000
  };
}

function inspectM4a(bytes) {
  const topLevel = readMp4Boxes(bytes, 0, bytes.length);
  if (!topLevel.some((box) => box.type === "ftyp")) {
    throw mismatchError("M4A");
  }
  const moov = topLevel.find((box) => box.type === "moov");
  const mediaData = topLevel.find((box) => box.type === "mdat" && box.dataEnd > box.dataStart);
  if (!moov || !mediaData) {
    throw malformedError();
  }

  const moovBoxes = readMp4Boxes(bytes, moov.dataStart, moov.dataEnd);
  let audioTrack = null;
  for (const track of moovBoxes.filter((box) => box.type === "trak")) {
    const trackBoxes = readMp4Boxes(bytes, track.dataStart, track.dataEnd);
    const trackHeader = trackBoxes.find((box) => box.type === "tkhd");
    const media = trackBoxes.find((box) => box.type === "mdia");
    if (!trackHeader || !media) {
      throw malformedError();
    }
    const mediaBoxes = readMp4Boxes(bytes, media.dataStart, media.dataEnd);
    const handler = mediaBoxes.find((box) => box.type === "hdlr");
    if (!handler || handler.dataStart + 12 > handler.dataEnd) {
      throw malformedError();
    }
    const handlerType = ascii(bytes, handler.dataStart + 8, 4);
    if (handlerType === "vide") {
      throw new AudioValidationError("video-not-supported", "Video-bearing media cannot be transcribed as audio.");
    }
    if (handlerType !== "soun") {
      continue;
    }
    if (audioTrack) {
      throw new AudioValidationError("unsupported-audio-layout", "The M4A file must contain exactly one audio track.");
    }

    const mdhd = mediaBoxes.find((box) => box.type === "mdhd");
    const minf = mediaBoxes.find((box) => box.type === "minf");
    if (!mdhd || !minf) {
      throw malformedError();
    }
    const timing = readMp4MediaTiming(bytes, mdhd);
    const codec = readMp4AudioCodec(bytes, minf);
    const trackId = readMp4TrackId(bytes, trackHeader);
    audioTrack = { ...timing, codec, trackId };
  }

  if (!audioTrack) {
    throw new AudioValidationError("unsupported-audio-layout", "The M4A file must contain one audio track.");
  }
  if (audioTrack.timescale <= 0) {
    throw new AudioValidationError("duration-unavailable", "The M4A duration could not be verified.");
  }

  const fragmentBoxes = topLevel.filter((box) => box.type === "moof");
  const fragmented = fragmentBoxes.length > 0;
  const duration = fragmented
    ? readMp4FragmentDuration(bytes, fragmentBoxes, moovBoxes, audioTrack.trackId)
    : audioTrack.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AudioValidationError("duration-unavailable", "The M4A duration could not be verified.");
  }

  return {
    container: "mp4",
    codec: audioTrack.codec,
    fragmented,
    durationMs: (duration / audioTrack.timescale) * 1000
  };
}

function readMp4TrackId(bytes, tkhd) {
  const version = bytes[tkhd.dataStart];
  const offset = version === 0
    ? tkhd.dataStart + 12
    : (version === 1 ? tkhd.dataStart + 20 : -1);
  if (offset < 0 || offset + 4 > tkhd.dataEnd) {
    throw malformedError();
  }
  const trackId = readUint32BE(bytes, offset);
  if (trackId <= 0) {
    throw malformedError();
  }
  return trackId;
}

function readMp4MediaTiming(bytes, mdhd) {
  const version = bytes[mdhd.dataStart];
  if (version === 0) {
    if (mdhd.dataStart + 20 > mdhd.dataEnd) {
      throw malformedError();
    }
    return {
      timescale: readUint32BE(bytes, mdhd.dataStart + 12),
      duration: readUint32BE(bytes, mdhd.dataStart + 16)
    };
  }
  if (version === 1) {
    if (mdhd.dataStart + 32 > mdhd.dataEnd) {
      throw malformedError();
    }
    return {
      timescale: readUint32BE(bytes, mdhd.dataStart + 20),
      duration: readUint64BE(bytes, mdhd.dataStart + 24)
    };
  }
  throw malformedError();
}

function readMp4AudioCodec(bytes, minf) {
  const stbl = readMp4Boxes(bytes, minf.dataStart, minf.dataEnd).find((box) => box.type === "stbl");
  if (!stbl) {
    throw malformedError();
  }
  const stsd = readMp4Boxes(bytes, stbl.dataStart, stbl.dataEnd).find((box) => box.type === "stsd");
  if (!stsd || stsd.dataStart + 8 > stsd.dataEnd) {
    throw malformedError();
  }
  const entryCount = readUint32BE(bytes, stsd.dataStart + 4);
  const entries = readMp4Boxes(bytes, stsd.dataStart + 8, stsd.dataEnd);
  if (entryCount !== 1 || entries.length !== 1) {
    throw new AudioValidationError("unsupported-audio-layout", "The M4A file must contain one audio sample description.");
  }
  const sampleEntry = entries[0].type;
  if (!/^[\x20-\x7e]{4}$/.test(sampleEntry)) {
    throw malformedError();
  }
  if (sampleEntry === "mp4a") {
    return "aac";
  }
  if (sampleEntry === "Opus") {
    return "opus";
  }
  return sampleEntry.trim().toLowerCase() || "unknown";
}

function readMp4FragmentDuration(bytes, fragmentBoxes, moovBoxes, trackId) {
  const defaultSampleDuration = readMp4DefaultSampleDuration(bytes, moovBoxes, trackId);
  let foundTrackFragment = false;
  let nextDecodeTime = 0;
  let maximumEndTime = 0;

  for (const fragment of fragmentBoxes) {
    for (const trackFragment of readMp4Boxes(bytes, fragment.dataStart, fragment.dataEnd)
      .filter((box) => box.type === "traf")) {
      const boxes = readMp4Boxes(bytes, trackFragment.dataStart, trackFragment.dataEnd);
      const tfhd = boxes.find((box) => box.type === "tfhd");
      if (!tfhd) {
        throw malformedError();
      }
      const header = readMp4TrackFragmentHeader(bytes, tfhd);
      if (header.trackId !== trackId) {
        continue;
      }
      if (header.durationIsEmpty) {
        continue;
      }

      const runs = boxes.filter((box) => box.type === "trun");
      if (runs.length === 0) {
        throw malformedError();
      }
      const decodeTimeBox = boxes.find((box) => box.type === "tfdt");
      let fragmentEnd = decodeTimeBox
        ? readMp4BaseDecodeTime(bytes, decodeTimeBox)
        : nextDecodeTime;
      const runDefaultDuration = header.defaultSampleDuration ?? defaultSampleDuration;
      for (const run of runs) {
        fragmentEnd = addSafeIntegers(
          fragmentEnd,
          readMp4TrackRunDuration(bytes, run, runDefaultDuration)
        );
      }
      foundTrackFragment = true;
      nextDecodeTime = fragmentEnd;
      maximumEndTime = Math.max(maximumEndTime, fragmentEnd);
    }
  }

  if (!foundTrackFragment || maximumEndTime <= 0) {
    throw new AudioValidationError("duration-unavailable", "The M4A duration could not be verified.");
  }
  return maximumEndTime;
}

function readMp4DefaultSampleDuration(bytes, moovBoxes, trackId) {
  const mvex = moovBoxes.find((box) => box.type === "mvex");
  if (!mvex) {
    return null;
  }
  for (const trex of readMp4Boxes(bytes, mvex.dataStart, mvex.dataEnd)
    .filter((box) => box.type === "trex")) {
    if (trex.dataStart + 24 > trex.dataEnd) {
      throw malformedError();
    }
    if (readUint32BE(bytes, trex.dataStart + 4) === trackId) {
      const duration = readUint32BE(bytes, trex.dataStart + 12);
      return duration > 0 ? duration : null;
    }
  }
  return null;
}

function readMp4TrackFragmentHeader(bytes, tfhd) {
  if (tfhd.dataStart + 8 > tfhd.dataEnd) {
    throw malformedError();
  }
  const flags = readMp4FullBoxFlags(bytes, tfhd);
  const trackId = readUint32BE(bytes, tfhd.dataStart + 4);
  if (trackId <= 0) {
    throw malformedError();
  }
  let cursor = tfhd.dataStart + 8;
  if ((flags & 0x000001) !== 0) {
    cursor = advanceMp4Cursor(cursor, 8, tfhd.dataEnd);
  }
  if ((flags & 0x000002) !== 0) {
    cursor = advanceMp4Cursor(cursor, 4, tfhd.dataEnd);
  }
  let defaultSampleDuration = null;
  if ((flags & 0x000008) !== 0) {
    cursor = advanceMp4Cursor(cursor, 4, tfhd.dataEnd);
    defaultSampleDuration = readUint32BE(bytes, cursor - 4);
  }
  if ((flags & 0x000010) !== 0) {
    cursor = advanceMp4Cursor(cursor, 4, tfhd.dataEnd);
  }
  if ((flags & 0x000020) !== 0) {
    cursor = advanceMp4Cursor(cursor, 4, tfhd.dataEnd);
  }
  if (cursor !== tfhd.dataEnd) {
    throw malformedError();
  }
  return {
    trackId,
    defaultSampleDuration: defaultSampleDuration > 0 ? defaultSampleDuration : null,
    durationIsEmpty: (flags & 0x010000) !== 0
  };
}

function readMp4BaseDecodeTime(bytes, tfdt) {
  if (tfdt.dataStart + 8 > tfdt.dataEnd) {
    throw malformedError();
  }
  const version = bytes[tfdt.dataStart];
  if (version === 0 && tfdt.dataStart + 8 === tfdt.dataEnd) {
    return readUint32BE(bytes, tfdt.dataStart + 4);
  }
  if (version === 1 && tfdt.dataStart + 12 === tfdt.dataEnd) {
    return readUint64BE(bytes, tfdt.dataStart + 4);
  }
  throw malformedError();
}

function readMp4TrackRunDuration(bytes, trun, defaultSampleDuration) {
  if (trun.dataStart + 8 > trun.dataEnd) {
    throw malformedError();
  }
  const flags = readMp4FullBoxFlags(bytes, trun);
  const sampleCount = readUint32BE(bytes, trun.dataStart + 4);
  let cursor = trun.dataStart + 8;
  if ((flags & 0x000001) !== 0) {
    cursor = advanceMp4Cursor(cursor, 4, trun.dataEnd);
  }
  if ((flags & 0x000004) !== 0) {
    cursor = advanceMp4Cursor(cursor, 4, trun.dataEnd);
  }

  const hasSampleDuration = (flags & 0x000100) !== 0;
  const bytesPerSample = (hasSampleDuration ? 4 : 0) +
    ((flags & 0x000200) !== 0 ? 4 : 0) +
    ((flags & 0x000400) !== 0 ? 4 : 0) +
    ((flags & 0x000800) !== 0 ? 4 : 0);
  const sampleBytes = sampleCount * bytesPerSample;
  if (!Number.isSafeInteger(sampleBytes) || cursor + sampleBytes !== trun.dataEnd) {
    throw malformedError();
  }
  if (!hasSampleDuration) {
    if (sampleCount > 0 && (!Number.isFinite(defaultSampleDuration) || defaultSampleDuration <= 0)) {
      throw new AudioValidationError("duration-unavailable", "The M4A duration could not be verified.");
    }
    return multiplySafeIntegers(sampleCount, defaultSampleDuration ?? 0);
  }

  let duration = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    duration = addSafeIntegers(duration, readUint32BE(bytes, cursor));
    cursor += bytesPerSample;
  }
  return duration;
}

function readMp4FullBoxFlags(bytes, box) {
  if (box.dataStart + 4 > box.dataEnd) {
    throw malformedError();
  }
  return (bytes[box.dataStart + 1] * 0x10000) +
    (bytes[box.dataStart + 2] * 0x100) +
    bytes[box.dataStart + 3];
}

function advanceMp4Cursor(cursor, amount, end) {
  if (cursor + amount > end) {
    throw malformedError();
  }
  return cursor + amount;
}

function addSafeIntegers(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw malformedError();
  }
  return result;
}

function multiplySafeIntegers(left, right) {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw malformedError();
  }
  return result;
}

function readMp4Boxes(bytes, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = readUint32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) {
        throw malformedError();
      }
      size = readUint64BE(bytes, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) {
      throw malformedError();
    }
    boxes.push({ type, dataStart: offset + headerSize, dataEnd: offset + size });
    offset += size;
  }
  if (offset !== end) {
    throw malformedError();
  }
  return boxes;
}

function readEbmlElements(bytes, start, end) {
  const elements = [];
  let offset = start;
  while (offset < end) {
    const id = readEbmlVint(bytes, offset, true);
    const size = readEbmlVint(bytes, offset + id.length, false);
    const dataStart = offset + id.length + size.length;
    const dataEnd = size.unknown ? end : dataStart + size.value;
    if (dataEnd > end || dataEnd < dataStart) {
      throw malformedError();
    }
    elements.push({ id: id.value, dataStart, dataEnd });
    offset = dataEnd;
  }
  return elements;
}

function readEbmlVint(bytes, offset, preserveMarker) {
  if (offset >= bytes.length || bytes[offset] === 0) {
    throw malformedError();
  }
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (bytes[offset] & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > bytes.length) {
    throw malformedError();
  }

  let value = preserveMarker ? bytes[offset] : (bytes[offset] & (mask - 1));
  let allOnes = !preserveMarker && value === mask - 1;
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[offset + index];
    allOnes = allOnes && bytes[offset + index] === 0xff;
  }
  if (!Number.isSafeInteger(value)) {
    throw malformedError();
  }
  return { length, value, unknown: allOnes };
}

function readEbmlFloat(bytes, start, end) {
  const length = end - start;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
  if (length === 4) {
    return view.getFloat32(0, false);
  }
  if (length === 8) {
    return view.getFloat64(0, false);
  }
  throw malformedError();
}

function readUnsignedInteger(bytes, start, end) {
  const length = end - start;
  if (length <= 0 || length > 8) {
    throw malformedError();
  }
  let value = 0;
  for (let offset = start; offset < end; offset += 1) {
    value = value * 256 + bytes[offset];
  }
  if (!Number.isSafeInteger(value)) {
    throw malformedError();
  }
  return value;
}

function validateMimeType(extension, mimeType) {
  if (GENERIC_MIME_TYPES.has(mimeType)) {
    return;
  }
  if (!AUDIO_MIME_TYPES[extension]?.has(mimeType)) {
    throw new AudioValidationError(
      "mime-mismatch",
      "The file extension, MIME type, and audio container do not match."
    );
  }
}

function normalizeAudioExtension(value) {
  return String(value || "").replace(/^\./, "").trim().toLowerCase();
}

function getFileExtension(name) {
  const match = /\.([^.\\/\s]+)$/.exec(String(name || "").toLowerCase());
  return match ? match[1] : "";
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new AudioValidationError("unreadable-file", "The audio file could not be read.");
}

function readId3v2Size(bytes) {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") {
    return 0;
  }
  const flags = bytes[5];
  const sizeBytes = bytes.slice(6, 10);
  if (sizeBytes.some((value) => value > 0x7f)) {
    throw malformedError();
  }
  const size = sizeBytes.reduce((sum, value) => (sum * 128) + value, 0);
  const footerSize = (flags & 0x10) !== 0 ? 10 : 0;
  const total = 10 + size + footerSize;
  if (total > bytes.length) {
    throw malformedError();
  }
  return total;
}

function isId3v1Tag(bytes, offset) {
  return bytes.length - offset === 128 && ascii(bytes, offset, 3) === "TAG";
}

function isPadding(bytes, offset) {
  for (let index = offset; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) {
      return false;
    }
  }
  return true;
}

function concatBytes(parts, length) {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function ascii(bytes, offset, length) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    return "";
  }
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index]);
  }
  return value;
}

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24BE(bytes, offset) {
  return (bytes[offset] * 0x10000) + (bytes[offset + 1] << 8) + bytes[offset + 2];
}

function readUint32LE(bytes, offset) {
  return (
    bytes[offset] +
    (bytes[offset + 1] * 0x100) +
    (bytes[offset + 2] * 0x10000) +
    (bytes[offset + 3] * 0x1000000)
  );
}

function readUint32BE(bytes, offset) {
  return (
    (bytes[offset] * 0x1000000) +
    (bytes[offset + 1] * 0x10000) +
    (bytes[offset + 2] * 0x100) +
    bytes[offset + 3]
  );
}

function readUint64LE(bytes, offset) {
  const low = readUint32LE(bytes, offset);
  const high = readUint32LE(bytes, offset + 4);
  const value = high * 0x100000000 + low;
  return Number.isSafeInteger(value) ? value : -1;
}

function readUint64BE(bytes, offset) {
  const high = readUint32BE(bytes, offset);
  const low = readUint32BE(bytes, offset + 4);
  const value = high * 0x100000000 + low;
  if (!Number.isSafeInteger(value)) {
    throw malformedError();
  }
  return value;
}

function mismatchError(label) {
  return new AudioValidationError(
    "container-mismatch",
    `The file does not contain a valid ${label} audio container.`
  );
}

function malformedError() {
  return new AudioValidationError("malformed-audio", "The audio container is malformed or unreadable.");
}

function formatBytes(value) {
  const megabytes = value / (1024 * 1024);
  return `${Math.round(megabytes * 10) / 10} MB`;
}

function formatDuration(valueMs) {
  const totalMinutes = Math.round(valueMs / 60000);
  return `${totalMinutes} minutes`;
}

module.exports = {
  AUDIO_ATTACHMENT_EXTENSIONS,
  AUDIO_MIME_TYPES,
  AudioValidationError,
  DEFAULT_MAX_AUDIO_BYTES,
  DEFAULT_MAX_AUDIO_DURATION_MS,
  getFileExtension,
  inspectAudioBuffer,
  normalizeAudioExtension
};
