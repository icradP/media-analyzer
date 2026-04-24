/**
 * PES 头解析。
 * 仅做数据层解析；默认不携带 `_rawData` / `_displayMetadata`。
 */

import Be from "../core/Be.js";

/**
 * @param {number} streamId
 * @returns {{ mediaType: "audio"|"video"|null, codecName: string|null }}
 */
export function classifyPesStreamId(streamId) {
    return streamId >= 192 && streamId <= 223
        ? { mediaType: "audio", codecName: "Audio" }
        : streamId >= 224 && streamId <= 239
          ? { mediaType: "video", codecName: "Video" }
          : streamId === 189
            ? { mediaType: "audio", codecName: "Private Audio" }
            : { mediaType: null, codecName: null };
}

/** @param {Uint8Array} payload */
export function detectAnnexBVideoCodecFromPesPayload(payload) {
    if (payload.length < 5) return null;
    let start = -1;
    for (let c = 0; c < payload.length - 4; c++) {
        if (payload[c] === 0 && payload[c + 1] === 0) {
            if (payload[c + 2] === 1) {
                start = c + 3;
                break;
            }
            if (payload[c + 2] === 0 && payload[c + 3] === 1) {
                start = c + 4;
                break;
            }
        }
    }
    if (start < 0 || start >= payload.length) return null;
    const first = payload[start];
    if (((first >> 7) & 1) !== 0) return null;
    const h264Type = first & 31;
    if ((h264Type >= 1 && h264Type <= 12) || (h264Type >= 19 && h264Type <= 21)) {
        return "h264";
    }
    if (start + 1 < payload.length && (payload[start + 1] & 7) >= 1 && ((first >> 1) & 63) <= 40) {
        return "h265";
    }
    return null;
}

function findAnnexBStartCodeOffset(payload, from = 0) {
    for (let i = from; i < payload.length - 3; i++) {
        if (payload[i] === 0x00 && payload[i + 1] === 0x00) {
            if (payload[i + 2] === 0x01) return i + 3;
            if (i + 3 < payload.length && payload[i + 2] === 0x00 && payload[i + 3] === 0x01) return i + 4;
        }
    }
    return -1;
}

function findAnnexBStartCode(payload, from = 0) {
    for (let i = from; i < payload.length - 3; i++) {
        if (payload[i] === 0x00 && payload[i + 1] === 0x00) {
            if (payload[i + 2] === 0x01) return { codeOffset: i, startCodeLength: 3, payloadOffset: i + 3 };
            if (i + 3 < payload.length && payload[i + 2] === 0x00 && payload[i + 3] === 0x01) {
                return { codeOffset: i, startCodeLength: 4, payloadOffset: i + 4 };
            }
        }
    }
    return null;
}

/**
 * 轻量 picture type 推断：优先识别 IDR/CRA 为 I，其余 VCL 归为 P。
 * TS analysis 阶段不做完整 slice 语法解析，避免引入重依赖。
 *
 * @param {Uint8Array} payload
 * @param {"h264"|"h265"|null} codecHint
 * @returns {"I"|"P"|"B"|null}
 */
export function detectPictureTypeFromPesPayload(payload, codecHint = null) {
    if (!payload || payload.length < 5) return null;
    const codec = codecHint || detectAnnexBVideoCodecFromPesPayload(payload);
    let offset = findAnnexBStartCodeOffset(payload, 0);
    while (offset > 0 && offset < payload.length) {
        const b0 = payload[offset];
        if (codec === "h264") {
            const nalType = b0 & 0x1f;
            if (nalType === 5) return "I";
            if (nalType >= 1 && nalType <= 4) return "P";
        } else if (codec === "h265") {
            const nalType = (b0 >> 1) & 0x3f;
            if ([16, 17, 18, 19, 20, 21].includes(nalType)) return "I";
            if (nalType >= 0 && nalType <= 9) return "P";
        }
        offset = findAnnexBStartCodeOffset(payload, offset + 1);
    }
    return null;
}

/**
 * Scan Annex-B payload and produce lightweight NAL items + offset mapping.
 *
 * @param {Uint8Array} payload
 * @param {"h264"|"h265"|null} [codecHint]
 * @param {number} [baseOffset]
 * @returns {{ nalus: Array<object>, fieldOffsets: Array<{field:string,offset:number,length:number}> }}
 */
export function scanAnnexBNalusFromPayload(payload, codecHint = null, baseOffset = 0) {
    const nalus = [];
    const fieldOffsets = [];
    if (!(payload instanceof Uint8Array) || payload.length < 4) return { nalus, fieldOffsets };
    const codec = codecHint || detectAnnexBVideoCodecFromPesPayload(payload) || null;
    let cursor = 0;
    let naluIndex = 0;
    while (cursor < payload.length - 3) {
        const sc = findAnnexBStartCode(payload, cursor);
        if (!sc) break;
        const next = findAnnexBStartCode(payload, sc.payloadOffset);
        const naluStart = sc.payloadOffset;
        const naluEnd = next ? next.codeOffset : payload.length;
        if (naluEnd > naluStart) {
            const naluLen = naluEnd - naluStart;
            const first = payload[naluStart];
            const headerLen = codec === "h265" ? 2 : 1;
            const nalType = codec === "h265" ? ((first >> 1) & 0x3f) : (first & 0x1f);
            nalus.push({
                type: codec || "h264",
                _nal_unit_type_value: nalType,
                naluLength: naluLen,
            });
            fieldOffsets.push({
                field: `annexb.nalu[${naluIndex}].start_code`,
                offset: baseOffset + sc.codeOffset,
                length: sc.startCodeLength,
            });
            fieldOffsets.push({
                field: `annexb.nalu[${naluIndex}].header`,
                offset: baseOffset + naluStart,
                length: Math.min(headerLen, naluLen),
            });
            if (naluLen > headerLen) {
                fieldOffsets.push({
                    field: `annexb.nalu[${naluIndex}].rbsp`,
                    offset: baseOffset + naluStart + headerLen,
                    length: naluLen - headerLen,
                });
            }
            fieldOffsets.push({
                field: `annexb.nalu[${naluIndex}]`,
                offset: baseOffset + naluStart,
                length: naluLen,
            });
            naluIndex += 1;
        }
        cursor = naluEnd;
    }
    return { nalus, fieldOffsets };
}

function parsePesExtension(reader, out) {
    const PES_private_data_flag = reader.readBits(1, "PES_private_data_flag");
    out.PES_private_data_flag = PES_private_data_flag;
    const pack_header_field_flag = reader.readBits(1, "pack_header_field_flag");
    out.pack_header_field_flag = pack_header_field_flag;
    const program_packet_sequence_counter_flag = reader.readBits(1, "program_packet_sequence_counter_flag");
    out.program_packet_sequence_counter_flag = program_packet_sequence_counter_flag;
    const P_STD_buffer_flag = reader.readBits(1, "P_STD_buffer_flag");
    out.P_STD_buffer_flag = P_STD_buffer_flag;
    reader.readBits(3, "PES_extension_reserved");
    const PES_extension_flag_2 = reader.readBits(1, "PES_extension_flag_2");
    out.PES_extension_flag_2 = PES_extension_flag_2;
    if (PES_private_data_flag) {
        const priv = new Uint8Array(16);
        for (let i = 0; i < 16; i++) priv[i] = reader.readBits(8, `PES_private_data[${i}]`);
        out.PES_private_data = priv;
    }
    if (pack_header_field_flag) {
        const pack_field_length = reader.readBits(8, "pack_field_length");
        out.pack_field_length = pack_field_length;
        for (let i = 0; i < pack_field_length; i++) reader.readBits(8, `pack_header[${i}]`);
    }
    if (program_packet_sequence_counter_flag) {
        reader.readBits(1, "program_packet_sequence_counter_marker_bit");
        out.program_packet_sequence_counter = reader.readBits(7, "program_packet_sequence_counter");
        reader.readBits(1, "MPEG1_MPEG2_identifier_marker_bit");
        out.MPEG1_MPEG2_identifier = reader.readBits(1, "MPEG1_MPEG2_identifier");
        out.original_stuff_length = reader.readBits(6, "original_stuff_length");
    }
    if (P_STD_buffer_flag) {
        reader.readBits(2, "P_STD_buffer_marker_bits");
        out.P_STD_buffer_scale = reader.readBits(1, "P_STD_buffer_scale");
        out.P_STD_buffer_size = reader.readBits(13, "P_STD_buffer_size");
    }
    if (PES_extension_flag_2) {
        reader.readBits(1, "PES_extension_field_marker_bit");
        const PES_extension_field_length = reader.readBits(7, "PES_extension_field_length");
        out.PES_extension_field_length = PES_extension_field_length;
        for (let i = 0; i < PES_extension_field_length; i++) {
            reader.readBits(8, `PES_extension_field_data[${i}]`);
        }
    }
}

function parsePesOptionalHeader(reader, out, payload) {
    out.marker_bits = reader.readBits(2, "marker_bits");
    out.PES_scrambling_control = reader.readBits(2, "PES_scrambling_control");
    out.PES_priority = reader.readBits(1, "PES_priority");
    out.data_alignment_indicator = reader.readBits(1, "data_alignment_indicator");
    out.copyright = reader.readBits(1, "copyright");
    out.original_or_copy = reader.readBits(1, "original_or_copy");
    const PTS_DTS_flags = reader.readBits(2, "PTS_DTS_flags");
    out.PTS_DTS_flags = PTS_DTS_flags;
    const ESCR_flag = reader.readBits(1, "ESCR_flag");
    out.ESCR_flag = ESCR_flag;
    const ES_rate_flag = reader.readBits(1, "ES_rate_flag");
    out.ES_rate_flag = ES_rate_flag;
    const DSM_trick_mode_flag = reader.readBits(1, "DSM_trick_mode_flag");
    out.DSM_trick_mode_flag = DSM_trick_mode_flag;
    const additional_copy_info_flag = reader.readBits(1, "additional_copy_info_flag");
    out.additional_copy_info_flag = additional_copy_info_flag;
    const PES_CRC_flag = reader.readBits(1, "PES_CRC_flag");
    out.PES_CRC_flag = PES_CRC_flag;
    const PES_extension_flag = reader.readBits(1, "PES_extension_flag");
    out.PES_extension_flag = PES_extension_flag;
    const PES_header_data_length = reader.readBits(8, "PES_header_data_length");
    out.PES_header_data_length = PES_header_data_length;
    const start = reader.getCurrentByteOffset();

    if (PTS_DTS_flags === 2 || PTS_DTS_flags === 3) {
        reader.readBits(4, "PTS_marker_1");
        const high = reader.readBits(3, "PTS_32_30");
        reader.readBits(1, "PTS_marker_bit_1");
        const mid = reader.readBits(15, "PTS_29_15");
        reader.readBits(1, "PTS_marker_bit_2");
        const low = reader.readBits(15, "PTS_14_0");
        reader.readBits(1, "PTS_marker_bit_3");
        const PTS = high * 2 ** 30 + mid * 2 ** 15 + low;
        out.PTS = PTS;
        out.PTS_seconds = PTS / 90000;
        reader.recordCompositeField(
            "PTS",
            [
                "PTS_marker_1",
                "PTS_32_30",
                "PTS_marker_bit_1",
                "PTS_29_15",
                "PTS_marker_bit_2",
                "PTS_14_0",
                "PTS_marker_bit_3",
            ],
            ["PTS_32_30", "PTS_29_15", "PTS_14_0"],
        );
    }
    if (PTS_DTS_flags === 3) {
        reader.readBits(4, "DTS_marker_1");
        const high = reader.readBits(3, "DTS_32_30");
        reader.readBits(1, "DTS_marker_bit_1");
        const mid = reader.readBits(15, "DTS_29_15");
        reader.readBits(1, "DTS_marker_bit_2");
        const low = reader.readBits(15, "DTS_14_0");
        reader.readBits(1, "DTS_marker_bit_3");
        const DTS = high * 2 ** 30 + mid * 2 ** 15 + low;
        out.DTS = DTS;
        out.DTS_seconds = DTS / 90000;
        reader.recordCompositeField(
            "DTS",
            [
                "DTS_marker_1",
                "DTS_32_30",
                "DTS_marker_bit_1",
                "DTS_29_15",
                "DTS_marker_bit_2",
                "DTS_14_0",
                "DTS_marker_bit_3",
            ],
            ["DTS_32_30", "DTS_29_15", "DTS_14_0"],
        );
    }
    if (ESCR_flag) {
        reader.readBits(2, "ESCR_reserved");
        const high = reader.readBits(3, "ESCR_base_32_30");
        reader.readBits(1, "ESCR_marker_bit_1");
        const mid = reader.readBits(15, "ESCR_base_29_15");
        reader.readBits(1, "ESCR_marker_bit_2");
        const low = reader.readBits(15, "ESCR_base_14_0");
        reader.readBits(1, "ESCR_marker_bit_3");
        const ESCR_extension = reader.readBits(9, "ESCR_extension");
        reader.readBits(1, "ESCR_marker_bit_4");
        const ESCR_base = high * 2 ** 30 + mid * 2 ** 15 + low;
        out.ESCR_base = ESCR_base;
        out.ESCR_extension = ESCR_extension;
        out.ESCR = ESCR_base * 300 + ESCR_extension;
    }
    if (ES_rate_flag) {
        reader.readBits(1, "ES_rate_marker_bit_1");
        out.ES_rate = reader.readBits(22, "ES_rate");
        reader.readBits(1, "ES_rate_marker_bit_2");
    }
    if (DSM_trick_mode_flag) {
        const trick_mode_control = reader.readBits(3, "trick_mode_control");
        out.trick_mode_control = trick_mode_control;
        if (trick_mode_control === 0 || trick_mode_control === 3) {
            out.field_id = reader.readBits(2, "field_id");
            out.intra_slice_refresh = reader.readBits(1, "intra_slice_refresh");
            out.frequency_truncation = reader.readBits(2, "frequency_truncation");
        } else if (trick_mode_control === 1 || trick_mode_control === 4) {
            out.rep_cntrl = reader.readBits(5, "rep_cntrl");
        } else if (trick_mode_control === 2) {
            out.field_id = reader.readBits(2, "field_id");
            reader.readBits(3, "reserved");
        } else {
            reader.readBits(5, "reserved");
        }
    }
    if (additional_copy_info_flag) {
        reader.readBits(1, "additional_copy_info_marker_bit");
        out.additional_copy_info = reader.readBits(7, "additional_copy_info");
    }
    if (PES_CRC_flag) {
        out.previous_PES_packet_CRC = reader.readBits(16, "previous_PES_packet_CRC");
    }
    if (PES_extension_flag) {
        parsePesExtension(reader, out);
    }

    const consumed = reader.getCurrentByteOffset() - start;
    const stuffingCount = PES_header_data_length - consumed;
    if (stuffingCount > 0) {
        for (let i = 0; i < stuffingCount; i++) reader.readBits(8, `stuffing_byte[${i}]`);
    }
    const payloadOffset = 9 + PES_header_data_length;
    if (payloadOffset < payload.length) {
        let payloadLimit = payload.length;
        if (
            out.PES_packet_length != null &&
            out.PES_packet_length > 0 &&
            out.PES_packet_length >= 3 + PES_header_data_length
        ) {
            const declaredPayloadSize = out.PES_packet_length - 3 - PES_header_data_length;
            payloadLimit = Math.min(payload.length, payloadOffset + declaredPayloadSize);
        }
        out.payload = payload.slice(payloadOffset, payloadLimit);
        out.payloadSize = out.payload.length;
    }
}

/**
 * @param {{ payload: Uint8Array, payloadOffset?: number }} packetLike
 * @param {{ fieldOffsets?: object|null, includeRawPayload?: boolean }} [options]
 */
export function parsePesPacket(packetLike, options = {}) {
    if (!packetLike || !packetLike.payload) return null;
    const payload = packetLike.payload;
    const payloadOffset = packetLike.payloadOffset ?? 0;
    if (payload.length < 6 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return null;
    try {
        const out = {};
        const fieldOffsets = options.fieldOffsets ?? null;
        if (fieldOffsets) out.fieldOffsets = fieldOffsets;
        const reader = new Be(payload, 0, payloadOffset, fieldOffsets, "");
        out.packet_start_code_prefix = reader.readBits(24, "packet_start_code_prefix");
        out.stream_id = reader.readBits(8, "stream_id");
        out.PES_packet_length = reader.readBits(16, "PES_packet_length");
        const sid = out.stream_id;
        if ((sid >= 192 && sid <= 223) || (sid >= 224 && sid <= 239) || sid === 189) {
            if (reader.getCurrentByteOffset() + 3 > payload.length) return out;
            parsePesOptionalHeader(reader, out, payload);
        } else if (sid === 188 || sid === 191 || sid === 240 || sid === 241 || sid === 255 || sid === 242 || sid === 248) {
            const start = reader.getCurrentByteOffset();
            out.PES_packet_data_byte = payload.slice(start);
        } else if (sid === 190) {
            const start = reader.getCurrentByteOffset();
            out.padding_byte = payload.slice(start);
        }
        if (options.includeRawPayload) {
            out._rawData = payload;
            out._byteOffset = payloadOffset;
            out._byteLength = payload.length;
        }
        return out;
    } catch {
        return null;
    }
}

/**
 * Normalize parsed PES fields for UI/data-model usage.
 *
 * @param {Uint8Array} payload
 * @returns {object|null}
 */
export function parsePesPacketSummary(payload) {
    if (!(payload instanceof Uint8Array) || payload.length < 6) return null;
    const parsed = parsePesPacket({ payload, payloadOffset: 0 }, { includeRawPayload: false });
    if (!parsed) return null;
    const pesPacketLength = Number.isFinite(parsed?.PES_packet_length) ? Number(parsed.PES_packet_length) : 0;
    const headerDataLength = Number.isFinite(parsed?.PES_header_data_length) ? Number(parsed.PES_header_data_length) : 0;
    const payloadStart = 9 + Math.max(0, headerDataLength);
    const packetTotalSize = pesPacketLength > 0 ? pesPacketLength + 6 : payload.length;
    const payloadSize = Math.max(0, Math.min(payload.length, packetTotalSize) - payloadStart);
    return {
        streamId: parsed.stream_id,
        pesPacketLength,
        markerBits: parsed.marker_bits,
        PES_scrambling_control: parsed.PES_scrambling_control,
        PES_priority: parsed.PES_priority,
        data_alignment_indicator: parsed.data_alignment_indicator,
        copyright: parsed.copyright,
        original_or_copy: parsed.original_or_copy,
        PTS_DTS_flags: parsed.PTS_DTS_flags,
        ESCR_flag: parsed.ESCR_flag,
        ES_rate_flag: parsed.ES_rate_flag,
        DSM_trick_mode_flag: parsed.DSM_trick_mode_flag,
        additional_copy_info_flag: parsed.additional_copy_info_flag,
        PES_CRC_flag: parsed.PES_CRC_flag,
        PES_extension_flag: parsed.PES_extension_flag,
        PES_header_data_length: headerDataLength,
        PTS: parsed.PTS,
        DTS: parsed.DTS,
        payloadStart,
        payloadSize,
    };
}

export const tsPesParseCodec = Object.freeze({
    classifyPesStreamId,
    detectAnnexBVideoCodecFromPesPayload,
    detectPictureTypeFromPesPayload,
    scanAnnexBNalusFromPayload,
    parsePesPacket,
    parsePesPacketSummary,
});
