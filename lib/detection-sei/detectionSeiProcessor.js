import { buildDetectionSeiNalu } from "./detectionSeiEncoder.js";
import { isDetectionSeiNalu } from "./detectionSeiDecoder.js";
import {
    DETECTION_SEI_SOURCE,
    detectionsToNormalizedBoxes,
    normalizeDetectionSeiPayload,
} from "./detectionSeiSchema.js";

export function buildDetectionSeiPayloadForFrame({
    frameWrapper,
    detections,
    imageWidth,
    imageHeight,
    model = null,
    source = DETECTION_SEI_SOURCE,
} = {}) {
    const raw = frameWrapper?._rawFrame || frameWrapper || {};
    const pts = firstFinite(raw.pts, raw.dts, raw.timestamp);
    const timeSec = firstFinite(raw.ptsTime, raw.dtsTime);
    return normalizeDetectionSeiPayload({
        frameIndex: Math.max(0, Math.round(Number(frameWrapper?.index ?? raw.index) || 0)),
        pts,
        timeMs: Number.isFinite(timeSec) ? timeSec * 1000 : undefined,
        source,
        model,
        image: {
            width: imageWidth,
            height: imageHeight,
        },
        detections: detectionsToNormalizedBoxes(detections, imageWidth, imageHeight, detections?.length || 0),
    });
}

export function buildDetectionSeiRecord(input = {}) {
    const payload = input.payload || buildDetectionSeiPayloadForFrame(input);
    return {
        frameWrapper: input.frameWrapper,
        payload,
        seiNaluBytes: input.seiNaluBytes instanceof Uint8Array ? input.seiNaluBytes : buildDetectionSeiNalu(payload),
    };
}

export function patchMediaFileWithDetectionSeiRecords(fileBytes, result, records, options = {}) {
    if (!(fileBytes instanceof Uint8Array) || fileBytes.length <= 0) throw new Error("No source bytes loaded.");
    const uniqueRecords = normalizeRecords(records);
    if (!uniqueRecords.length) throw new Error("No detection SEI records to write.");
    const formatName = String(result?.format?.formatName || "").toLowerCase();
    if (formatName === "flv") return patchFlvH264Frames(fileBytes, result, uniqueRecords, options);
    if (formatName === "mp4" || formatName === "mov" || formatName.includes("mp4")) {
        return patchMp4H264Samples(fileBytes, result, uniqueRecords, options);
    }
    if (formatName === "h264" || formatName === "avc" || formatName === "annexb") {
        return patchAnnexBFrames(fileBytes, uniqueRecords, options);
    }
    throw new Error(`Detection SEI export currently supports FLV/H.264, MP4/H.264 and raw H.264. Current format=${formatName || "unknown"}.`);
}

export function insertSeiNaluIntoAvcSample(sampleBytes, seiNaluBytes, options = {}) {
    const lengthSize = positiveInt(options.lengthSize, 4);
    const nalus = splitLengthPrefixedNalUnits(sampleBytes, lengthSize);
    if (!nalus?.length) throw new Error("Failed to parse length-prefixed H.264 sample.");
    let removedCount = 0;
    const kept = [];
    for (const nalu of nalus) {
        if (options.replaceExisting !== false && isDetectionSeiNalu(nalu)) {
            removedCount++;
            continue;
        }
        kept.push(nalu);
    }
    const insertIndex = pickSeiInsertIndex(kept);
    kept.splice(insertIndex, 0, seiNaluBytes);
    const patchedBytes = joinLengthPrefixedNalUnits(kept, lengthSize);
    return {
        patchedBytes,
        delta: patchedBytes.length - sampleBytes.length,
        removedCount,
        insertedIndex: insertIndex,
    };
}

export function insertSeiNaluIntoAnnexBAccessUnit(accessUnitBytes, seiNaluBytes, options = {}) {
    const units = splitAnnexBUnits(accessUnitBytes);
    if (!units.length) throw new Error("Failed to parse Annex-B H.264 access unit.");
    const kept = [];
    let removedCount = 0;
    for (const unit of units) {
        if (options.replaceExisting !== false && isDetectionSeiNalu(unit.nalu)) {
            removedCount++;
            continue;
        }
        kept.push(unit);
    }
    const insertIndex = pickSeiInsertIndex(kept.map((unit) => unit.nalu));
    kept.splice(insertIndex, 0, {
        startCode: Uint8Array.from([0, 0, 0, 1]),
        nalu: seiNaluBytes,
    });
    const patchedBytes = concatBytes(kept.flatMap((unit) => [unit.startCode, unit.nalu]));
    return {
        patchedBytes,
        delta: patchedBytes.length - accessUnitBytes.length,
        removedCount,
        insertedIndex: insertIndex,
    };
}

function patchFlvH264Frames(fileBytes, result, records, options) {
    const modifications = [];
    let writtenFrames = 0;
    let totalDelta = 0;
    for (const record of records) {
        const frame = record.frameWrapper?._rawFrame || record.frameWrapper;
        const range = frame?.formatSpecific?.fieldOffsets?.avcData || null;
        if (!range || !Number.isFinite(range.offset) || !Number.isFinite(range.length) || range.length <= 0) continue;
        const sampleOffset = Number(range.offset);
        const sampleLength = Number(range.length);
        const sample = fileBytes.subarray(sampleOffset, sampleOffset + sampleLength);
        const stream = getStreamForFrame(result, frame);
        const lengthSize = avcLengthSizeFromStream(stream);
        const patched = insertSeiNaluIntoAvcSample(sample, record.seiNaluBytes, {
            lengthSize,
            replaceExisting: options.replaceExisting !== false,
        });
        modifications.push({ offset: sampleOffset, oldLength: sampleLength, bytes: patched.patchedBytes, kind: "sample" });
        const delta = patched.delta;
        totalDelta += delta;
        writtenFrames++;
        if (delta !== 0) {
            const tagStart = Number(frame?.offset ?? frame?.formatSpecific?.offset);
            if (!Number.isFinite(tagStart) || tagStart < 0 || tagStart + 15 > fileBytes.length) {
                throw new Error(`Invalid FLV tag offset for frame ${frame?.index ?? "-"}.`);
            }
            const oldDataSize = readU24BE(fileBytes, tagStart + 1);
            const newDataSize = oldDataSize + delta;
            if (newDataSize <= 0 || newDataSize > 0xffffff) throw new Error("FLV dataSize overflow after Detection SEI insertion.");
            modifications.push({ offset: tagStart + 1, oldLength: 3, bytes: u24(newDataSize), kind: "flv-dataSize" });
            modifications.push({
                offset: tagStart + 11 + oldDataSize,
                oldLength: 4,
                bytes: u32(11 + newDataSize),
                kind: "flv-previousTagSize",
            });
        }
    }
    if (!writtenFrames) throw new Error("No FLV H.264 video frames could be patched with Detection SEI.");
    return {
        patchedBytes: applyByteModifications(fileBytes, modifications),
        writtenFrames,
        delta: totalDelta,
        container: "flv",
    };
}

function patchMp4H264Samples(fileBytes, result, records, options) {
    const tracks = collectMp4Tracks(result?.formatSpecific?.boxes || []);
    if (!tracks.length) throw new Error("MP4 sample tables were not found.");
    const sampleMods = [];
    const modifications = [];
    let writtenFrames = 0;
    let totalDelta = 0;
    const stszUpdates = new Map();
    for (const record of records) {
        const frame = record.frameWrapper?._rawFrame || record.frameWrapper;
        const streamIndex = Number(frame?.streamIndex);
        const sampleIndex = Math.max(1, Math.round(Number(frame?.formatSpecific?.sampleIndex) || 0));
        const sampleOffset = Number(frame?.offset ?? frame?.formatSpecific?.sampleOffset);
        const sampleLength = Number(frame?.size);
        if (!Number.isFinite(streamIndex) || !Number.isFinite(sampleIndex) || sampleIndex <= 0) continue;
        if (!Number.isFinite(sampleOffset) || !Number.isFinite(sampleLength) || sampleLength <= 0) continue;
        const stream = getStreamForFrame(result, frame);
        const lengthSize = avcLengthSizeFromStream(stream);
        const sample = fileBytes.subarray(sampleOffset, sampleOffset + sampleLength);
        const patched = insertSeiNaluIntoAvcSample(sample, record.seiNaluBytes, {
            lengthSize,
            replaceExisting: options.replaceExisting !== false,
        });
        sampleMods.push({
            offset: sampleOffset,
            oldLength: sampleLength,
            bytes: patched.patchedBytes,
            delta: patched.delta,
            streamIndex,
            sampleIndex,
        });
        const key = `${streamIndex}:${sampleIndex}`;
        stszUpdates.set(key, patched.patchedBytes.length);
        totalDelta += patched.delta;
        writtenFrames++;
    }
    if (!writtenFrames) throw new Error("No MP4 H.264 samples could be patched with Detection SEI.");
    for (const mod of sampleMods) {
        modifications.push({ offset: mod.offset, oldLength: mod.oldLength, bytes: mod.bytes, kind: "sample" });
    }
    for (const track of tracks) {
        addMp4StszUpdates(fileBytes, modifications, track, stszUpdates);
    }
    addMp4ChunkOffsetUpdates(modifications, tracks, sampleMods);
    addMp4MdatSizeUpdates(fileBytes, modifications, result?.formatSpecific?.boxes || [], sampleMods);
    return {
        patchedBytes: applyByteModifications(fileBytes, modifications),
        writtenFrames,
        delta: totalDelta,
        container: "mp4",
    };
}

function patchAnnexBFrames(fileBytes, records, options) {
    const modifications = [];
    let writtenFrames = 0;
    let totalDelta = 0;
    for (const record of records) {
        const frame = record.frameWrapper?._rawFrame || record.frameWrapper;
        const offset = Number(frame?.offset ?? frame?.formatSpecific?.offset);
        const length = Number(frame?.size ?? frame?.formatSpecific?.size);
        if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) continue;
        const accessUnit = fileBytes.subarray(offset, offset + length);
        const patched = insertSeiNaluIntoAnnexBAccessUnit(accessUnit, record.seiNaluBytes, {
            replaceExisting: options.replaceExisting !== false,
        });
        modifications.push({ offset, oldLength: length, bytes: patched.patchedBytes, kind: "annexb-au" });
        totalDelta += patched.delta;
        writtenFrames++;
    }
    if (!writtenFrames) throw new Error("No raw H.264 access units could be patched with Detection SEI.");
    return {
        patchedBytes: applyByteModifications(fileBytes, modifications),
        writtenFrames,
        delta: totalDelta,
        container: "h264",
    };
}

function addMp4StszUpdates(fileBytes, modifications, track, stszUpdates) {
    const stsz = track.stsz;
    if (!stsz?.data) return;
    const sampleCount = Number(stsz.data.sampleCount) || 0;
    const fixedSampleSize = Number(stsz.data.sampleSize) || 0;
    const trackUpdates = [];
    for (const [key, newSize] of stszUpdates) {
        const [streamIndexText, sampleIndexText] = key.split(":");
        if (Number(streamIndexText) !== track.streamIndex) continue;
        const sampleIndex = Number(sampleIndexText);
        if (sampleIndex >= 1 && sampleIndex <= sampleCount) trackUpdates.push({ sampleIndex, newSize });
    }
    if (!trackUpdates.length) return;
    if (fixedSampleSize > 0) {
        throw new Error("MP4 files with fixed stsz.sampleSize cannot be expanded in the current Detection SEI writer.");
    }
    const entryBase = stsz.dataOffset + 12;
    for (const item of trackUpdates) {
        const off = entryBase + (item.sampleIndex - 1) * 4;
        if (off < 0 || off + 4 > fileBytes.length) throw new Error("MP4 stsz entry offset out of range.");
        modifications.push({ offset: off, oldLength: 4, bytes: u32(item.newSize), kind: "mp4-stsz" });
    }
}

function addMp4ChunkOffsetUpdates(modifications, tracks, sampleMods) {
    for (const track of tracks) {
        const box = track.stco || track.co64;
        if (!box?.data || !Array.isArray(box.data.offsets)) continue;
        const isCo64 = box.type === "co64";
        const entrySize = isCo64 ? 8 : 4;
        const entryBase = box.dataOffset + 8;
        for (let i = 0; i < box.data.offsets.length; i++) {
            const oldOffset = Number(box.data.offsets[i]);
            if (!Number.isFinite(oldOffset)) continue;
            const delta = deltaBeforeOffset(sampleMods, oldOffset);
            if (delta === 0) continue;
            const newOffset = oldOffset + delta;
            modifications.push({
                offset: entryBase + i * entrySize,
                oldLength: entrySize,
                bytes: isCo64 ? u64(newOffset) : u32(newOffset),
                kind: "mp4-chunk-offset",
            });
        }
    }
}

function addMp4MdatSizeUpdates(fileBytes, modifications, boxes, sampleMods) {
    for (const box of boxes || []) {
        if (box?.type !== "mdat") continue;
        const dataStart = Number(box.dataOffset);
        const boxEnd = Number(box.offset) + Number(box.size);
        const delta = sampleMods
            .filter((mod) => mod.offset >= dataStart && mod.offset < boxEnd)
            .reduce((sum, mod) => sum + mod.delta, 0);
        if (delta === 0) continue;
        const oldSize = Number(box.size);
        const newSize = oldSize + delta;
        if (newSize <= 0) throw new Error("MP4 mdat size underflow after Detection SEI insertion.");
        if (box.headerSize === 16) {
            modifications.push({ offset: box.offset + 8, oldLength: 8, bytes: u64(newSize), kind: "mp4-mdat-size64" });
        } else {
            if (newSize > 0xffffffff) throw new Error("MP4 mdat size exceeds 32-bit box size.");
            modifications.push({ offset: box.offset, oldLength: 4, bytes: u32(newSize), kind: "mp4-mdat-size" });
        }
    }
}

function collectMp4Tracks(boxes) {
    const tracks = [];
    const trakBoxes = [];
    walkBoxes(boxes, (box) => {
        if (box?.type === "trak") trakBoxes.push(box);
    });
    for (let i = 0; i < trakBoxes.length; i++) {
        const trak = trakBoxes[i];
        const mdia = findChild(trak, "mdia");
        const minf = findChild(mdia, "minf");
        const stbl = findChild(minf, "stbl");
        if (!stbl) continue;
        tracks.push({
            streamIndex: i,
            trak,
            stsz: findChild(stbl, "stsz"),
            stsc: findChild(stbl, "stsc"),
            stco: findChild(stbl, "stco"),
            co64: findChild(stbl, "co64"),
        });
    }
    return tracks;
}

function normalizeRecords(records) {
    const map = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        if (!record?.seiNaluBytes || !record?.frameWrapper) continue;
        const idx = Number(record.frameWrapper?.index ?? record.frameWrapper?._rawFrame?.index);
        const key = Number.isFinite(idx) ? String(idx) : `${map.size}`;
        map.set(key, record);
    }
    return Array.from(map.values());
}

function applyByteModifications(source, mods) {
    const sorted = (Array.isArray(mods) ? mods : [])
        .filter((mod) => mod?.bytes instanceof Uint8Array && Number.isFinite(mod.offset) && Number.isFinite(mod.oldLength))
        .sort((a, b) => a.offset - b.offset || b.oldLength - a.oldLength);
    let totalDelta = 0;
    let cursor = 0;
    for (const mod of sorted) {
        if (mod.offset < cursor) throw new Error(`Overlapping byte modifications near offset ${mod.offset}.`);
        totalDelta += mod.bytes.length - mod.oldLength;
        cursor = mod.offset + mod.oldLength;
    }
    const out = new Uint8Array(source.length + totalDelta);
    let inPos = 0;
    let outPos = 0;
    for (const mod of sorted) {
        const head = source.subarray(inPos, mod.offset);
        out.set(head, outPos);
        outPos += head.length;
        out.set(mod.bytes, outPos);
        outPos += mod.bytes.length;
        inPos = mod.offset + mod.oldLength;
    }
    const tail = source.subarray(inPos);
    out.set(tail, outPos);
    return out;
}

function pickSeiInsertIndex(nalus) {
    const firstVcl = nalus.findIndex((nalu) => {
        const type = naluType(nalu);
        return type >= 1 && type <= 5;
    });
    if (firstVcl >= 0) return firstVcl;
    const firstNonAud = nalus.findIndex((nalu) => naluType(nalu) !== 9);
    return firstNonAud >= 0 ? firstNonAud : nalus.length;
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

function joinLengthPrefixedNalUnits(nalus, lengthSize) {
    const parts = [];
    for (const nalu of nalus) {
        if (!(nalu instanceof Uint8Array) || nalu.length <= 0) continue;
        parts.push(uintBE(nalu.length, lengthSize), nalu);
    }
    return concatBytes(parts);
}

function splitAnnexBUnits(bytes) {
    const out = [];
    let sc = findAnnexBStartCode(bytes, 0);
    while (sc) {
        const naluStart = sc.offset + sc.length;
        const next = findAnnexBStartCode(bytes, naluStart);
        let naluEnd = next ? next.offset : bytes.length;
        while (naluEnd > naluStart && bytes[naluEnd - 1] === 0) naluEnd--;
        if (naluEnd > naluStart) {
            out.push({
                startCode: bytes.slice(sc.offset, sc.offset + sc.length),
                nalu: bytes.subarray(naluStart, naluEnd),
            });
        }
        sc = next;
    }
    return out;
}

function findAnnexBStartCode(bytes, from) {
    for (let i = Math.max(0, from); i + 3 < bytes.length; i++) {
        if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) return { offset: i, length: 3 };
        if (i + 4 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
            return { offset: i, length: 4 };
        }
    }
    return null;
}

function deltaBeforeOffset(sampleMods, offset) {
    return sampleMods.reduce((sum, mod) => sum + (mod.offset < offset ? mod.delta : 0), 0);
}

function getStreamForFrame(result, frame) {
    const idx = Number(frame?.streamIndex);
    return Array.isArray(result?.streams) && Number.isFinite(idx) ? result.streams[idx] || null : null;
}

function avcLengthSizeFromStream(stream) {
    const raw = Number(stream?.decoderConfig?.lengthSizeMinusOne);
    return Number.isFinite(raw) ? Math.max(1, Math.min(4, raw + 1)) : 4;
}

function naluType(nalu) {
    return nalu instanceof Uint8Array && nalu.length ? nalu[0] & 0x1f : -1;
}

function walkBoxes(boxes, visitor) {
    for (const box of Array.isArray(boxes) ? boxes : []) {
        visitor(box);
        if (Array.isArray(box?.children)) walkBoxes(box.children, visitor);
    }
}

function findChild(box, type) {
    return Array.isArray(box?.children) ? box.children.find((child) => child?.type === type) || null : null;
}

function firstFinite(...values) {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return undefined;
}

function positiveInt(value, fallback) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readU24BE(bytes, off) {
    return (bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2];
}

function uintBE(value, length) {
    const out = new Uint8Array(length);
    let n = Math.max(0, Math.round(Number(value) || 0));
    for (let i = length - 1; i >= 0; i--) {
        out[i] = n & 0xff;
        n = Math.floor(n / 256);
    }
    return out;
}

function u24(value) {
    const n = Math.max(0, Math.min(0xffffff, Math.round(Number(value) || 0)));
    return Uint8Array.of((n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function u32(value) {
    const n = Math.max(0, Math.min(0xffffffff, Math.round(Number(value) || 0)));
    return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function u64(value) {
    let n = BigInt(Math.max(0, Math.round(Number(value) || 0)));
    const out = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) {
        out[i] = Number(n & 0xffn);
        n >>= 8n;
    }
    return out;
}

function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + (part?.length || 0), 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of parts) {
        if (!(part instanceof Uint8Array) || part.length <= 0) continue;
        out.set(part, off);
        off += part.length;
    }
    return out;
}

export const detectionSeiProcessor = Object.freeze({
    buildDetectionSeiPayloadForFrame,
    buildDetectionSeiRecord,
    patchMediaFileWithDetectionSeiRecords,
    insertSeiNaluIntoAvcSample,
    insertSeiNaluIntoAnnexBAccessUnit,
});
