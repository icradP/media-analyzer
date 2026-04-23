/**
 * H.264 SPS NALU RBSP 解析。
 * 输入为「单条 NAL」：首字节为 NAL header，其后为 RBSP（可含 emulation prevention 三字节序列）。
 */

import Be from "../core/Be.js";
import {
    removeEmulationPrevention,
    getAVCProfileName,
    getAVCLevelName,
    getChromaFormatName,
} from "../core/Constants.js";

export function readH264NalUnitHeader(reader) {
    const forbidden_zero_bit = reader.readBits(1, "forbidden_zero_bit");
    const nal_ref_idc = reader.readBits(2, "nal_ref_idc");
    const nal_unit_type = reader.readBits(5, "nal_unit_type");
    return { forbidden_zero_bit, nal_ref_idc, nal_unit_type };
}

function vuiAspectRatioIdcName(idc) {
    return (
        {
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
        }[idc] || "Reserved"
    );
}

function vuiVideoFormatName(v) {
    return (
        {
            0: "Component",
            1: "PAL",
            2: "NTSC",
            3: "SECAM",
            4: "MAC",
            5: "Unspecified",
            6: "Reserved",
            7: "Reserved",
        }[v] || "Unknown"
    );
}

function vuiColourPrimariesName(v) {
    return (
        {
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
        }[v] || "Unspecified"
    );
}

function vuiTransferCharacteristicsName(v) {
    return (
        {
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
        }[v] || "Unspecified"
    );
}

function vuiMatrixCoefficientsName(v) {
    return (
        {
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
        }[v] || "Unspecified"
    );
}

function parseH264HrdParameters(reader) {
    const a = {};
    const i = reader.readUE("cpb_cnt_minus1");
    a.cpb_cnt_minus1 = i;
    a.bit_rate_scale = reader.readBits(4, "bit_rate_scale");
    a.cpb_size_scale = reader.readBits(4, "cpb_size_scale");
    const r = [];
    for (let s = 0; s <= i; s++) {
        const c = {};
        const o = reader.prefix;
        reader.prefix = `${o}.cpb_specs[${s}]`;
        c.bit_rate_value_minus1 = reader.readUE("bit_rate_value_minus1");
        c.cpb_size_value_minus1 = reader.readUE("cpb_size_value_minus1");
        c.cbr_flag = reader.readBits(1, "cbr_flag");
        reader.prefix = o;
        r.push(c);
    }
    a.cpb_specs = r;
    a.initial_cpb_removal_delay_length_minus1 = reader.readBits(
        5,
        "initial_cpb_removal_delay_length_minus1",
    );
    a.cpb_removal_delay_length_minus1 = reader.readBits(
        5,
        "cpb_removal_delay_length_minus1",
    );
    a.dpb_output_delay_length_minus1 = reader.readBits(5, "dpb_output_delay_length_minus1");
    a.time_offset_length = reader.readBits(5, "time_offset_length");
    return a;
}

function parseH264VuiParameters(reader) {
    const a = {};
    const i = reader.prefix;
    reader.prefix = i ? `${i}.vui_parameters` : "vui_parameters";
    const r = reader.readBits(1, "aspect_ratio_info_present_flag");
    a.aspect_ratio_info_present_flag = r;
    if (r) {
        const v = reader.readBits(8, "aspect_ratio_idc");
        a.aspect_ratio_idc = `${v} (${vuiAspectRatioIdcName(v)})`;
        a._aspect_ratio_idc_value = v;
        if (v === 255) {
            a.sar_width = reader.readBits(16, "sar_width");
            a.sar_height = reader.readBits(16, "sar_height");
        }
    }
    const s = reader.readBits(1, "overscan_info_present_flag");
    a.overscan_info_present_flag = s;
    if (s) {
        const v = {};
        const p = reader.prefix;
        reader.prefix = `${p}.overscan_info`;
        v.overscan_appropriate_flag = reader.readBits(1, "overscan_appropriate_flag");
        reader.prefix = p;
        a.overscan_info = v;
    }
    const c = reader.readBits(1, "video_signal_type_present_flag");
    a.video_signal_type_present_flag = c;
    if (c) {
        const v = {};
        const p = reader.prefix;
        reader.prefix = `${p}.video_signal_type`;
        const S = reader.readBits(3, "video_format");
        v.video_format = `${S} (${vuiVideoFormatName(S)})`;
        v._video_format_value = S;
        v.video_full_range_flag = reader.readBits(1, "video_full_range_flag");
        const b = reader.readBits(1, "colour_description_present_flag");
        v.colour_description_present_flag = b;
        if (b) {
            const x = {};
            const T = reader.prefix;
            reader.prefix = `${T}.colour_description`;
            const N = reader.readBits(8, "colour_primaries");
            x.colour_primaries = `${N} (${vuiColourPrimariesName(N)})`;
            x._colour_primaries_value = N;
            const A = reader.readBits(8, "transfer_characteristics");
            x.transfer_characteristics = `${A} (${vuiTransferCharacteristicsName(A)})`;
            x._transfer_characteristics_value = A;
            const L = reader.readBits(8, "matrix_coefficients");
            x.matrix_coefficients = `${L} (${vuiMatrixCoefficientsName(L)})`;
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
        const v = {};
        const p = reader.prefix;
        reader.prefix = `${p}.chroma_loc_info`;
        v.chroma_sample_loc_type_top_field = reader.readUE("chroma_sample_loc_type_top_field");
        v.chroma_sample_loc_type_bottom_field = reader.readUE("chroma_sample_loc_type_bottom_field");
        reader.prefix = p;
        a.chroma_loc_info = v;
    }
    const f = reader.readBits(1, "timing_info_present_flag");
    a.timing_info_present_flag = f;
    if (f) {
        const v = {};
        const p = reader.prefix;
        reader.prefix = `${p}.timing_info`;
        const S = reader.readBits(32, "num_units_in_tick");
        v.num_units_in_tick = S;
        const b = reader.readBits(32, "time_scale");
        v.time_scale = b;
        v.fixed_frame_rate_flag = reader.readBits(1, "fixed_frame_rate_flag");
        if (S > 0) {
            const x = b / (2 * S);
            v.calculated_frame_rate = `${x.toFixed(3)} fps`;
        }
        reader.prefix = p;
        a.timing_info = v;
    }
    const m = reader.readBits(1, "nal_hrd_parameters_present_flag");
    a.nal_hrd_parameters_present_flag = m;
    if (m) {
        const v = reader.prefix;
        reader.prefix = `${v}.nal_hrd_parameters`;
        a.nal_hrd_parameters = parseH264HrdParameters(reader);
        reader.prefix = v;
    }
    const h = reader.readBits(1, "vcl_hrd_parameters_present_flag");
    a.vcl_hrd_parameters_present_flag = h;
    if (h) {
        const v = reader.prefix;
        reader.prefix = `${v}.vcl_hrd_parameters`;
        a.vcl_hrd_parameters = parseH264HrdParameters(reader);
        reader.prefix = v;
    }
    if (m || h) {
        a.low_delay_hrd_flag = reader.readBits(1, "low_delay_hrd_flag");
    }
    a.pic_struct_present_flag = reader.readBits(1, "pic_struct_present_flag");
    const g = reader.readBits(1, "bitstream_restriction_flag");
    a.bitstream_restriction_flag = g;
    if (g) {
        const v = {};
        const p = reader.prefix;
        reader.prefix = `${p}.bitstream_restriction`;
        v.motion_vectors_over_pic_boundaries_flag = reader.readBits(
            1,
            "motion_vectors_over_pic_boundaries_flag",
        );
        v.max_bytes_per_pic_denom = reader.readUE("max_bytes_per_pic_denom");
        v.max_bits_per_mb_denom = reader.readUE("max_bits_per_mb_denom");
        v.log2_max_mv_length_horizontal = reader.readUE("log2_max_mv_length_horizontal");
        v.log2_max_mv_length_vertical = reader.readUE("log2_max_mv_length_vertical");
        v.max_num_reorder_frames = reader.readUE("max_num_reorder_frames");
        v.max_dec_frame_buffering = reader.readUE("max_dec_frame_buffering");
        reader.prefix = p;
        a.bitstream_restriction = v;
    }
    reader.prefix = i;
    return a;
}

const HIGH_PROFILE_IDS = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134];

/**
 * @param {Uint8Array} nalu — 含 1 字节 NAL header + RBSP
 * @param {number} [baseByteOffset=0] — fieldOffsets 用绝对偏移
 * @param {Record<string, unknown>} [fieldOffsets={}]
 * @param {number|string} [spsIndex=0] — 键名前缀 sequenceHeader.sps[n]
 */
export function parseH264SpsNaluPayload(
    nalu,
    baseByteOffset = 0,
    fieldOffsets = {},
    spsIndex = 0,
) {
    if (!nalu || nalu.length < 4) return {};
    try {
        const s = {};
        const c =
            typeof spsIndex === "string" ? spsIndex : `sequenceHeader.sps[${spsIndex}]`;
        const o = nalu.slice(0, 1);
        const { data: m, removedPositions: h } = removeEmulationPrevention(nalu.slice(1));
        const g = new Uint8Array(o.length + m.length);
        g.set(o, 0);
        g.set(m, o.length);
        const v = h.map((W) => W + 1);
        const p = new Be(g, 0, baseByteOffset, fieldOffsets, c, v);
        const S = readH264NalUnitHeader(p);
        const b = g[0];
        s._nalUnitHeader_byte = b;
        s._nalUnitHeader_binary = b.toString(2).padStart(8, "0");
        s.forbidden_zero_bit = S.forbidden_zero_bit;
        s.nal_ref_idc = S.nal_ref_idc;
        s.nal_unit_type = S.nal_unit_type;
        if (fieldOffsets) {
            fieldOffsets[`${c}._nalUnitHeader_byte`] = { offset: baseByteOffset, length: 1 };
            fieldOffsets[`${c}._nalUnitHeader_binary`] = { offset: baseByteOffset, length: 1 };
        }
        const x = p.readBits(8, "profile_idc");
        s.profile_idc = `${x} (${getAVCProfileName(x)})`;
        s._profile_idc_value = x;
        s.constraint_set0_flag = p.readBits(1, "constraint_set0_flag");
        s.constraint_set1_flag = p.readBits(1, "constraint_set1_flag");
        s.constraint_set2_flag = p.readBits(1, "constraint_set2_flag");
        s.constraint_set3_flag = p.readBits(1, "constraint_set3_flag");
        s.constraint_set4_flag = p.readBits(1, "constraint_set4_flag");
        s.constraint_set5_flag = p.readBits(1, "constraint_set5_flag");
        s.reserved_zero_2bits = p.readBits(2, "reserved_zero_2bits");
        const T = p.readBits(8, "level_idc");
        s.level_idc = `${T} (${getAVCLevelName(T)})`;
        s._level_idc_value = T;
        const N = Math.floor(p.bitPosition / 8);
        const A = p.readUE("seq_parameter_set_id");
        s.seq_parameter_set_id = A;
        if (HIGH_PROFILE_IDS.includes(x)) {
            const W = p.readUE("chroma_format_idc");
            s.chroma_format_idc = `${W} (${getChromaFormatName(W)})`;
            s._chroma_format_idc_value = W;
            if (s._chroma_format_idc_value === 3) {
                s.separate_colour_plane_flag = p.readBits(1, "separate_colour_plane_flag");
            }
            const Q = p.readUE("bit_depth_luma_minus8");
            const R = Q + 8;
            s.bit_depth_luma_minus8 = `${Q} (bit_depth: ${R})`;
            s._bit_depth_luma_value = R;
            const Y = p.readUE("bit_depth_chroma_minus8");
            const Z = Y + 8;
            s.bit_depth_chroma_minus8 = `${Y} (bit_depth: ${Z})`;
            s._bit_depth_chroma_value = Z;
            s.qpprime_y_zero_transform_bypass_flag = p.readBits(
                1,
                "qpprime_y_zero_transform_bypass_flag",
            );
            const ne = p.readBits(1, "seq_scaling_matrix_present_flag");
            s.seq_scaling_matrix_present_flag = ne;
            if (ne) {
                const se = s._chroma_format_idc_value !== 3 ? 8 : 12;
                for (let ee = 0; ee < se; ee++) {
                    const H = p.readBits(1, `seq_scaling_list[${ee}].seq_scaling_list_present_flag`);
                    s[`seq_scaling_list[${ee}]`] = { seq_scaling_list_present_flag: H };
                    if (H) {
                        const ie = ee < 6 ? 16 : 64;
                        const oe = [];
                        let pe = 8;
                        let be = 8;
                        for (let xe = 0; xe < ie; xe++) {
                            if (be !== 0) {
                                const Ce = p.readSE();
                                be = (pe + Ce + 256) % 256;
                            }
                            pe = be === 0 ? pe : be;
                            oe.push(pe);
                        }
                        s[`seq_scaling_list[${ee}]`].scalingList = oe;
                    }
                }
            }
        } else {
            s._chroma_format_idc_value = 1;
            s._bit_depth_luma_value = 8;
        }
        s.log2_max_frame_num_minus4 = p.readUE("log2_max_frame_num_minus4");
        const I = p.readUE("pic_order_cnt_type");
        s.pic_order_cnt_type = I;
        if (I === 0) {
            s.log2_max_pic_order_cnt_lsb_minus4 = p.readUE("log2_max_pic_order_cnt_lsb_minus4");
        } else if (I === 1) {
            s.delta_pic_order_always_zero_flag = p.readBits(
                1,
                "delta_pic_order_always_zero_flag",
            );
            s.offset_for_non_ref_pic = p.readSE("offset_for_non_ref_pic");
            s.offset_for_top_to_bottom_field = p.readSE("offset_for_top_to_bottom_field");
            const W = p.readUE("num_ref_frames_in_pic_order_cnt_cycle");
            s.num_ref_frames_in_pic_order_cnt_cycle = W;
            const Q = [];
            for (let R = 0; R < W; R++) {
                Q.push(p.readSE(`offset_for_ref_frame[${R}]`));
            }
            if (Q.length > 0) s.offset_for_ref_frame = Q;
        }
        s.max_num_ref_frames = p.readUE("max_num_ref_frames");
        s.gaps_in_frame_num_allowed_flag = p.readBits(1, "gaps_in_frame_num_allowed_flag");
        const O = p.readUE("pic_width_in_mbs_minus1");
        const E = (O + 1) * 16;
        s._pic_width_in_mbs_minus1_value = O;
        const j = p.readUE("pic_height_in_map_units_minus1");
        const C = j + 1;
        s._pic_height_in_map_units_minus1_value = j;
        const B = p.readBits(1, "frame_mbs_only_flag");
        s.frame_mbs_only_flag = B;
        const k = C * (B ? 1 : 2) * 16;
        if (!B) {
            s.mb_adaptive_frame_field_flag = p.readBits(1, "mb_adaptive_frame_field_flag");
        }
        s.direct_8x8_inference_flag = p.readBits(1, "direct_8x8_inference_flag");
        const U = p.readBits(1, "frame_cropping_flag");
        s.frame_cropping_flag = U;
        let M = 0;
        let q = 0;
        let D = 0;
        let z = 0;
        if (U) {
            M = p.readUE("frame_crop_left_offset");
            s.frame_crop_left_offset = M;
            q = p.readUE("frame_crop_right_offset");
            s.frame_crop_right_offset = q;
            D = p.readUE("frame_crop_top_offset");
            s.frame_crop_top_offset = D;
            z = p.readUE("frame_crop_bottom_offset");
            s.frame_crop_bottom_offset = z;
            const W = s._chroma_format_idc_value !== void 0 ? s._chroma_format_idc_value : 1;
            let Q = 2;
            let R = 2;
            if (W === 1) {
                Q = 2;
                R = 2;
            } else if (W === 2) {
                Q = 2;
                R = 1;
            } else if (W === 3) {
                Q = 1;
                R = 1;
            }
            const Y = Q;
            const Z = R * (B ? 1 : 2);
            const ne = E - (M + q) * Y;
            const se = k - (D + z) * Z;
            s._actualWidth = ne;
            s._actualHeight = se;
            s.pic_width_in_mbs_minus1 = `${O} (actual: ${ne})`;
            s.pic_height_in_map_units_minus1 = `${j} (actual: ${se})`;
        } else {
            s._actualWidth = E;
            s._actualHeight = k;
            s.pic_width_in_mbs_minus1 = `${O} (actual: ${E})`;
            s.pic_height_in_map_units_minus1 = `${j} (actual: ${k})`;
        }
        const K = p.readBits(1, "vui_parameters_present_flag");
        s.vui_parameters_present_flag = K;
        if (K) {
            s.vui_parameters = parseH264VuiParameters(p);
        }
        const X = Math.ceil(p.bitPosition / 8) - N;
        if (fieldOffsets && X > 0) {
            const W = { offset: baseByteOffset + N, length: X };
            const Q = (R, Y) => {
                Object.keys(R).forEach((Z) => {
                    if (!Z.startsWith("_")) {
                        const ne = `${Y}.${Z}`;
                        if (!fieldOffsets[ne]) fieldOffsets[ne] = W;
                        const se = R[Z];
                        if (typeof se === "object" && se !== null && !Array.isArray(se)) {
                            Q(se, ne);
                        }
                    }
                });
            };
            Object.keys(s).forEach((R) => {
                if (
                    !R.startsWith("_") &&
                    R !== "forbidden_zero_bit" &&
                    R !== "nal_ref_idc" &&
                    R !== "nal_unit_type" &&
                    R !== "profile_idc" &&
                    R !== "level_idc" &&
                    !R.includes("constraint_set") &&
                    R !== "reserved_zero_2bits"
                ) {
                    const Y = `${c}.${R}`;
                    if (!fieldOffsets[Y]) fieldOffsets[Y] = W;
                    const Z = s[R];
                    if (typeof Z === "object" && Z !== null && !Array.isArray(Z)) {
                        Q(Z, Y);
                    }
                }
            });
        }
        s.rbsp_stop_one_bit = p.readBits(1, "rbsp_stop_one_bit");
        let te = 0;
        for (; p.bitPosition % 8 !== 0; ) {
            const W = p.readBits(1, `rbsp_alignment_zero_bit[${te}]`);
            s[`rbsp_alignment_zero_bit[${te}]`] = W;
            te++;
        }
        return s;
    } catch {
        return {};
    }
}

export const h264SpsCodec = Object.freeze({
    parseH264SpsNaluPayload,
    readH264NalUnitHeader,
});
