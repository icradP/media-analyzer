/** HEVC SPS VUI 参数解析。 */

import Be from "../core/Be.js";

const ASPECT_RATIO_IDC = {
    0: "Unspecified",
    1: "1:1 (Square)",
    2: "12:11",
    3: "10:11",
    4: "16:11",
    5: "40:33",
    6: "24:11",
    7: "20:11",
    8: "32:11",
    9: "80:33",
    10: "18:11",
    11: "15:11",
    12: "64:33",
    13: "160:99",
    14: "4:3",
    15: "3:2",
    16: "2:1",
    255: "Extended_SAR",
};

const VIDEO_FORMAT = {
    0: "Component",
    1: "PAL",
    2: "NTSC",
    3: "SECAM",
    4: "MAC",
    5: "Unspecified",
    6: "Reserved",
    7: "Reserved",
};

const COLOUR_PRIMARIES = {
    1: "BT.709",
    2: "Unspecified",
    4: "BT.470M",
    5: "BT.470BG",
    6: "SMPTE 170M",
    7: "SMPTE 240M",
    8: "FILM",
    9: "BT.2020",
    10: "SMPTE ST 428",
    11: "DCI-P3",
    12: "Display P3",
};

const TRANSFER_CHARACTERISTICS = {
    1: "BT.709",
    4: "BT.470M",
    5: "BT.470BG",
    6: "SMPTE 170M",
    7: "SMPTE 240M",
    8: "Linear",
    9: "Log 100:1",
    10: "Log 316:1",
    11: "IEC 61966-2-4",
    12: "BT.1361",
    13: "IEC 61966-2-1 (sRGB)",
    14: "BT.2020 10-bit",
    15: "BT.2020 12-bit",
    16: "SMPTE ST 2084 (PQ)",
    17: "SMPTE ST 428",
    18: "ARIB STD-B67 (HLG)",
};

const MATRIX_COEFFS = {
    0: "Identity",
    1: "BT.709",
    4: "FCC",
    5: "BT.470BG",
    6: "SMPTE 170M",
    7: "SMPTE 240M",
    8: "YCgCo",
    9: "BT.2020 NCL",
    10: "BT.2020 CL",
    11: "SMPTE ST 2085",
    12: "Chroma NCL",
    13: "Chroma CL",
    14: "ICtCp",
};

/** @param reader Be */
export function parseHevcSpsVuiParameters(reader) {
    const a = {};
    const i = reader.prefix;
    reader.prefix = i ? `${i}.vui_parameters` : "vui_parameters";
    const r = reader.readBits(1, "aspect_ratio_info_present_flag");
    a.aspect_ratio_info_present_flag = r;
    if (r) {
        const v = reader.readBits(8, "aspect_ratio_idc");
        a.aspect_ratio_idc = `${v} (${ASPECT_RATIO_IDC[v] || "Reserved"})`;
        a._aspect_ratio_idc_value = v;
        if (v === 255) {
            a.sar_width = reader.readBits(16, "sar_width");
            a.sar_height = reader.readBits(16, "sar_height");
        }
    }
    const s = reader.readBits(1, "overscan_info_present_flag");
    a.overscan_info_present_flag = s;
    if (s) {
        a.overscan_appropriate_flag = reader.readBits(1, "overscan_appropriate_flag");
    }
    const c = reader.readBits(1, "video_signal_type_present_flag");
    a.video_signal_type_present_flag = c;
    if (c) {
        const v = {};
        const p = reader.prefix;
        reader.prefix = `${p}.video_signal_type`;
        const S = reader.readBits(3, "video_format");
        v.video_format = `${S} (${VIDEO_FORMAT[S] || "Unknown"})`;
        v._video_format_value = S;
        v.video_full_range_flag = reader.readBits(1, "video_full_range_flag");
        const b = reader.readBits(1, "colour_description_present_flag");
        v.colour_description_present_flag = b;
        if (b) {
            const x = {};
            const T = reader.prefix;
            reader.prefix = `${T}.colour_description`;
            const N = reader.readBits(8, "colour_primaries");
            x.colour_primaries = `${N} (${COLOUR_PRIMARIES[N] || "Unspecified"})`;
            x._colour_primaries_value = N;
            const A = reader.readBits(8, "transfer_characteristics");
            x.transfer_characteristics = `${A} (${TRANSFER_CHARACTERISTICS[A] || "Unspecified"})`;
            x._transfer_characteristics_value = A;
            const L = reader.readBits(8, "matrix_coefficients");
            x.matrix_coefficients = `${L} (${MATRIX_COEFFS[L] || "Unknown"})`;
            x._matrix_coefficients_value = L;
            reader.prefix = T;
            v.colour_description = x;
        }
        reader.prefix = p;
        a.video_signal_type = v;
    }
    const o = reader.readBits(1, "chroma_loc_info_present_flag");
    a.chroma_loc_info_present_flag = o;
    if (o) {
        a.chroma_sample_loc_type_top_field = reader.readUE("chroma_sample_loc_type_top_field");
        a.chroma_sample_loc_type_bottom_field = reader.readUE("chroma_sample_loc_type_bottom_field");
    }
    a.neutral_chroma_indication_flag = reader.readBits(1, "neutral_chroma_indication_flag");
    a.field_seq_flag = reader.readBits(1, "field_seq_flag");
    a.frame_field_info_present_flag = reader.readBits(1, "frame_field_info_present_flag");
    const f = reader.readBits(1, "default_display_window_flag");
    a.default_display_window_flag = f;
    if (f) {
        a.def_disp_win_left_offset = reader.readUE("def_disp_win_left_offset");
        a.def_disp_win_right_offset = reader.readUE("def_disp_win_right_offset");
        a.def_disp_win_top_offset = reader.readUE("def_disp_win_top_offset");
        a.def_disp_win_bottom_offset = reader.readUE("def_disp_win_bottom_offset");
    }
    const m = reader.readBits(1, "vui_timing_info_present_flag");
    a.vui_timing_info_present_flag = m;
    if (m) {
        const v = {};
        const p = reader.prefix;
        reader.prefix = `${p}.timing_info`;
        const S = reader.readBits(32, "vui_num_units_in_tick");
        v.vui_num_units_in_tick = S;
        const b = reader.readBits(32, "vui_time_scale");
        v.vui_time_scale = b;
        if (S > 0) {
            v.calculated_frame_rate = `${(b / S).toFixed(3)} fps`;
        }
        const x = reader.readBits(1, "vui_poc_proportional_to_timing_flag");
        v.vui_poc_proportional_to_timing_flag = x;
        if (x) {
            v.vui_num_ticks_poc_diff_one_minus1 = reader.readUE("vui_num_ticks_poc_diff_one_minus1");
        }
        reader.prefix = p;
        a.timing_info = v;
    }
    const h = reader.readBits(1, "vui_hrd_parameters_present_flag");
    a.vui_hrd_parameters_present_flag = h;
    if (h) {
        a._hrd_parameters_note = "HRD parameters present but not parsed";
    }
    const g = reader.readBits(1, "bitstream_restriction_flag");
    a.bitstream_restriction_flag = g;
    if (g) {
        const v = {};
        const p = reader.prefix;
        reader.prefix = `${p}.bitstream_restriction`;
        v.tiles_fixed_structure_flag = reader.readBits(1, "tiles_fixed_structure_flag");
        v.motion_vectors_over_pic_boundaries_flag = reader.readBits(
            1,
            "motion_vectors_over_pic_boundaries_flag",
        );
        v.restricted_ref_pic_lists_flag = reader.readBits(1, "restricted_ref_pic_lists_flag");
        v.min_spatial_segmentation_idc = reader.readUE("min_spatial_segmentation_idc");
        v.max_bytes_per_pic_denom = reader.readUE("max_bytes_per_pic_denom");
        v.max_bits_per_min_cu_denom = reader.readUE("max_bits_per_min_cu_denom");
        v.log2_max_mv_length_horizontal = reader.readUE("log2_max_mv_length_horizontal");
        v.log2_max_mv_length_vertical = reader.readUE("log2_max_mv_length_vertical");
        reader.prefix = p;
        a.bitstream_restriction = v;
    }
    reader.prefix = i;
    return a;
}
