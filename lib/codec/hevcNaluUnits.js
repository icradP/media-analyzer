/** HEVC VPS / SPS / PPS / SEI NAL 解析。 */

import Be from "../core/Be.js";
import {
    removeEmulationPrevention,
    getChromaFormatName,
    getHEVCProfileName,
    getHEVCLevelName,
    getHEVCTierName,
} from "../core/Constants.js";
import { hevcNalUnitTypeShortName, HEVC_SEI_PAYLOAD_TYPE_LABELS } from "./mediaInspectorTrees.js";
import { parseSeiRbspMessageLoop, readSeiRbspTrailingBits } from "./h264Sei.js";
import { parseHevcSpsVuiParameters } from "./hevcVui.js";
import { parseHevcSpsShortTermRefPicSets } from "./hevcSpsShortTermRefPicSets.js";

export function readHevcNalUnitHeader(reader) {
    const forbidden_zero_bit = reader.readBits(1, "forbidden_zero_bit");
    const nal_unit_type = reader.readBits(6, "nal_unit_type");
    const nuh_layer_id = reader.readBits(6, "nuh_layer_id");
    const nuh_temporal_id_plus1 = reader.readBits(3, "nuh_temporal_id_plus1");
    return {
        forbidden_zero_bit,
        nal_unit_type,
        nal_unit_type_name: hevcNalUnitTypeShortName(nal_unit_type),
        nuh_layer_id,
        nuh_temporal_id_plus1,
    };
}

function readHevcProfileTierLevel(reader, c) {
    const T = reader.prefix;
    const pfx = c ? `${c}.profile_tier_level` : "profile_tier_level";
    reader.prefix = pfx;
    const x = {};
    x.general_profile_space = reader.readBits(2, "general_profile_space");
    const N = reader.readBits(1, "general_tier_flag");
    x.general_tier_flag = `${N} (${getHEVCTierName(N)})`;
    x._general_tier_flag_value = N;
    const A = reader.readBits(5, "general_profile_idc");
    x.general_profile_idc = `${A} (${getHEVCProfileName(A)})`;
    x._general_profile_idc_value = A;
    const L = {};
    for (let U = 0; U < 32; U++) {
        L[`flag[${U}]`] = reader.readBits(1, `general_profile_compatibility_flags.flag[${U}]`);
    }
    x.general_profile_compatibility_flags = L;
    let I = 0;
    for (let U = 0; U < 32; U++) I |= L[`flag[${U}]`] << (31 - U);
    x._general_profile_compatibility_flags_raw = `0x${I.toString(16).padStart(8, "0")}`;
    x.general_progressive_source_flag = reader.readBits(1, "general_progressive_source_flag");
    x.general_interlaced_source_flag = reader.readBits(1, "general_interlaced_source_flag");
    x.general_non_packed_constraint_flag = reader.readBits(1, "general_non_packed_constraint_flag");
    x.general_frame_only_constraint_flag = reader.readBits(1, "general_frame_only_constraint_flag");
    x.general_reserved_zero_7bits = reader.readBits(7, "general_reserved_zero_7bits");
    x.general_one_picture_only_constraint_flag = reader.readBits(
        1,
        "general_one_picture_only_constraint_flag",
    );
    reader.startField("general_reserved_zero_35bits");
    const O = reader._readBitsRaw(32);
    const F = reader._readBitsRaw(3);
    reader._finishField();
    x.general_reserved_zero_35bits = `${O.toString(16).padStart(8, "0")}${F.toString(16).padStart(1, "0")}`;
    x.general_inbld_flag = reader.readBits(1, "general_inbld_flag");
    const E = reader.readBits(8, "general_level_idc");
    x.general_level_idc = `${E} (${getHEVCLevelName(E)})`;
    x._general_level_idc_value = E;
    reader.prefix = T;
    return x;
}

function lookupHevcSeiPayloadType(t) {
    return HEVC_SEI_PAYLOAD_TYPE_LABELS[t] ?? null;
}

export function parseHevcVpsNaluPayload(nalu, baseByteOffset = 0, fieldOffsets = {}, vpsIndex = 0) {
    if (!nalu || nalu.length < 2) return {};
    try {
        const s = {};
        const c = typeof vpsIndex === "string" ? vpsIndex : `sequenceHeader.vps[${vpsIndex}]`;
        const o = nalu.slice(0, 2);
        const f = removeEmulationPrevention(nalu.slice(2));
        const m = f.data;
        const h = f.removedPositions;
        const g = new Uint8Array(o.length + m.length);
        g.set(o, 0);
        g.set(m, o.length);
        const v = h.map((U) => U + 2);
        const p = new Be(g, 0, baseByteOffset, fieldOffsets, c, v);
        const S = readHevcNalUnitHeader(p);
        s.forbidden_zero_bit = S.forbidden_zero_bit;
        s.nal_unit_type = `${S.nal_unit_type} (${S.nal_unit_type_name})`;
        s._nal_unit_type_value = S.nal_unit_type;
        s.nuh_layer_id = S.nuh_layer_id;
        s.nuh_temporal_id_plus1 = S.nuh_temporal_id_plus1;
        s.vps_video_parameter_set_id = p.readBits(4, "vps_video_parameter_set_id");
        s.vps_base_layer_internal_flag = p.readBits(1, "vps_base_layer_internal_flag");
        s.vps_base_layer_available_flag = p.readBits(1, "vps_base_layer_available_flag");
        s.vps_max_layers_minus1 = p.readBits(6, "vps_max_layers_minus1");
        const b = p.readBits(3, "vps_max_sub_layers_minus1");
        s.vps_max_sub_layers_minus1 = b;
        s.vps_temporal_id_nesting_flag = p.readBits(1, "vps_temporal_id_nesting_flag");
        s.vps_reserved_0xffff_16bits = p.readBits(16, "vps_reserved_0xffff_16bits");
        s.profile_tier_level = readHevcProfileTierLevel(p, c);
        const j = p.readBits(1, "vps_sub_layer_ordering_info_present_flag");
        s.vps_sub_layer_ordering_info_present_flag = j;
        const C = j ? 0 : b;
        for (let U = C; U <= b; U++) {
            s[`vps_max_dec_pic_buffering_minus1[${U}]`] = p.readUE(`vps_max_dec_pic_buffering_minus1[${U}]`);
            s[`vps_max_num_reorder_pics[${U}]`] = p.readUE(`vps_max_num_reorder_pics[${U}]`);
            s[`vps_max_latency_increase_plus1[${U}]`] = p.readUE(`vps_max_latency_increase_plus1[${U}]`);
        }
        s.vps_max_layer_id = p.readBits(6, "vps_max_layer_id");
        const B = p.readUE("vps_num_layer_sets_minus1");
        s.vps_num_layer_sets_minus1 = B;
        if (B > 0) {
            const U = [];
            const M = s.vps_max_layer_id ?? 0;
            for (let q = 1; q <= B; q++) {
                const D = [];
                for (let z = 0; z <= M; z++) {
                    D.push(p.readBits(1, `layer_id_included_flag[${q}][${z}]`));
                }
                U.push(D);
            }
            s._layer_id_included_flags = U;
        }
        const P = p.readBits(1, "vps_timing_info_present_flag");
        s.vps_timing_info_present_flag = P;
        if (P) {
            s.vps_num_units_in_tick = p.readBits(32, "vps_num_units_in_tick");
            s.vps_time_scale = p.readBits(32, "vps_time_scale");
            const U = p.readBits(1, "vps_poc_proportional_to_timing_flag");
            s.vps_poc_proportional_to_timing_flag = U;
            if (U) {
                s.vps_num_ticks_poc_diff_one_minus1 = p.readUE("vps_num_ticks_poc_diff_one_minus1");
            }
            const M = p.readUE("vps_num_hrd_parameters");
            s.vps_num_hrd_parameters = M;
            if (M > 0) {
                s._hrd_parameters_skipped = `${M} HRD parameter sets (not parsed)`;
            }
        }
        s.vps_extension_flag = p.readBits(1, "vps_extension_flag");
        if (s.vps_extension_flag) {
            s._vps_extension_data = "VPS extension data present (not parsed)";
        }
        s.rbsp_stop_one_bit = p.readBits(1, "rbsp_stop_one_bit");
        let k = 0;
        for (; p.bitPosition % 8 !== 0; ) {
            s[`rbsp_alignment_zero_bit[${k}]`] = p.readBits(1, `rbsp_alignment_zero_bit[${k}]`);
            k++;
        }
        return s;
    } catch {
        return {};
    }
}

export function parseHevcSpsNaluPayload(nalu, baseByteOffset = 0, fieldOffsets = {}, spsIndex = 0) {
    if (!nalu || nalu.length < 2) return {};
    try {
        const s = {};
        const c = typeof spsIndex === "string" ? spsIndex : `sequenceHeader.sps[${spsIndex}]`;
        const o = nalu.slice(0, 2);
        const f = removeEmulationPrevention(nalu.slice(2));
        const m = f.data;
        const h = f.removedPositions;
        const g = new Uint8Array(o.length + m.length);
        g.set(o, 0);
        g.set(m, o.length);
        const v = h.map((se) => se + 2);
        const p = new Be(g, 0, baseByteOffset, fieldOffsets, c, v);
        const S = readHevcNalUnitHeader(p);
        s.forbidden_zero_bit = S.forbidden_zero_bit;
        s.nal_unit_type = `${S.nal_unit_type} (${S.nal_unit_type_name})`;
        s._nal_unit_type_value = S.nal_unit_type;
        s.nuh_layer_id = S.nuh_layer_id;
        s.nuh_temporal_id_plus1 = S.nuh_temporal_id_plus1;
        s.sps_video_parameter_set_id = p.readBits(4, "sps_video_parameter_set_id");
        const b = p.readBits(3, "sps_max_sub_layers_minus1");
        s.sps_max_sub_layers_minus1 = b;
        s.sps_temporal_id_nesting_flag = p.readBits(1, "sps_temporal_id_nesting_flag");
        s.profile_tier_level = readHevcProfileTierLevel(p, c);
        s.sps_seq_parameter_set_id = p.readUE("sps_seq_parameter_set_id");
        const C = p.readUE("chroma_format_idc");
        s.chroma_format_idc = `${C} (${getChromaFormatName(C)})`;
        s._chroma_format_idc_value = C;
        if (C === 3) {
            s.separate_colour_plane_flag = p.readBits(1, "separate_colour_plane_flag");
        }
        const B = p.readUE("pic_width_in_luma_samples");
        const P = p.readUE("pic_height_in_luma_samples");
        const k = p.readBits(1, "conformance_window_flag");
        s.conformance_window_flag = k;
        let U = B;
        let M = P;
        if (k) {
            const se = p.readUE("conf_win_left_offset");
            s.conf_win_left_offset = se;
            const ee = p.readUE("conf_win_right_offset");
            s.conf_win_right_offset = ee;
            const H = p.readUE("conf_win_top_offset");
            s.conf_win_top_offset = H;
            const ie = p.readUE("conf_win_bottom_offset");
            s.conf_win_bottom_offset = ie;
            let oe = 1;
            let pe = 1;
            if (C === 1) {
                oe = 2;
                pe = 2;
            } else if (C === 2) {
                oe = 2;
                pe = 1;
            }
            U = B - (se + ee) * oe;
            M = P - (H + ie) * pe;
        }
        s._actualWidth = U;
        s._actualHeight = M;
        s.pic_width_in_luma_samples = `${B} (actual: ${U})`;
        s.pic_height_in_luma_samples = `${P} (actual: ${M})`;
        s._pic_width_in_luma_samples_value = U;
        s._pic_height_in_luma_samples_value = M;
        const q = p.readUE("bit_depth_luma_minus8");
        const D = q + 8;
        s.bit_depth_luma_minus8 = `${q} (bit_depth: ${D})`;
        s._bit_depth_luma_value = D;
        const z = p.readUE("bit_depth_chroma_minus8");
        const K = z + 8;
        s.bit_depth_chroma_minus8 = `${z} (bit_depth: ${K})`;
        s._bit_depth_chroma_value = K;
        s.log2_max_pic_order_cnt_lsb_minus4 = p.readUE("log2_max_pic_order_cnt_lsb_minus4");
        const V = p.readBits(1, "sps_sub_layer_ordering_info_present_flag");
        s.sps_sub_layer_ordering_info_present_flag = V;
        const X = V ? 0 : b;
        for (let se = X; se <= b; se++) {
            s[`sps_max_dec_pic_buffering_minus1[${se}]`] = p.readUE(`sps_max_dec_pic_buffering_minus1[${se}]`);
            s[`sps_max_num_reorder_pics[${se}]`] = p.readUE(`sps_max_num_reorder_pics[${se}]`);
            s[`sps_max_latency_increase_plus1[${se}]`] = p.readUE(`sps_max_latency_increase_plus1[${se}]`);
        }
        s.log2_min_luma_coding_block_size_minus3 = p.readUE("log2_min_luma_coding_block_size_minus3");
        s.log2_diff_max_min_luma_coding_block_size = p.readUE("log2_diff_max_min_luma_coding_block_size");
        s.log2_min_luma_transform_block_size_minus2 = p.readUE("log2_min_luma_transform_block_size_minus2");
        s.log2_diff_max_min_luma_transform_block_size = p.readUE(
            "log2_diff_max_min_luma_transform_block_size",
        );
        s.max_transform_hierarchy_depth_inter = p.readUE("max_transform_hierarchy_depth_inter");
        s.max_transform_hierarchy_depth_intra = p.readUE("max_transform_hierarchy_depth_intra");
        const te = p.readBits(1, "scaling_list_enabled_flag");
        s.scaling_list_enabled_flag = te;
        if (te) {
            s.sps_scaling_list_data_present_flag = p.readBits(1, "sps_scaling_list_data_present_flag");
        }
        s.amp_enabled_flag = p.readBits(1, "amp_enabled_flag");
        s.sample_adaptive_offset_enabled_flag = p.readBits(1, "sample_adaptive_offset_enabled_flag");
        const W = p.readBits(1, "pcm_enabled_flag");
        s.pcm_enabled_flag = W;
        if (W) {
            s.pcm_sample_bit_depth_luma_minus1 = p.readBits(4, "pcm_sample_bit_depth_luma_minus1");
            s.pcm_sample_bit_depth_chroma_minus1 = p.readBits(4, "pcm_sample_bit_depth_chroma_minus1");
            s.log2_min_pcm_luma_coding_block_size_minus3 = p.readUE(
                "log2_min_pcm_luma_coding_block_size_minus3",
            );
            s.log2_diff_max_min_pcm_luma_coding_block_size = p.readUE(
                "log2_diff_max_min_pcm_luma_coding_block_size",
            );
            s.pcm_loop_filter_disabled_flag = p.readBits(1, "pcm_loop_filter_disabled_flag");
        }
        s.num_short_term_ref_pic_sets = p.readUE("num_short_term_ref_pic_sets");
        const Q = s.num_short_term_ref_pic_sets;
        if (Q > 0) {
            parseHevcSpsShortTermRefPicSets(p, Q, b, s, c);
        }
        const R = p.readBits(1, "long_term_ref_pics_present_flag");
        s.long_term_ref_pics_present_flag = R;
        if (R) {
            s.num_long_term_ref_pics_sps = p.readUE("num_long_term_ref_pics_sps");
        }
        s.sps_temporal_mvp_enabled_flag = p.readBits(1, "sps_temporal_mvp_enabled_flag");
        s.strong_intra_smoothing_enabled_flag = p.readBits(1, "strong_intra_smoothing_enabled_flag");
        const Y = p.readBits(1, "vui_parameters_present_flag");
        s.vui_parameters_present_flag = Y;
        if (Y) {
            s.vui_parameters = parseHevcSpsVuiParameters(p);
        }
        const Z = p.readBits(1, "sps_extension_present_flag");
        s.sps_extension_present_flag = Z;
        if (Z) {
            s.sps_range_extension_flag = p.readBits(1, "sps_range_extension_flag");
            s.sps_multilayer_extension_flag = p.readBits(1, "sps_multilayer_extension_flag");
            s.sps_3d_extension_flag = p.readBits(1, "sps_3d_extension_flag");
            s.sps_scc_extension_flag = p.readBits(1, "sps_scc_extension_flag");
            s.sps_extension_4bits = p.readBits(4, "sps_extension_4bits");
            if (
                s.sps_range_extension_flag ||
                s.sps_multilayer_extension_flag ||
                s.sps_3d_extension_flag ||
                s.sps_scc_extension_flag ||
                s.sps_extension_4bits
            ) {
                s._note = "SPS extension data present but not parsed";
            }
        }
        s.rbsp_stop_one_bit = p.readBits(1, "rbsp_stop_one_bit");
        let ne = 0;
        for (; p.bitPosition % 8 !== 0; ) {
            s[`rbsp_alignment_zero_bit[${ne}]`] = p.readBits(1, `rbsp_alignment_zero_bit[${ne}]`);
            ne++;
        }
        return s;
    } catch {
        return {};
    }
}

export function parseHevcPpsNaluPayload(nalu, baseByteOffset = 0, fieldOffsets = {}, ppsIndex = 0) {
    if (!nalu || nalu.length < 2) return {};
    try {
        const s = {};
        const c = typeof ppsIndex === "string" ? ppsIndex : `sequenceHeader.pps[${ppsIndex}]`;
        const o = nalu.slice(0, 2);
        const f = removeEmulationPrevention(nalu.slice(2));
        const m = f.data;
        const h = f.removedPositions;
        const g = new Uint8Array(o.length + m.length);
        g.set(o, 0);
        g.set(m, o.length);
        const v = h.map((I) => I + 2);
        const p = new Be(g, 0, baseByteOffset, fieldOffsets, c, v);
        const S = readHevcNalUnitHeader(p);
        s.forbidden_zero_bit = S.forbidden_zero_bit;
        s.nal_unit_type = `${S.nal_unit_type} (${S.nal_unit_type_name})`;
        s._nal_unit_type_value = S.nal_unit_type;
        s.nuh_layer_id = S.nuh_layer_id;
        s.nuh_temporal_id_plus1 = S.nuh_temporal_id_plus1;
        s.pps_pic_parameter_set_id = p.readUE("pps_pic_parameter_set_id");
        s.pps_seq_parameter_set_id = p.readUE("pps_seq_parameter_set_id");
        s.dependent_slice_segments_enabled_flag = p.readBits(1, "dependent_slice_segments_enabled_flag");
        s.output_flag_present_flag = p.readBits(1, "output_flag_present_flag");
        s.num_extra_slice_header_bits = p.readBits(3, "num_extra_slice_header_bits");
        s.sign_data_hiding_enabled_flag = p.readBits(1, "sign_data_hiding_enabled_flag");
        s.cabac_init_present_flag = p.readBits(1, "cabac_init_present_flag");
        s.num_ref_idx_l0_default_active_minus1 = p.readUE("num_ref_idx_l0_default_active_minus1");
        s.num_ref_idx_l1_default_active_minus1 = p.readUE("num_ref_idx_l1_default_active_minus1");
        s.init_qp_minus26 = p.readSE("init_qp_minus26");
        s.constrained_intra_pred_flag = p.readBits(1, "constrained_intra_pred_flag");
        s.transform_skip_enabled_flag = p.readBits(1, "transform_skip_enabled_flag");
        const b = p.readBits(1, "cu_qp_delta_enabled_flag");
        s.cu_qp_delta_enabled_flag = b;
        if (b) {
            s.diff_cu_qp_delta_depth = p.readUE("diff_cu_qp_delta_depth");
        }
        s.pps_cb_qp_offset = p.readSE("pps_cb_qp_offset");
        s.pps_cr_qp_offset = p.readSE("pps_cr_qp_offset");
        s.pps_slice_chroma_qp_offsets_present_flag = p.readBits(
            1,
            "pps_slice_chroma_qp_offsets_present_flag",
        );
        s.weighted_pred_flag = p.readBits(1, "weighted_pred_flag");
        s.weighted_bipred_flag = p.readBits(1, "weighted_bipred_flag");
        s.transquant_bypass_enabled_flag = p.readBits(1, "transquant_bypass_enabled_flag");
        const x = p.readBits(1, "tiles_enabled_flag");
        s.tiles_enabled_flag = x;
        s.entropy_coding_sync_enabled_flag = p.readBits(1, "entropy_coding_sync_enabled_flag");
        if (x) {
            s.num_tile_columns_minus1 = p.readUE("num_tile_columns_minus1");
            s.num_tile_rows_minus1 = p.readUE("num_tile_rows_minus1");
            s.uniform_spacing_flag = p.readBits(1, "uniform_spacing_flag");
            s.loop_filter_across_tiles_enabled_flag = p.readBits(1, "loop_filter_across_tiles_enabled_flag");
        }
        s.pps_loop_filter_across_slices_enabled_flag = p.readBits(
            1,
            "pps_loop_filter_across_slices_enabled_flag",
        );
        const T = p.readBits(1, "deblocking_filter_control_present_flag");
        s.deblocking_filter_control_present_flag = T;
        if (T) {
            s.deblocking_filter_override_enabled_flag = p.readBits(1, "deblocking_filter_override_enabled_flag");
            const I = p.readBits(1, "pps_deblocking_filter_disabled_flag");
            s.pps_deblocking_filter_disabled_flag = I;
            if (!I) {
                s.pps_beta_offset_div2 = p.readSE("pps_beta_offset_div2");
                s.pps_tc_offset_div2 = p.readSE("pps_tc_offset_div2");
            }
        }
        s.pps_scaling_list_data_present_flag = p.readBits(1, "pps_scaling_list_data_present_flag");
        s.lists_modification_present_flag = p.readBits(1, "lists_modification_present_flag");
        s.log2_parallel_merge_level_minus2 = p.readUE("log2_parallel_merge_level_minus2");
        s.slice_segment_header_extension_present_flag = p.readBits(
            1,
            "slice_segment_header_extension_present_flag",
        );
        s.pps_extension_present_flag = p.readBits(1, "pps_extension_present_flag");
        s.rbsp_stop_one_bit = p.readBits(1, "rbsp_stop_one_bit");
        let L = 0;
        for (; p.bitPosition % 8 !== 0; ) {
            s[`rbsp_alignment_zero_bit[${L}]`] = p.readBits(1, `rbsp_alignment_zero_bit[${L}]`);
            L++;
        }
        return s;
    } catch {
        return {};
    }
}

export function parseHevcSeiNaluPayload(nalu, baseByteOffset = 0, fieldOffsets = {}, seiIndex = 0) {
    if (!nalu || nalu.length < 2) return {};
    try {
        const s = {};
        const c = typeof seiIndex === "string" ? seiIndex : `sequenceHeader.sei[${seiIndex}]`;
        const o = nalu.slice(0, 2);
        const f = removeEmulationPrevention(nalu.slice(2));
        const m = f.data;
        const h = f.removedPositions;
        const g = new Uint8Array(o.length + m.length);
        g.set(o, 0);
        g.set(m, o.length);
        const v = h.map((T) => T + 2);
        const p = new Be(g, 0, baseByteOffset, fieldOffsets, c, v);
        const S = readHevcNalUnitHeader(p);
        s.forbidden_zero_bit = S.forbidden_zero_bit;
        s.nal_unit_type = `${S.nal_unit_type} (${S.nal_unit_type_name})`;
        s._nal_unit_type_value = S.nal_unit_type;
        s.nuh_layer_id = S.nuh_layer_id;
        s.nuh_temporal_id_plus1 = S.nuh_temporal_id_plus1;
        const b = p.bitPosition;
        if (g.length - Math.floor(b / 8) <= 1) {
            s._note = "SEI data too short or empty";
            return s;
        }
        parseSeiRbspMessageLoop(p, g, s, lookupHevcSeiPayloadType);
        readSeiRbspTrailingBits(p, g, s);
        return s;
    } catch {
        return {};
    }
}

export const hevcNaluUnitsCodec = Object.freeze({
    readHevcNalUnitHeader,
    parseHevcVpsNaluPayload,
    parseHevcSpsNaluPayload,
    parseHevcPpsNaluPayload,
    parseHevcSeiNaluPayload,
});
