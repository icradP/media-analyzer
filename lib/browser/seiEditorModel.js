import { parseH264SeiNaluPayload, SEI_PAYLOAD_TYPE_NAMES } from "../codec/h264Sei.js";
import {
    appendSeiVarLen,
    concatBytes,
    decodeH264SeiRbspMessages,
    findAnnexBStartCode,
    insertEmulationPreventionBytes,
    readSeiVarLen,
} from "../codec/h264Bitstream.js";
import { sliceFrameBytes } from "./framePlayback.js";
import { shouldPreferAvccForFrame } from "../codec/h264FrameAccess.js";
import {
    insertSeiIntoMp4SampleFile,
    replaceSeiInMp4SampleFile,
    splitAvcSampleNalUnits,
} from "../codec/mp4AvcSei.js";

export const H264_SEI_PAYLOAD_TYPE_NAMES = SEI_PAYLOAD_TYPE_NAMES;

const DEFAULT_USER_DATA_UNREGISTERED_UUID = Uint8Array.from([
    0x9e, 0xd8, 0x6f, 0x31, 0xa6, 0x3f, 0x4f, 0x25,
    0x90, 0x3d, 0x6c, 0x9a, 0x76, 0x21, 0x42, 0x01,
]);

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
    const { payload, baseOffset, preferredTransport } = extractPayloadForNaluParse(rf, result);
    if (!(payload instanceof Uint8Array) || payload.length < 6) throw new Error("Selected frame has no valid video payload.");
    const hintLengthSize = Number(videoStream?.decoderConfig?.lengthSizeMinusOne) + 1;
    let nalus = [];
    let transport = "";
    const preferAvcc = preferredTransport === "avcc" || shouldPreferAvccForFrame(rf, result);
    if (preferAvcc) {
        const avcc = detectLengthSizeAndParse(payload, hintLengthSize);
        if (!avcc) throw new Error("Failed to parse H264 length-prefixed NAL units from selected frame.");
        nalus = avcc.nalus;
        transport = `avcc-${avcc.lengthSize}`;
    } else {
        nalus = parseAnnexBNalUnits(payload);
        transport = "annexb";
        if (!nalus.length) {
            const avcc = detectLengthSizeAndParse(payload, hintLengthSize);
            if (!avcc) throw new Error("Failed to parse H264 NAL units from selected frame.");
            nalus = avcc.nalus;
            transport = `avcc-${avcc.lengthSize}`;
        }
    }
    const sei = nalus.find((n) => n.nalType === 6);
    if (!sei) throw new Error("No SEI NAL (type 6) found in selected frame.");
    const formatName = String(result?.format?.formatName || "").toLowerCase();
    const isMp4 = formatName === "mp4" || formatName === "mov" || formatName.includes("mp4");
    const absOffset = baseOffset + sei.naluStart;
    const lengthFieldAbsOffset = Number.isFinite(sei.lengthFieldStart) ? baseOffset + sei.lengthFieldStart : null;
    const seiBytes = sei.nalu.slice(0);
    const seiPayload = extractFirstH264SeiMessagePayload(seiBytes);
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
        lengthFieldAbsOffset,
        lengthFieldSize: Number.isFinite(sei.lengthSize) ? sei.lengthSize : null,
        payloadTypes,
        formatName,
        container: isMp4 ? "mp4" : formatName || "raw",
        streamIndex: Number.isFinite(Number(rf?.streamIndex)) ? Number(rf.streamIndex) : null,
        pts: Number.isFinite(Number(rf?.pts)) ? Number(rf.pts) : null,
        dts: Number.isFinite(Number(rf?.dts)) ? Number(rf.dts) : null,
        timeMs: Number.isFinite(Number(rf?.ptsTime ?? rf?.dtsTime))
            ? Number(rf?.ptsTime ?? rf?.dtsTime) * 1000
            : null,
        sampleIndex: Number.isFinite(Number(rf?.formatSpecific?.sampleIndex)) ? Number(rf.formatSpecific.sampleIndex) : null,
        sampleOffset: Number.isFinite(Number(rf?.offset ?? rf?.formatSpecific?.sampleOffset))
            ? Number(rf?.offset ?? rf?.formatSpecific?.sampleOffset)
            : null,
        sampleLength: Number.isFinite(Number(rf?.size)) ? Number(rf.size) : null,
        naluIndex: Number.isFinite(Number(sei.index)) ? Number(sei.index) : null,
        naluCount: nalus.length,
        seiCount: nalus.filter((n) => n.nalType === 6).length,
        tagStartOffset: Number.isFinite(rf?.offset) ? Number(rf.offset) : null,
    };
    if (isMp4) ctx.mp4Boxes = result?.formatSpecific?.boxes || null;
    if (seiPayload) {
        ctx.payloadType = seiPayload.payloadType;
        ctx.payloadSize = seiPayload.payloadBytes.length;
        ctx.editablePayloadSize = seiPayload.editablePayloadBytes.length;
        ctx.protectedPrefixBytes = seiPayload.protectedPrefixBytes;
        ctx.messageIndex = seiPayload.messageIndex;
        ctx.messageCount = seiPayload.messageCount;
    }
    return { context: ctx, seiBytes, seiPayload };
}

export function buildH264SeiNaluFromPayload(payloadType, payloadBytes, options = {}) {
    const type = Number(payloadType);
    if (!Number.isInteger(type) || type < 0) throw new Error("SEI payloadType must be a non-negative integer.");
    if (!(payloadBytes instanceof Uint8Array)) throw new Error("SEI payload bytes are required.");
    const protectedPrefixBytes = resolveProtectedPrefixBytes(type, options);
    const fullPayloadBytes = protectedPrefixBytes?.length
        ? concatBytes([protectedPrefixBytes, payloadBytes])
        : payloadBytes;
    const rbsp = [];
    appendSeiVarLen(rbsp, type);
    appendSeiVarLen(rbsp, fullPayloadBytes.length);
    for (const b of fullPayloadBytes) rbsp.push(b);
    rbsp.push(0x80);
    const ebsp = insertEmulationPreventionBytes(Uint8Array.from(rbsp));
    const out = new Uint8Array(1 + ebsp.length);
    out[0] = 0x06;
    out.set(ebsp, 1);
    return out;
}

export function insertH264SeiIntoFrame(fileBytes, frameWrapper, result, seiNaluBytes, videoStream = null) {
    if (!(fileBytes instanceof Uint8Array) || fileBytes.length <= 0) throw new Error("No source bytes loaded.");
    if (!frameWrapper || frameWrapper._mediaType !== "video") throw new Error("Select a video frame first.");
    if (!(seiNaluBytes instanceof Uint8Array) || seiNaluBytes.length <= 0) throw new Error("SEI insert bytes are required.");
    const rf = frameWrapper._rawFrame;
    const formatName = String(result?.format?.formatName || "").toLowerCase();
    const isMp4 = formatName === "mp4" || formatName === "mov" || formatName.includes("mp4");
    if (isMp4) {
        return insertSeiIntoMp4SampleFile(fileBytes, frameWrapper, result, seiNaluBytes, videoStream, {
            replaceExisting: false,
        });
    }
    if (formatName !== "flv") {
        throw new Error(`SEI insertion is currently supported for FLV/H.264 and MP4/H.264. Current format=${formatName || "unknown"}.`);
    }
    const { payload, baseOffset, preferredTransport } = extractPayloadForNaluParse(rf, result);
    if (preferredTransport !== "avcc" || !(payload instanceof Uint8Array) || payload.length <= 0) {
        throw new Error("Selected FLV frame does not expose AVC length-prefixed payload for SEI insertion.");
    }
    const hintLengthSize = Number(videoStream?.decoderConfig?.lengthSizeMinusOne) + 1;
    const avcc = detectLengthSizeAndParse(payload, hintLengthSize);
    if (!avcc?.nalus?.length) throw new Error("Failed to parse AVC NAL units for SEI insertion.");
    const insertRel = pickSeiInsertOffset(avcc.nalus);
    const insertOffset = baseOffset + insertRel;
    const lengthSize = avcc.lengthSize;
    const insertBytes = new Uint8Array(lengthSize + seiNaluBytes.length);
    writeUintBE(insertBytes, 0, lengthSize, seiNaluBytes.length);
    insertBytes.set(seiNaluBytes, lengthSize);

    const tagStart = Number(rf?.offset);
    if (!Number.isFinite(tagStart) || tagStart < 0 || tagStart + 11 > fileBytes.length) {
        throw new Error("Invalid FLV tag start offset.");
    }
    const headerDataSize = readU24BE(fileBytes, tagStart + 1);
    if (!Number.isFinite(headerDataSize) || headerDataSize < 0) throw new Error("Failed to read FLV dataSize.");
    const oldPrevTagOffset = tagStart + 11 + headerDataSize;
    if (oldPrevTagOffset + 4 > fileBytes.length) throw new Error("FLV PreviousTagSize out of range.");
    const newDataSize = headerDataSize + insertBytes.length;
    if (newDataSize <= 0) throw new Error(`Invalid FLV dataSize after SEI insertion: ${newDataSize}.`);

    const patched = spliceBytes(fileBytes, insertOffset, 0, insertBytes);
    writeU24BE(patched, tagStart + 1, newDataSize);
    writeU32BE(patched, oldPrevTagOffset + insertBytes.length, 11 + newDataSize);
    return {
        patchedBytes: patched,
        delta: insertBytes.length,
        insertOffset: insertOffset + lengthSize,
        naluLength: seiNaluBytes.length,
        lengthFieldOffset: insertOffset,
        lengthFieldSize: lengthSize,
    };
}

export function applyH264SeiPatch(fileBytes, seiContext, editedBytes) {
    if (!(fileBytes instanceof Uint8Array) || fileBytes.length <= 0) throw new Error("No source bytes loaded.");
    if (!seiContext) throw new Error("Extract SEI first.");
    if (!(editedBytes instanceof Uint8Array)) throw new Error("SEI patch bytes are required.");
    const oldLen = Number(seiContext.naluLength) || 0;
    if (oldLen <= 0) throw new Error("Invalid SEI context length.");
    const delta = editedBytes.length - oldLen;
    const isFlv = seiContext.formatName === "flv";
    const isMp4 = seiContext.formatName === "mp4" || seiContext.formatName === "mov" || String(seiContext.formatName || "").includes("mp4");
    if (isMp4) return replaceSeiInMp4SampleFile(fileBytes, seiContext, editedBytes);
    if (!isFlv && delta !== 0) {
        throw new Error(`Variable-length SEI is currently supported for FLV/MP4 only. Current format=${seiContext.formatName || "unknown"}.`);
    }
    if (!isFlv || delta === 0) {
        const patched = fileBytes.slice(0);
        patched.set(editedBytes, seiContext.absOffset);
        writeNaluLengthFieldIfPresent(patched, seiContext, editedBytes.length);
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
    writeNaluLengthFieldIfPresent(patched, seiContext, editedBytes.length);
    writeU24BE(patched, tagStart + 1, newDataSize);
    const newPrevTagOffset = oldPrevTagOffset + delta;
    writeU32BE(patched, newPrevTagOffset, 11 + newDataSize);
    return { patchedBytes: patched, delta };
}

function extractPayloadForNaluParse(rf, result) {
    const fileData = result?.formatSpecific?.fileData || null;
    const fs = rf?.formatSpecific || {};
    const codecRange = pickCodecPayloadRange(fs);
    let payload = null;
    let baseOffset = Number.isFinite(rf?.offset) ? rf.offset : (Number.isFinite(fs?.offset) ? fs.offset : 0);
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
            baseOffset = start;
            preferredTransport = "avcc";
        }
    }
    if (!(payload instanceof Uint8Array) || payload.length === 0) {
        payload = sliceFrameBytes(rf, fileData);
    }
    if (!(payload instanceof Uint8Array) || payload.length === 0) {
        return { payload: null, baseOffset: 0, preferredTransport: null };
    }
    if (result?.format?.formatName === "flv" || fs?.tagType === 9 || payload[0] === 9) {
        if (payload[0] === 9 && payload.length > 16) {
            payload = payload.slice(11);
            baseOffset += 11;
            const codecId = payload[0] & 0x0f;
            const packetType = payload[1];
            if ((codecId === 7 || codecId === 12) && packetType === 1 && payload.length > 5) {
                payload = payload.slice(5);
                baseOffset += 5;
                if (codecId === 7) preferredTransport = "avcc";
            }
        } else if (payload.length > 5 && payload[1] === 1) {
            payload = payload.slice(5);
            baseOffset += 5;
            preferredTransport = "avcc";
        }
    }
    return { payload, baseOffset, preferredTransport };
}

function pickCodecPayloadRange(fs) {
    const fo = fs?.fieldOffsets || {};
    return fo.avcData || null;
}

function parseAvccNalUnits(payload, lengthSize) {
    const out = splitAvcSampleNalUnits(payload, lengthSize);
    if (!out) return null;
    for (const item of out) {
        const nalu = item.nalu;
        if (!isLikelyH264NalHeader(nalu[0])) return null;
    }
    return out;
}

function pickSeiInsertOffset(nalus) {
    const firstVcl = nalus.find((n) => n.nalType >= 1 && n.nalType <= 5);
    if (firstVcl && Number.isFinite(firstVcl.lengthFieldStart)) return firstVcl.lengthFieldStart;
    const firstNonAud = nalus.find((n) => n.nalType !== 9);
    if (firstNonAud && Number.isFinite(firstNonAud.lengthFieldStart)) return firstNonAud.lengthFieldStart;
    const last = nalus[nalus.length - 1];
    return Number.isFinite(last?.naluEnd) ? last.naluEnd : 0;
}

function parseAnnexBNalUnits(payload) {
    const out = [];
    const first = findAnnexBStartCode(payload, 0);
    if (!first) return out;
    let start = first.offset;
    while (start < payload.length) {
        const sc = findAnnexBStartCode(payload, start);
        if (!sc) break;
        const naluStart = sc.offset + sc.length;
        const nextSc = findAnnexBStartCode(payload, naluStart);
        const naluEnd = nextSc ? nextSc.offset : payload.length;
        if (naluEnd > naluStart) {
            const nalu = payload.subarray(naluStart, naluEnd);
            if (isLikelyH264NalHeader(nalu[0])) {
                out.push({ naluStart, naluEnd, nalu, nalType: nalu[0] & 0x1f });
            }
        }
        if (!nextSc) break;
        start = nextSc.offset;
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

function extractFirstH264SeiMessagePayload(seiNalu) {
    const messages = decodeH264SeiRbspMessages(seiNalu).map((message, messageIndex) => {
        const detail = describeH264SeiPayload(message.payloadType, message.payloadBytes);
        return {
            messageIndex,
            payloadType: message.payloadType,
            payloadBytes: message.payloadBytes,
            ...detail,
        };
    });
    if (!messages.length) return null;
    return { ...messages[0], messageCount: messages.length };
}

function describeH264SeiPayload(payloadType, payloadBytes) {
    const fields = [];
    let protectedPrefixBytes = new Uint8Array();
    let editablePayloadBytes = payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array();
    let editableLabel = "payload";

    if (payloadType === 5 && payloadBytes.length >= 16) {
        protectedPrefixBytes = payloadBytes.slice(0, 16);
        editablePayloadBytes = payloadBytes.slice(16);
        editableLabel = "user_data_payload_byte";
        fields.push({
            name: "uuid_iso_iec_11578",
            value: formatUuid(protectedPrefixBytes),
            bytes: bytesToHex(protectedPrefixBytes),
        });
    } else if (payloadType === 5) {
        fields.push({
            name: "uuid_iso_iec_11578",
            value: "missing",
            bytes: "-",
        });
    } else if (payloadType === 4 && payloadBytes.length >= 1) {
        let prefixLen = 1;
        const countryCode = payloadBytes[0];
        fields.push({
            name: "itu_t_t35_country_code",
            value: `0x${countryCode.toString(16).toUpperCase().padStart(2, "0")}`,
            bytes: bytesToHex(payloadBytes.slice(0, 1)),
        });
        if (countryCode === 0xff && payloadBytes.length >= 2) {
            prefixLen = 2;
            fields.push({
                name: "itu_t_t35_country_code_extension",
                value: `0x${payloadBytes[1].toString(16).toUpperCase().padStart(2, "0")}`,
                bytes: bytesToHex(payloadBytes.slice(1, 2)),
            });
        }
        if (countryCode === 0xb5 && payloadBytes.length >= 3) {
            const providerCode = (payloadBytes[1] << 8) | payloadBytes[2];
            prefixLen = 3;
            fields.push({
                name: "itu_t_t35_provider_code",
                value: `0x${providerCode.toString(16).toUpperCase().padStart(4, "0")}`,
                bytes: bytesToHex(payloadBytes.slice(1, 3)),
            });
            if (providerCode === 0x0031 && payloadBytes.length >= 7) {
                prefixLen = 7;
                fields.push({
                    name: "user_identifier",
                    value: bytesToAscii(payloadBytes.slice(3, 7)),
                    bytes: bytesToHex(payloadBytes.slice(3, 7)),
                });
            }
        }
        protectedPrefixBytes = payloadBytes.slice(0, prefixLen);
        editablePayloadBytes = payloadBytes.slice(prefixLen);
        editableLabel = "user_data_payload_byte";
    }

    return {
        fields,
        protectedPrefixBytes,
        editablePayloadBytes,
        editableLabel,
    };
}

function formatUuid(bytes) {
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex.length !== 32) return hex;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function resolveProtectedPrefixBytes(payloadType, options) {
    if (options?.protectedPrefixBytes instanceof Uint8Array && options.protectedPrefixBytes.length > 0) {
        return options.protectedPrefixBytes;
    }
    if (options?.autoProtectedPrefix !== false && payloadType === 5) {
        return DEFAULT_USER_DATA_UNREGISTERED_UUID;
    }
    return null;
}

function isLikelyH264NalHeader(byte) {
    if (!Number.isFinite(byte)) return false;
    const forbiddenZeroBit = (byte & 0x80) >>> 7;
    const nalType = byte & 0x1f;
    return forbiddenZeroBit === 0 && nalType > 0 && nalType <= 23;
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

function writeUintBE(bytes, off, length, value) {
    if (!(bytes instanceof Uint8Array)) return;
    if (!Number.isFinite(off) || !Number.isFinite(length) || length < 1 || length > 4) return;
    if (off < 0 || off + length > bytes.length) return;
    let n = Math.max(0, Math.round(Number(value) || 0));
    for (let i = length - 1; i >= 0; i--) {
        bytes[off + i] = n & 0xff;
        n >>>= 8;
    }
}

function writeNaluLengthFieldIfPresent(bytes, seiContext, value) {
    const off = Number(seiContext?.lengthFieldAbsOffset);
    const size = Number(seiContext?.lengthFieldSize);
    if (!Number.isFinite(off) || !Number.isFinite(size)) return;
    writeUintBE(bytes, off, size, value);
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
    H264_SEI_PAYLOAD_TYPE_NAMES,
    bytesToHex,
    hexToBytes,
    bytesToAscii,
    asciiToBytes,
    extractH264SeiFromFrame,
    buildH264SeiNaluFromPayload,
    insertH264SeiIntoFrame,
    applyH264SeiPatch,
});
