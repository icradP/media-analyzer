import {
  buildVideoDecodePlan,
  codecCandidatesForStream,
  collectVideoFrames,
  pickPrimaryMediaResult,
  sliceFrameBytes,
} from "../browser/index.js";

export class MseSourceController {
  constructor({ videoEl, onLog = null, onStatus = null, formatTime = null } = {}) {
    if (!(videoEl instanceof HTMLVideoElement)) throw new Error("videoEl is required.");
    this.videoEl = videoEl;
    this.onLog = typeof onLog === "function" ? onLog : null;
    this.onStatus = typeof onStatus === "function" ? onStatus : null;
    this.formatTime = typeof formatTime === "function" ? formatTime : ((n) => Number(n || 0).toFixed(3));
    this.activeObjectUrl = "";
  }

  stopPlayback({ release = false } = {}) {
    try {
      this.videoEl.pause();
    } catch {
      // ignore pause errors
    }
    if (!release) return;
    this.videoEl.removeAttribute("src");
    try {
      this.videoEl.load();
    } catch {
      // ignore reset errors
    }
    if (this.activeObjectUrl) {
      URL.revokeObjectURL(this.activeObjectUrl);
      this.activeObjectUrl = "";
    }
  }

  async seekTo(sec) {
    const target = Math.max(0, Number(sec) || 0);
    if (this.videoEl.readyState < 1) await waitEvent(this.videoEl, "loadedmetadata", 15000);
    await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(new Error("Timeout seeking MSE video.")), 10000);
      const finish = (err = null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.videoEl.removeEventListener("seeked", onSeeked);
        this.videoEl.removeEventListener("error", onError);
        if (err) reject(err);
        else resolve();
      };
      const onSeeked = () => finish();
      const onError = () => finish(new Error("MSE seek failed."));
      this.videoEl.addEventListener("seeked", onSeeked, { once: true });
      this.videoEl.addEventListener("error", onError, { once: true });
      try {
        this.videoEl.currentTime = target;
        if (Math.abs(this.videoEl.currentTime - target) < 0.02) finish();
      } catch (err) {
        finish(err);
      }
    });
  }

  describeVideoState() {
    return `duration=${fmt(this.videoEl.duration, this.formatTime)}, buffered=${fmtRanges(this.videoEl.buffered, this.formatTime)}, readyState=${this.videoEl.readyState}`;
  }

  async createSource({ bytes, result, mediaInfo }) {
    const MediaSourceCtor = window.MediaSource || window.WebKitMediaSource;
    if (!MediaSourceCtor) throw new Error("MediaSource API is not available in this browser.");
    if (!(bytes instanceof Uint8Array) || bytes.length <= 0) throw new Error("No media bytes for MSE playback.");
    let lastErr = null;
    if (isFragmentedMp4Bytes(bytes)) {
      try {
        return await this.#createMseBufferedSource(
          bytes,
          mseMimeCandidates(result),
          sourceDurationSec(result),
          "mse-sourcebuffer",
        );
      } catch (err) {
        lastErr = err;
      }
    } else if (isMp4LikeSource(bytes, result)) {
      return this.#createNativeVideoSource(bytes, blobMimeForNativeVideo(result), "regular MP4/MOV is played by native video; MSE append requires fragmented MP4");
    } else {
      try {
        this.#status("Transmuxing H.264 to fMP4 for MSE...");
        const muxed = buildH264Fmp4FromAnalysis({ mediaInfo, result, pushLog: this.#log.bind(this) });
        const reasonParts = ["video-only fMP4", `${muxed.frameCount} frames`];
        if (muxed.droppedFrameCount > 0) reasonParts.push(`dropped ${muxed.droppedFrameCount} pre-keyframe frames`);
        if (muxed.sourceStartSec > 0.001) reasonParts.push(`source starts at ${fmt(muxed.sourceStartSec, this.formatTime)}`);
        return await this.#createMseBufferedSource(
          muxed.bytes,
          [muxed.mime, "video/mp4"],
          sourceDurationSec(result, muxed.durationSec),
          "mse-transmuxed",
          reasonParts.join(", "),
          { durationSec: muxed.durationSec, sourceStartSec: muxed.sourceStartSec },
        );
      } catch (err) {
        lastErr = err;
      }
    }
    const reason = isFragmentedMp4Bytes(bytes)
      ? lastErr?.message || "SourceBuffer append failed"
      : `fMP4 transmux unavailable: ${lastErr?.message || "source is not fragmented MP4"}`;
    const fallback = this.#createNativeVideoSource(bytes, blobMimeForNativeVideo(result), reason);
    fallback.mseError = lastErr;
    return fallback;
  }

  #status(text) {
    if (this.onStatus) this.onStatus(text);
  }

  #log(text) {
    if (this.onLog) this.onLog(text);
  }

  #createNativeVideoSource(bytes, mime, reason) {
    const blob = new Blob([bytes], { type: mime });
    const objectUrl = URL.createObjectURL(blob);
    this.activeObjectUrl = objectUrl;
    this.videoEl.src = objectUrl;
    return { mode: "native-video", mime: blob.type || "video", reason };
  }

  async #createMseBufferedSource(bytes, rawCandidates, durationSec, mode, reason = "", metadata = {}) {
    const MediaSourceCtor = window.MediaSource || window.WebKitMediaSource;
    if (!MediaSourceCtor) throw new Error("MediaSource API is not available in this browser.");
    const candidates = (rawCandidates || []).filter((mime, idx, arr) =>
      mime &&
      arr.indexOf(mime) === idx &&
      (typeof MediaSourceCtor.isTypeSupported !== "function" || MediaSourceCtor.isTypeSupported(mime))
    );
    if (!candidates.length) throw new Error("No supported MSE mime type for this media.");
    let lastErr = null;
    for (const mime of candidates) {
      const mediaSource = new MediaSourceCtor();
      const objectUrl = URL.createObjectURL(mediaSource);
      this.activeObjectUrl = objectUrl;
      try {
        const sourceOpen = waitEvent(mediaSource, "sourceopen", 10000);
        this.videoEl.src = objectUrl;
        await sourceOpen;
        const sourceBuffer = mediaSource.addSourceBuffer(mime);
        await appendMseBytes(sourceBuffer, bytes);
        this.#log(`[mse buffer] appended=${bytes.length} bytes, mime=${mime}, sourceBuffer=${fmtRanges(sourceBuffer.buffered, this.formatTime)}`);
        try {
          const duration = Number(durationSec);
          if (Number.isFinite(duration) && duration > 0) mediaSource.duration = duration;
        } catch {
          // Some streams do not allow setting duration.
        }
        this.#log(`[mse buffer] mediaSource duration=${fmt(mediaSource.duration, this.formatTime)}, videoDuration=${fmt(this.videoEl.duration, this.formatTime)}, videoBuffered=${fmtRanges(this.videoEl.buffered, this.formatTime)}, readyState=${this.videoEl.readyState}`);
        try {
          if (mediaSource.readyState === "open") mediaSource.endOfStream();
        } catch {
          // ignore
        }
        return { mode, mime, objectUrl, reason, ...metadata };
      } catch (err) {
        lastErr = err;
        this.videoEl.removeAttribute("src");
        try { this.videoEl.load(); } catch {}
        URL.revokeObjectURL(objectUrl);
        if (this.activeObjectUrl === objectUrl) this.activeObjectUrl = "";
      }
    }
    throw lastErr || new Error("SourceBuffer append failed.");
  }
}

function fmt(sec, formatTime) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return "-";
  return formatTime(n);
}

function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "-";
  return `${(n / 1000).toFixed(3)}s`;
}

function fmtRanges(ranges, formatTime) {
  if (!ranges || typeof ranges.length !== "number" || ranges.length <= 0) return "empty";
  const out = [];
  for (let i = 0; i < ranges.length; i++) {
    try { out.push(`${fmt(ranges.start(i), formatTime)}-${fmt(ranges.end(i), formatTime)}`); } catch {}
  }
  return out.length ? out.join(", ") : "empty";
}

function audioCodecForMse(audioStream) {
  const name = String(audioStream?.codecName || "").toLowerCase();
  if (!name.includes("aac") && !name.includes("mp4a")) return null;
  const profile = Number(audioStream?.profile);
  const objectType = Number.isFinite(profile) && profile > 0 ? Math.round(profile) : 2;
  return `mp4a.40.${objectType}`;
}

function mseMimeCandidates(result) {
  const MediaSourceCtor = window.MediaSource || window.WebKitMediaSource;
  if (!MediaSourceCtor) throw new Error("MediaSource API is not available in this browser.");
  const streams = Array.isArray(result?.streams) ? result.streams : [];
  const videoStream = streams.find((s) => s.codecType === "video");
  if (!videoStream) throw new Error("No video stream for MSE playback.");
  const audioStream = streams.find((s) => s.codecType === "audio") || null;
  const audioCodec = audioCodecForMse(audioStream);
  const out = [];
  for (const videoCodec of codecCandidatesForStream(videoStream)) {
    const codecs = audioCodec ? [videoCodec, audioCodec] : [videoCodec];
    out.push(`video/mp4; codecs="${codecs.join(",")}"`);
    out.push(`video/mp4; codecs="${videoCodec}"`);
  }
  out.push("video/mp4");
  return out.filter((mime, idx, arr) =>
    arr.indexOf(mime) === idx &&
    (typeof MediaSourceCtor.isTypeSupported !== "function" || MediaSourceCtor.isTypeSupported(mime))
  );
}

function scanTopLevelIsoBoxes(bytes, maxBytes = 8 * 1024 * 1024) {
  const boxes = new Set();
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return boxes;
  const limit = Math.min(bytes.length, maxBytes);
  let off = 0;
  while (off + 8 <= limit) {
    let size = bytes[off] * 0x1000000 + (bytes[off + 1] << 16) + (bytes[off + 2] << 8) + bytes[off + 3];
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    let header = 8;
    if (size === 1 && off + 16 <= limit) {
      const hi = bytes[off + 8] * 0x1000000 + (bytes[off + 9] << 16) + (bytes[off + 10] << 8) + bytes[off + 11];
      const lo = bytes[off + 12] * 0x1000000 + (bytes[off + 13] << 16) + (bytes[off + 14] << 8) + bytes[off + 15];
      size = hi * 0x100000000 + lo;
      header = 16;
    } else if (size === 0) {
      size = bytes.length - off;
    }
    if (!Number.isFinite(size) || size < header || off + size > bytes.length + 8) break;
    boxes.add(type);
    if (type === "moof") break;
    off += size;
  }
  return boxes;
}

function isFragmentedMp4Bytes(bytes) { return scanTopLevelIsoBoxes(bytes).has("moof"); }
function isMp4LikeSource(bytes, result) {
  const formatName = String(result?.format?.formatName || "").toLowerCase();
  const formatLongName = String(result?.format?.formatLongName || "").toLowerCase();
  if (formatName.includes("mp4") || formatName.includes("mov") || formatName.includes("m4s")) return true;
  if (formatLongName.includes("mp4") || formatLongName.includes("quicktime")) return true;
  return scanTopLevelIsoBoxes(bytes).has("ftyp");
}
function blobMimeForNativeVideo(result) {
  const formatName = String(result?.format?.formatName || "").toLowerCase();
  if (formatName.includes("mp4") || formatName.includes("mov") || formatName.includes("m4s")) return "video/mp4";
  return "application/octet-stream";
}

function sourceDurationSec(result, fallback = null) {
  const fromMux = Number(fallback);
  if (Number.isFinite(fromMux) && fromMux > 0) return fromMux;
  const duration = Number(result?.format?.duration);
  if (Number.isFinite(duration) && duration > 0) return duration;
  return null;
}

function concatBytes(parts) {
  const input = (parts || []).filter((p) => p instanceof Uint8Array && p.length > 0);
  const total = input.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of input) { out.set(part, off); off += part.length; }
  return out;
}
function asciiBytes(text) { const s = String(text); const out = new Uint8Array(s.length); for (let i = 0; i < out.length; i++) out[i] = s.charCodeAt(i) & 0xff; return out; }
function u8(v) { return Uint8Array.of(Number(v) & 0xff); }
function u16(v) { const n = Math.max(0, Math.min(0xffff, Math.round(Number(v) || 0))); return Uint8Array.of((n >>> 8) & 0xff, n & 0xff); }
function u24(v) { const n = Math.max(0, Math.min(0xffffff, Math.round(Number(v) || 0))); return Uint8Array.of((n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
function u32(v) { const n = Math.max(0, Math.min(0xffffffff, Math.round(Number(v) || 0))); return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
function i32(v) { const n = Math.round(Number(v) || 0) >>> 0; return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
function u64(v) { const n = Math.max(0, Math.floor(Number(v) || 0)); const hi = Math.floor(n / 0x100000000); const lo = n % 0x100000000; return concatBytes([u32(hi), u32(lo)]); }
function fixed16_16(v) { return u32(Math.round((Number(v) || 0) * 65536)); }
function mp4Box(type, ...payloads) { const body = concatBytes(payloads); const out = new Uint8Array(8 + body.length); out.set(u32(out.length), 0); out.set(asciiBytes(type).subarray(0, 4), 4); out.set(body, 8); return out; }
function fullMp4Box(type, version, flags, ...payloads) { return mp4Box(type, u8(version), u24(flags), ...payloads); }
function mp4Matrix() { return concatBytes([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]); }
function buildMvhd(timescale, duration) { return fullMp4Box("mvhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), mp4Matrix(), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(2)); }
function buildTkhd(width, height, duration) { return fullMp4Box("tkhd", 0, 0x000007, u32(0), u32(0), u32(1), u32(0), u32(duration), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), mp4Matrix(), fixed16_16(width), fixed16_16(height)); }
function buildMdhd(timescale, duration) { return fullMp4Box("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)); }
function buildHdlr() { return fullMp4Box("hdlr", 0, 0, u32(0), asciiBytes("vide"), u32(0), u32(0), u32(0), asciiBytes("VideoHandler\0")); }
function buildDinf() { const url = fullMp4Box("url ", 0, 0x000001); const dref = fullMp4Box("dref", 0, 0, u32(1), url); return mp4Box("dinf", dref); }
function buildAvc1SampleEntry(width, height, avcC) { const compressorName = new Uint8Array(32); return mp4Box("avc1", new Uint8Array([0,0,0,0,0,0,0,1]), u16(0), u16(0), u32(0), u32(0), u32(0), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), compressorName, u16(0x0018), u16(0xffff), mp4Box("avcC", avcC)); }
function buildStbl(width, height, avcC) { const stsd = fullMp4Box("stsd", 0, 0, u32(1), buildAvc1SampleEntry(width, height, avcC)); return mp4Box("stbl", stsd, fullMp4Box("stts",0,0,u32(0)), fullMp4Box("stsc",0,0,u32(0)), fullMp4Box("stsz",0,0,u32(0),u32(0)), fullMp4Box("stco",0,0,u32(0))); }
function buildMoov({ width, height, timescale, duration, avcC }) { const safeDuration = Math.max(1, Math.ceil(Number(duration) || 1)); const vmhd = fullMp4Box("vmhd", 0, 0x000001, u16(0), u16(0), u16(0), u16(0)); const minf = mp4Box("minf", vmhd, buildDinf(), buildStbl(width, height, avcC)); const mdia = mp4Box("mdia", buildMdhd(timescale, safeDuration), buildHdlr(), minf); const trak = mp4Box("trak", buildTkhd(width, height, safeDuration), mdia); const trex = fullMp4Box("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)); return mp4Box("moov", buildMvhd(timescale, safeDuration), trak, mp4Box("mvex", trex)); }
function buildTrun(samples, dataOffset) { const rows = []; for (const s of samples) rows.push(u32(s.duration), u32(s.data.length), u32(s.isKeyframe ? 0x02000000 : 0x01010000), i32(s.compositionOffset)); return fullMp4Box("trun", 1, 0x000f01, u32(samples.length), i32(dataOffset), ...rows); }
function buildMoof(samples, baseDecodeTime) { const mfhd = fullMp4Box("mfhd", 0, 0, u32(1)); const tfhd = fullMp4Box("tfhd", 0, 0x020000, u32(1)); const tfdt = fullMp4Box("tfdt", 1, 0, u64(baseDecodeTime)); let trun = buildTrun(samples, 0); let traf = mp4Box("traf", tfhd, tfdt, trun); let moof = mp4Box("moof", mfhd, traf); trun = buildTrun(samples, moof.length + 8); traf = mp4Box("traf", tfhd, tfdt, trun); moof = mp4Box("moof", mfhd, traf); return moof; }
function buildAvcDecoderConfigRecord(sps, pps) { if (!(sps instanceof Uint8Array) || !(pps instanceof Uint8Array) || sps.length < 4) return null; const out = new Uint8Array(11 + sps.length + pps.length); let o = 0; out[o++] = 1; out[o++] = sps[1]; out[o++] = sps[2]; out[o++] = sps[3]; out[o++] = 0xff; out[o++] = 0xe1; out[o++] = (sps.length >>> 8) & 0xff; out[o++] = sps.length & 0xff; out.set(sps, o); o += sps.length; out[o++] = 1; out[o++] = (pps.length >>> 8) & 0xff; out[o++] = pps.length & 0xff; out.set(pps, o); return out; }
function forceAvcC4ByteLengthSize(avcC) { if (!(avcC instanceof Uint8Array) || avcC.length < 5) return null; const out = avcC.slice(0); out[4] = (out[4] & 0xfc) | 0x03; return out; }
function h264CodecFromAvcC(avcC) { if (!(avcC instanceof Uint8Array) || avcC.length < 4) return "avc1.42E01E"; const hex = [avcC[1], avcC[2], avcC[3]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase(); return `avc1.${hex}`; }
function hasAnnexBStartCode(bytes) { if (!(bytes instanceof Uint8Array) || bytes.length < 4) return false; for (let i = 0; i + 3 < bytes.length; i++) { if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) return true; if (i + 4 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) return true; } return false; }
function findAnnexBStartCode(bytes, from) { for (let i = Math.max(0, from); i + 3 < bytes.length; i++) { if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) return { index: i, length: 3 }; if (i + 4 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) return { index: i, length: 4 }; } return null; }
function splitAnnexBNalus(bytes) { const first = findAnnexBStartCode(bytes, 0); if (!first) return []; const nalus = []; let start = first.index + first.length; while (start < bytes.length) { const next = findAnnexBStartCode(bytes, start); let end = next ? next.index : bytes.length; while (end > start && bytes[end - 1] === 0) end -= 1; if (end > start) nalus.push(bytes.subarray(start, end)); if (!next) break; start = next.index + next.length; } return nalus; }
function readNaluLength(bytes, off, lengthSize) { let len = 0; for (let i = 0; i < lengthSize; i++) len = (len * 256) + bytes[off + i]; return len; }
function splitLengthPrefixedNalUnits(bytes, lengthSize) { if (!(bytes instanceof Uint8Array) || lengthSize < 1 || lengthSize > 4) return null; const nalus = []; let off = 0; while (off + lengthSize <= bytes.length) { const len = readNaluLength(bytes, off, lengthSize); off += lengthSize; if (len <= 0 || off + len > bytes.length) return null; nalus.push(bytes.subarray(off, off + len)); off += len; } return off === bytes.length && nalus.length ? nalus : null; }
function lengthPrefixedNalUnitsTo4(bytes, lengthSize) { const nalus = splitLengthPrefixedNalUnits(bytes, lengthSize); if (!nalus) return null; if (lengthSize === 4) return bytes; const parts = []; for (const nalu of nalus) parts.push(u32(nalu.length), nalu); return concatBytes(parts); }
function annexBToLengthPrefixed(bytes) { const nalus = splitAnnexBNalus(bytes); if (!nalus.length) return null; const parts = []; for (const nalu of nalus) parts.push(u32(nalu.length), nalu); return concatBytes(parts); }
function normalizeH264SamplePayload(payload, lengthSize) { if (!(payload instanceof Uint8Array) || payload.length <= 0) return null; if (hasAnnexBStartCode(payload)) return annexBToLengthPrefixed(payload); const preferred = lengthPrefixedNalUnitsTo4(payload, lengthSize || 4); if (preferred) return preferred; for (const size of [4, 3, 2, 1]) { if (size === lengthSize) continue; const converted = lengthPrefixedNalUnitsTo4(payload, size); if (converted) return converted; } return null; }
function parseH264ParameterSets(payload, lengthSize = 4) { let nalus = []; if (hasAnnexBStartCode(payload)) nalus = splitAnnexBNalus(payload); else nalus = splitLengthPrefixedNalUnits(payload, lengthSize) || splitLengthPrefixedNalUnits(payload, 4) || []; let sps = null; let pps = null; for (const nalu of nalus) { if (!(nalu instanceof Uint8Array) || nalu.length <= 0) continue; const t = nalu[0] & 0x1f; if (t === 7 && !sps) sps = nalu.slice(0); if (t === 8 && !pps) pps = nalu.slice(0); if (sps && pps) break; } return { sps, pps }; }
function h264PayloadHasIdr(payload) { let nalus = []; if (hasAnnexBStartCode(payload)) nalus = splitAnnexBNalus(payload); else nalus = splitLengthPrefixedNalUnits(payload, 4) || []; return nalus.some((nalu) => nalu.length > 0 && (nalu[0] & 0x1f) === 5); }
function isFlvVideoConfigFrame(frame) { const fs = frame?.formatSpecific || {}; if (Number(fs?._avcPacketType_value) === 0 || Number(fs?._avcPacketType_value) === 2) return true; if (Number(fs?._isExHeader_value) === 1 && Number(fs?._packetType_value) === 0) return true; return false; }
function isFrameKeyframe(frame, payload = null) { const fs = frame?.formatSpecific || {}; if (frame?.isKeyframe === true || frame?.isKeyFrame === true || fs?.keyframe === true) return true; if (Number(fs?._frameType_value) === 1) return true; return payload instanceof Uint8Array ? h264PayloadHasIdr(payload) : false; }
function firstFinite(...values) { for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; } return null; }
function fpsFromStream(stream) { const candidates = [stream?.avgFrameRate, stream?.rFrameRate, stream?.frameRate, stream?.fps]; for (const raw of candidates) { if (typeof raw === "string" && raw.includes("/")) { const [a, b] = raw.split("/").map(Number); if (Number.isFinite(a) && Number.isFinite(b) && b > 0 && a > 0) return a / b; } const n = Number(raw); if (Number.isFinite(n) && n > 0) return n; } return 30; }
function estimateSampleDurationMs(samples, stream) { const diffs = []; for (let i = 1; i < samples.length; i++) { const diff = samples[i].dtsMs - samples[i - 1].dtsMs; if (Number.isFinite(diff) && diff > 0) diffs.push(diff); } if (diffs.length) { diffs.sort((a, b) => a - b); return Math.max(1, Math.round(diffs[Math.floor(diffs.length / 2)])); } return Math.max(1, Math.round(1000 / fpsFromStream(stream))); }
function medianPositiveDtsDiffMs(samples, startIndex = 1, maxItems = 32) { const diffs = []; for (let i = Math.max(1, startIndex); i < samples.length && diffs.length < maxItems; i++) { const diff = samples[i].dtsMs - samples[i - 1].dtsMs; if (Number.isFinite(diff) && diff > 0) diffs.push(diff); } if (!diffs.length) return null; diffs.sort((a, b) => a - b); return Math.round(diffs[Math.floor(diffs.length / 2)]); }
function compactSample(sample, idx) { const frame = sample?.frameIndex ?? sample?.sourceOrder ?? idx; const key = sample?.isKeyframe ? "K" : "D"; const dur = Number.isFinite(sample?.duration) ? ` dur=${Math.round(sample.duration)}ms` : ""; const cto = Number.isFinite(sample?.compositionOffset) ? ` cto=${Math.round(sample.compositionOffset)}ms` : ""; return `#${idx}/f${frame}/${key} dts=${fmtMs(sample?.dtsMs)} pts=${fmtMs(sample?.ptsMs)}${dur}${cto}`; }
function compactSamples(samples, max = 6) { const input = Array.isArray(samples) ? samples : []; const head = input.slice(0, max).map(compactSample); const suffix = input.length > max ? ` ... +${input.length - max}` : ""; return `${head.join(" | ")}${suffix}`; }
function findDtsGapWarnings(samples, expectedDurationMs) { const input = Array.isArray(samples) ? samples : []; const expected = Math.max(1, Number(expectedDurationMs) || 33); const largeGap = Math.max(1000, expected * 12); const warnings = []; for (let i = 1; i < input.length && warnings.length < 6; i++) { const diff = input[i].dtsMs - input[i - 1].dtsMs; if (!Number.isFinite(diff)) continue; if (diff <= 0) warnings.push(`#${i} non-monotonic ${Math.round(diff)}ms`); else if (diff > largeGap) warnings.push(`#${i} large-gap ${Math.round(diff)}ms`); } return warnings; }
function maybeRepairInitialZeroTimestampJump(samples, estimatedDurationMs) { const input = Array.isArray(samples) ? samples : []; if (input.length < 3) return { samples: input, repaired: false }; const first = input[0]; const second = input[1]; const firstNearZero = Math.abs(Number(first?.dtsMs) || 0) <= 1; const jumpMs = Number(second?.dtsMs) - Number(first?.dtsMs); const medianDiffMs = medianPositiveDtsDiffMs(input, 2) || Number(estimatedDurationMs) || 33; const thresholdMs = Math.max(3000, medianDiffMs * 20); if (!firstNearZero || !Number.isFinite(jumpMs) || jumpMs <= thresholdMs || medianDiffMs <= 0 || medianDiffMs > 1000) return { samples: input, repaired: false, jumpMs, medianDiffMs }; const ctoMs = (Number(first?.ptsMs) || 0) - (Number(first?.dtsMs) || 0); const fixedFirstDtsMs = Math.max(0, Math.round(Number(second.dtsMs) - medianDiffMs)); const fixed = [{ ...first, dtsMs: fixedFirstDtsMs, ptsMs: fixedFirstDtsMs + ctoMs }, ...input.slice(1)]; return { samples: fixed, repaired: true, fixedFirstDtsMs, jumpMs, medianDiffMs }; }

function buildH264Fmp4FromAnalysis({ mediaInfo, result, pushLog }) {
  const primary = pickPrimaryMediaResult(mediaInfo);
  if (!primary) throw new Error("No analyzed media available for transmux.");
  const streams = Array.isArray(primary.streams) ? primary.streams : [];
  const videoStream = streams.find((s) => s.codecType === "video");
  const codecName = String(videoStream?.codecName || "").toLowerCase();
  if (!codecName.includes("264") && !codecName.includes("avc")) throw new Error(`MSE transmux currently supports H.264 only, got ${videoStream?.codecName || "unknown"}.`);
  const videoFrames = collectVideoFrames(mediaInfo);
  if (!videoFrames.length) throw new Error("No video frames to transmux.");
  const avcC = extractAvcCForFmp4(videoFrames, mediaInfo, 4);
  if (!(avcC instanceof Uint8Array) || avcC.length < 7) throw new Error("Missing H.264 avcC/SPS/PPS for fMP4.");
  const inputLengthSize = ((avcC[4] & 0x03) + 1) || 4;
  const fileData = primary?.formatSpecific?.fileData;
  const rawSamples = [];
  for (let i = 0; i < videoFrames.length; i++) {
    const frame = videoFrames[i];
    if (isFlvVideoConfigFrame(frame)) continue;
    const payload = sliceFrameBytes(frame, fileData);
    const data = normalizeH264SamplePayload(payload, inputLengthSize);
    if (!(data instanceof Uint8Array) || data.length <= 0) continue;
    const fallbackTime = i / fpsFromStream(videoStream);
    const dtsSec = firstFinite(frame?.dtsTime, frame?.ptsTime, fallbackTime);
    const ptsSec = firstFinite(frame?.ptsTime, frame?.dtsTime, fallbackTime);
    rawSamples.push({ data, frameIndex: frame?.index ?? null, sourceOrder: i, dtsMs: Math.max(0, Math.round((dtsSec || 0) * 1000)), ptsMs: Math.max(0, Math.round((ptsSec || 0) * 1000)), isKeyframe: isFrameKeyframe(frame, data) });
  }
  rawSamples.sort((a, b) => (a.dtsMs - b.dtsMs) || (a.sourceOrder - b.sourceOrder));
  if (!rawSamples.length) throw new Error("No H.264 access-unit payloads to transmux.");
  const firstKeyIndex = rawSamples.findIndex((sample) => sample.isKeyframe);
  if (firstKeyIndex < 0) throw new Error("No H.264 keyframe found for fMP4 fragment start.");
  let playableSamples = rawSamples.slice(firstKeyIndex);
  playableSamples[0].isKeyframe = true;
  const sourceStartMs = Math.max(0, playableSamples[0].dtsMs);
  const estimatedDurationBeforeRepair = estimateSampleDurationMs(playableSamples, videoStream);
  const timestampRepair = maybeRepairInitialZeroTimestampJump(playableSamples, estimatedDurationBeforeRepair);
  playableSamples = timestampRepair.samples;
  const muxBaseDtsMs = Math.max(0, playableSamples[0].dtsMs);
  const normalizedSamples = playableSamples.map((sample) => ({ ...sample, dtsMs: Math.max(0, sample.dtsMs - muxBaseDtsMs), ptsMs: sample.ptsMs - muxBaseDtsMs }));
  const defaultDuration = estimateSampleDurationMs(normalizedSamples, videoStream);
  let maxEndMs = 0;
  const samples = normalizedSamples.map((sample, idx) => {
    const next = normalizedSamples[idx + 1];
    const duration = next && next.dtsMs > sample.dtsMs ? next.dtsMs - sample.dtsMs : defaultDuration;
    const compositionOffset = sample.ptsMs - sample.dtsMs;
    maxEndMs = Math.max(maxEndMs, sample.dtsMs + duration, sample.ptsMs + duration);
    return { ...sample, duration: Math.max(1, Math.round(duration)), compositionOffset: Math.round(compositionOffset) };
  });
  const width = Math.max(16, Math.round(Number(videoStream?.width) || 1920));
  const height = Math.max(16, Math.round(Number(videoStream?.height) || 1080));
  const timescale = 1000;
  const duration = Math.max(1, Math.ceil(maxEndMs));
  const ftyp = mp4Box("ftyp", asciiBytes("isom"), u32(0x00000200), asciiBytes("isom"), asciiBytes("iso6"), asciiBytes("avc1"), asciiBytes("mp41"));
  const moov = buildMoov({ width, height, timescale, duration, avcC });
  const moof = buildMoof(samples, 0);
  const mdat = mp4Box("mdat", concatBytes(samples.map((sample) => sample.data)));
  const codec = h264CodecFromAvcC(avcC);
  if (typeof pushLog === "function") {
    const keyCount = rawSamples.filter((sample) => sample.isKeyframe).length;
    const rawFirst = rawSamples[0] || null;
    const rawLast = rawSamples[rawSamples.length - 1] || null;
    pushLog(`[mse ts] raw=${rawSamples.length}, playable=${playableSamples.length}, keyframes=${keyCount}, firstKeyRawIndex=${firstKeyIndex}, codec=${codec}`);
    pushLog(`[mse ts] raw range dts=${fmtMs(rawFirst?.dtsMs)}..${fmtMs(rawLast?.dtsMs)}, pts=${fmtMs(rawFirst?.ptsMs)}..${fmtMs(rawLast?.ptsMs)}`);
    pushLog(`[mse ts] raw first samples: ${compactSamples(rawSamples)}`);
    if (timestampRepair?.repaired) pushLog(`[mse ts] repaired initial zero timestamp: jump=${Math.round(timestampRepair.jumpMs)}ms, medianDelta=${Math.round(timestampRepair.medianDiffMs)}ms, firstDts=>${fmtMs(timestampRepair.fixedFirstDtsMs)}`);
    const warnings = findDtsGapWarnings(normalizedSamples, defaultDuration);
    if (warnings.length) pushLog(`[mse ts] normalized warnings: ${warnings.join(" | ")}`);
    pushLog(`[mse ts] mux base=${fmtMs(muxBaseDtsMs)}, uiOffset=${fmtMs(sourceStartMs)}, defaultDur=${Math.round(defaultDuration)}ms, muxDuration=${fmtMs(duration)}`);
  }
  return { bytes: concatBytes([ftyp, moov, moof, mdat]), mime: `video/mp4; codecs="${codec}"`, durationSec: duration / timescale, frameCount: samples.length, originalFrameCount: rawSamples.length, droppedFrameCount: firstKeyIndex, sourceStartSec: sourceStartMs / 1000, codec };
}

function extractAvcCForFmp4(videoFrames, mediaInfo, fallbackLengthSize) {
  const target = videoFrames.find((frame) => !isFlvVideoConfigFrame(frame) && isFrameKeyframe(frame)) || videoFrames.find((frame) => !isFlvVideoConfigFrame(frame));
  if (target) {
    try {
      const plan = buildVideoDecodePlan({ mediaInfo, targetFrameIndex: target.index });
      if (plan?.description instanceof Uint8Array && plan.description.length >= 7) return forceAvcC4ByteLengthSize(plan.description);
    } catch {}
  }
  let sps = null;
  let pps = null;
  const primary = pickPrimaryMediaResult(mediaInfo);
  const fileData = primary?.formatSpecific?.fileData;
  for (const frame of videoFrames) {
    if (isFlvVideoConfigFrame(frame)) continue;
    const payload = sliceFrameBytes(frame, fileData);
    if (!(payload instanceof Uint8Array) || payload.length <= 0) continue;
    const ps = parseH264ParameterSets(payload, fallbackLengthSize);
    sps = sps || ps.sps;
    pps = pps || ps.pps;
    if (sps && pps) break;
  }
  return forceAvcC4ByteLengthSize(buildAvcDecoderConfigRecord(sps, pps));
}

function waitEvent(target, eventName, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timeout waiting ${eventName}`)); }, timeoutMs);
    const onDone = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(`Error while waiting ${eventName}`)); };
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(eventName, onDone); target.removeEventListener("error", onError); };
    target.addEventListener(eventName, onDone, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function appendMseBytes(sourceBuffer, bytes) {
  return new Promise((resolve, reject) => {
    const onDone = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("MSE SourceBuffer append failed.")); };
    const cleanup = () => { sourceBuffer.removeEventListener("updateend", onDone); sourceBuffer.removeEventListener("error", onError); };
    sourceBuffer.addEventListener("updateend", onDone, { once: true });
    sourceBuffer.addEventListener("error", onError, { once: true });
    sourceBuffer.appendBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  });
}

