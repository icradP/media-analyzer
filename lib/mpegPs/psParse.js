/** MPEG-PS packet/header parser (data-layer only). */
import Be from "../core/Be.js";
import { streamTypeDisplayName } from "../mpegTs/tsStreamTypes.js";
import {
    classifyPesStreamId,
    detectAnnexBVideoCodecFromPesPayload,
    detectPictureTypeFromPesPayload,
    parsePesPacket,
} from "../mpegTs/tsPesParse.js";
import { bitrateBpsFromBytesAndDuration } from "../core/mediaMath.js";

export const PS_STREAM_IDS = Object.freeze({
    PACK_START: 0xba,
    SYSTEM_HEADER: 0xbb,
    PROGRAM_STREAM_MAP: 0xbc,
    PRIVATE_STREAM_1: 0xbd,
    PADDING_STREAM: 0xbe,
    PRIVATE_STREAM_2: 0xbf,
    AUDIO_START: 0xc0,
    AUDIO_END: 0xdf,
    VIDEO_START: 0xe0,
    VIDEO_END: 0xef,
    ECM: 0xf0,
    EMM: 0xf1,
    DSM_CC: 0xf2,
    ISO_13522: 0xf3,
    H222_1_A: 0xf4,
    H222_1_B: 0xf5,
    H222_1_C: 0xf6,
    H222_1_D: 0xf7,
    H222_1_E: 0xf8,
    ANCILLARY: 0xf9,
    PROGRAM_END: 0xb9,
});

function hasStartCodePrefix(bytes, offset) {
    return (
        offset + 3 < bytes.length &&
        bytes[offset] === 0x00 &&
        bytes[offset + 1] === 0x00 &&
        bytes[offset + 2] === 0x01
    );
}

export function findNextPsStartCode(bytes, offset) {
    for (let i = Math.max(0, offset); i + 3 < bytes.length; i++) {
        if (hasStartCodePrefix(bytes, i)) {
            return { offset: i, streamId: bytes[i + 3] };
        }
    }
    return null;
}

export function psStreamIdName(streamId) {
    if (streamId >= PS_STREAM_IDS.AUDIO_START && streamId <= PS_STREAM_IDS.AUDIO_END) return "audio";
    if (streamId >= PS_STREAM_IDS.VIDEO_START && streamId <= PS_STREAM_IDS.VIDEO_END) return "video";
    if (streamId === PS_STREAM_IDS.PACK_START) return "packHeader";
    if (streamId === PS_STREAM_IDS.SYSTEM_HEADER) return "systemHeader";
    if (streamId === PS_STREAM_IDS.PROGRAM_STREAM_MAP) return "programStreamMap";
    if (streamId === PS_STREAM_IDS.PROGRAM_END) return "programEnd";
    if (streamId === PS_STREAM_IDS.PRIVATE_STREAM_1) return "privateStream1";
    if (streamId === PS_STREAM_IDS.PRIVATE_STREAM_2) return "privateStream2";
    if (streamId === PS_STREAM_IDS.PADDING_STREAM) return "padding";
    return `stream-0x${streamId.toString(16).padStart(2, "0")}`;
}

export function parsePsPackHeader(bytes, offset, options = {}) {
    if (!hasStartCodePrefix(bytes, offset) || bytes[offset + 3] !== PS_STREAM_IDS.PACK_START) return null;
    const fieldOffsets = options.fieldOffsets ?? null;
    const out = {};
    const r = new Be(bytes, offset, offset, fieldOffsets, "packHeader");
    try {
        out.start_code = r.readBits(32, "start_code");
        const marker2 = r.readBits(2, "marker_bits");
        if (marker2 === 0x01) {
            out.isMPEG2 = true;
            out.marker_bits = marker2;
            out.scr_base_32_30 = r.readBits(3, "scr_base_32_30");
            out.marker_bit_1 = r.readBits(1, "marker_bit_1");
            out.scr_base_29_15 = r.readBits(15, "scr_base_29_15");
            out.marker_bit_2 = r.readBits(1, "marker_bit_2");
            out.scr_base_14_0 = r.readBits(15, "scr_base_14_0");
            out.marker_bit_3 = r.readBits(1, "marker_bit_3");
            out.scr_extension = r.readBits(9, "scr_extension");
            out.marker_bit_4 = r.readBits(1, "marker_bit_4");
            out.program_mux_rate = r.readBits(22, "program_mux_rate");
            out.marker_bits_2 = r.readBits(2, "marker_bits_2");
            out.reserved = r.readBits(5, "reserved");
            out.pack_stuffing_length = r.readBits(3, "pack_stuffing_length");
            const stuffingLen = out.pack_stuffing_length || 0;
            for (let i = 0; i < stuffingLen && r.getCurrentByteOffset() < bytes.length; i++) {
                r.readBits(8, `stuffing_byte[${i}]`);
            }
            out.bitrate = out.program_mux_rate * 50 * 8;
        } else {
            out.isMPEG2 = false;
            out.marker_bits = marker2;
            out.scr_32_30 = r.readBits(3, "scr_32_30");
            out.marker_bit_1 = r.readBits(1, "marker_bit_1");
            out.scr_29_15 = r.readBits(15, "scr_29_15");
            out.marker_bit_2 = r.readBits(1, "marker_bit_2");
            out.scr_14_0 = r.readBits(15, "scr_14_0");
            out.marker_bit_3 = r.readBits(1, "marker_bit_3");
            out.marker_bit_4 = r.readBits(1, "marker_bit_4");
            out.mux_rate = r.readBits(22, "mux_rate");
            out.marker_bit_5 = r.readBits(1, "marker_bit_5");
            out.bitrate = out.mux_rate * 50 * 8;
        }
        const end = r.getCurrentByteOffset();
        out._byteOffset = offset;
        out._byteLength = end - offset;
        if (fieldOffsets) out.fieldOffsets = fieldOffsets;
        return { packHeader: out, nextOffset: end };
    } catch {
        return null;
    }
}

export function parsePsSystemHeader(bytes, offset, options = {}) {
    if (!hasStartCodePrefix(bytes, offset) || bytes[offset + 3] !== PS_STREAM_IDS.SYSTEM_HEADER) return null;
    if (offset + 6 > bytes.length) return null;
    const header_length = ((bytes[offset + 4] << 8) | bytes[offset + 5]) >>> 0;
    const packetSize = 6 + header_length;
    if (offset + packetSize > bytes.length) return null;
    const fieldOffsets = options.fieldOffsets ?? null;
    const out = { streams: [] };
    const r = new Be(bytes, offset, offset, fieldOffsets, "systemHeader");
    try {
        out.start_code = r.readBits(32, "start_code");
        out.header_length = r.readBits(16, "header_length");
        out.marker_bit_1 = r.readBits(1, "marker_bit_1");
        out.rate_bound = r.readBits(22, "rate_bound");
        out.marker_bit_2 = r.readBits(1, "marker_bit_2");
        out.audio_bound = r.readBits(6, "audio_bound");
        out.fixed_flag = r.readBits(1, "fixed_flag");
        out.CSPS_flag = r.readBits(1, "CSPS_flag");
        out.system_audio_lock_flag = r.readBits(1, "system_audio_lock_flag");
        out.system_video_lock_flag = r.readBits(1, "system_video_lock_flag");
        out.marker_bit_3 = r.readBits(1, "marker_bit_3");
        out.video_bound = r.readBits(5, "video_bound");
        out.packet_rate_restriction_flag = r.readBits(1, "packet_rate_restriction_flag");
        out.reserved_bits = r.readBits(7, "reserved_bits");
        const dataEnd = offset + 6 + out.header_length;
        let streamIndex = 0;
        while (r.getCurrentByteOffset() + 3 <= dataEnd) {
            const stream_id = r.readBits(8, `streams[${streamIndex}].stream_id`);
            const marker_bits = r.readBits(2, `streams[${streamIndex}].marker_bits`);
            const buffer_bound_scale = r.readBits(1, `streams[${streamIndex}].buffer_bound_scale`);
            const buffer_size_bound = r.readBits(13, `streams[${streamIndex}].buffer_size_bound`);
            out.streams.push({
                stream_id,
                marker_bits,
                buffer_bound_scale,
                buffer_size_bound,
            });
            streamIndex += 1;
        }
        out.bitrateBound = out.rate_bound * 50 * 8;
        out._byteOffset = offset;
        out._byteLength = packetSize;
        if (fieldOffsets) out.fieldOffsets = fieldOffsets;
        return { systemHeader: out, nextOffset: offset + packetSize };
    } catch {
        return null;
    }
}

export function parsePsProgramStreamMap(bytes, offset, options = {}) {
    if (!hasStartCodePrefix(bytes, offset) || bytes[offset + 3] !== PS_STREAM_IDS.PROGRAM_STREAM_MAP) return null;
    if (offset + 6 > bytes.length) return null;
    const mapLen = ((bytes[offset + 4] << 8) | bytes[offset + 5]) >>> 0;
    const packetSize = 6 + mapLen;
    if (offset + packetSize > bytes.length) return null;
    const fieldOffsets = options.fieldOffsets ?? null;
    const out = { elementary_streams: [] };
    const r = new Be(bytes, offset, offset, fieldOffsets, "psm");
    try {
        out.start_code = r.readBits(32, "start_code");
        out.program_stream_map_length = r.readBits(16, "program_stream_map_length");
        out.current_next_indicator = r.readBits(1, "current_next_indicator");
        out.reserved_1 = r.readBits(2, "reserved_1");
        out.program_stream_map_version = r.readBits(5, "program_stream_map_version");
        out.reserved_2 = r.readBits(7, "reserved_2");
        out.marker_bit = r.readBits(1, "marker_bit");
        out.program_stream_info_length = r.readBits(16, "program_stream_info_length");
        if (out.program_stream_info_length > 0) {
            out.program_stream_info = new Uint8Array(out.program_stream_info_length);
            for (let i = 0; i < out.program_stream_info_length; i++) {
                out.program_stream_info[i] = r.readBits(8, `program_stream_info[${i}]`);
            }
        }
        out.elementary_stream_map_length = r.readBits(16, "elementary_stream_map_length");
        const esEnd = r.getCurrentByteOffset() + out.elementary_stream_map_length;
        let esIndex = 0;
        while (r.getCurrentByteOffset() + 4 <= esEnd) {
            const stream_type = r.readBits(8, `elementary_streams[${esIndex}].stream_type`);
            const elementary_stream_id = r.readBits(8, `elementary_streams[${esIndex}].elementary_stream_id`);
            const elementary_stream_info_length = r.readBits(16, `elementary_streams[${esIndex}].elementary_stream_info_length`);
            const descriptors = new Uint8Array(elementary_stream_info_length);
            for (let i = 0; i < elementary_stream_info_length; i++) {
                descriptors[i] = r.readBits(8, `elementary_streams[${esIndex}].descriptor[${i}]`);
            }
            out.elementary_streams.push({
                stream_type,
                stream_type_name: streamTypeDisplayName(stream_type),
                elementary_stream_id,
                elementary_stream_info_length,
                descriptors,
            });
            esIndex += 1;
        }
        if (r.getCurrentByteOffset() + 4 <= offset + packetSize) {
            out.CRC_32 = r.readBits(32, "CRC_32");
        }
        out._byteOffset = offset;
        out._byteLength = packetSize;
        if (fieldOffsets) out.fieldOffsets = fieldOffsets;
        return { psm: out, nextOffset: offset + packetSize };
    } catch {
        return null;
    }
}

function detectPesPacketLength(bytes, offset) {
    const pesLength = ((bytes[offset + 4] << 8) | bytes[offset + 5]) >>> 0;
    if (pesLength !== 0) return 6 + pesLength;
    const next = findNextPsStartCode(bytes, offset + 6);
    return next ? next.offset - offset : bytes.length - offset;
}

export function parsePsPacketAt(bytes, offset, options = {}) {
    if (!hasStartCodePrefix(bytes, offset) || offset + 4 > bytes.length) return null;
    const streamId = bytes[offset + 3];
    if (streamId === PS_STREAM_IDS.PACK_START) {
        const pack = parsePsPackHeader(bytes, offset, options);
        return pack ? { type: "packHeader", streamId, ...pack } : null;
    }
    if (streamId === PS_STREAM_IDS.SYSTEM_HEADER) {
        const sh = parsePsSystemHeader(bytes, offset, options);
        return sh ? { type: "systemHeader", streamId, ...sh } : null;
    }
    if (streamId === PS_STREAM_IDS.PROGRAM_STREAM_MAP) {
        const psm = parsePsProgramStreamMap(bytes, offset, options);
        return psm ? { type: "programStreamMap", streamId, ...psm } : null;
    }
    if (streamId === PS_STREAM_IDS.PROGRAM_END) {
        return {
            type: "programEnd",
            streamId,
            programEnd: { _byteOffset: offset, _byteLength: 4 },
            nextOffset: offset + 4,
        };
    }
    if (offset + 6 > bytes.length) return null;
    const packetLen = detectPesPacketLength(bytes, offset);
    if (packetLen <= 0 || offset + packetLen > bytes.length) return null;
    const pesBytes = bytes.slice(offset, offset + packetLen);
    const parsedPes = parsePesPacket(
        { payload: pesBytes, payloadOffset: offset },
        { fieldOffsets: options.fieldOffsets ?? null, includeRawPayload: options.includeRawPayload ?? false },
    );
    const classified = classifyPesStreamId(streamId);
    const pesPacket = {
        ...(parsedPes || {}),
        stream_id: streamId,
        streamTypeName: psStreamIdName(streamId),
        mediaType: classified.mediaType,
        codecName: classified.codecName,
        _byteOffset: offset,
        _byteLength: packetLen,
    };
    return { type: "pesPacket", streamId, pesPacket, nextOffset: offset + packetLen };
}

/**
 * Parse PS packets and bridge PES payload to existing tsPes parser.
 */
export function parseMpegPsPackets(bytes, options = {}) {
    const maxPackets = options.maxPackets ?? Number.POSITIVE_INFINITY;
    const includeRawPayload = options.includeRawPayload ?? false;
    const includePacketList = options.includePacketList ?? true;
    const includePesOnly = options.includePesOnly ?? false;
    let cursor = options.startOffset ?? 0;
    const first = findNextPsStartCode(bytes, cursor);
    if (!first) {
        return {
            format: { formatName: "ps", formatLongName: "MPEG Program Stream", detected: false },
            packetCount: 0,
            pesCount: 0,
            packets: [],
            pesPackets: [],
            packHeaders: [],
            systemHeaders: [],
            psms: [],
        };
    }
    cursor = first.offset;
    const packets = [];
    const pesPackets = [];
    const packHeaders = [];
    const systemHeaders = [];
    const psms = [];
    let packetCount = 0;
    let lastPackHeader = null;
    let lastSystemHeader = null;
    let lastPsm = null;
    while (cursor + 3 < bytes.length && packetCount < maxPackets) {
        const next = findNextPsStartCode(bytes, cursor);
        if (!next) break;
        cursor = next.offset;
        const parsed = parsePsPacketAt(bytes, cursor, { includeRawPayload });
        if (!parsed || parsed.nextOffset <= cursor) {
            cursor += 4;
            continue;
        }
        packetCount += 1;
        if (parsed.type === "packHeader" && parsed.packHeader) {
            lastPackHeader = parsed.packHeader;
            packHeaders.push(parsed.packHeader);
        } else if (parsed.type === "systemHeader" && parsed.systemHeader) {
            lastSystemHeader = parsed.systemHeader;
            systemHeaders.push(parsed.systemHeader);
        } else if (parsed.type === "programStreamMap" && parsed.psm) {
            lastPsm = parsed.psm;
            psms.push(parsed.psm);
        } else if (parsed.type === "pesPacket" && parsed.pesPacket) {
            if (lastPackHeader) parsed.pesPacket.packHeader = lastPackHeader;
            if (lastSystemHeader) parsed.pesPacket.systemHeader = lastSystemHeader;
            if (lastPsm) parsed.pesPacket.psm = lastPsm;
            pesPackets.push(parsed.pesPacket);
        }
        if (includePacketList && !includePesOnly) packets.push(parsed);
        cursor = parsed.nextOffset;
    }
    return {
        format: {
            formatName: "ps",
            formatLongName: "MPEG Program Stream",
            detected: true,
            packetCount,
            pesCount: pesPackets.length,
        },
        packetCount,
        pesCount: pesPackets.length,
        packets: includePacketList && !includePesOnly ? packets : [],
        pesPackets,
        packHeaders,
        systemHeaders,
        psms,
    };
}

function codecNameFromPsm(psm, streamId) {
    if (!psm || !Array.isArray(psm.elementary_streams)) return null;
    const hit = psm.elementary_streams.find((s) => s.elementary_stream_id === streamId);
    return hit?.stream_type_name || null;
}

function mergeCodecName(pes, fallbackPsm) {
    if (pes.mediaType === "video" && pes.payload?.length) {
        const codec = detectAnnexBVideoCodecFromPesPayload(pes.payload);
        if (codec === "h264") return "H.264";
        if (codec === "h265") return "H.265";
    }
    const psmCodec = codecNameFromPsm(pes.psm || fallbackPsm, pes.stream_id);
    if (psmCodec) return psmCodec;
    return pes.codecName || null;
}

/**
 * Build stream/frame-level analysis from parsed PS packets.
 * Data-only output: format/streams/frames/formatSpecific.
 */
export function buildMpegPsAnalysisResult(fileBytes, parsedPackets) {
    const pesPackets = parsedPackets?.pesPackets || [];
    const streamStats = new Map();
    let minPts = null;
    let maxPts = null;
    let videoBytes = 0;
    let audioBytes = 0;
    const fallbackPsm = parsedPackets?.psms?.[parsedPackets.psms.length - 1] || null;
    const frames = pesPackets.map((pes, index) => {
        const streamId = pes.stream_id;
        const mediaType = pes.mediaType || "data";
        const codecName = mergeCodecName(pes, fallbackPsm);
        const codecHint = codecName === "H.264" ? "h264" : codecName === "H.265" ? "h265" : null;
        const pictureType =
            mediaType === "video" && pes.payload?.length
                ? detectPictureTypeFromPesPayload(pes.payload, codecHint)
                : null;
        const pts = pes.PTS ?? pes.pts ?? null;
        const dts = pes.DTS ?? pes.dts ?? pts;
        const payloadSize = pes.payloadSize ?? pes.payload?.length ?? pes._byteLength ?? 0;
        if (!streamStats.has(streamId)) {
            streamStats.set(streamId, {
                stream_id: streamId,
                codecType: mediaType,
                codecName,
                count: 0,
                firstPTS: null,
                lastPTS: null,
                bytes: 0,
            });
        }
        const st = streamStats.get(streamId);
        st.count += 1;
        st.bytes += payloadSize;
        if (!st.codecName && codecName) st.codecName = codecName;
        if (pts != null) {
            if (st.firstPTS == null || pts < st.firstPTS) st.firstPTS = pts;
            if (st.lastPTS == null || pts > st.lastPTS) st.lastPTS = pts;
            if (minPts == null || pts < minPts) minPts = pts;
            if (maxPts == null || pts > maxPts) maxPts = pts;
        }
        if (mediaType === "video") videoBytes += payloadSize;
        else if (mediaType === "audio") audioBytes += payloadSize;
        return {
            index,
            streamIndex: -1,
            mediaType,
            codecName: codecName || undefined,
            pts: pts ?? 0,
            ptsTime: pts != null ? pts / 90000 : undefined,
            dts: dts ?? 0,
            dtsTime: dts != null ? dts / 90000 : undefined,
            duration: 0,
            durationTime: 0,
            size: payloadSize,
            offset: pes._byteOffset ?? 0,
            flags: pictureType === "I" ? "K" : "_",
            isKeyframe: pictureType === "I",
            pictureType: pictureType || undefined,
            displayName: `PES #${index}`,
            remark: pes.streamTypeName || "",
            formatSpecific: {
                ...pes,
                pictureType: pictureType || undefined,
            },
        };
    });
    const duration = minPts != null && maxPts != null && maxPts >= minPts ? (maxPts - minPts) / 90000 : 0;
    const streams = [...streamStats.values()].map((s, idx) => {
        const streamDuration =
            s.firstPTS != null && s.lastPTS != null && s.lastPTS >= s.firstPTS
                ? (s.lastPTS - s.firstPTS) / 90000
                : duration;
        const bitrate = streamDuration > 0 ? bitrateBpsFromBytesAndDuration(s.bytes, streamDuration) : 0;
        return {
            index: idx,
            stream_id: s.stream_id,
            codecType: s.codecType,
            codecName: s.codecName,
            duration: streamDuration,
            bitrate,
            frameCount: s.count,
        };
    });
    frames.forEach((f) => {
        const idx = streams.findIndex((s) => s.stream_id === (f.formatSpecific?.stream_id ?? -1));
        f.streamIndex = idx;
    });
    const totalBitrate = duration > 0 ? bitrateBpsFromBytesAndDuration(fileBytes.byteLength, duration) : 0;
    return {
        format: {
            formatName: "ps",
            formatLongName: "MPEG Program Stream",
            duration,
            bitrate: totalBitrate,
            size: fileBytes.byteLength,
        },
        streams,
        frames,
        formatSpecific: {
            packetCount: parsedPackets?.packetCount || 0,
            pesCount: pesPackets.length,
            packHeaders: parsedPackets?.packHeaders || [],
            systemHeaders: parsedPackets?.systemHeaders || [],
            psms: parsedPackets?.psms || [],
            videoBytes,
            audioBytes,
            fileData: fileBytes,
        },
    };
}

/**
 * Parse complete PS buffer into analysis-style object.
 */
export function parseMpegPsForAnalysis(fileBytes, options = {}) {
    const parsed = parseMpegPsPackets(fileBytes, {
        maxPackets: options.maxPackets,
        includeRawPayload: options.includeRawPayload ?? false,
        includePacketList: options.includePacketList ?? false,
    });
    if (!parsed.format?.detected) {
        return {
            format: {
                formatName: "ps",
                formatLongName: "MPEG Program Stream",
                detected: false,
                size: fileBytes.byteLength,
            },
            streams: [],
            frames: [],
            formatSpecific: {
                packetCount: 0,
                pesCount: 0,
                fileData: fileBytes,
            },
        };
    }
    return buildMpegPsAnalysisResult(fileBytes, parsed);
}

export const mpegPsParseCodec = Object.freeze({
    PS_STREAM_IDS,
    findNextPsStartCode,
    psStreamIdName,
    parsePsPackHeader,
    parsePsSystemHeader,
    parsePsProgramStreamMap,
    parsePsPacketAt,
    parseMpegPsPackets,
    buildMpegPsAnalysisResult,
    parseMpegPsForAnalysis,
});
