import {
    concatBytes,
    pickSeiInsertIndex,
    readU24BE,
    splitAnnexBUnits,
    u24,
    u32,
} from "../codec/h264Bitstream.js";
import {
    insertSeiIntoMp4Sample,
    patchMp4SampleBytes,
} from "../codec/mp4AvcSei.js";
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
    return insertSeiIntoMp4Sample(sampleBytes, seiNaluBytes, {
        ...options,
        removePredicate: isDetectionSeiNalu,
    });
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
    const sampleMods = [];
    let writtenFrames = 0;
    let totalDelta = 0;
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
        totalDelta += patched.delta;
        writtenFrames++;
    }
    if (!writtenFrames) throw new Error("No MP4 H.264 samples could be patched with Detection SEI.");
    const patchedFile = patchMp4SampleBytes(fileBytes, result, sampleMods);
    return {
        patchedBytes: patchedFile.patchedBytes,
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

function getStreamForFrame(result, frame) {
    const idx = Number(frame?.streamIndex);
    return Array.isArray(result?.streams) && Number.isFinite(idx) ? result.streams[idx] || null : null;
}

function avcLengthSizeFromStream(stream) {
    const raw = Number(stream?.decoderConfig?.lengthSizeMinusOne);
    return Number.isFinite(raw) ? Math.max(1, Math.min(4, raw + 1)) : 4;
}

function firstFinite(...values) {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return undefined;
}
