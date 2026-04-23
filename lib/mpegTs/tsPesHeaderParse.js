/**
 * PES 包头解析。
 * 可选 `fieldOffsets`；默认无 `_rawData`。
 */

import Be from "../core/Be.js";

function readPesExtension(t, a) {
    const i = t.readBits(1, "PES_private_data_flag");
    a.PES_private_data_flag = i;
    const r = t.readBits(1, "pack_header_field_flag");
    a.pack_header_field_flag = r;
    const s = t.readBits(1, "program_packet_sequence_counter_flag");
    a.program_packet_sequence_counter_flag = s;
    const c = t.readBits(1, "P_STD_buffer_flag");
    a.P_STD_buffer_flag = c;
    t.readBits(3, "PES_extension_reserved");
    const o = t.readBits(1, "PES_extension_flag_2");
    a.PES_extension_flag_2 = o;
    if (i) {
        const f = new Uint8Array(16);
        for (let m = 0; m < 16; m++) f[m] = t.readBits(8, `PES_private_data[${m}]`);
        a.PES_private_data = f;
    }
    if (r) {
        const f = t.readBits(8, "pack_field_length");
        a.pack_field_length = f;
        for (let m = 0; m < f; m++) t.readBits(8, `pack_header[${m}]`);
    }
    if (s) {
        t.readBits(1, "program_packet_sequence_counter_marker_bit");
        const f = t.readBits(7, "program_packet_sequence_counter");
        t.readBits(1, "MPEG1_MPEG2_identifier_marker_bit");
        const m = t.readBits(1, "MPEG1_MPEG2_identifier");
        const h = t.readBits(6, "original_stuff_length");
        a.program_packet_sequence_counter = f;
        a.MPEG1_MPEG2_identifier = m;
        a.original_stuff_length = h;
    }
    if (c) {
        t.readBits(2, "P_STD_buffer_marker_bits");
        const f = t.readBits(1, "P_STD_buffer_scale");
        const m = t.readBits(13, "P_STD_buffer_size");
        a.P_STD_buffer_scale = f;
        a.P_STD_buffer_size = m;
    }
    if (o) {
        t.readBits(1, "PES_extension_field_marker_bit");
        const f = t.readBits(7, "PES_extension_field_length");
        a.PES_extension_field_length = f;
        for (let m = 0; m < f; m++) t.readBits(8, `PES_extension_field_data[${m}]`);
    }
}

function parsePesOptionalHeader(t, a, i) {
    const r = t.readBits(2, "marker_bits");
    a.marker_bits = r;
    a.PES_scrambling_control = t.readBits(2, "PES_scrambling_control");
    a.PES_priority = t.readBits(1, "PES_priority");
    a.data_alignment_indicator = t.readBits(1, "data_alignment_indicator");
    a.copyright = t.readBits(1, "copyright");
    a.original_or_copy = t.readBits(1, "original_or_copy");
    const h = t.readBits(2, "PTS_DTS_flags");
    a.PTS_DTS_flags = h;
    const g = t.readBits(1, "ESCR_flag");
    a.ESCR_flag = g;
    const v = t.readBits(1, "ES_rate_flag");
    a.ES_rate_flag = v;
    const p = t.readBits(1, "DSM_trick_mode_flag");
    a.DSM_trick_mode_flag = p;
    const S = t.readBits(1, "additional_copy_info_flag");
    a.additional_copy_info_flag = S;
    const b = t.readBits(1, "PES_CRC_flag");
    a.PES_CRC_flag = b;
    const x = t.readBits(1, "PES_extension_flag");
    a.PES_extension_flag = x;
    const T = t.readBits(8, "PES_header_data_length");
    a.PES_header_data_length = T;
    const N = t.getCurrentByteOffset();
    if (h === 2 || h === 3) {
        t.readBits(4, "PTS_marker_1");
        const F = t.readBits(3, "PTS_32_30");
        t.readBits(1, "PTS_marker_bit_1");
        const E = t.readBits(15, "PTS_29_15");
        t.readBits(1, "PTS_marker_bit_2");
        const j = t.readBits(15, "PTS_14_0");
        t.readBits(1, "PTS_marker_bit_3");
        const C = F * 2 ** 30 + E * 2 ** 15 + j;
        a.PTS = C;
        a.PTS_seconds = C / 9e4;
        t.recordCompositeField(
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
    if (h === 3) {
        t.readBits(4, "DTS_marker_1");
        const F = t.readBits(3, "DTS_32_30");
        t.readBits(1, "DTS_marker_bit_1");
        const E = t.readBits(15, "DTS_29_15");
        t.readBits(1, "DTS_marker_bit_2");
        const j = t.readBits(15, "DTS_14_0");
        t.readBits(1, "DTS_marker_bit_3");
        const C = F * 2 ** 30 + E * 2 ** 15 + j;
        a.DTS = C;
        a.DTS_seconds = C / 9e4;
        t.recordCompositeField(
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
    if (g) {
        t.readBits(2, "ESCR_reserved");
        const F = t.readBits(3, "ESCR_base_32_30");
        t.readBits(1, "ESCR_marker_bit_1");
        const E = t.readBits(15, "ESCR_base_29_15");
        t.readBits(1, "ESCR_marker_bit_2");
        const j = t.readBits(15, "ESCR_base_14_0");
        t.readBits(1, "ESCR_marker_bit_3");
        const C = t.readBits(9, "ESCR_extension");
        t.readBits(1, "ESCR_marker_bit_4");
        const B = F * 2 ** 30 + E * 2 ** 15 + j;
        a.ESCR_base = B;
        a.ESCR_extension = C;
        a.ESCR = B * 300 + C;
    }
    if (v) {
        t.readBits(1, "ES_rate_marker_bit_1");
        const F = t.readBits(22, "ES_rate");
        t.readBits(1, "ES_rate_marker_bit_2");
        a.ES_rate = F;
    }
    if (p) {
        const F = t.readBits(3, "trick_mode_control");
        a.trick_mode_control = F;
        if (F === 0) {
            a.field_id = t.readBits(2, "field_id");
            a.intra_slice_refresh = t.readBits(1, "intra_slice_refresh");
            a.frequency_truncation = t.readBits(2, "frequency_truncation");
        } else if (F === 1) {
            a.rep_cntrl = t.readBits(5, "rep_cntrl");
        } else if (F === 2) {
            a.field_id = t.readBits(2, "field_id");
            t.readBits(3, "reserved");
        } else if (F === 3) {
            a.field_id = t.readBits(2, "field_id");
            a.intra_slice_refresh = t.readBits(1, "intra_slice_refresh");
            a.frequency_truncation = t.readBits(2, "frequency_truncation");
        } else if (F === 4) {
            a.rep_cntrl = t.readBits(5, "rep_cntrl");
        } else {
            t.readBits(5, "reserved");
        }
    }
    if (S) {
        t.readBits(1, "additional_copy_info_marker_bit");
        a.additional_copy_info = t.readBits(7, "additional_copy_info");
    }
    if (b) {
        a.previous_PES_packet_CRC = t.readBits(16, "previous_PES_packet_CRC");
    }
    if (x) readPesExtension(t, a);
    const L = t.getCurrentByteOffset() - N;
    const I = T - L;
    if (I > 0) for (let F = 0; F < I; F++) t.readBits(8, `stuffing_byte[${F}]`);
    const O = 9 + T;
    if (O < i.length) {
        a.payload = i.subarray(O);
        a.payloadSize = i.length - O;
    }
}

/**
 * @param {{ payload: Uint8Array; payloadOffset?: number; fieldOffsets?: object|null }} t
 */
export function parsePesPacketFromPayload(t) {
    if (!t?.payload) return null;
    try {
        const a = t.payload;
        const i = t.payloadOffset ?? 0;
        const fo = t.fieldOffsets ?? null;
        if (a.length < 6 || a[0] !== 0 || a[1] !== 0 || a[2] !== 1) return null;
        const r = {};
        const s = new Be(a, 0, i, fo, "");
        r.packet_start_code_prefix = s.readBits(24, "packet_start_code_prefix");
        const o = s.readBits(8, "stream_id");
        r.stream_id = o;
        const f = s.readBits(16, "PES_packet_length");
        r.PES_packet_length = f;
        if ((o >= 192 && o <= 223) || (o >= 224 && o <= 239) || o === 189) {
            if (s.getCurrentByteOffset() + 3 > a.length) return r;
            parsePesOptionalHeader(s, r, a);
        } else if (
            o === 188 ||
            o === 191 ||
            o === 240 ||
            o === 241 ||
            o === 255 ||
            o === 242 ||
            o === 248
        ) {
            const h = s.getCurrentByteOffset();
            r.PES_packet_data_byte = a.subarray(h);
        } else if (o === 190) {
            const h = s.getCurrentByteOffset();
            r.padding_byte = a.subarray(h);
        }
        return r;
    } catch {
        return null;
    }
}

export const tsPesHeaderParseCodec = Object.freeze({
    parsePesPacketFromPayload,
});
