/** H.264 slice_header（NAL type 1 / 5）解析。 */

import Be from "../core/Be.js";
import { removeEmulationPrevention, getSliceTypeName } from "../core/Constants.js";
import { readH264NalUnitHeader } from "./h264Sps.js";

/**
 * @param {Uint8Array} nalu — 完整 NAL（含 1 字节 header + RBSP，RBSP 可含 EPB）
 * @param {Record<string, unknown>} [fieldOffsets={}]
 * @param {number|string} [naluIndex=0] — 用于 field 前缀：`nalu[n]` 或自定义字符串
 * @param {number} [baseByteOffset=0]
 * @param {Record<string, unknown>|null} [sps=null]
 * @param {Record<string, unknown>|null} [pps=null]
 */
export function parseH264SliceNaluPayload(
    nalu,
    fieldOffsets = {},
    naluIndex = 0,
    baseByteOffset = 0,
    sps = null,
    pps = null,
) {
    const o = {};
    const f = typeof naluIndex === "string" ? naluIndex : `nalu[${naluIndex}]`;
    try {
        const m = nalu.slice(0, 1);
        const h = new Be(m, 0, 0, null, "");
        const g = readH264NalUnitHeader(h);
        const v = g.nal_ref_idc;
        const p = g.nal_unit_type;
        const b = (typeof p === "number" ? p : 0) === 5;
        const x = removeEmulationPrevention(nalu.slice(1));
        const T = x.data;
        const N = x.removedPositions;
        const A = new Uint8Array(m.length + T.length);
        A.set(m, 0);
        A.set(T, m.length);
        const L = N.map((Q) => Q + 1);
        const I = new Be(A, 1, baseByteOffset, fieldOffsets, f, L);
        o.first_mb_in_slice = I.readUE("first_mb_in_slice");
        const O = I.readUE("slice_type");
        o.slice_type = `${O} (${getSliceTypeName(O)})`;
        o._slice_type_value = O;
        o.pic_parameter_set_id = I.readUE("pic_parameter_set_id");
        if (!sps) {
            o._needsReparse = true;
            o._parseIncomplete =
                "Missing SPS info, fields after pic_parameter_set_id not parsed";
            return o;
        }
        const s = sps;
        const c = pps;
        const F = s.log2_max_frame_num_minus4 ?? 0;
        const E = s.pic_order_cnt_type ?? 0;
        const j = s.log2_max_pic_order_cnt_lsb_minus4 ?? 0;
        const C = s.frame_mbs_only_flag ?? 1;
        const B = s.separate_colour_plane_flag ?? 0;
        const P = s.delta_pic_order_always_zero_flag ?? 0;
        const k = c?._entropy_coding_mode_flag_value ?? 0;
        const U = c?.bottom_field_pic_order_in_frame_present_flag ?? 0;
        const M = c?.redundant_pic_cnt_present_flag ?? 0;
        const q = c?.deblocking_filter_control_present_flag ?? 1;
        const D = c?.num_slice_groups_minus1 ?? 0;
        const z = c?.weighted_pred_flag ?? 0;
        const K = c?._weighted_bipred_idc_value ?? 0;
        if (B === 1) o.colour_plane_id = I.readBits(2, "colour_plane_id");
        const V = F + 4;
        o.frame_num = I.readBits(V, "frame_num");
        let X = 0;
        if (C === 0) {
            X = I.readBits(1, "field_pic_flag");
            o.field_pic_flag = X;
            if (X === 1) o.bottom_field_flag = I.readBits(1, "bottom_field_flag");
        }
        if (b) o.idr_pic_id = I.readUE("idr_pic_id");
        if (E === 0) {
            const Q = j + 4;
            o.pic_order_cnt_lsb = I.readBits(Q, "pic_order_cnt_lsb");
            if (U === 1 && X === 0) {
                o.delta_pic_order_cnt_bottom = I.readSE("delta_pic_order_cnt_bottom");
            }
        }
        if (E === 1 && P === 0) {
            o.delta_pic_order_cnt_0 = I.readSE("delta_pic_order_cnt_0");
            if (U === 1 && X === 0) {
                o.delta_pic_order_cnt_1 = I.readSE("delta_pic_order_cnt_1");
            }
        }
        if (M === 1) o.redundant_pic_cnt = I.readUE("redundant_pic_cnt");
        const te = O % 5;
        if (te === 1) {
            o.direct_spatial_mv_pred_flag = I.readBits(1, "direct_spatial_mv_pred_flag");
        }
        if (te === 0 || te === 1 || te === 3) {
            const Q = I.readBits(1, "num_ref_idx_active_override_flag");
            o.num_ref_idx_active_override_flag = Q;
            if (Q === 1) {
                o.num_ref_idx_l0_active_minus1 = I.readUE("num_ref_idx_l0_active_minus1");
                if (te === 1) {
                    o.num_ref_idx_l1_active_minus1 = I.readUE("num_ref_idx_l1_active_minus1");
                }
            }
        }
        if (te !== 2 && te !== 4) {
            const Q = I.readBits(1, "ref_pic_list_modification_flag_l0");
            o.ref_pic_list_modification_flag_l0 = Q;
            if (Q === 1) {
                let R;
                let Y = 0;
                do {
                    R = I.readUE(`modification_of_pic_nums_idc[${Y}]`);
                    o[`modification_of_pic_nums_idc[${Y}]`] = R;
                    if (R === 0 || R === 1) {
                        o[`abs_diff_pic_num_minus1[${Y}]`] = I.readUE(
                            `abs_diff_pic_num_minus1[${Y}]`,
                        );
                    } else if (R === 2) {
                        o[`long_term_pic_num[${Y}]`] = I.readUE(`long_term_pic_num[${Y}]`);
                    }
                    Y++;
                } while (R !== 3 && Y < 100);
            }
            if (te === 1) {
                const R = I.readBits(1, "ref_pic_list_modification_flag_l1");
                o.ref_pic_list_modification_flag_l1 = R;
                if (R === 1) {
                    let Y;
                    let Z = 0;
                    do {
                        Y = I.readUE(`modification_of_pic_nums_idc_l1[${Z}]`);
                        o[`modification_of_pic_nums_idc_l1[${Z}]`] = Y;
                        if (Y === 0 || Y === 1) {
                            o[`abs_diff_pic_num_minus1_l1[${Z}]`] = I.readUE(
                                `abs_diff_pic_num_minus1_l1[${Z}]`,
                            );
                        } else if (Y === 2) {
                            o[`long_term_pic_num_l1[${Z}]`] = I.readUE(
                                `long_term_pic_num_l1[${Z}]`,
                            );
                        }
                        Z++;
                    } while (Y !== 3 && Z < 100);
                }
            }
        }
        if ((z === 1 && (te === 0 || te === 3)) || (K === 1 && te === 1)) {
            o.luma_log2_weight_denom = I.readUE("luma_log2_weight_denom");
            const Q = s?._chroma_format_idc_value ?? 1;
            const R = B === 0 && Q !== 0 ? Q : 0;
            if (R !== 0) {
                o.chroma_log2_weight_denom = I.readUE("chroma_log2_weight_denom");
            }
            const Y = o.num_ref_idx_l0_active_minus1;
            const Z =
                Y !== undefined
                    ? Y + 1
                    : (c?.num_ref_idx_l0_default_active_minus1 ?? 0) + 1;
            for (let ne = 0; ne < Z; ne++) {
                const se = I.readBits(1, `luma_weight_l0_flag[${ne}]`);
                o[`luma_weight_l0_flag[${ne}]`] = se;
                if (se === 1) {
                    o[`luma_weight_l0[${ne}]`] = I.readSE(`luma_weight_l0[${ne}]`);
                    o[`luma_offset_l0[${ne}]`] = I.readSE(`luma_offset_l0[${ne}]`);
                }
                if (R !== 0) {
                    const ee = I.readBits(1, `chroma_weight_l0_flag[${ne}]`);
                    o[`chroma_weight_l0_flag[${ne}]`] = ee;
                    if (ee === 1) {
                        for (let H = 0; H < 2; H++) {
                            o[`chroma_weight_l0[${ne}][${H}]`] = I.readSE(
                                `chroma_weight_l0[${ne}][${H}]`,
                            );
                            o[`chroma_offset_l0[${ne}][${H}]`] = I.readSE(
                                `chroma_offset_l0[${ne}][${H}]`,
                            );
                        }
                    }
                }
            }
            if (te === 1) {
                const ne = o.num_ref_idx_l1_active_minus1;
                const se =
                    ne !== undefined
                        ? ne + 1
                        : (c?.num_ref_idx_l1_default_active_minus1 ?? 0) + 1;
                for (let ee = 0; ee < se; ee++) {
                    const H = I.readBits(1, `luma_weight_l1_flag[${ee}]`);
                    o[`luma_weight_l1_flag[${ee}]`] = H;
                    if (H === 1) {
                        o[`luma_weight_l1[${ee}]`] = I.readSE(`luma_weight_l1[${ee}]`);
                        o[`luma_offset_l1[${ee}]`] = I.readSE(`luma_offset_l1[${ee}]`);
                    }
                    if (R !== 0) {
                        const ie = I.readBits(1, `chroma_weight_l1_flag[${ee}]`);
                        o[`chroma_weight_l1_flag[${ee}]`] = ie;
                        if (ie === 1) {
                            for (let oe = 0; oe < 2; oe++) {
                                o[`chroma_weight_l1[${ee}][${oe}]`] = I.readSE(
                                    `chroma_weight_l1[${ee}][${oe}]`,
                                );
                                o[`chroma_offset_l1[${ee}][${oe}]`] = I.readSE(
                                    `chroma_offset_l1[${ee}][${oe}]`,
                                );
                            }
                        }
                    }
                }
            }
        }
        if (v !== 0) {
            if (b) {
                o.no_output_of_prior_pics_flag = I.readBits(1, "no_output_of_prior_pics_flag");
                o.long_term_reference_flag = I.readBits(1, "long_term_reference_flag");
            } else {
                const Q = I.readBits(1, "adaptive_ref_pic_marking_mode_flag");
                o.adaptive_ref_pic_marking_mode_flag = Q;
                if (Q === 1) {
                    let R;
                    let Y = 0;
                    do {
                        R = I.readUE(`memory_management_control_operation[${Y}]`);
                        o[`memory_management_control_operation[${Y}]`] = R;
                        if (R === 1 || R === 3) {
                            o[`difference_of_pic_nums_minus1[${Y}]`] = I.readUE(
                                `difference_of_pic_nums_minus1[${Y}]`,
                            );
                        }
                        if (R === 2) {
                            o[`long_term_pic_num[${Y}]`] = I.readUE(`long_term_pic_num[${Y}]`);
                        }
                        if (R === 3 || R === 6) {
                            o[`long_term_frame_idx[${Y}]`] = I.readUE(
                                `long_term_frame_idx[${Y}]`,
                            );
                        }
                        if (R === 4) {
                            o[`max_long_term_frame_idx_plus1[${Y}]`] = I.readUE(
                                `max_long_term_frame_idx_plus1[${Y}]`,
                            );
                        }
                        Y++;
                    } while (R !== 0 && Y < 100);
                }
            }
        }
        if (k === 1 && te !== 2 && te !== 4) {
            o.cabac_init_idc = I.readUE("cabac_init_idc");
        }
        o.slice_qp_delta = I.readSE("slice_qp_delta");
        if (te === 3 || te === 4) {
            if (te === 3) {
                o.sp_for_switch_flag = I.readBits(1, "sp_for_switch_flag");
            }
            o.slice_qs_delta = I.readSE("slice_qs_delta");
        }
        if (q === 1) {
            const Q = I.readUE("disable_deblocking_filter_idc");
            o.disable_deblocking_filter_idc = Q;
            if (Q !== 1) {
                o.slice_alpha_c0_offset_div2 = I.readSE("slice_alpha_c0_offset_div2");
                o.slice_beta_offset_div2 = I.readSE("slice_beta_offset_div2");
            }
        }
        if (D > 0) {
            const R = c?.slice_groups?.pic_size_in_map_units_minus1 ?? 0;
            const Y = Math.ceil(Math.log2(R + 1));
            if (Y > 0) {
                o.slice_group_change_cycle = I.readBits(Y, "slice_group_change_cycle");
            }
        }
        if (k === 1) {
            let Q = 0;
            for (; I.bitPosition % 8 !== 0; ) {
                o[`cabac_alignment_one_bit[${Q}]`] = I.readBits(
                    1,
                    `cabac_alignment_one_bit[${Q}]`,
                );
                Q++;
            }
        }
    } catch (err) {
        o._parseError = err instanceof Error ? err.message : String(err);
    }
    return o;
}

export const h264SliceCodec = Object.freeze({
    parseH264SliceNaluPayload,
});
