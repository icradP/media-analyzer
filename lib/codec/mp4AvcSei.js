import {
    concatBytes,
    joinLengthPrefixedNalUnits,
    naluType,
    pickSeiInsertIndex,
    u32,
    u64,
} from "./h264Bitstream.js";

export function splitAvcSampleNalUnits(sampleBytes, lengthSize = 4) {
    if (!(sampleBytes instanceof Uint8Array) || lengthSize < 1 || lengthSize > 4) return null;
    const out = [];
    let off = 0;
    while (off + lengthSize <= sampleBytes.length) {
        let len = 0;
        for (let i = 0; i < lengthSize; i++) len = (len * 256) + sampleBytes[off + i];
        const lengthFieldStart = off;
        const naluStart = off + lengthSize;
        const naluEnd = naluStart + len;
        if (len <= 0 || naluEnd > sampleBytes.length) return null;
        const nalu = sampleBytes.subarray(naluStart, naluEnd);
        out.push({
            index: out.length,
            lengthFieldStart,
            lengthSize,
            naluStart,
            naluEnd,
            naluLength: len,
            nalu,
            nalType: naluType(nalu),
        });
        off = naluEnd;
    }
    return off === sampleBytes.length && out.length ? out : null;
}

export function insertSeiIntoMp4Sample(sampleBytes, seiNaluBytes, options = {}) {
    const lengthSize = positiveInt(options.lengthSize, 4);
    const parsed = splitAvcSampleNalUnits(sampleBytes, lengthSize);
    if (!parsed?.length) throw new Error("Failed to parse MP4 AVC length-prefixed sample.");
    if (!(seiNaluBytes instanceof Uint8Array) || seiNaluBytes.length <= 0) {
        throw new Error("SEI NALU bytes are required.");
    }
    const replaceNaluIndex = Number.isInteger(options.replaceNaluIndex) ? Number(options.replaceNaluIndex) : null;
    const removePredicate = typeof options.removePredicate === "function" ? options.removePredicate : null;
    const kept = [];
    let removedCount = 0;
    let replacedCount = 0;
    for (const item of parsed) {
        if (replaceNaluIndex != null && item.index === replaceNaluIndex) {
            kept.push(seiNaluBytes);
            replacedCount++;
            continue;
        }
        if (replaceNaluIndex == null && removePredicate && options.replaceExisting !== false && removePredicate(item.nalu, item)) {
            removedCount++;
            continue;
        }
        kept.push(item.nalu);
    }
    let insertedIndex = replaceNaluIndex;
    if (!replacedCount) {
        insertedIndex = pickSeiInsertIndex(kept);
        kept.splice(insertedIndex, 0, seiNaluBytes);
    }
    const patchedBytes = joinLengthPrefixedNalUnits(kept, lengthSize);
    return {
        patchedBytes,
        delta: patchedBytes.length - sampleBytes.length,
        removedCount,
        replacedCount,
        insertedIndex,
        naluCount: kept.length,
    };
}

export function resolveMp4AvcSampleTarget(fileBytes, frameWrapper, result, videoStream = null) {
    const frame = frameWrapper?._rawFrame || frameWrapper;
    if (!(fileBytes instanceof Uint8Array)) throw new Error("No source bytes loaded.");
    if (!frame) throw new Error("No MP4 sample frame selected.");
    const streamIndex = Number(frame.streamIndex);
    const stream = videoStream || (Number.isFinite(streamIndex) ? result?.streams?.[streamIndex] : null);
    const codecName = String(stream?.codecName || frame?.codecName || "").toLowerCase();
    if (codecName && codecName !== "avc1" && codecName !== "avc3" && !codecName.includes("264") && !codecName.includes("avc")) {
        throw new Error(`MP4 SEI editor minimal path supports H.264/AVC only. Current codec=${codecName}.`);
    }
    const sampleIndex = Math.max(1, Math.round(Number(frame?.formatSpecific?.sampleIndex) || 0));
    const sampleOffset = Number(frame.offset ?? frame?.formatSpecific?.sampleOffset);
    const sampleLength = Number(frame.size);
    if (!Number.isFinite(streamIndex) || streamIndex < 0) throw new Error("MP4 sample stream index is missing.");
    if (!Number.isFinite(sampleIndex) || sampleIndex <= 0) throw new Error("MP4 sample index is missing.");
    if (!Number.isFinite(sampleOffset) || !Number.isFinite(sampleLength) || sampleLength <= 0) {
        throw new Error("MP4 sample byte range is missing.");
    }
    if (sampleOffset < 0 || sampleOffset + sampleLength > fileBytes.length) {
        throw new Error("MP4 sample byte range is out of file bounds.");
    }
    const lengthSize = avcLengthSizeFromStream(stream);
    return {
        frame,
        stream,
        streamIndex,
        sampleIndex,
        sampleOffset,
        sampleLength,
        lengthSize,
        sampleBytes: fileBytes.subarray(sampleOffset, sampleOffset + sampleLength),
    };
}

export function patchMp4SampleBytes(fileBytes, result, sampleMods) {
    if (!(fileBytes instanceof Uint8Array) || fileBytes.length <= 0) throw new Error("No source bytes loaded.");
    const mods = (Array.isArray(sampleMods) ? sampleMods : []).filter((mod) => mod?.bytes instanceof Uint8Array);
    if (!mods.length) throw new Error("No MP4 sample modifications to apply.");
    const boxes = result?.formatSpecific?.boxes || [];
    const tracks = collectMp4Tracks(boxes);
    if (!tracks.length) throw new Error("MP4 sample tables were not found.");

    const modifications = [];
    const stszUpdates = new Map();
    let totalDelta = 0;
    for (const mod of mods) {
        const offset = Number(mod.offset);
        const oldLength = Number(mod.oldLength);
        const streamIndex = Number(mod.streamIndex);
        const sampleIndex = Number(mod.sampleIndex);
        if (!Number.isFinite(offset) || !Number.isFinite(oldLength) || oldLength <= 0) continue;
        if (!Number.isFinite(streamIndex) || !Number.isFinite(sampleIndex) || sampleIndex <= 0) continue;
        const delta = mod.bytes.length - oldLength;
        modifications.push({ offset, oldLength, bytes: mod.bytes, kind: mod.kind || "mp4-sample" });
        stszUpdates.set(`${streamIndex}:${sampleIndex}`, mod.bytes.length);
        totalDelta += delta;
        mod.delta = delta;
    }
    if (!modifications.length) throw new Error("No valid MP4 sample modifications to apply.");
    for (const track of tracks) addMp4StszUpdates(fileBytes, modifications, track, stszUpdates);
    addMp4ChunkOffsetUpdates(modifications, tracks, mods);
    addMp4MdatSizeUpdates(modifications, boxes, mods);
    return {
        patchedBytes: applyByteModifications(fileBytes, modifications),
        delta: totalDelta,
        modifiedSamples: modifications.filter((mod) => mod.kind === "mp4-sample").length,
    };
}

export function insertSeiIntoMp4SampleFile(fileBytes, frameWrapper, result, seiNaluBytes, videoStream = null, options = {}) {
    const target = resolveMp4AvcSampleTarget(fileBytes, frameWrapper, result, videoStream);
    const patched = insertSeiIntoMp4Sample(target.sampleBytes, seiNaluBytes, {
        ...options,
        lengthSize: target.lengthSize,
    });
    const filePatch = patchMp4SampleBytes(fileBytes, result, [{
        offset: target.sampleOffset,
        oldLength: target.sampleLength,
        bytes: patched.patchedBytes,
        streamIndex: target.streamIndex,
        sampleIndex: target.sampleIndex,
        kind: "mp4-sample",
    }]);
    return {
        patchedBytes: filePatch.patchedBytes,
        delta: filePatch.delta,
        sampleOffset: target.sampleOffset,
        sampleIndex: target.sampleIndex,
        lengthFieldSize: target.lengthSize,
        insertedIndex: patched.insertedIndex,
        removedCount: patched.removedCount,
        replacedCount: patched.replacedCount,
        container: "mp4",
    };
}

export function replaceSeiInMp4SampleFile(fileBytes, seiContext, editedNaluBytes) {
    const sampleOffset = Number(seiContext?.sampleOffset);
    const sampleLength = Number(seiContext?.sampleLength);
    const streamIndex = Number(seiContext?.streamIndex);
    const sampleIndex = Number(seiContext?.sampleIndex);
    const lengthSize = positiveInt(seiContext?.lengthFieldSize, 4);
    const naluIndex = Number(seiContext?.naluIndex);
    const boxes = seiContext?.mp4Boxes;
    if (!Array.isArray(boxes)) throw new Error("MP4 sample table context is missing. Extract the SEI again before editing.");
    if (!Number.isFinite(sampleOffset) || !Number.isFinite(sampleLength) || sampleLength <= 0) {
        throw new Error("MP4 SEI sample range is missing.");
    }
    if (!Number.isFinite(naluIndex) || naluIndex < 0) throw new Error("MP4 SEI NALU index is missing.");
    const sampleBytes = fileBytes.subarray(sampleOffset, sampleOffset + sampleLength);
    const patched = insertSeiIntoMp4Sample(sampleBytes, editedNaluBytes, {
        lengthSize,
        replaceNaluIndex: naluIndex,
    });
    const filePatch = patchMp4SampleBytes(fileBytes, { formatSpecific: { boxes } }, [{
        offset: sampleOffset,
        oldLength: sampleLength,
        bytes: patched.patchedBytes,
        streamIndex,
        sampleIndex,
        kind: "mp4-sample",
    }]);
    return {
        patchedBytes: filePatch.patchedBytes,
        delta: filePatch.delta,
        sampleOffset,
        sampleIndex,
        lengthFieldSize: lengthSize,
        replacedCount: patched.replacedCount,
        container: "mp4",
    };
}

export function applyByteModifications(source, mods) {
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
    out.set(source.subarray(inPos), outPos);
    return out;
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
        throw new Error("MP4 files with fixed stsz.sampleSize cannot be expanded in the current SEI writer.");
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

function addMp4MdatSizeUpdates(modifications, boxes, sampleMods) {
    for (const box of boxes || []) {
        if (box?.type !== "mdat") continue;
        const dataStart = Number(box.dataOffset);
        const boxEnd = Number(box.offset) + Number(box.size);
        const delta = sampleMods
            .filter((mod) => mod.offset >= dataStart && mod.offset < boxEnd)
            .reduce((sum, mod) => sum + (Number(mod.delta) || 0), 0);
        if (delta === 0) continue;
        const oldSize = Number(box.size);
        const newSize = oldSize + delta;
        if (newSize <= 0) throw new Error("MP4 mdat size underflow after SEI insertion.");
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

function walkBoxes(boxes, visitor) {
    for (const box of Array.isArray(boxes) ? boxes : []) {
        visitor(box);
        if (Array.isArray(box?.children)) walkBoxes(box.children, visitor);
    }
}

function findChild(box, type) {
    return Array.isArray(box?.children) ? box.children.find((child) => child?.type === type) || null : null;
}

function deltaBeforeOffset(sampleMods, offset) {
    return sampleMods.reduce((sum, mod) => sum + (mod.offset < offset ? (Number(mod.delta) || 0) : 0), 0);
}

function avcLengthSizeFromStream(stream) {
    const raw = Number(stream?.decoderConfig?.lengthSizeMinusOne);
    return Number.isFinite(raw) ? Math.max(1, Math.min(4, raw + 1)) : 4;
}

function positiveInt(value, fallback) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const mp4AvcSeiCodec = Object.freeze({
    splitAvcSampleNalUnits,
    insertSeiIntoMp4Sample,
    resolveMp4AvcSampleTarget,
    patchMp4SampleBytes,
    insertSeiIntoMp4SampleFile,
    replaceSeiInMp4SampleFile,
    applyByteModifications,
});
