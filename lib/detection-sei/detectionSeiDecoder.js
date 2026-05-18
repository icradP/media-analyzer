import { removeEmulationPrevention } from "../core/Constants.js";
import { sliceFrameBytes } from "../browser/framePlayback.js";
import {
    DETECTION_SEI_UUID_BYTES,
    isDetectionSeiPayload,
    normalizeDetectionSeiPayload,
    normalizedBoxesToDetections,
} from "./detectionSeiSchema.js";

const textDecoder = new TextDecoder();

export function decodeDetectionSeiFromNalu(seiNalu) {
    const messages = decodeH264SeiMessagesFromNalu(seiNalu);
    for (const msg of messages) {
        const payload = decodeDetectionSeiMessage(msg);
        if (payload) return payload;
    }
    return null;
}

export function decodeAllDetectionSeiFromNalu(seiNalu) {
    return decodeH264SeiMessagesFromNalu(seiNalu)
        .map(decodeDetectionSeiMessage)
        .filter(Boolean);
}

export function isDetectionSeiNalu(seiNalu) {
    return !!decodeDetectionSeiFromNalu(seiNalu);
}

export function readDetectionSeiPayloadFromFrame(frameWrapper, result, videoStream = null) {
    const nalus = collectH264NalUnitsFromFrame(frameWrapper, result, videoStream);
    let latest = null;
    for (const nalu of nalus) {
        if (!(nalu instanceof Uint8Array) || nalu.length < 1 || (nalu[0] & 0x1f) !== 6) continue;
        const payload = decodeDetectionSeiFromNalu(nalu);
        if (payload) latest = payload;
    }
    return latest;
}

export function detectionSeiPayloadToCanvasDetections(payload, canvas) {
    if (!payload || !canvas) return [];
    return normalizedBoxesToDetections(payload, canvas.width || payload?.image?.width, canvas.height || payload?.image?.height);
}

export function collectH264NalUnitsFromFrame(frameWrapper, result, videoStream = null) {
    const frame = frameWrapper?._rawFrame || frameWrapper;
    if (!frame || (frameWrapper?._mediaType && frameWrapper._mediaType !== "video")) return [];
    const { payload, preferredTransport } = extractFramePayloadForNaluParse(frame, result);
    if (!(payload instanceof Uint8Array) || payload.length <= 0) return [];
    const hintLengthSize = Number(videoStream?.decoderConfig?.lengthSizeMinusOne) + 1;
    const preferAvcc = preferredTransport === "avcc" || shouldPreferAvcc(frame, result);
    if (preferAvcc) {
        const parsed = detectLengthSizeAndSplit(payload, hintLengthSize);
        if (parsed?.nalus?.length) return parsed.nalus;
    }
    const annex = splitAnnexBNalus(payload);
    if (annex.length) return annex;
    const parsed = detectLengthSizeAndSplit(payload, hintLengthSize);
    return parsed?.nalus || [];
}

export function decodeH264SeiMessagesFromNalu(seiNalu) {
    if (!(seiNalu instanceof Uint8Array) || seiNalu.length < 2 || (seiNalu[0] & 0x1f) !== 6) return [];
    const rbsp = removeEmulationPrevention(seiNalu.slice(1)).data;
    const out = [];
    let off = 0;
    while (off < rbsp.length - 1) {
        const type = readSeiVarLen(rbsp, off);
        if (!type) break;
        off = type.next;
        const size = readSeiVarLen(rbsp, off);
        if (!size) break;
        off = size.next;
        if (off + size.value > rbsp.length) break;
        out.push({
            payloadType: type.value,
            payloadBytes: rbsp.slice(off, off + size.value),
        });
        off += size.value;
    }
    return out;
}

function decodeDetectionSeiMessage(message) {
    if (!message || Number(message.payloadType) !== 5) return null;
    const bytes = message.payloadBytes;
    if (!(bytes instanceof Uint8Array) || bytes.length <= 16) return null;
    if (!bytesEqual(bytes.subarray(0, 16), DETECTION_SEI_UUID_BYTES)) return null;
    try {
        const obj = JSON.parse(textDecoder.decode(bytes.subarray(16)));
        if (!isDetectionSeiPayload(obj)) return null;
        return normalizeDetectionSeiPayload(obj);
    } catch {
        return null;
    }
}

function extractFramePayloadForNaluParse(frame, result) {
    const fileData = result?.formatSpecific?.fileData || null;
    const fs = frame?.formatSpecific || {};
    const codecRange = fs?.fieldOffsets?.avcData || null;
    let payload = null;
    let preferredTransport = null;
    if (
        fileData instanceof Uint8Array &&
        codecRange &&
        Number.isFinite(codecRange.offset) &&
        Number.isFinite(codecRange.length) &&
        codecRange.length > 0
    ) {
        const start = Number(codecRange.offset);
        const end = start + Number(codecRange.length);
        if (start >= 0 && end <= fileData.length) {
            payload = fileData.subarray(start, end);
            preferredTransport = "avcc";
        }
    }
    if (!(payload instanceof Uint8Array) || payload.length === 0) {
        payload = sliceFrameBytes(frame, fileData);
    }
    if (!(payload instanceof Uint8Array) || payload.length === 0) return { payload: null, preferredTransport: null };
    if (result?.format?.formatName === "flv" || fs?.tagType === 9 || payload[0] === 9) {
        if (payload[0] === 9 && payload.length > 16) {
            payload = payload.subarray(11);
            const codecId = payload[0] & 0x0f;
            const packetType = payload[1];
            if (codecId === 7 && packetType === 1 && payload.length > 5) {
                payload = payload.subarray(5);
                preferredTransport = "avcc";
            }
        } else if (payload.length > 5 && payload[1] === 1) {
            payload = payload.subarray(5);
            preferredTransport = "avcc";
        }
    }
    return { payload, preferredTransport };
}

function shouldPreferAvcc(frame, result) {
    const formatName = String(result?.format?.formatName || "").toLowerCase();
    const fs = frame?.formatSpecific || {};
    if (formatName === "flv" || formatName === "mp4" || formatName === "mov") return true;
    if (fs?.fieldOffsets?.avcData) return true;
    return false;
}

function detectLengthSizeAndSplit(payload, hintLengthSize = null) {
    const tries = [];
    if (Number.isFinite(hintLengthSize) && hintLengthSize >= 1 && hintLengthSize <= 4) tries.push(hintLengthSize);
    for (const n of [4, 3, 2, 1]) if (!tries.includes(n)) tries.push(n);
    for (const lengthSize of tries) {
        const nalus = splitLengthPrefixedNalUnits(payload, lengthSize);
        if (nalus?.length) return { lengthSize, nalus };
    }
    return null;
}

function splitLengthPrefixedNalUnits(bytes, lengthSize) {
    if (!(bytes instanceof Uint8Array) || lengthSize < 1 || lengthSize > 4) return null;
    const out = [];
    let off = 0;
    while (off + lengthSize <= bytes.length) {
        let len = 0;
        for (let i = 0; i < lengthSize; i++) len = (len * 256) + bytes[off + i];
        off += lengthSize;
        if (len <= 0 || off + len > bytes.length) return null;
        out.push(bytes.subarray(off, off + len));
        off += len;
    }
    return off === bytes.length && out.length ? out : null;
}

function splitAnnexBNalus(bytes) {
    const out = [];
    let startCode = findAnnexBStartCode(bytes, 0);
    if (!startCode) return out;
    while (startCode) {
        const naluStart = startCode.index + startCode.length;
        const next = findAnnexBStartCode(bytes, naluStart);
        let naluEnd = next ? next.index : bytes.length;
        while (naluEnd > naluStart && bytes[naluEnd - 1] === 0) naluEnd--;
        if (naluEnd > naluStart) out.push(bytes.subarray(naluStart, naluEnd));
        startCode = next;
    }
    return out;
}

function findAnnexBStartCode(bytes, from) {
    for (let i = Math.max(0, from); i + 3 < bytes.length; i++) {
        if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) return { index: i, length: 3 };
        if (i + 4 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
            return { index: i, length: 4 };
        }
    }
    return null;
}

function readSeiVarLen(bytes, offset) {
    let value = 0;
    let off = offset;
    while (off < bytes.length && bytes[off] === 0xff) {
        value += 255;
        off++;
    }
    if (off >= bytes.length) return null;
    value += bytes[off];
    return { value, next: off + 1 };
}

function bytesEqual(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export const detectionSeiDecoder = Object.freeze({
    decodeDetectionSeiFromNalu,
    decodeAllDetectionSeiFromNalu,
    isDetectionSeiNalu,
    readDetectionSeiPayloadFromFrame,
    detectionSeiPayloadToCanvasDetections,
    collectH264NalUnitsFromFrame,
    decodeH264SeiMessagesFromNalu,
});
