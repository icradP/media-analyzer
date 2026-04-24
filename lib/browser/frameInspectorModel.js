import { sliceFrameBytes } from "./framePlayback.js";
import {
    parseAvcLengthPrefixedNalUnits,
    parseHevcLengthPrefixedNalUnits,
    parseAnnexBH264NalUnits,
    parseAnnexBHevcNalUnits,
} from "../codec/index.js";
import {
    detectAnnexBVideoCodecFromPesPayload,
    scanAnnexBNalusFromPayload,
    parsePesPacketSummary,
} from "../mpegTs/index.js";

function pickKeys(obj, keys) {
    const out = {};
    for (const k of keys) {
        if (obj && obj[k] !== undefined) out[k] = obj[k];
    }
    return out;
}

function normalizeFieldOffsets(fieldOffsets, baseOffset = 0) {
    if (!fieldOffsets || typeof fieldOffsets !== "object") return [];
    const rows = [];
    for (const [k, v] of Object.entries(fieldOffsets)) {
        if (!v || typeof v !== "object") continue;
        if (typeof v.offset === "number" && typeof v.length === "number") {
            rows.push({ field: k, offset: v.offset + baseOffset, length: v.length });
        }
    }
    rows.sort((a, b) => a.offset - b.offset);
    return rows.slice(0, 200);
}

function normalizeFieldOffsetsAuto(fieldOffsets, rf, fs) {
    const rows = normalizeFieldOffsets(fieldOffsets, 0);
    if (!rows.length) return rows;
    const absBase = Number.isFinite(rf?.offset)
        ? Number(rf.offset)
        : (Number.isFinite(fs?.offset) ? Number(fs.offset) : 0);
    const payloadLen = Number.isFinite(rf?.size)
        ? Number(rf.size)
        : (Number.isFinite(fs?.byteLength) ? Number(fs.byteLength) : (Number.isFinite(fs?.dataSize) ? Number(fs.dataSize) : 0));
    if (!Number.isFinite(absBase) || !Number.isFinite(payloadLen) || payloadLen <= 0) return rows;
    const maxRel = rows.reduce((m, r) => Math.max(m, Number(r.offset) + Number(r.length)), 0);
    const looksRelative = maxRel <= payloadLen + 32;
    if (!looksRelative) return rows;
    return rows.map((r) => ({ ...r, offset: r.offset + absBase }));
}

function mergeFieldRows(...groups) {
    const merged = [];
    const seen = new Set();
    for (const g of groups) {
        for (const row of Array.isArray(g) ? g : []) {
            if (!row || typeof row !== "object") continue;
            const off = Number(row.offset);
            const len = Number(row.length);
            const field = String(row.field || "");
            if (!Number.isFinite(off) || !Number.isFinite(len) || len <= 0 || !field) continue;
            const key = `${field}@${off}:${len}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push({ field, offset: off, length: len });
        }
    }
    merged.sort((a, b) => a.offset - b.offset || b.length - a.length);
    return merged.slice(0, 400);
}

function collectNaluItems(fs) {
    const out = [];
    if (!fs || typeof fs !== "object") return out;
    Object.keys(fs)
        .filter((k) => /^nalu\[\d+\]$/.test(k))
        .sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0))
        .forEach((k) => {
            if (fs[k] && typeof fs[k] === "object") out.push(fs[k]);
        });
    if (Array.isArray(fs.nalus)) for (const n of fs.nalus) if (n && typeof n === "object") out.push(n);
    if (fs.es && Array.isArray(fs.es.nalus)) for (const n of fs.es.nalus) if (n && typeof n === "object") out.push(n);
    if (fs.pes && Array.isArray(fs.pes.nalus)) for (const n of fs.pes.nalus) if (n && typeof n === "object") out.push(n);
    return out;
}

export function pickHexSourceBytesForInspector(rf, primaryBytes) {
    const fs = rf?.formatSpecific || {};
    const direct = [rf?._rawData, fs?._rawData, fs?._data];
    for (const c of direct) {
        if (c instanceof Uint8Array && c.length > 0) return c;
    }
    const off = Number.isFinite(rf?.offset) ? Number(rf.offset) : (Number.isFinite(fs?.offset) ? Number(fs.offset) : null);
    const len = Number.isFinite(rf?.size)
        ? Number(rf.size)
        : (Number.isFinite(fs?.byteLength) ? Number(fs.byteLength) : (Number.isFinite(fs?.dataSize) ? Number(fs.dataSize) : null));
    if (primaryBytes instanceof Uint8Array && off != null && len != null && len > 0) {
        const end = Math.min(primaryBytes.length, off + len);
        if (end > off) return primaryBytes.subarray(off, end);
    }
    return sliceFrameBytes(rf, primaryBytes);
}

function buildContainerFieldOffsets(rf, fs) {
    const rows = [];
    const push = (field, offset, length) => {
        const off = Number(offset);
        const len = Number(length);
        if (!Number.isFinite(off) || !Number.isFinite(len) || len <= 0) return;
        rows.push({ field, offset: off, length: len });
    };
    const rfOffset = Number.isFinite(rf?.offset) ? Number(rf.offset) : null;
    const rfSize = Number.isFinite(rf?.size) ? Number(rf.size) : null;
    if (rfOffset != null && rfSize != null) push("frame.payload", rfOffset, rfSize);
    const fsOffset = Number.isFinite(fs?.offset) ? Number(fs.offset) : null;
    const fsByteLength = Number.isFinite(fs?.byteLength) ? Number(fs.byteLength) : (Number.isFinite(fs?.dataSize) ? Number(fs.dataSize) : null);
    if (fsOffset != null && fsByteLength != null) push("formatSpecific.payload", fsOffset, fsByteLength);
    if (rfOffset != null && Number.isFinite(fs?.PES_packet_length)) {
        const pesLen = Number(fs.PES_packet_length);
        if (pesLen > 0) push("ts.pes.packet", rfOffset, pesLen + 6);
    }
    return rows;
}

function buildTsPesFieldOffsets(rf, fs, fullBytes) {
    const rows = [];
    const push = (field, offset, length) => {
        if (Number.isFinite(offset) && Number.isFinite(length) && length > 0) rows.push({ field, offset, length });
    };
    const base = Number.isFinite(rf?.offset) ? Number(rf.offset) : (Number.isFinite(fs?.offset) ? Number(fs.offset) : null);
    if (base == null) return rows;
    const pes = parsePesPacketSummary(fullBytes);
    if (!pes) return rows;
    push("ts.pes.packet_start_code_prefix", base, 3);
    push("ts.pes.stream_id", base + 3, 1);
    push("ts.pes.PES_packet_length", base + 4, 2);
    push("ts.pes.flags_1", base + 6, 1);
    push("ts.pes.flags_2", base + 7, 1);
    push("ts.pes.PES_header_data_length", base + 8, 1);
    if (pes.PTS_DTS_flags === 2 || pes.PTS_DTS_flags === 3) push("ts.pes.PTS", base + 9, 5);
    if (pes.PTS_DTS_flags === 3) push("ts.pes.DTS", base + 14, 5);
    if (pes.PES_header_data_length > 0) push("ts.pes.optional_header", base + 9, pes.PES_header_data_length);
    if (pes.pesPacketLength > 0) push("ts.pes.packet", base, Math.min(fullBytes.length, pes.pesPacketLength + 6));
    if (pes.payloadSize > 0) push("ts.pes.payload", base + pes.payloadStart, pes.payloadSize);
    return rows;
}

function buildFlvFieldOffsets(rf, fs) {
    const rows = [];
    const push = (field, offset, length) => {
        if (Number.isFinite(offset) && Number.isFinite(length) && length > 0) rows.push({ field, offset, length });
    };
    const base = Number.isFinite(fs?.offset) ? Number(fs.offset) : (Number.isFinite(rf?.offset) ? Number(rf.offset) : null);
    if (base == null) return rows;
    const dataSize = Number.isFinite(fs?.dataSize) ? Number(fs.dataSize) : null;
    const bodyLen = Number.isFinite(fs?.byteLength) ? Number(fs.byteLength) : dataSize;
    if (bodyLen != null && bodyLen > 0) push("flv.tag.body", base, bodyLen);
    if (fs?.tagType === 9 || fs?.mediaType === "video") {
        push("flv.video.frameType_codecId", base, 1);
        push("flv.video.packetType", base + 1, 1);
        push("flv.video.compositionTime", base + 2, 3);
    }
    return rows;
}

function parseNalusFromFrame(rf, result, primaryBytes, streams) {
    if (!rf || rf.mediaType !== "video") return { nalus: [], fieldOffsets: [] };
    const stream = typeof rf.streamIndex === "number"
        ? streams.find((s) => s.index === rf.streamIndex && s.codecType === "video")
        : streams.find((s) => s.codecType === "video");
    const codecName = String(rf.codecName || stream?.codecName || "").toLowerCase();
    const fs = rf?.formatSpecific || {};
    const full = pickHexSourceBytesForInspector(rf, primaryBytes);
    let payload = full;
    let baseOffset = Number.isFinite(rf?.offset) ? Number(rf.offset) : (Number.isFinite(fs?.offset) ? Number(fs.offset) : 0);
    const pes = parsePesPacketSummary(full);
    if (pes && pes.payloadStart < full.length) {
        const end = pes.pesPacketLength > 0 ? Math.min(full.length, pes.pesPacketLength + 6) : full.length;
        payload = full.subarray(pes.payloadStart, end);
        baseOffset += pes.payloadStart;
    }
    if (!(payload instanceof Uint8Array) || payload.length === 0) return { nalus: [], fieldOffsets: [] };
    const annexBDetected = detectAnnexBVideoCodecFromPesPayload(payload) != null;
    const codecHint = codecName.includes("265") || codecName.includes("hevc") || codecName.includes("hev1") || codecName.includes("hvc1")
        ? "h265"
        : "h264";
    if (annexBDetected) {
        if (codecHint === "h264") {
            const annexFieldOffsets = {};
            const annexParsed = parseAnnexBH264NalUnits(payload, 0, annexFieldOffsets, stream?.decoderConfig || null);
            return { nalus: Array.isArray(annexParsed) ? annexParsed : [], fieldOffsets: normalizeFieldOffsets(annexFieldOffsets, baseOffset) };
        }
        if (codecHint === "h265") {
            const annexFieldOffsets = {};
            const annexParsed = parseAnnexBHevcNalUnits(payload, 0, annexFieldOffsets, stream?.decoderConfig || null);
            return { nalus: Array.isArray(annexParsed) ? annexParsed : [], fieldOffsets: normalizeFieldOffsets(annexFieldOffsets, baseOffset) };
        }
        return scanAnnexBNalusFromPayload(payload, codecHint, baseOffset);
    }
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const fieldOffsets = {};
    try {
        if (codecName.includes("264") || codecName.includes("avc")) {
            const lsmo = stream?.decoderConfig?.lengthSizeMinusOne ?? 3;
            const parsed = parseAvcLengthPrefixedNalUnits(dv, 0, payload.length, lsmo, fieldOffsets, stream?.decoderConfig || null);
            return { nalus: Array.isArray(parsed) ? parsed : [], fieldOffsets: normalizeFieldOffsets(fieldOffsets, baseOffset) };
        }
        if (codecName.includes("265") || codecName.includes("hevc") || codecName.includes("hev1") || codecName.includes("hvc1")) {
            const lsmo = stream?.decoderConfig?.lengthSizeMinusOne ?? 3;
            const parsed = parseHevcLengthPrefixedNalUnits(dv, 0, payload.length, lsmo, fieldOffsets, stream?.decoderConfig || null);
            return { nalus: Array.isArray(parsed) ? parsed : [], fieldOffsets: normalizeFieldOffsets(fieldOffsets, baseOffset) };
        }
    } catch {
        // ignore, return empty below
    }
    return { nalus: [], fieldOffsets: [] };
}

export function buildFrameDetailForInspector(frame, result) {
    if (!frame || !frame._rawFrame) return null;
    const rf = frame._rawFrame;
    const fs = rf.formatSpecific || {};
    const primaryBytes = result?.formatSpecific?.fileData || null;
    const streams = Array.isArray(result?.streams) ? result.streams : [];
    const full = pickHexSourceBytesForInspector(rf, primaryBytes);

    let parsedNalus = collectNaluItems(fs);
    const sourceFieldOffsets = normalizeFieldOffsetsAuto(fs.fieldOffsets, rf, fs);
    let parsedFieldOffsets = sourceFieldOffsets;
    if (parsedNalus.length === 0 && rf.mediaType === "video") {
        const reparsed = parseNalusFromFrame(rf, result, primaryBytes, streams);
        if (reparsed.nalus.length > 0) parsedNalus = reparsed.nalus;
        if (reparsed.fieldOffsets.length > 0) parsedFieldOffsets = mergeFieldRows(sourceFieldOffsets, reparsed.fieldOffsets);
    }
    parsedFieldOffsets = mergeFieldRows(
        parsedFieldOffsets,
        buildTsPesFieldOffsets(rf, fs, full),
        buildFlvFieldOffsets(rf, fs),
        buildContainerFieldOffsets(rf, fs),
    );

    const naluItems = parsedNalus.map((n, i) => ({
        index: i,
        nal_unit_type: n.nal_unit_type ?? n._nal_unit_type_value ?? null,
        naluLength: n.naluLength ?? n.totalLength ?? null,
        slice_type: n.slice_type ?? n._slice_type_value ?? null,
        frame_num: n.frame_num ?? null,
        poc: n.pic_order_cnt_lsb ?? n.slice_pic_order_cnt_lsb ?? null,
    }));

    const flvTag = fs.tagType !== undefined || fs.tagTypeName !== undefined
        ? pickKeys(fs, ["tagType", "tagTypeName", "dataSize", "timestamp", "timestampFull", "isExHeader", "packetType", "fourCC", "codecId", "mediaType", "pictureType", "offset", "byteLength"])
        : null;

    const pes = parsePesPacketSummary(full);
    const streamIdNum = Number(fs.stream_id);
    const streamIdHex = Number.isFinite(streamIdNum) ? `0x${streamIdNum.toString(16).toUpperCase().padStart(2, "0")}` : null;
    const range = Array.isArray(fs.packetRange) ? fs.packetRange : null;
    const packetRangeText =
        range && range.length >= 2 && Number.isFinite(Number(range[0])) && Number.isFinite(Number(range[1]))
            ? `${range[0]}..${range[1]}`
            : null;
    const tsPes = fs.pid !== undefined || fs.stream_id !== undefined || fs.PES_packet_length !== undefined
        ? pickKeys(
            {
                pid: fs.pid,
                packet_start_code_prefix: pes ? "0x000001" : undefined,
                stream_id: pes?.streamId ?? fs.stream_id,
                stream_id_hex: pes?.streamId != null ? `0x${Number(pes.streamId).toString(16).toUpperCase().padStart(2, "0")}` : streamIdHex,
                PES_packet_length: pes?.pesPacketLength ?? fs.PES_packet_length,
                marker_bits: pes?.markerBits,
                PES_scrambling_control: pes?.PES_scrambling_control,
                PES_priority: pes?.PES_priority,
                data_alignment_indicator: pes?.data_alignment_indicator,
                copyright: pes?.copyright,
                original_or_copy: pes?.original_or_copy,
                PTS_DTS_flags: pes?.PTS_DTS_flags,
                ESCR_flag: pes?.ESCR_flag,
                ES_rate_flag: pes?.ES_rate_flag,
                DSM_trick_mode_flag: pes?.DSM_trick_mode_flag,
                additional_copy_info_flag: pes?.additional_copy_info_flag,
                PES_CRC_flag: pes?.PES_CRC_flag,
                PES_extension_flag: pes?.PES_extension_flag,
                PES_header_data_length: pes?.PES_header_data_length,
                PTS: pes?.PTS ?? (Number.isFinite(rf?.pts) ? rf.pts : undefined),
                PTS_sec: Number.isFinite(pes?.PTS) ? Number((pes.PTS / 90000).toFixed(3)) : (Number.isFinite(rf?.ptsTime) ? Number(rf.ptsTime.toFixed(3)) : undefined),
                payload_size: pes?.payloadSize,
                pesCount: fs.pesCount,
                packetRange: range,
                packetRangeText,
                pictureType: fs.pictureType,
            },
            [
                "pid", "packet_start_code_prefix", "stream_id", "stream_id_hex", "PES_packet_length", "marker_bits",
                "PES_scrambling_control", "PES_priority", "data_alignment_indicator", "copyright", "original_or_copy",
                "PTS_DTS_flags", "ESCR_flag", "ES_rate_flag", "DSM_trick_mode_flag", "additional_copy_info_flag",
                "PES_CRC_flag", "PES_extension_flag", "PES_header_data_length", "PTS", "PTS_sec", "payload_size",
                "pesCount", "packetRange", "packetRangeText", "pictureType",
            ],
        )
        : null;

    return {
        frameIndex: rf.index ?? frame.index ?? null,
        mediaType: rf.mediaType ?? frame._mediaType ?? null,
        codecName: rf.codecName ?? frame._codecFormat ?? null,
        time: pickKeys(rf, ["pts", "dts", "ptsTime", "dtsTime", "timestamp"]),
        naluCount: naluItems.length,
        nalus: naluItems,
        flvTag,
        tsPes,
        fieldOffsets: parsedFieldOffsets,
    };
}

export const frameInspectorModelCodec = Object.freeze({
    pickHexSourceBytesForInspector,
    buildFrameDetailForInspector,
});

