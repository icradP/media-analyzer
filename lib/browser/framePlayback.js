import { buildAdtsFixedHeader7, getAacSamplingFrequencyIndex } from "../codec/aacAdts.js";

function firstDefined(...vals) {
    for (const v of vals) {
        if (v !== undefined && v !== null) return v;
    }
    return null;
}

export function pickPrimaryMediaResult(mediaInfo) {
    if (!mediaInfo || typeof mediaInfo !== "object") return null;
    const looksLikeMediaResult = (v) =>
        !!v &&
        typeof v === "object" &&
        (Array.isArray(v.streams) || Array.isArray(v.frames) || !!v.formatSpecific || !!v.format);
    // Accept both shapes:
    // 1) mediaInfo map: { mp4: result, ts: result, ... }
    // 2) direct analysis result: { format, streams, frames, formatSpecific }
    if (looksLikeMediaResult(mediaInfo)) {
        return mediaInfo;
    }
    const named =
        mediaInfo.flv ||
        mediaInfo.mp4 ||
        mediaInfo.ts ||
        mediaInfo["mpeg-ts"] ||
        mediaInfo.mpegts ||
        mediaInfo.ps ||
        mediaInfo.rtp ||
        mediaInfo.mkv ||
        mediaInfo.h264 ||
        mediaInfo.h265 ||
        mediaInfo.mp3 ||
        mediaInfo.wav ||
        mediaInfo.flac ||
        mediaInfo.opus;
    if (looksLikeMediaResult(named)) return named;
    // Fallback for dynamic keys like "mpeg-ts", "unknown", etc.
    for (const v of Object.values(mediaInfo)) {
        if (looksLikeMediaResult(v)) return v;
    }
    return null;
}

export function detectVideoCodecForPlayback(mediaInfo) {
    const primary = pickPrimaryMediaResult(mediaInfo);
    if (!primary) return null;
    const streams = Array.isArray(primary.streams) ? primary.streams : [];
    const video = streams.find((s) => s.codecType === "video");
    const name = String(video?.codecName || "").toLowerCase();
    if (name.includes("264") || name.includes("avc")) return "h264";
    if (name.includes("265") || name.includes("hevc") || name.includes("hev1") || name.includes("hvc1")) return "hevc";
    return null;
}

export function collectVideoFrames(mediaInfo) {
    const primary = pickPrimaryMediaResult(mediaInfo);
    const frames = Array.isArray(primary?.frames) ? primary.frames : [];
    return frames.filter((f) => f.mediaType === "video");
}

export function collectAudioFrames(mediaInfo) {
    const primary = pickPrimaryMediaResult(mediaInfo);
    const frames = Array.isArray(primary?.frames) ? primary.frames : [];
    return frames.filter((f) => f.mediaType === "audio");
}

export function sliceFrameBytes(frame, fileData) {
    if (!frame) return null;
    const direct = firstDefined(
        frame._rawData,
        frame.formatSpecific?._rawData,
        frame._assembledESData,
        frame.formatSpecific?._assembledESData,
        frame.data instanceof Uint8Array ? frame.data : null,
    );
    if (direct instanceof Uint8Array && direct.length > 0) return direct;
    if (fileData instanceof Uint8Array) {
        const offset = firstDefined(
            frame.offset,
            frame.formatSpecific?.offset,
            frame.formatSpecific?._byteOffset,
            0,
        );
        const size = firstDefined(
            frame.size,
            frame.formatSpecific?.size,
            frame.formatSpecific?.dataSize,
            frame.formatSpecific?._byteLength,
            0,
        );
        if (Number.isFinite(offset) && Number.isFinite(size) && size > 0) {
            return fileData.subarray(offset, offset + size);
        }
    }
    return null;
}

function findAnnexBStartCode(data, from) {
    for (let i = from; i + 3 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0) {
            if (data[i + 2] === 1) return { offset: i, length: 3 };
            if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) return { offset: i, length: 4 };
        }
    }
    return null;
}

function splitAnnexBNalus(data) {
    const out = [];
    let pos = 0;
    while (pos < data.length) {
        const sc = findAnnexBStartCode(data, pos);
        if (!sc) break;
        const payloadStart = sc.offset + sc.length;
        const next = findAnnexBStartCode(data, payloadStart);
        const payloadEnd = next ? next.offset : data.length;
        if (payloadEnd > payloadStart) out.push(data.subarray(payloadStart, payloadEnd));
        pos = payloadEnd;
    }
    return out;
}

function hasAnnexBStartCode(data) {
    return !!findAnnexBStartCode(data, 0);
}

function annexBToLengthPrefixed(data) {
    const nalus = splitAnnexBNalus(data);
    if (!nalus.length) return data;
    const total = nalus.reduce((n, nalu) => n + 4 + nalu.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const nalu of nalus) {
        const len = nalu.length >>> 0;
        out[off] = (len >>> 24) & 0xff;
        out[off + 1] = (len >>> 16) & 0xff;
        out[off + 2] = (len >>> 8) & 0xff;
        out[off + 3] = len & 0xff;
        out.set(nalu, off + 4);
        off += 4 + nalu.length;
    }
    return out;
}

function parseParameterSetsFromAnnexB(data, codecFamily) {
    const nalus = splitAnnexBNalus(data);
    let sps = null;
    let pps = null;
    let vps = null;
    for (const nalu of nalus) {
        if (!nalu.length) continue;
        if (codecFamily === "h264") {
            const nalType = nalu[0] & 0x1f;
            if (nalType === 7 && !sps) sps = nalu.slice(0);
            else if (nalType === 8 && !pps) pps = nalu.slice(0);
        } else if (codecFamily === "hevc") {
            if (nalu.length < 2) continue;
            const nalType = (nalu[0] >> 1) & 0x3f;
            if (nalType === 32 && !vps) vps = nalu.slice(0);
            else if (nalType === 33 && !sps) sps = nalu.slice(0);
            else if (nalType === 34 && !pps) pps = nalu.slice(0);
        }
        if (codecFamily === "h264" && sps && pps) break;
        if (codecFamily === "hevc" && vps && sps && pps) break;
    }
    return { sps, pps, vps };
}

function parseParameterSetsFromLengthPrefixed(data, codecFamily) {
    if (!(data instanceof Uint8Array)) return { sps: null, pps: null, vps: null };
    let sps = null;
    let pps = null;
    let vps = null;
    let off = 0;
    while (off + 4 <= data.length) {
        const len =
            ((data[off] << 24) >>> 0) |
            (data[off + 1] << 16) |
            (data[off + 2] << 8) |
            data[off + 3];
        off += 4;
        if (len <= 0 || off + len > data.length) break;
        const nalu = data.subarray(off, off + len);
        off += len;
        if (!nalu.length) continue;
        if (codecFamily === "h264") {
            const nalType = nalu[0] & 0x1f;
            if (nalType === 7 && !sps) sps = nalu.slice(0);
            else if (nalType === 8 && !pps) pps = nalu.slice(0);
        } else if (codecFamily === "hevc") {
            if (nalu.length < 2) continue;
            const nalType = (nalu[0] >> 1) & 0x3f;
            if (nalType === 32 && !vps) vps = nalu.slice(0);
            else if (nalType === 33 && !sps) sps = nalu.slice(0);
            else if (nalType === 34 && !pps) pps = nalu.slice(0);
        }
        if (codecFamily === "h264" && sps && pps) break;
        if (codecFamily === "hevc" && vps && sps && pps) break;
    }
    return { sps, pps, vps };
}

function extractParameterSetsFromMp4Boxes(primaryResult, codecFamily) {
    const boxes = primaryResult?.formatSpecific?.boxes;
    if (!Array.isArray(boxes)) return { sps: null, pps: null, vps: null };
    const stack = [...boxes];
    while (stack.length > 0) {
        const box = stack.pop();
        if (Array.isArray(box?.children)) {
            for (const child of box.children) stack.push(child);
        }
        if (box?.type !== "stsd") continue;
        const entries = box?.data?.entries || box?.children || [];
        for (const entry of entries) {
            const cfg = entry?.config || entry?.data || null;
            if (!cfg) continue;
            if (codecFamily === "h264") {
                const sps = asUint8Array(cfg?.sps?.[0]);
                const pps = asUint8Array(cfg?.pps?.[0]);
                if (sps && pps) return { sps, pps, vps: null };
            } else if (codecFamily === "hevc") {
                const vps = asUint8Array(cfg?.vps?.[0]);
                const sps = asUint8Array(cfg?.sps?.[0]);
                const pps = asUint8Array(cfg?.pps?.[0]);
                if (vps && sps && pps) return { sps, pps, vps };
            }
        }
    }
    return { sps: null, pps: null, vps: null };
}

function extractParameterSetsFromFlvSequenceHeader(primaryResult, codecFamily) {
    const frames = Array.isArray(primaryResult?.frames) ? primaryResult.frames : [];
    for (const frame of frames) {
        const fs = frame?.formatSpecific;
        if (!fs?.sequenceHeader) continue;
        const seq = fs.sequenceHeader;
        const fieldOffsets = fs.fieldOffsets || {};
        const raw = fs._rawData;
        const baseOffset = Number.isFinite(fs._byteOffset) ? fs._byteOffset : 0;
        if (!(raw instanceof Uint8Array)) continue;

        const readNaluByOffsetKey = (offsetKey, itemKey) => {
            const pos = fieldOffsets[offsetKey];
            const item = seq[itemKey];
            const naluLength = item?.naluLength;
            if (!pos || !Number.isFinite(naluLength)) return null;
            const start = pos.offset + 2 - baseOffset;
            const end = start + naluLength;
            if (start < 0 || end > raw.length) return null;
            return raw.slice(start, end);
        };

        if (codecFamily === "h264") {
            const sps = readNaluByOffsetKey("sequenceHeader.sps[0].naluLength", "sps[0]");
            const pps = readNaluByOffsetKey("sequenceHeader.pps[0].naluLength", "pps[0]");
            if (sps && pps) return { sps, pps, vps: null };
        } else if (codecFamily === "hevc") {
            const vps = readNaluByOffsetKey("sequenceHeader.vps[0].naluLength", "vps[0]");
            const sps = readNaluByOffsetKey("sequenceHeader.sps[0].naluLength", "sps[0]");
            const pps = readNaluByOffsetKey("sequenceHeader.pps[0].naluLength", "pps[0]");
            if (vps && sps && pps) return { sps, pps, vps };
        }
    }
    return { sps: null, pps: null, vps: null };
}

function asUint8Array(v) {
    if (!v) return null;
    if (v instanceof Uint8Array) return v;
    if (ArrayBuffer.isView(v)) {
        return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (Array.isArray(v)) return Uint8Array.from(v);
    if (typeof v === "object") {
        const keys = Object.keys(v)
            .filter((k) => /^\d+$/.test(k))
            .map((k) => Number(k))
            .sort((a, b) => a - b);
        if (keys.length > 0) {
            const arr = new Uint8Array(keys.length);
            for (let i = 0; i < keys.length; i++) {
                arr[i] = Number(v[String(keys[i])]) & 0xff;
            }
            return arr;
        }
    }
    return null;
}

function extractParameterSetsFromStreamConfig(primaryResult, codecFamily) {
    const stream = (primaryResult?.streams || []).find((s) => s.codecType === "video");
    const cfg = stream?.decoderConfig;
    if (!cfg || typeof cfg !== "object") return { sps: null, pps: null, vps: null };
    if (codecFamily === "h264") {
        const sps = asUint8Array(cfg?.sps?.[0]);
        const pps = asUint8Array(cfg?.pps?.[0]);
        return { sps, pps, vps: null };
    }
    if (codecFamily === "hevc") {
        const vps = asUint8Array(cfg?.vps?.[0]);
        const sps = asUint8Array(cfg?.sps?.[0]);
        const pps = asUint8Array(cfg?.pps?.[0]);
        return { sps, pps, vps };
    }
    return { sps: null, pps: null, vps: null };
}

function buildAvcDecoderConfigRecord(sps, pps) {
    if (!(sps instanceof Uint8Array) || !(pps instanceof Uint8Array) || sps.length < 4) return null;
    const out = new Uint8Array(11 + sps.length + pps.length);
    let o = 0;
    out[o++] = 1;
    out[o++] = sps[1];
    out[o++] = sps[2];
    out[o++] = sps[3];
    out[o++] = 0xff;
    out[o++] = 0xe1;
    out[o++] = (sps.length >> 8) & 0xff;
    out[o++] = sps.length & 0xff;
    out.set(sps, o);
    o += sps.length;
    out[o++] = 1;
    out[o++] = (pps.length >> 8) & 0xff;
    out[o++] = pps.length & 0xff;
    out.set(pps, o);
    return out;
}

function buildHevcDecoderConfigRecord(vps, sps, pps) {
    if (!(vps instanceof Uint8Array) || !(sps instanceof Uint8Array) || !(pps instanceof Uint8Array)) return null;
    const total = 26 + (5 + vps.length) + (5 + sps.length) + (5 + pps.length);
    const out = new Uint8Array(total);
    let o = 0;
    out[o++] = 1;
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = 0x90;
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = 0x5d;
    out[o++] = 0xf0;
    out[o++] = 0;
    out[o++] = 0xfc;
    out[o++] = 0xfd;
    out[o++] = 0xf8;
    out[o++] = 0xf8;
    out[o++] = 0;
    out[o++] = 0;
    out[o++] = 0x0f;
    out[o++] = 3;
    out[o++] = 32;
    out[o++] = 0;
    out[o++] = 1;
    out[o++] = (vps.length >> 8) & 0xff;
    out[o++] = vps.length & 0xff;
    out.set(vps, o);
    o += vps.length;
    out[o++] = 33;
    out[o++] = 0;
    out[o++] = 1;
    out[o++] = (sps.length >> 8) & 0xff;
    out[o++] = sps.length & 0xff;
    out.set(sps, o);
    o += sps.length;
    out[o++] = 34;
    out[o++] = 0;
    out[o++] = 1;
    out[o++] = (pps.length >> 8) & 0xff;
    out[o++] = pps.length & 0xff;
    out.set(pps, o);
    return out;
}

function isVideoFrameKeyframe(frame) {
    if (!frame) return false;
    if (frame.pictureType === "I" || frame.pictureType === "IDR") return true;
    if (frame.isKeyframe === true || frame.isKeyFrame === true) return true;
    const fs = frame.formatSpecific || {};
    return fs.keyframe === true || fs._frameType_value === 1;
}

function resolveAudioTrack(mediaInfo) {
    const primary = pickPrimaryMediaResult(mediaInfo);
    const streams = Array.isArray(primary?.streams) ? primary.streams : [];
    return streams.find((s) => s.codecType === "audio") || null;
}

function wrapRawAacToAdts(payload, mediaInfo) {
    const audioTrack = resolveAudioTrack(mediaInfo);
    const objectType = Number(audioTrack?.profile || 2);
    const sampleRate = Number(audioTrack?.sampleRate || 44100);
    const channelConfig = Number(audioTrack?.channels || 2);
    const sampleRateIndex = getAacSamplingFrequencyIndex(sampleRate);
    // buildAdtsFixedHeader7(aacFrameLength, profile, samplingFreqIndex, channelConfig)
    const header = buildAdtsFixedHeader7(payload.length, objectType, sampleRateIndex, channelConfig);
    const out = new Uint8Array(header.length + payload.length);
    out.set(header, 0);
    out.set(payload, header.length);
    return out;
}

function concatUint8Arrays(chunks) {
    const total = chunks.reduce((n, chunk) => n + (chunk?.length || 0), 0);
    if (!total) return null;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array) || chunk.length === 0) continue;
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return offset > 0 ? out : null;
}

function frameCodecNameHint(frame, mediaInfo) {
    const trackName = String(resolveAudioTrack(mediaInfo)?.codecName || "").toLowerCase();
    if (trackName) return trackName;
    const fs = frame?.formatSpecific || {};
    const fromFrame = String(frame?.codecName || fs?.codecName || fs?.codec || "").toLowerCase();
    return fromFrame || "";
}

function findAudioFrameWindowByIndex(frame, mediaInfo, maxFrames) {
    const frames = collectAudioFrames(mediaInfo);
    if (!Array.isArray(frames) || frames.length === 0) return [];
    const selectedIndex = Number(frame?.index);
    const start = Number.isFinite(selectedIndex)
        ? frames.findIndex((f) => Number(f?.index) === selectedIndex)
        : -1;
    if (start < 0) return [frame].filter(Boolean);
    return frames.slice(start, Math.min(frames.length, start + Math.max(1, maxFrames)));
}

function normalizeAudioPayloadForPlayback(frame, mediaInfo, payload, options = {}) {
    if (!(payload instanceof Uint8Array) || payload.length === 0) return null;
    const codecName = frameCodecNameHint(frame, mediaInfo);
    const isAdtsLike = payload.length >= 2 && payload[0] === 0xff && (payload[1] & 0xf0) === 0xf0;
    const isRawAac = (codecName.includes("aac") || codecName.includes("mp4a")) && !isAdtsLike;
    const adtsMode = options?.aacAdtsMode || "auto";
    if (!isRawAac) return payload;
    if (adtsMode === "off") return payload;
    return wrapRawAacToAdts(payload, mediaInfo);
}

export function buildAudioPlaybackBytesForFrameRange(frames, mediaInfo, options = {}) {
    const primary = pickPrimaryMediaResult(mediaInfo);
    const inputFrames = Array.isArray(frames) ? frames : [];
    const out = [];
    for (const item of inputFrames) {
        const payload = sliceFrameBytes(item, primary?.formatSpecific?.fileData);
        const normalized = normalizeAudioPayloadForPlayback(item, mediaInfo, payload, options);
        if (normalized) out.push(normalized);
    }
    return concatUint8Arrays(out);
}

export function buildAudioPlaybackBytes(frame, mediaInfo, options = {}) {
    const windowFrames = findAudioFrameWindowByIndex(
        frame,
        mediaInfo,
        Number(options.maxFrames) > 0 ? Number(options.maxFrames) : 1,
    );
    return buildAudioPlaybackBytesForFrameRange(windowFrames, mediaInfo, options);
}

export async function decodeVideoFramesToCanvas({
    encodedFrames,
    frameMeta = null,
    codecString,
    description = null,
    canvas,
    timestampStepUs = 33333,
    optimizeForLatency = true,
}) {
    if (typeof VideoDecoder === "undefined") {
        throw new Error("VideoDecoder API is not available in this browser.");
    }
    if (!canvas) throw new Error("canvas is required.");
    if (!Array.isArray(encodedFrames) || encodedFrames.length === 0) {
        throw new Error("encodedFrames is empty.");
    }
    let lastFrame = null;
    let decodeError = null;
    let decodeErrorAt = null;
    let lastQueuedChunk = null;
    const decoder = new VideoDecoder({
        output: (frame) => {
            if (lastFrame) {
                try {
                    lastFrame.close();
                } catch {
                    // ignore close error
                }
            }
            lastFrame = frame;
        },
        error: (err) => {
            decodeError = err || new Error("VideoDecoder error");
            decodeErrorAt = lastQueuedChunk;
        },
    });
    decoder.configure({
        codec: codecString,
        description: description || undefined,
        optimizeForLatency,
    });
    let ts = 0;
    for (let i = 0; i < encodedFrames.length; i++) {
        const item = encodedFrames[i];
        const data = item?.data;
        if (!(data instanceof Uint8Array) || data.length === 0) continue;
        const chunkType = item?.type === "key" ? "key" : "delta";
        const meta = Array.isArray(frameMeta) ? frameMeta[i] || null : null;
        lastQueuedChunk = {
            chunkIndex: i,
            type: chunkType,
            timestampUs: ts,
            size: data.length,
            frameIndex: meta?.frameIndex ?? null,
            pts: meta?.pts ?? null,
            dts: meta?.dts ?? null,
            ptsTime: meta?.ptsTime ?? null,
            dtsTime: meta?.dtsTime ?? null,
        };
        const chunk = new EncodedVideoChunk({
            type: chunkType,
            timestamp: ts,
            data,
        });
        try {
            decoder.decode(chunk);
        } catch (err) {
            const wrapped = new Error(`VideoDecoder.decode failed at chunk ${i}: ${err?.message || String(err)}`);
            wrapped.cause = err;
            wrapped.diagnostics = {
                stage: "decode",
                codecString,
                hasDescription: !!description,
                descriptionLength: description ? description.length : 0,
                chunk: lastQueuedChunk,
            };
            try {
                decoder.close();
            } catch {
                // ignore close error
            }
            throw wrapped;
        }
        ts += timestampStepUs;
    }
    try {
        await decoder.flush();
    } catch (err) {
        const wrapped = new Error(`VideoDecoder.flush failed: ${err?.message || String(err)}`);
        wrapped.cause = err;
        wrapped.diagnostics = {
            stage: "flush",
            codecString,
            hasDescription: !!description,
            descriptionLength: description ? description.length : 0,
            chunk: decodeErrorAt || lastQueuedChunk,
        };
        try {
            decoder.close();
        } catch {
            // ignore close error
        }
        throw wrapped;
    }
    if (decodeError) {
        try {
            decoder.close();
        } catch {
            // ignore close error
        }
        const wrapped = new Error(`VideoDecoder error callback: ${decodeError?.message || String(decodeError)}`);
        wrapped.cause = decodeError;
        wrapped.diagnostics = {
            stage: "decoder-error-callback",
            codecString,
            hasDescription: !!description,
            descriptionLength: description ? description.length : 0,
            chunk: decodeErrorAt || lastQueuedChunk,
        };
        throw wrapped;
    }
    if (lastFrame) {
        canvas.width = lastFrame.displayWidth;
        canvas.height = lastFrame.displayHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("2D context is unavailable.");
        ctx.drawImage(lastFrame, 0, 0);
        lastFrame.close();
        lastFrame = null;
    }
    decoder.close();
}

export function buildVideoDecodePlan({
    mediaInfo,
    targetFrameIndex,
}) {
    const primary = pickPrimaryMediaResult(mediaInfo);
    if (!primary) throw new Error("No media result.");
    const stream = (primary.streams || []).find((s) => s.codecType === "video");
    const codecName = String(stream?.codecName || "").toLowerCase();
    const codecFamily =
        codecName.includes("264") || codecName.includes("avc")
            ? "h264"
            : codecName.includes("265") || codecName.includes("hevc") || codecName.includes("hev1") || codecName.includes("hvc1")
                ? "hevc"
                : null;
    if (!codecFamily) throw new Error(`Unsupported video codec: ${stream?.codecName || "unknown"}`);
    const videoFrames = collectVideoFrames(mediaInfo);
    if (!videoFrames.length) throw new Error("No video frames.");
    const idx = videoFrames.findIndex((f) => f.index === targetFrameIndex);
    if (idx < 0) throw new Error("Target frame not found in video frames.");
    let keyIdx = idx;
    while (keyIdx >= 0 && !isVideoFrameKeyframe(videoFrames[keyIdx])) keyIdx -= 1;
    if (keyIdx < 0) throw new Error("No previous keyframe found.");
    const windowFrames = videoFrames.slice(keyIdx, idx + 1);
    const fileData = primary.formatSpecific?.fileData;
    const isTsInput =
        String(primary?.format?.formatName || "").toLowerCase() === "mpeg-ts" ||
        String(primary?.format?.formatLongName || "").toLowerCase().includes("transport stream");
    let hasAnnexBInput = false;
    const encodedFrames = [];
    const encodedFrameMeta = [];
    let sps = null;
    let pps = null;
    let vps = null;
    const paramSource = {
        window: false,
        flvSequenceHeader: false,
        streamDecoderConfig: false,
        mp4Boxes: false,
    };
    for (let i = 0; i < windowFrames.length; i++) {
        const frame = windowFrames[i];
        const payload = sliceFrameBytes(frame, fileData);
        if (!(payload instanceof Uint8Array) || payload.length === 0) continue;
        const usesAnnexB = hasAnnexBStartCode(payload);
        if (usesAnnexB) hasAnnexBInput = true;
        if (usesAnnexB) {
            const ps = parseParameterSetsFromAnnexB(payload, codecFamily);
            if (ps.sps || ps.pps || ps.vps) paramSource.window = true;
            sps = sps || ps.sps;
            pps = pps || ps.pps;
            vps = vps || ps.vps;
        } else {
            const ps = parseParameterSetsFromLengthPrefixed(payload, codecFamily);
            if (ps.sps || ps.pps || ps.vps) paramSource.window = true;
            sps = sps || ps.sps;
            pps = pps || ps.pps;
            vps = vps || ps.vps;
        }
        encodedFrames.push({
            type: "delta",
            // TS demux outputs Annex-B AU data; keep it as Annex-B for WebCodecs.
            data: usesAnnexB && isTsInput ? payload : usesAnnexB ? annexBToLengthPrefixed(payload) : payload,
        });
        encodedFrameMeta.push({
            frameIndex: frame?.index ?? null,
            pts: Number.isFinite(frame?.pts) ? frame.pts : null,
            dts: Number.isFinite(frame?.dts) ? frame.dts : null,
            ptsTime: Number.isFinite(frame?.ptsTime) ? frame.ptsTime : null,
            dtsTime: Number.isFinite(frame?.dtsTime) ? frame.dtsTime : null,
        });
    }
    if (!encodedFrames.length) throw new Error("No decodable frame payload in selected window.");
    // WebCodecs hard requirement: first chunk after configure/flush must be key.
    encodedFrames[0].type = "key";
    if (codecFamily === "h264" && (!sps || !pps)) {
        const fromFlvSeq = extractParameterSetsFromFlvSequenceHeader(primary, codecFamily);
        if (fromFlvSeq.sps || fromFlvSeq.pps || fromFlvSeq.vps) paramSource.flvSequenceHeader = true;
        sps = sps || fromFlvSeq.sps;
        pps = pps || fromFlvSeq.pps;
    }
    if (codecFamily === "h264" && (!sps || !pps)) {
        const fromStream = extractParameterSetsFromStreamConfig(primary, codecFamily);
        if (fromStream.sps || fromStream.pps || fromStream.vps) paramSource.streamDecoderConfig = true;
        sps = sps || fromStream.sps;
        pps = pps || fromStream.pps;
    }
    if (codecFamily === "h264" && (!sps || !pps)) {
        const fromBoxes = extractParameterSetsFromMp4Boxes(primary, codecFamily);
        if (fromBoxes.sps || fromBoxes.pps || fromBoxes.vps) paramSource.mp4Boxes = true;
        sps = sps || fromBoxes.sps;
        pps = pps || fromBoxes.pps;
    } else if (codecFamily === "hevc" && (!vps || !sps || !pps)) {
        const fromFlvSeq = extractParameterSetsFromFlvSequenceHeader(primary, codecFamily);
        if (fromFlvSeq.sps || fromFlvSeq.pps || fromFlvSeq.vps) paramSource.flvSequenceHeader = true;
        vps = vps || fromFlvSeq.vps;
        sps = sps || fromFlvSeq.sps;
        pps = pps || fromFlvSeq.pps;
    }
    if (codecFamily === "hevc" && (!vps || !sps || !pps)) {
        const fromStream = extractParameterSetsFromStreamConfig(primary, codecFamily);
        if (fromStream.sps || fromStream.pps || fromStream.vps) paramSource.streamDecoderConfig = true;
        vps = vps || fromStream.vps;
        sps = sps || fromStream.sps;
        pps = pps || fromStream.pps;
    }
    if (codecFamily === "hevc" && (!vps || !sps || !pps)) {
        const fromBoxes = extractParameterSetsFromMp4Boxes(primary, codecFamily);
        if (fromBoxes.sps || fromBoxes.pps || fromBoxes.vps) paramSource.mp4Boxes = true;
        vps = vps || fromBoxes.vps;
        sps = sps || fromBoxes.sps;
        pps = pps || fromBoxes.pps;
    }
    const description =
        codecFamily === "h264"
            ? buildAvcDecoderConfigRecord(sps, pps)
            : buildHevcDecoderConfigRecord(vps, sps, pps);
    const effectiveDescription = hasAnnexBInput ? null : description;
    if (codecFamily === "hevc" && !effectiveDescription) {
        const err = new Error("HEVC decoder description is missing (VPS/SPS/PPS not found).");
        err.diagnostics = {
            codecFamily,
            paramSource,
            hasVps: !!vps,
            hasSps: !!sps,
            hasPps: !!pps,
            windowFrameCount: windowFrames.length,
            encodedFrameCount: encodedFrames.length,
            decodeWindowStartFrameIndex: windowFrames[0]?.index ?? null,
        };
        throw err;
    }
    return {
        codecFamily,
        encodedFrames,
        encodedFrameMeta,
        description: effectiveDescription || null,
        decodeWindowStartFrameIndex: windowFrames[0]?.index ?? null,
    };
}

export async function playAudioFrameWithWebAudio({
    frame,
    mediaInfo,
    audioContext = null,
    maxDecodeFrames = 10,
}) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) throw new Error("WebAudio API is not available in this browser.");
    const ctx = audioContext || new Ctx();
    if (ctx.state === "suspended") await ctx.resume();
    const attempts = [
        { maxFrames: maxDecodeFrames, aacAdtsMode: "auto" },
        { maxFrames: maxDecodeFrames, aacAdtsMode: "off" },
        { maxFrames: 1, aacAdtsMode: "auto" },
        { maxFrames: 1, aacAdtsMode: "off" },
        { maxFrames: Math.max(20, maxDecodeFrames), aacAdtsMode: "auto" },
    ];
    let decoded = null;
    let lastError = null;
    const diagnostics = [];
    for (const attempt of attempts) {
        const bytes = buildAudioPlaybackBytes(frame, mediaInfo, attempt);
        if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
            diagnostics.push({ ...attempt, bytes: 0, ok: false, message: "empty-bytes" });
            continue;
        }
        try {
            decoded = await ctx.decodeAudioData(bytes.buffer.slice(0));
            diagnostics.push({ ...attempt, bytes: bytes.length, ok: true });
            break;
        } catch (err) {
            lastError = err;
            diagnostics.push({
                ...attempt,
                bytes: bytes.length,
                ok: false,
                message: err?.message || String(err),
            });
        }
    }
    if (!decoded) {
        const err = new Error(lastError?.message || "Unable to decode audio data");
        err.diagnostics = {
            frameIndex: frame?.index ?? null,
            codecName: resolveAudioTrack(mediaInfo)?.codecName || null,
            attempts: diagnostics,
        };
        throw err;
    }
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(ctx.destination);
    src.start(0);
    return { ctx, source: src, durationSec: decoded.duration };
}

export const framePlaybackCodec = Object.freeze({
    pickPrimaryMediaResult,
    detectVideoCodecForPlayback,
    collectVideoFrames,
    collectAudioFrames,
    sliceFrameBytes,
    buildVideoDecodePlan,
    buildAudioPlaybackBytes,
    buildAudioPlaybackBytesForFrameRange,
    decodeVideoFramesToCanvas,
    playAudioFrameWithWebAudio,
});
