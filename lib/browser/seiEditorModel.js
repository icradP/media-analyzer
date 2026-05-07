import { parseH264SeiNaluPayload } from "../codec/h264Sei.js";
import { sliceFrameBytes } from "./framePlayback.js";

export function bytesToHex(bytes) {
    if (!(bytes instanceof Uint8Array)) return "";
    return Array.from(bytes).map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

export function hexToBytes(text) {
    const clean = String(text || "").replace(/[^0-9a-fA-F]/g, "");
    if (!clean.length || clean.length % 2 !== 0) throw new Error("Hex text length must be even.");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}

export function bytesToAscii(bytes) {
    if (!(bytes instanceof Uint8Array)) return "";
    let out = "";
    for (const b of bytes) {
        if (b === 0x0a) out += "\n";
        else if (b === 0x0d) out += "\r";
        else if (b === 0x09) out += "\t";
        else if (b >= 0x20 && b <= 0x7E) out += String.fromCharCode(b);
        else out += ".";
    }
    return out;
}

export function asciiToBytes(text) {
    const s = String(text ?? "");
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code > 0x7F) throw new Error("ASCII only: found non-ASCII character.");
        out[i] = code;
    }
    return out;
}

export function extractH264SeiFromFrame(frameWrapper, result, videoStream = null) {
    const frame = frameWrapper;
    if (!frame || frame._mediaType !== "video") throw new Error("Select a video frame first.");
    const rf = frame._rawFrame;
    const { payload, baseOffset } = extractPayloadForNaluParse(rf, result);
    if (!(payload instanceof Uint8Array) || payload.length < 6) throw new Error("Selected frame has no valid video payload.");
    const hintLengthSize = Number(videoStream?.decoderConfig?.lengthSizeMinusOne) + 1;
    let nalus = parseAnnexBNalUnits(payload);
    let transport = "annexb";
    if (!nalus.length) {
        const avcc = detectLengthSizeAndParse(payload, hintLengthSize);
        if (!avcc) throw new Error("Failed to parse H264 NAL units from selected frame.");
        nalus = avcc.nalus;
        transport = `avcc-${avcc.lengthSize}`;
    }
    const sei = nalus.find((n) => n.nalType === 6);
    if (!sei) throw new Error("No SEI NAL (type 6) found in selected frame.");
    const absOffset = baseOffset + sei.naluStart;
    const seiBytes = sei.nalu.slice(0);
    const seiParsed = parseH264SeiNaluPayload(seiBytes, absOffset, {}, "seiEditor");
    const payloadTypes = Object.keys(seiParsed)
        .filter((k) => /^_payloadType\[\d+\]_value$/.test(k))
        .map((k) => seiParsed[k])
        .filter((v) => Number.isFinite(Number(v)));
    const ctx = {
        frameIndex: Number(frame.index),
        absOffset,
        naluLength: seiBytes.length,
        transport,
        payloadTypes,
        formatName: String(result?.format?.formatName || "").toLowerCase(),
        tagStartOffset: Number.isFinite(rf?.offset) ? Number(rf.offset) : null,
    };
    return { context: ctx, seiBytes };
}

export function applyH264SeiPatch(fileBytes, seiContext, editedBytes) {
    if (!(fileBytes instanceof Uint8Array) || fileBytes.length <= 0) throw new Error("No source bytes loaded.");
    if (!seiContext) throw new Error("Extract SEI first.");
    if (!(editedBytes instanceof Uint8Array)) throw new Error("SEI patch bytes are required.");
    const oldLen = Number(seiContext.naluLength) || 0;
    if (oldLen <= 0) throw new Error("Invalid SEI context length.");
    const delta = editedBytes.length - oldLen;
    const isFlv = seiContext.formatName === "flv";
    if (!isFlv && delta !== 0) {
        throw new Error(`Variable-length SEI is currently supported for FLV only. Current format=${seiContext.formatName || "unknown"}.`);
    }
    if (!isFlv || delta === 0) {
        const patched = fileBytes.slice(0);
        patched.set(editedBytes, seiContext.absOffset);
        return { patchedBytes: patched, delta };
    }
    const tagStart = Number(seiContext.tagStartOffset);
    if (!Number.isFinite(tagStart) || tagStart < 0 || tagStart + 11 > fileBytes.length) {
        throw new Error("Invalid FLV tag start offset.");
    }
    const headerDataSize = readU24BE(fileBytes, tagStart + 1);
    if (!Number.isFinite(headerDataSize) || headerDataSize < 0) throw new Error("Failed to read FLV dataSize.");
    const oldPrevTagOffset = tagStart + 11 + headerDataSize;
    if (oldPrevTagOffset + 4 > fileBytes.length) throw new Error("FLV PreviousTagSize out of range.");
    const newDataSize = headerDataSize + delta;
    if (newDataSize <= 0) throw new Error(`Invalid FLV dataSize after SEI patch: ${newDataSize}.`);
    const patched = spliceBytes(fileBytes, seiContext.absOffset, oldLen, editedBytes);
    writeU24BE(patched, tagStart + 1, newDataSize);
    const newPrevTagOffset = oldPrevTagOffset + delta;
    writeU32BE(patched, newPrevTagOffset, 11 + newDataSize);
    return { patchedBytes: patched, delta };
}

function extractPayloadForNaluParse(rf, result) {
    const fileData = result?.formatSpecific?.fileData || null;
    const fs = rf?.formatSpecific || {};
    let payload = sliceFrameBytes(rf, fileData);
    if (!(payload instanceof Uint8Array) || payload.length === 0) {
        return { payload: null, baseOffset: 0 };
    }
    let baseOffset = Number.isFinite(rf?.offset) ? rf.offset : (Number.isFinite(fs?.offset) ? fs.offset : 0);
    if (result?.format?.formatName === "flv" || fs?.tagType === 9 || payload[0] === 9) {
        if (payload[0] === 9 && payload.length > 16) {
            payload = payload.slice(11);
            baseOffset += 11;
            const codecId = payload[0] & 0x0f;
            const packetType = payload[1];
            if ((codecId === 7 || codecId === 12) && packetType === 1 && payload.length > 5) {
                payload = payload.slice(5);
                baseOffset += 5;
            }
        } else if (payload.length > 5 && payload[1] === 1) {
            payload = payload.slice(5);
            baseOffset += 5;
        }
    }
    return { payload, baseOffset };
}

function parseAvccNalUnits(payload, lengthSize) {
    const out = [];
    let off = 0;
    while (off + lengthSize <= payload.length) {
        let len = 0;
        for (let i = 0; i < lengthSize; i++) len = (len * 256) + payload[off + i];
        const naluStart = off + lengthSize;
        const naluEnd = naluStart + len;
        if (len <= 0 || naluEnd > payload.length) return null;
        const nalu = payload.subarray(naluStart, naluEnd);
        out.push({ naluStart, naluEnd, nalu, nalType: nalu[0] & 0x1f });
        off = naluEnd;
    }
    return off === payload.length ? out : null;
}

function findAnnexBStartCode(bytes, from) {
    for (let i = Math.max(0, from); i + 3 < bytes.length; i++) {
        if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) return { idx: i, len: 3 };
        if (i + 4 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) return { idx: i, len: 4 };
    }
    return null;
}

function parseAnnexBNalUnits(payload) {
    const out = [];
    const first = findAnnexBStartCode(payload, 0);
    if (!first) return out;
    let start = first.idx;
    while (start < payload.length) {
        const sc = findAnnexBStartCode(payload, start);
        if (!sc) break;
        const naluStart = sc.idx + sc.len;
        const nextSc = findAnnexBStartCode(payload, naluStart);
        const naluEnd = nextSc ? nextSc.idx : payload.length;
        if (naluEnd > naluStart) {
            const nalu = payload.subarray(naluStart, naluEnd);
            out.push({ naluStart, naluEnd, nalu, nalType: nalu[0] & 0x1f });
        }
        if (!nextSc) break;
        start = nextSc.idx;
    }
    return out;
}

function detectLengthSizeAndParse(payload, hintLengthSize = null) {
    const tries = [];
    if (Number.isFinite(hintLengthSize) && hintLengthSize >= 1 && hintLengthSize <= 4) tries.push(hintLengthSize);
    for (const n of [4, 3, 2, 1]) if (!tries.includes(n)) tries.push(n);
    for (const n of tries) {
        const parsed = parseAvccNalUnits(payload, n);
        if (parsed && parsed.length) return { lengthSize: n, nalus: parsed };
    }
    return null;
}

function readU24BE(bytes, off) {
    if (!(bytes instanceof Uint8Array) || off < 0 || off + 3 > bytes.length) return null;
    return bytes[off] * 0x10000 + bytes[off + 1] * 0x100 + bytes[off + 2];
}

function writeU24BE(bytes, off, value) {
    const n = Math.max(0, Math.min(0xFFFFFF, Math.round(Number(value) || 0)));
    bytes[off] = (n >>> 16) & 0xff;
    bytes[off + 1] = (n >>> 8) & 0xff;
    bytes[off + 2] = n & 0xff;
}

function writeU32BE(bytes, off, value) {
    const n = Math.max(0, Math.min(0xFFFFFFFF, Math.round(Number(value) || 0)));
    bytes[off] = (n >>> 24) & 0xff;
    bytes[off + 1] = (n >>> 16) & 0xff;
    bytes[off + 2] = (n >>> 8) & 0xff;
    bytes[off + 3] = n & 0xff;
}

function spliceBytes(source, replaceOffset, replaceLength, insertBytes) {
    const head = source.subarray(0, replaceOffset);
    const tail = source.subarray(replaceOffset + replaceLength);
    const out = new Uint8Array(head.length + insertBytes.length + tail.length);
    out.set(head, 0);
    out.set(insertBytes, head.length);
    out.set(tail, head.length + insertBytes.length);
    return out;
}

export const seiEditorModelCodec = Object.freeze({
    bytesToHex,
    hexToBytes,
    bytesToAscii,
    asciiToBytes,
    extractH264SeiFromFrame,
    applyH264SeiPatch,
});
