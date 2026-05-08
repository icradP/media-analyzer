import {
  buildVideoDecodePlan,
  codecCandidatesForStream,
  collectAudioFrames,
  collectVideoFrames,
  pickPrimaryMediaResult,
  sliceFrameBytes,
} from "../browser/index.js";
import { decodeG711ToFloat32 } from "../codec/g711.js";

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
        const streams = Array.isArray(result?.streams) ? result.streams : [];
        const hasVideo = streams.some((s) => s?.codecType === "video");
        const hasAudio = streams.some((s) => s?.codecType === "audio");
        const audioOnly = hasAudio && !hasVideo;
        this.#status(audioOnly ? "Transmuxing audio to fMP4 for MSE..." : "Transmuxing H.264 to fMP4 for MSE...");
        const muxed = audioOnly
          ? await buildAudioOnlyFmp4FromAnalysis({ mediaInfo, result, pushLog: this.#log.bind(this) })
          : await buildH264Fmp4FromAnalysis({ mediaInfo, result, pushLog: this.#log.bind(this) });
        const reasonParts = [muxed.audioCodec ? `fMP4 with ${muxed.audioCodec} audio` : "video-only fMP4", `${muxed.frameCount} frames`];
        if (muxed.audioFrameCount > 0) reasonParts.push(`${muxed.audioFrameCount} audio frames`);
        if (muxed.droppedFrameCount > 0) reasonParts.push(`dropped ${muxed.droppedFrameCount} pre-keyframe frames`);
        if (muxed.sourceStartSec > 0.001) reasonParts.push(`source starts at ${fmt(muxed.sourceStartSec, this.formatTime)}`);
        return await this.#createMseBufferedSource(
          muxed.bytes,
          [muxed.mime, audioOnly ? "audio/mp4" : "video/mp4"],
          sourceDurationSec(result, muxed.durationSec),
          audioOnly ? "mse-transmuxed-audio" : "mse-transmuxed",
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
function buildMvhd(timescale, duration, nextTrackId = 2) { return fullMp4Box("mvhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), mp4Matrix(), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(nextTrackId)); }
function buildTkhd({ trackId = 1, width = 0, height = 0, duration = 1, volume = 0 } = {}) { return fullMp4Box("tkhd", 0, 0x000007, u32(0), u32(0), u32(trackId), u32(0), u32(duration), u32(0), u32(0), u16(0), u16(0), u16(volume), u16(0), mp4Matrix(), fixed16_16(width), fixed16_16(height)); }
function buildMdhd(timescale, duration) { return fullMp4Box("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)); }
function buildHdlr(handlerType = "vide", name = "VideoHandler") { return fullMp4Box("hdlr", 0, 0, u32(0), asciiBytes(handlerType), u32(0), u32(0), u32(0), asciiBytes(`${name}\0`)); }
function buildDinf() { const url = fullMp4Box("url ", 0, 0x000001); const dref = fullMp4Box("dref", 0, 0, u32(1), url); return mp4Box("dinf", dref); }
function buildAvc1SampleEntry(width, height, avcC) { const compressorName = new Uint8Array(32); return mp4Box("avc1", new Uint8Array([0,0,0,0,0,0,0,1]), u16(0), u16(0), u32(0), u32(0), u32(0), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), compressorName, u16(0x0018), u16(0xffff), mp4Box("avcC", avcC)); }
function buildVideoStbl(width, height, avcC) { const stsd = fullMp4Box("stsd", 0, 0, u32(1), buildAvc1SampleEntry(width, height, avcC)); return mp4Box("stbl", stsd, fullMp4Box("stts",0,0,u32(0)), fullMp4Box("stsc",0,0,u32(0)), fullMp4Box("stsz",0,0,u32(0),u32(0)), fullMp4Box("stco",0,0,u32(0))); }
function descriptorLength(length) { return u8(Math.max(0, Math.min(0x7f, Number(length) || 0))); }
function buildEsds(audioSpecificConfig, avgBitrate = 0) { const asc = audioSpecificConfig instanceof Uint8Array ? audioSpecificConfig : new Uint8Array([0x12, 0x10]); const decoderSpecific = concatBytes([u8(0x05), descriptorLength(asc.length), asc]); const decoderConfigBody = concatBytes([u8(0x40), u8(0x15), u24(0), u32(avgBitrate || 0), u32(avgBitrate || 0), decoderSpecific]); const decoderConfig = concatBytes([u8(0x04), descriptorLength(decoderConfigBody.length), decoderConfigBody]); const slConfig = concatBytes([u8(0x06), descriptorLength(1), u8(0x02)]); const esBody = concatBytes([u16(1), u8(0), decoderConfig, slConfig]); return fullMp4Box("esds", 0, 0, u8(0x03), descriptorLength(esBody.length), esBody); }
function buildMp4aSampleEntry({ sampleRate, channels, audioSpecificConfig, avgBitrate }) { const rate = Math.max(1, Math.round(Number(sampleRate) || 44100)); const ch = Math.max(1, Math.min(8, Math.round(Number(channels) || 2))); return mp4Box("mp4a", new Uint8Array([0,0,0,0,0,0,0,1]), u32(0), u32(0), u16(ch), u16(16), u16(0), u16(0), u32(rate * 65536), buildEsds(audioSpecificConfig, avgBitrate)); }
function buildAudioStbl(audioTrack) { const stsd = fullMp4Box("stsd", 0, 0, u32(1), buildMp4aSampleEntry(audioTrack)); return mp4Box("stbl", stsd, fullMp4Box("stts",0,0,u32(0)), fullMp4Box("stsc",0,0,u32(0)), fullMp4Box("stsz",0,0,u32(0),u32(0)), fullMp4Box("stco",0,0,u32(0))); }
function buildTrex(trackId) { return fullMp4Box("trex", 0, 0, u32(trackId), u32(1), u32(0), u32(0), u32(0)); }
function buildMoov({ width, height, timescale, duration, avcC, audioTrack = null }) {
  const safeDuration = Math.max(1, Math.ceil(Number(duration) || 1));
  const videoTrackId = 1;
  const audioTrackId = 2;
  const hasVideo = avcC instanceof Uint8Array && avcC.length >= 7;
  const traks = [];
  const trexs = [];
  if (hasVideo) {
    const vmhd = fullMp4Box("vmhd", 0, 0x000001, u16(0), u16(0), u16(0), u16(0));
    const videoMinf = mp4Box("minf", vmhd, buildDinf(), buildVideoStbl(width, height, avcC));
    const videoMdia = mp4Box("mdia", buildMdhd(timescale, safeDuration), buildHdlr("vide", "VideoHandler"), videoMinf);
    const videoTrak = mp4Box("trak", buildTkhd({ trackId: videoTrackId, width, height, duration: safeDuration, volume: 0 }), videoMdia);
    traks.push(videoTrak);
    trexs.push(buildTrex(videoTrackId));
  }
  if (audioTrack?.samples?.length) {
    const sampleRate = Math.max(1, Math.round(Number(audioTrack.sampleRate) || 44100));
    const audioDuration = Math.max(1, Math.ceil(Number(audioTrack.duration) || 1));
    const smhd = fullMp4Box("smhd", 0, 0, u16(0), u16(0));
    const audioMinf = mp4Box("minf", smhd, buildDinf(), buildAudioStbl(audioTrack));
    const audioMdia = mp4Box("mdia", buildMdhd(sampleRate, audioDuration), buildHdlr("soun", "SoundHandler"), audioMinf);
    traks.push(mp4Box("trak", buildTkhd({ trackId: audioTrackId, duration: Math.ceil((audioDuration / sampleRate) * timescale), volume: 0x0100 }), audioMdia));
    trexs.push(buildTrex(audioTrackId));
  }
  return mp4Box("moov", buildMvhd(timescale, safeDuration, traks.length + 1), ...traks, mp4Box("mvex", ...trexs));
}
function buildVideoTrun(samples, dataOffset) { const rows = []; for (const s of samples) rows.push(u32(s.duration), u32(s.data.length), u32(s.isKeyframe ? 0x02000000 : 0x01010000), i32(s.compositionOffset)); return fullMp4Box("trun", 1, 0x000f01, u32(samples.length), i32(dataOffset), ...rows); }
function buildAudioTrun(samples, dataOffset) { const rows = []; for (const s of samples) rows.push(u32(s.duration), u32(s.data.length)); return fullMp4Box("trun", 0, 0x000301, u32(samples.length), i32(dataOffset), ...rows); }
function buildMoof(videoSamples, audioSamples = [], baseVideoDecodeTime = 0, baseAudioDecodeTime = 0) {
  const mfhd = fullMp4Box("mfhd", 0, 0, u32(1));
  const hasVideo = Array.isArray(videoSamples) && videoSamples.length > 0;
  const hasAudio = Array.isArray(audioSamples) && audioSamples.length > 0;
  if (!hasVideo && !hasAudio) throw new Error("No samples for moof.");
  const videoTfhd = fullMp4Box("tfhd", 0, 0x020000, u32(1));
  const audioTfhd = fullMp4Box("tfhd", 0, 0x020000, u32(2));
  const videoTfdt = fullMp4Box("tfdt", 1, 0, u64(baseVideoDecodeTime));
  const audioTfdt = fullMp4Box("tfdt", 1, 0, u64(baseAudioDecodeTime));
  let videoTrun = hasVideo ? buildVideoTrun(videoSamples, 0) : null;
  let audioTrun = hasAudio ? buildAudioTrun(audioSamples, 0) : null;
  let trafs = [];
  if (videoTrun) trafs.push(mp4Box("traf", videoTfhd, videoTfdt, videoTrun));
  if (audioTrun) trafs.push(mp4Box("traf", audioTfhd, audioTfdt, audioTrun));
  let moof = mp4Box("moof", mfhd, ...trafs);
  const videoDataLength = hasVideo ? videoSamples.reduce((sum, sample) => sum + sample.data.length, 0) : 0;
  videoTrun = hasVideo ? buildVideoTrun(videoSamples, moof.length + 8) : null;
  audioTrun = hasAudio ? buildAudioTrun(audioSamples, moof.length + 8 + videoDataLength) : null;
  trafs = [];
  if (videoTrun) trafs.push(mp4Box("traf", videoTfhd, videoTfdt, videoTrun));
  if (audioTrun) trafs.push(mp4Box("traf", audioTfhd, audioTfdt, audioTrun));
  return mp4Box("moof", mfhd, ...trafs);
}
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
function h264PayloadNalTypes(payload) { let nalus = []; if (hasAnnexBStartCode(payload)) nalus = splitAnnexBNalus(payload); else nalus = splitLengthPrefixedNalUnits(payload, 4) || []; return nalus.map((nalu) => nalu.length > 0 ? nalu[0] & 0x1f : -1).filter((type) => type >= 0); }
function h264PayloadHasIdr(payload) { return h264PayloadNalTypes(payload).includes(5); }
function h264PayloadHasParameterSets(payload) {
  const types = h264PayloadNalTypes(payload);
  return types.includes(7) && types.includes(8);
}
function filterH264SampleNalUnits(payload, { dropAud = true, dropFiller = true, dropUnsupported = true, requireVcl = true } = {}) {
  const nalus = splitLengthPrefixedNalUnits(payload, 4);
  if (!nalus || !nalus.length) return null;
  const kept = [];
  let hasVcl = false;
  const allowed = new Set([1, 5, 6, 7, 8]);
  for (const nalu of nalus) {
    if (!(nalu instanceof Uint8Array) || nalu.length <= 0) continue;
    const type = nalu[0] & 0x1f;
    if (dropAud && type === 9) continue;
    if (dropFiller && type === 12) continue;
    if (dropUnsupported && !allowed.has(type)) continue;
    if (type === 1 || type === 5) hasVcl = true;
    kept.push(nalu);
  }
  if (requireVcl && !hasVcl) return null;
  if (!kept.length) return null;
  const parts = [];
  for (const nalu of kept) parts.push(u32(nalu.length), nalu);
  return concatBytes(parts);
}
function lengthPrefixedNalu(nalu) {
  if (!(nalu instanceof Uint8Array) || nalu.length <= 0) return null;
  return concatBytes([u32(nalu.length), nalu]);
}
function parseAvcCParameterSets(avcC) {
  if (!(avcC instanceof Uint8Array) || avcC.length < 7) return { sps: null, pps: null };
  let off = 5;
  const spsCount = avcC[off++] & 0x1f;
  let sps = null;
  for (let i = 0; i < spsCount && off + 2 <= avcC.length; i++) {
    const len = (avcC[off] << 8) | avcC[off + 1];
    off += 2;
    if (len <= 0 || off + len > avcC.length) break;
    if (!sps) sps = avcC.slice(off, off + len);
    off += len;
  }
  if (off >= avcC.length) return { sps, pps: null };
  const ppsCount = avcC[off++];
  let pps = null;
  for (let i = 0; i < ppsCount && off + 2 <= avcC.length; i++) {
    const len = (avcC[off] << 8) | avcC[off + 1];
    off += 2;
    if (len <= 0 || off + len > avcC.length) break;
    if (!pps) pps = avcC.slice(off, off + len);
    off += len;
  }
  return { sps, pps };
}
function prependParameterSetsToIdrSample(sampleData, avcC) {
  if (!(sampleData instanceof Uint8Array) || sampleData.length <= 0) return sampleData;
  if (h264PayloadHasParameterSets(sampleData)) return sampleData;
  const { sps, pps } = parseAvcCParameterSets(avcC);
  const spsBytes = lengthPrefixedNalu(sps);
  const ppsBytes = lengthPrefixedNalu(pps);
  if (!spsBytes || !ppsBytes) return sampleData;
  return concatBytes([spsBytes, ppsBytes, sampleData]);
}
function isFlvVideoConfigFrame(frame) { const fs = frame?.formatSpecific || {}; if (Number(fs?._avcPacketType_value) === 0 || Number(fs?._avcPacketType_value) === 2) return true; if (Number(fs?._isExHeader_value) === 1 && Number(fs?._packetType_value) === 0) return true; return false; }
function isFrameKeyframe(frame, payload = null) { const fs = frame?.formatSpecific || {}; if (frame?.isKeyframe === true || frame?.isKeyFrame === true || fs?.keyframe === true) return true; if (Number(fs?._frameType_value) === 1) return true; return payload instanceof Uint8Array ? h264PayloadHasIdr(payload) : false; }
function firstFinite(...values) { for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; } return null; }
function fpsFromStream(stream) { const candidates = [stream?.avgFrameRate, stream?.rFrameRate, stream?.frameRate, stream?.fps]; for (const raw of candidates) { if (typeof raw === "string" && raw.includes("/")) { const [a, b] = raw.split("/").map(Number); if (Number.isFinite(a) && Number.isFinite(b) && b > 0 && a > 0) return a / b; } const n = Number(raw); if (Number.isFinite(n) && n > 0) return n; } return 30; }
function estimateSampleDurationMs(samples, stream) { const diffs = []; for (let i = 1; i < samples.length; i++) { const diff = samples[i].dtsMs - samples[i - 1].dtsMs; if (Number.isFinite(diff) && diff > 0) diffs.push(diff); } if (diffs.length) { diffs.sort((a, b) => a - b); return Math.max(1, Math.round(diffs[Math.floor(diffs.length / 2)])); } return Math.max(1, Math.round(1000 / fpsFromStream(stream))); }
function medianPositiveDtsDiffMs(samples, startIndex = 1, maxItems = 32) { const diffs = []; for (let i = Math.max(1, startIndex); i < samples.length && diffs.length < maxItems; i++) { const diff = samples[i].dtsMs - samples[i - 1].dtsMs; if (Number.isFinite(diff) && diff > 0) diffs.push(diff); } if (!diffs.length) return null; diffs.sort((a, b) => a - b); return Math.round(diffs[Math.floor(diffs.length / 2)]); }
function compactSample(sample, idx) { const frame = sample?.frameIndex ?? sample?.sourceOrder ?? idx; const key = sample?.hasIdr ? "IDR" : sample?.isKeyframe ? "K" : "D"; const nalTypes = Array.isArray(sample?.nalTypes) && sample.nalTypes.length ? ` nal=${sample.nalTypes.slice(0, 8).join(".")}` : ""; const dur = Number.isFinite(sample?.duration) ? ` dur=${Math.round(sample.duration)}ms` : ""; const cto = Number.isFinite(sample?.compositionOffset) ? ` cto=${Math.round(sample.compositionOffset)}ms` : ""; return `#${idx}/f${frame}/${key} dts=${fmtMs(sample?.dtsMs)} pts=${fmtMs(sample?.ptsMs)}${dur}${cto}${nalTypes}`; }
function compactSamples(samples, max = 6) { const input = Array.isArray(samples) ? samples : []; const head = input.slice(0, max).map(compactSample); const suffix = input.length > max ? ` ... +${input.length - max}` : ""; return `${head.join(" | ")}${suffix}`; }
function findDtsGapWarnings(samples, expectedDurationMs) { const input = Array.isArray(samples) ? samples : []; const expected = Math.max(1, Number(expectedDurationMs) || 33); const largeGap = Math.max(1000, expected * 12); const warnings = []; for (let i = 1; i < input.length && warnings.length < 6; i++) { const diff = input[i].dtsMs - input[i - 1].dtsMs; if (!Number.isFinite(diff)) continue; if (diff <= 0) warnings.push(`#${i} non-monotonic ${Math.round(diff)}ms`); else if (diff > largeGap) warnings.push(`#${i} large-gap ${Math.round(diff)}ms`); } return warnings; }
function maybeRepairInitialZeroTimestampJump(samples, estimatedDurationMs) { const input = Array.isArray(samples) ? samples : []; if (input.length < 3) return { samples: input, repaired: false }; const first = input[0]; const second = input[1]; const firstNearZero = Math.abs(Number(first?.dtsMs) || 0) <= 1; const jumpMs = Number(second?.dtsMs) - Number(first?.dtsMs); const medianDiffMs = medianPositiveDtsDiffMs(input, 2) || Number(estimatedDurationMs) || 33; const thresholdMs = Math.max(3000, medianDiffMs * 20); if (!firstNearZero || !Number.isFinite(jumpMs) || jumpMs <= thresholdMs || medianDiffMs <= 0 || medianDiffMs > 1000) return { samples: input, repaired: false, jumpMs, medianDiffMs }; const ctoMs = (Number(first?.ptsMs) || 0) - (Number(first?.dtsMs) || 0); const fixedFirstDtsMs = Math.max(0, Math.round(Number(second.dtsMs) - medianDiffMs)); const fixed = [{ ...first, dtsMs: fixedFirstDtsMs, ptsMs: fixedFirstDtsMs + ctoMs }, ...input.slice(1)]; return { samples: fixed, repaired: true, fixedFirstDtsMs, jumpMs, medianDiffMs }; }

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function frameCodecNameHint(frame, audioStream) {
  const streamName = String(audioStream?.codecName || "").toLowerCase();
  if (streamName) return streamName;
  const fs = frame?.formatSpecific || {};
  return String(frame?.codecName || fs?.codecName || fs?.codec || fs?.soundFormat || "").toLowerCase();
}
function isG711CodecName(codecName) { return codecName.includes("g.711") || codecName.includes("g711") || codecName.includes("pcma") || codecName.includes("pcmu"); }
function isG711AudioStreamOrFrame(audioStream, frame) {
  if (isG711CodecName(frameCodecNameHint(frame, audioStream))) return true;
  const soundFormat = Number(frame?.formatSpecific?._soundFormat_value);
  return soundFormat === 7 || soundFormat === 8;
}
function g711LawForFrame(frame, audioStream) {
  const codecName = frameCodecNameHint(frame, audioStream);
  if (codecName.includes("mu-law") || codecName.includes("mulaw") || codecName.includes("u-law") || codecName.includes("ulaw") || codecName.includes("pcmu")) return "mulaw";
  if (codecName.includes("a-law") || codecName.includes("alaw") || codecName.includes("pcma")) return "alaw";
  return Number(frame?.formatSpecific?._soundFormat_value) === 8 ? "mulaw" : "alaw";
}
function resolveAudioChannelCount(frame, audioStream) {
  const trackChannels = Number(audioStream?.channels);
  if (Number.isFinite(trackChannels) && trackChannels > 0) return Math.round(trackChannels);
  const soundType = Number(frame?.formatSpecific?._soundType_value);
  if (Number.isFinite(soundType)) return soundType === 1 ? 2 : 1;
  return 1;
}
function resolveAudioSampleRate(frame, audioStream) {
  const trackRate = Number(audioStream?.sampleRate);
  if (Number.isFinite(trackRate) && trackRate > 0) return Math.round(trackRate);
  const soundRate = Number(frame?.formatSpecific?._soundRate_value);
  if (soundRate === 0) return 5512;
  if (soundRate === 1) return 11025;
  if (soundRate === 2) return 22050;
  if (soundRate === 3) return 44100;
  return 8000;
}
function audioFrameTimeMs(frame, fallbackSec = 0) {
  const sec = firstFinite(frame?.dtsTime, frame?.ptsTime, frame?.timestamp, frame?.time, fallbackSec);
  return Number.isFinite(sec) ? Math.max(0, Math.round(sec * 1000)) : null;
}
function isAacConfigFrame(frame) { return Number(frame?.formatSpecific?._aacPacketType_value) === 0; }
function sliceAudioPayloadBytes(frame, fileData) {
  const fo = frame?.fieldOffsets || frame?.formatSpecific?.fieldOffsets || {};
  const keys = isAacConfigFrame(frame)
    ? ["audioSpecificConfig", "configData", "aacData", "audioData", "data"]
    : ["aacData", "audioData", "data"];
  if (fileData instanceof Uint8Array) {
    for (const key of keys) {
      const range = fo[key];
      if (!range || !Number.isFinite(range.offset) || !Number.isFinite(range.length) || range.length <= 0) continue;
      const start = Number(range.offset);
      const end = start + Number(range.length);
      if (start >= 0 && end <= fileData.length) return fileData.subarray(start, end);
    }
  }
  return sliceFrameBytes(frame, fileData);
}
function isAdtsAac(payload) { return payload instanceof Uint8Array && payload.length >= 7 && payload[0] === 0xff && (payload[1] & 0xf0) === 0xf0; }
function parseAdtsAac(payload) {
  if (!isAdtsAac(payload)) return null;
  const objectType = ((payload[2] >>> 6) & 0x03) + 1;
  const sampleRateIndex = (payload[2] >>> 2) & 0x0f;
  const channelConfig = ((payload[2] & 0x01) << 2) | ((payload[3] >>> 6) & 0x03);
  const frameLength = ((payload[3] & 0x03) << 11) | (payload[4] << 3) | ((payload[5] >>> 5) & 0x07);
  const headerLength = (payload[1] & 0x01) ? 7 : 9;
  if (frameLength <= headerLength || frameLength > payload.length) return null;
  return {
    objectType,
    sampleRateIndex,
    sampleRate: AAC_SAMPLE_RATES[sampleRateIndex] || 44100,
    channels: channelConfig || 2,
    raw: payload.subarray(headerLength, frameLength),
  };
}
function buildAacAudioSpecificConfig(objectType, sampleRate, channels) {
  const ot = Math.max(1, Math.min(31, Math.round(Number(objectType) || 2)));
  let sampleRateIndex = AAC_SAMPLE_RATES.indexOf(Math.round(Number(sampleRate) || 44100));
  if (sampleRateIndex < 0) sampleRateIndex = 4;
  const channelConfig = Math.max(1, Math.min(15, Math.round(Number(channels) || 2)));
  return Uint8Array.of(((ot & 0x1f) << 3) | ((sampleRateIndex >> 1) & 0x07), ((sampleRateIndex & 0x01) << 7) | ((channelConfig & 0x0f) << 3));
}
function parseAacAudioSpecificConfig(config) {
  if (!(config instanceof Uint8Array) || config.length < 2) return null;
  const objectType = (config[0] >>> 3) & 0x1f;
  const sampleRateIndex = ((config[0] & 0x07) << 1) | (config[1] >>> 7);
  const channels = (config[1] >>> 3) & 0x0f;
  return { objectType, sampleRateIndex, sampleRate: AAC_SAMPLE_RATES[sampleRateIndex] || 44100, channels: channels || 2 };
}
function resolveAacInfo(audioFrames, audioStream, fileData) {
  let objectType = Number(audioStream?.profile);
  if (!Number.isFinite(objectType) || objectType <= 0) objectType = 2;
  let sampleRate = Number(audioStream?.sampleRate);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) sampleRate = 44100;
  let channels = Number(audioStream?.channels);
  if (!Number.isFinite(channels) || channels <= 0) channels = 2;
  let audioSpecificConfig = null;
  for (const frame of audioFrames) {
    const payload = sliceAudioPayloadBytes(frame, fileData);
    if (!(payload instanceof Uint8Array) || payload.length < 2) continue;
    if (isAacConfigFrame(frame)) {
      audioSpecificConfig = payload.slice(0);
      const parsed = parseAacAudioSpecificConfig(audioSpecificConfig);
      if (parsed) ({ objectType, sampleRate, channels } = parsed);
      break;
    }
    const adts = parseAdtsAac(payload);
    if (adts) {
      objectType = adts.objectType;
      sampleRate = adts.sampleRate;
      channels = adts.channels;
      audioSpecificConfig = buildAacAudioSpecificConfig(objectType, sampleRate, channels);
      break;
    }
  }
  if (!(audioSpecificConfig instanceof Uint8Array)) audioSpecificConfig = buildAacAudioSpecificConfig(objectType, sampleRate, channels);
  return { objectType, sampleRate: Math.round(sampleRate), channels: Math.round(channels), audioSpecificConfig };
}
function medianPositive(values) {
  const input = (values || []).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  return input.length ? input[Math.floor(input.length / 2)] : null;
}
function buildAudioTrackFromEncodedSamples({ rawSamples, sampleRate, channels, audioSpecificConfig, codec = "mp4a.40.2", source = "aac", bitrate = 0 }) {
  const sorted = (rawSamples || []).filter((sample) => sample?.data instanceof Uint8Array && sample.data.length > 0 && Number.isFinite(sample.dtsUnits)).sort((a, b) => a.dtsUnits - b.dtsUnits);
  if (!sorted.length) return null;
  const diffs = [];
  for (let i = 1; i < sorted.length; i++) {
    const diff = sorted[i].dtsUnits - sorted[i - 1].dtsUnits;
    if (diff > 0) diffs.push(diff);
  }
  const defaultDuration = Math.max(1, Math.round(medianPositive(diffs) || 1024));
  const baseDecodeTime = Math.max(0, Math.round(sorted[0].dtsUnits));
  let maxEnd = baseDecodeTime;
  const samples = sorted.map((sample, idx) => {
    const next = sorted[idx + 1];
    const duration = Number.isFinite(sample.durationUnits) && sample.durationUnits > 0
      ? sample.durationUnits
      : next && next.dtsUnits > sample.dtsUnits
        ? next.dtsUnits - sample.dtsUnits
        : defaultDuration;
    maxEnd = Math.max(maxEnd, Math.round(sample.dtsUnits + duration));
    return { data: sample.data, duration: Math.max(1, Math.round(duration)) };
  });
  return {
    samples,
    baseDecodeTime,
    duration: Math.max(1, maxEnd),
    sampleRate,
    channels,
    audioSpecificConfig,
    codec,
    source,
    avgBitrate: bitrate,
  };
}
function buildAacPassthroughTrack({ audioFrames, audioStream, fileData, sourceStartMs, sourceEndMs, pushLog }) {
  const info = resolveAacInfo(audioFrames, audioStream, fileData);
  const rawSamples = [];
  for (let i = 0; i < audioFrames.length; i++) {
    const frame = audioFrames[i];
    if (isAacConfigFrame(frame)) continue;
    const tMs = audioFrameTimeMs(frame, i * 1024 / info.sampleRate);
    if (!Number.isFinite(tMs) || tMs < sourceStartMs - 2 || tMs > sourceEndMs + 250) continue;
    let payload = sliceAudioPayloadBytes(frame, fileData);
    if (!(payload instanceof Uint8Array) || payload.length <= 0) continue;
    const adts = parseAdtsAac(payload);
    if (adts?.raw instanceof Uint8Array) payload = adts.raw;
    if (!(payload instanceof Uint8Array) || payload.length <= 0) continue;
    rawSamples.push({
      data: payload.slice(0),
      dtsUnits: Math.max(0, Math.round(((tMs - sourceStartMs) / 1000) * info.sampleRate)),
      durationUnits: 1024,
    });
  }
  const track = buildAudioTrackFromEncodedSamples({ rawSamples, ...info, codec: `mp4a.40.${Math.round(info.objectType || 2)}`, source: "aac" });
  if (track && typeof pushLog === "function") pushLog(`[mse audio] AAC passthrough: samples=${track.samples.length}, sampleRate=${track.sampleRate}, channels=${track.channels}, base=${track.baseDecodeTime}`);
  return track;
}
function decodeG711FramesToInterleavedFloat32(frames, mediaInfo, audioStream) {
  const primary = pickPrimaryMediaResult(mediaInfo);
  const fileData = primary?.formatSpecific?.fileData;
  const seed = frames[0] || null;
  const channels = resolveAudioChannelCount(seed, audioStream);
  const sampleRate = resolveAudioSampleRate(seed, audioStream);
  const law = g711LawForFrame(seed, audioStream);
  const decodedParts = [];
  let totalFrames = 0;
  for (const frame of frames) {
    const payload = sliceAudioPayloadBytes(frame, fileData);
    if (!(payload instanceof Uint8Array) || payload.length <= 0) continue;
    const decoded = decodeG711ToFloat32(payload, law, channels);
    if (!decoded.length || !decoded[0]?.length) continue;
    decodedParts.push(decoded);
    totalFrames += decoded[0].length;
  }
  if (!decodedParts.length || totalFrames <= 0) return null;
  const data = new Float32Array(totalFrames * channels);
  let offset = 0;
  for (const decoded of decodedParts) {
    const frameCount = decoded[0].length;
    for (let i = 0; i < frameCount; i++) {
      for (let ch = 0; ch < channels; ch++) data[(offset + i) * channels + ch] = decoded[ch]?.[i] || 0;
    }
    offset += frameCount;
  }
  return { data, totalFrames, channels, sampleRate, law };
}
function resampleInterleavedFloat32(input, fromRate, toRate, channels) {
  const srcRate = Math.max(1, Math.round(Number(fromRate) || 1));
  const dstRate = Math.max(1, Math.round(Number(toRate) || srcRate));
  const ch = Math.max(1, Math.round(Number(channels) || 1));
  if (!(input instanceof Float32Array) || input.length <= 0 || srcRate === dstRate) return input;
  const srcFrames = Math.floor(input.length / ch);
  const dstFrames = Math.max(1, Math.round((srcFrames * dstRate) / srcRate));
  const out = new Float32Array(dstFrames * ch);
  for (let i = 0; i < dstFrames; i++) {
    const srcPos = (i * srcRate) / dstRate;
    const left = Math.min(srcFrames - 1, Math.floor(srcPos));
    const right = Math.min(srcFrames - 1, left + 1);
    const frac = srcPos - left;
    for (let c = 0; c < ch; c++) {
      const a = input[left * ch + c] || 0;
      const b = input[right * ch + c] || 0;
      out[i * ch + c] = a + (b - a) * frac;
    }
  }
  return out;
}
function prependInterleavedSilence(input, silenceFrames, channels) {
  const ch = Math.max(1, Math.round(Number(channels) || 1));
  const leading = Math.max(0, Math.round(Number(silenceFrames) || 0));
  if (!(input instanceof Float32Array) || input.length <= 0 || leading <= 0) return input;
  const out = new Float32Array(input.length + leading * ch);
  out.set(input, leading * ch);
  return out;
}
async function encodePcmToAacWithWebCodecs({ pcm, sampleRate, channels, timestampUs, bitrate }) {
  if (typeof AudioEncoder !== "function" || typeof AudioData !== "function") throw new Error("PCMA/PCMU -> AAC requires WebCodecs AudioEncoder.");
  const candidateConfigs = [
    { codec: "mp4a.40.2", sampleRate, numberOfChannels: channels, bitrate },
    { codec: "aac", sampleRate, numberOfChannels: channels, bitrate },
  ];
  let config = null;
  for (const candidate of candidateConfigs) {
    if (typeof AudioEncoder.isConfigSupported !== "function") {
      config = candidate;
      break;
    }
    try {
      const support = await AudioEncoder.isConfigSupported(candidate);
      if (support?.supported) {
        config = support.config || candidate;
        break;
      }
    } catch {
      // try the next codec string
    }
  }
  if (!config) throw new Error(`PCMA/PCMU -> AAC unsupported by this browser AudioEncoder (${sampleRate}Hz/${channels}ch).`);
  const chunks = [];
  let decoderConfig = null;
  let encoderError = null;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const adts = parseAdtsAac(data);
      chunks.push({
        data: adts?.raw instanceof Uint8Array ? adts.raw.slice(0) : data,
        timestampUs: Number(chunk.timestamp) || 0,
        durationUs: Number(chunk.duration) || null,
      });
      if (metadata?.decoderConfig) decoderConfig = metadata.decoderConfig;
    },
    error: (err) => {
      encoderError = err;
    },
  });
  try {
    encoder.configure(config);
    const audioData = new AudioData({
      format: "f32",
      sampleRate,
      numberOfFrames: Math.floor(pcm.length / channels),
      numberOfChannels: channels,
      timestamp: Math.max(0, Math.round(Number(timestampUs) || 0)),
      data: pcm,
    });
    encoder.encode(audioData);
    audioData.close();
    await encoder.flush();
  } finally {
    try { encoder.close(); } catch {}
  }
  if (encoderError) throw encoderError;
  let description = null;
  const rawDesc = decoderConfig?.description;
  if (rawDesc instanceof Uint8Array) description = rawDesc.slice(0);
  else if (rawDesc instanceof ArrayBuffer) description = new Uint8Array(rawDesc.slice(0));
  return { chunks, decoderConfig, description, codec: decoderConfig?.codec || "mp4a.40.2" };
}
async function buildG711TranscodedAacTrack({ audioFrames, audioStream, mediaInfo, sourceStartMs, sourceEndMs, pushLog }) {
  const selected = [];
  for (let i = 0; i < audioFrames.length; i++) {
    const frame = audioFrames[i];
    const tMs = audioFrameTimeMs(frame, i * 0.02);
    if (!Number.isFinite(tMs) || tMs < sourceStartMs - 2 || tMs > sourceEndMs + 250) continue;
    selected.push(frame);
  }
  if (!selected.length) return null;
  const decoded = decodeG711FramesToInterleavedFloat32(selected, mediaInfo, audioStream);
  if (!decoded) return null;
  const firstMs = audioFrameTimeMs(selected[0], 0);
  const leadingSilenceFrames = Math.max(0, Math.round(((firstMs - sourceStartMs) / 1000) * decoded.sampleRate));
  const sourcePcm = prependInterleavedSilence(decoded.data, leadingSilenceFrames, decoded.channels);
  const timestampUs = 0;
  if (typeof pushLog === "function") pushLog(`[mse audio] transcoding ${frameCodecNameHint(selected[0], audioStream) || "g711"} -> AAC: frames=${selected.length}, pcm=${decoded.totalFrames}, leadSilence=${leadingSilenceFrames}, sampleRate=${decoded.sampleRate}, channels=${decoded.channels}`);
  const encodeRates = [decoded.sampleRate, 48000, 44100, 16000].filter((rate, idx, arr) => rate > 0 && arr.indexOf(rate) === idx);
  let encoded = null;
  let encodeRate = decoded.sampleRate;
  let bitrate = 64000;
  let lastEncodeErr = null;
  for (const rate of encodeRates) {
    const pcm = rate === decoded.sampleRate ? sourcePcm : resampleInterleavedFloat32(sourcePcm, decoded.sampleRate, rate, decoded.channels);
    bitrate = Math.max(32000, Math.min(128000, Math.round(rate * decoded.channels * 4)));
    try {
      if (rate !== decoded.sampleRate && typeof pushLog === "function") pushLog(`[mse audio] retry AAC transcode with resample ${decoded.sampleRate}Hz -> ${rate}Hz.`);
      encoded = await encodePcmToAacWithWebCodecs({
        pcm,
        sampleRate: rate,
        channels: decoded.channels,
        timestampUs,
        bitrate,
      });
      encodeRate = rate;
      break;
    } catch (err) {
      lastEncodeErr = err;
      if (typeof pushLog === "function") pushLog(`[mse audio] AAC encode attempt failed at ${rate}Hz: ${err?.message || String(err)}`);
    }
  }
  if (!encoded) throw lastEncodeErr || new Error("PCMA/PCMU -> AAC encode failed.");
  const configInfo = encoded.description ? parseAacAudioSpecificConfig(encoded.description) : null;
  const audioSpecificConfig = encoded.description || buildAacAudioSpecificConfig(2, encodeRate, decoded.channels);
  const rawSamples = encoded.chunks.map((chunk) => ({
    data: chunk.data,
    dtsUnits: Math.max(0, Math.round((chunk.timestampUs / 1000000) * encodeRate)),
    durationUnits: Number.isFinite(chunk.durationUs) && chunk.durationUs > 0 ? Math.max(1, Math.round((chunk.durationUs / 1000000) * encodeRate)) : null,
  }));
  const track = buildAudioTrackFromEncodedSamples({
    rawSamples,
    sampleRate: configInfo?.sampleRate || encodeRate,
    channels: configInfo?.channels || decoded.channels,
    audioSpecificConfig,
    codec: "mp4a.40.2",
    source: "g711-transcoded-aac",
    bitrate,
  });
  if (track && typeof pushLog === "function") pushLog(`[mse audio] AAC transcode output: samples=${track.samples.length}, base=${track.baseDecodeTime}, duration=${fmtMs((track.duration / track.sampleRate) * 1000)}`);
  return track;
}
async function buildMseAacAudioTrackFromAnalysis({ mediaInfo, audioStream, fileData, sourceStartMs, sourceEndMs, pushLog }) {
  const audioFrames = collectAudioFrames(mediaInfo);
  if (!audioStream || !audioFrames.length) return null;
  const codecName = String(audioStream?.codecName || "").toLowerCase();
  if (codecName.includes("aac") || codecName.includes("mp4a")) return buildAacPassthroughTrack({ audioFrames, audioStream, fileData, sourceStartMs, sourceEndMs, pushLog });
  if (isG711AudioStreamOrFrame(audioStream, audioFrames[0])) {
    try {
      return await buildG711TranscodedAacTrack({ audioFrames, audioStream, mediaInfo, sourceStartMs, sourceEndMs, pushLog });
    } catch (err) {
      if (typeof pushLog === "function") pushLog(`[mse audio] PCMA/PCMU -> AAC failed: ${err?.message || String(err)}; muxing video only.`);
      return null;
    }
  }
  if (typeof pushLog === "function") pushLog(`[mse audio] unsupported audio codec=${audioStream?.codecName || "unknown"}; muxing video only.`);
  return null;
}

async function buildH264Fmp4FromAnalysis({ mediaInfo, result, pushLog }) {
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
  let skippedNonVclSamples = 0;
  const skippedNonVclTypes = [];
  for (let i = 0; i < videoFrames.length; i++) {
    const frame = videoFrames[i];
    if (isFlvVideoConfigFrame(frame)) continue;
    const payload = sliceFrameBytes(frame, fileData);
    const normalizedData = normalizeH264SamplePayload(payload, inputLengthSize);
    if (!(normalizedData instanceof Uint8Array) || normalizedData.length <= 0) continue;
    const beforeTypes = h264PayloadNalTypes(normalizedData);
    const data = filterH264SampleNalUnits(normalizedData);
    if (!(data instanceof Uint8Array) || data.length <= 0) {
      if (!beforeTypes.includes(1) && !beforeTypes.includes(5)) {
        skippedNonVclSamples += 1;
        if (skippedNonVclTypes.length < 8) skippedNonVclTypes.push(`#${i}:${beforeTypes.join(".") || "-"}`);
      }
      continue;
    }
    const fallbackTime = i / fpsFromStream(videoStream);
    const dtsSec = firstFinite(frame?.dtsTime, frame?.ptsTime, fallbackTime);
    const ptsSec = firstFinite(frame?.ptsTime, frame?.dtsTime, fallbackTime);
    const hasIdr = h264PayloadHasIdr(data);
    rawSamples.push({
      data,
      frameIndex: frame?.index ?? null,
      sourceOrder: i,
      dtsMs: Math.max(0, Math.round((dtsSec || 0) * 1000)),
      ptsMs: Math.max(0, Math.round((ptsSec || 0) * 1000)),
      isKeyframe: hasIdr || isFrameKeyframe(frame, data),
      hasIdr,
      nalTypes: h264PayloadNalTypes(data),
    });
  }
  rawSamples.sort((a, b) => (a.dtsMs - b.dtsMs) || (a.sourceOrder - b.sourceOrder));
  if (!rawSamples.length) throw new Error("No H.264 access-unit payloads to transmux.");
  const firstIdrIndex = rawSamples.findIndex((sample) => sample.hasIdr);
  const firstKeyIndex = firstIdrIndex >= 0 ? firstIdrIndex : rawSamples.findIndex((sample) => sample.isKeyframe);
  if (firstKeyIndex < 0) throw new Error("No H.264 keyframe found for fMP4 fragment start.");
  if (firstIdrIndex < 0) throw new Error("No H.264 IDR NAL found for fMP4 fragment start.");
  let playableSamples = rawSamples.slice(firstKeyIndex).map((sample) => {
    if (!sample.hasIdr) return sample;
    const data = prependParameterSetsToIdrSample(sample.data, avcC);
    return { ...sample, isKeyframe: true, data, nalTypes: h264PayloadNalTypes(data) };
  });
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
  const codec = h264CodecFromAvcC(avcC);
  const videoDuration = Math.max(1, Math.ceil(maxEndMs));
  const audioStream = streams.find((s) => s.codecType === "audio") || null;
  const audioTrack = await buildMseAacAudioTrackFromAnalysis({
    mediaInfo,
    audioStream,
    fileData,
    sourceStartMs: muxBaseDtsMs,
    sourceEndMs: muxBaseDtsMs + videoDuration,
    pushLog,
  });
  const audioDurationMs = audioTrack ? Math.ceil((audioTrack.duration / audioTrack.sampleRate) * timescale) : 0;
  const duration = Math.max(videoDuration, audioDurationMs || 0);
  const brands = [asciiBytes("isom"), asciiBytes("iso6"), asciiBytes("avc1"), asciiBytes("mp41"), asciiBytes("mp42")];
  const ftyp = mp4Box("ftyp", asciiBytes("isom"), u32(0x00000200), ...brands);
  const moov = buildMoov({ width, height, timescale, duration, avcC, audioTrack });
  const audioSamples = audioTrack?.samples || [];
  const moof = buildMoof(samples, audioSamples, 0, audioTrack?.baseDecodeTime || 0);
  const mdat = mp4Box("mdat", concatBytes([...samples.map((sample) => sample.data), ...audioSamples.map((sample) => sample.data)]));
  const codecs = [codec, audioTrack?.codec].filter(Boolean);
  if (typeof pushLog === "function") {
    const keyCount = rawSamples.filter((sample) => sample.isKeyframe).length;
    const idrCount = rawSamples.filter((sample) => sample.hasIdr).length;
    const rawFirst = rawSamples[0] || null;
    const rawLast = rawSamples[rawSamples.length - 1] || null;
    pushLog(`[mse ts] raw=${rawSamples.length}, playable=${playableSamples.length}, keyframes=${keyCount}, idr=${idrCount}, firstKeyRawIndex=${firstKeyIndex}, codec=${codec}`);
    pushLog(`[mse ts] raw range dts=${fmtMs(rawFirst?.dtsMs)}..${fmtMs(rawLast?.dtsMs)}, pts=${fmtMs(rawFirst?.ptsMs)}..${fmtMs(rawLast?.ptsMs)}`);
    pushLog(`[mse ts] raw first samples: ${compactSamples(rawSamples)}`);
    if (skippedNonVclSamples > 0) pushLog(`[mse ts] skipped non-VCL samples=${skippedNonVclSamples} (${skippedNonVclTypes.join(" | ")})`);
    pushLog(`[mse ts] first mux sample: ${compactSample(samples[0], 0)}`);
    pushLog(`[mse ts] mux IDR samples: ${compactSamples(samples.filter((sample) => sample.hasIdr), 8)}`);
    if (timestampRepair?.repaired) pushLog(`[mse ts] repaired initial zero timestamp: jump=${Math.round(timestampRepair.jumpMs)}ms, medianDelta=${Math.round(timestampRepair.medianDiffMs)}ms, firstDts=>${fmtMs(timestampRepair.fixedFirstDtsMs)}`);
    const warnings = findDtsGapWarnings(normalizedSamples, defaultDuration);
    if (warnings.length) pushLog(`[mse ts] normalized warnings: ${warnings.join(" | ")}`);
    pushLog(`[mse ts] mux base=${fmtMs(muxBaseDtsMs)}, uiOffset=${fmtMs(sourceStartMs)}, defaultDur=${Math.round(defaultDuration)}ms, muxDuration=${fmtMs(duration)}`);
  }
  return {
    bytes: concatBytes([ftyp, moov, moof, mdat]),
    mime: `video/mp4; codecs="${codecs.join(",")}"`,
    durationSec: duration / timescale,
    frameCount: samples.length,
    audioFrameCount: audioSamples.length,
    originalFrameCount: rawSamples.length,
    droppedFrameCount: firstKeyIndex,
    sourceStartSec: sourceStartMs / 1000,
    codec,
    audioCodec: audioTrack?.codec || "",
  };
}

async function buildAudioOnlyFmp4FromAnalysis({ mediaInfo, result, pushLog }) {
  const primary = pickPrimaryMediaResult(mediaInfo);
  if (!primary) throw new Error("No analyzed media available for transmux.");
  const streams = Array.isArray(primary.streams) ? primary.streams : [];
  const audioStream = streams.find((s) => s.codecType === "audio");
  if (!audioStream) throw new Error("No audio stream for audio-only transmux.");
  const fileData = primary?.formatSpecific?.fileData;
  const audioFrames = collectAudioFrames(mediaInfo);
  if (!audioFrames.length) throw new Error("No audio frames to transmux.");
  let sourceStartMs = Infinity;
  let sourceEndMs = 0;
  for (let i = 0; i < audioFrames.length; i++) {
    const frame = audioFrames[i];
    const tMs = audioFrameTimeMs(frame, i * 0.02);
    if (!Number.isFinite(tMs)) continue;
    sourceStartMs = Math.min(sourceStartMs, tMs);
    sourceEndMs = Math.max(sourceEndMs, tMs + 50);
  }
  if (!Number.isFinite(sourceStartMs)) sourceStartMs = 0;
  if (sourceEndMs <= sourceStartMs) sourceEndMs = sourceStartMs + 1000;
  const audioTrack = await buildMseAacAudioTrackFromAnalysis({
    mediaInfo,
    audioStream,
    fileData,
    sourceStartMs,
    sourceEndMs,
    pushLog,
  });
  if (!audioTrack?.samples?.length) throw new Error(`Audio transmux unsupported for codec ${audioStream?.codecName || "unknown"}.`);
  const timescale = 1000;
  const audioDurationMs = Math.max(1, Math.ceil((audioTrack.duration / audioTrack.sampleRate) * timescale));
  const brands = [asciiBytes("isom"), asciiBytes("iso6"), asciiBytes("mp41"), asciiBytes("mp42"), asciiBytes("M4A ")];
  const ftyp = mp4Box("ftyp", asciiBytes("isom"), u32(0x00000200), ...brands);
  const moov = buildMoov({ width: 0, height: 0, timescale, duration: audioDurationMs, avcC: null, audioTrack });
  const moof = buildMoof([], audioTrack.samples, 0, audioTrack.baseDecodeTime || 0);
  const mdat = mp4Box("mdat", concatBytes(audioTrack.samples.map((sample) => sample.data)));
  if (typeof pushLog === "function") {
    pushLog(`[mse audio-only] codec=${audioTrack.codec}, samples=${audioTrack.samples.length}, rate=${audioTrack.sampleRate}, channels=${audioTrack.channels}, duration=${fmtMs(audioDurationMs)}`);
  }
  return {
    bytes: concatBytes([ftyp, moov, moof, mdat]),
    mime: `audio/mp4; codecs="${audioTrack.codec}"`,
    durationSec: audioDurationMs / timescale,
    frameCount: 0,
    audioFrameCount: audioTrack.samples.length,
    originalFrameCount: audioFrames.length,
    droppedFrameCount: 0,
    sourceStartSec: sourceStartMs / 1000,
    codec: "",
    audioCodec: audioTrack.codec || "",
  };
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
