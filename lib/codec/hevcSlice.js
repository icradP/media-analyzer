/**
 * HEVC slice NAL RBSP 解析。
 * 供 `parseHevcLengthPrefixedNalUnits` 在拿到 SPS/PPS 上下文后调用。
 */

import Be from "../core/Be.js";
import { removeEmulationPrevention } from "../core/Constants.js";
import { readHevcNalUnitHeader } from "./hevcNaluUnits.js";

const HEVC_SLICE_TYPE_NAMES = {
    0: "B (Bi-predictive)",
    1: "P (Predictive)",
    2: "I (Intra)",
    3: "SP slice",
    4: "SI slice",
};

function formatHevcSliceTypeName(sliceType) {
    return HEVC_SLICE_TYPE_NAMES[sliceType] ?? "Unknown";
}

/**
 * @param {Uint8Array} nalu — 含 2 字节 NAL 头 + RBSP（可含 EPB）
 * @param {Record<string, unknown>} [fieldOffsets={}]
 * @param {number|string} [naluIndex=0] — 用于 field 前缀 `nalu[n]`
 * @param {number} [baseByteOffset=0] — RBSP 起始在文件中的字节偏移（NAL 头后第一个字节的绝对偏移期望为 baseByteOffset+2）
 * @param {Record<string, unknown>|null} [spsInfo=null]
 * @param {Record<string, unknown>|null} [ppsInfo=null]
 */
export function parseHevcSliceNaluPayload(
    nalu,
    fieldOffsets = {},
    naluIndex = 0,
    baseByteOffset = 0,
    spsInfo = null,
    ppsInfo = null,
) {
    const out = {};
    const prefix = typeof naluIndex === "string" ? naluIndex : `nalu[${naluIndex}]`;
    try {
        const headerBytes = nalu.slice(0, 2);
        const headerReader = new Be(headerBytes, 0, 0, null, "");
        const nh = readHevcNalUnitHeader(headerReader);
        const nalType = typeof nh.nal_unit_type === "number" ? nh.nal_unit_type : 0;
        const epb = removeEmulationPrevention(nalu.slice(2));
        const rbsp = epb.data;
        const removed = epb.removedPositions.map((k) => k + 2);
        const combined = new Uint8Array(headerBytes.length + rbsp.length);
        combined.set(headerBytes, 0);
        combined.set(rbsp, headerBytes.length);
        const reader = new Be(combined, 2, baseByteOffset, fieldOffsets, prefix, removed);
        const isIDR = nalType === 19 || nalType === 20;
        const isSliceFamily = nalType >= 16 && nalType <= 23;
        const firstSlice = reader.readBits(1, "first_slice_segment_in_pic_flag");
        out.first_slice_segment_in_pic_flag = firstSlice;
        if (isSliceFamily) {
            out.no_output_of_prior_pics_flag = reader.readBits(1, "no_output_of_prior_pics_flag");
        }
        out.slice_pic_parameter_set_id = reader.readUE("slice_pic_parameter_set_id");
        if (!firstSlice && !spsInfo) {
            out._needsReparse = true;
            out._parseIncomplete = "Missing SPS info, slice_segment_address cannot be parsed";
            return out;
        }
        const log2MaxPicOrderCntLsbMinus4 = spsInfo?.log2_max_pic_order_cnt_lsb_minus4 ?? 4;
        const numExtraSliceHeaderBits = ppsInfo?.num_extra_slice_header_bits ?? 0;
        const dependentSliceSegmentsEnabled = ppsInfo?.dependent_slice_segments_enabled_flag ?? 0;
        const outputFlagPresent = ppsInfo?.output_flag_present_flag ?? 0;
        let dependentFlag = 0;
        if (!firstSlice && dependentSliceSegmentsEnabled) {
            dependentFlag = reader.readBits(1, "dependent_slice_segment_flag");
            out.dependent_slice_segment_flag = dependentFlag;
        }
        if (!dependentFlag) {
                if (!firstSlice) {
                    const picW = spsInfo?._pic_width_in_luma_samples_value ?? 1920;
                    const picH = spsInfo?._pic_height_in_luma_samples_value ?? 1080;
                    const addrBits = Math.min(16, Math.ceil(Math.log2((picW * picH) / 256)));
                    if (addrBits > 0) {
                        out.slice_segment_address = reader.readBits(addrBits, "slice_segment_address");
                    }
                }
                for (let u = 0; u < numExtraSliceHeaderBits; u++) {
                    out[`slice_reserved_flag[${u}]`] = reader.readBits(1, `slice_reserved_flag[${u}]`);
                }
                const sliceType = reader.readUE("slice_type");
                out.slice_type = `${sliceType} (${formatHevcSliceTypeName(sliceType)})`;
                out._slice_type_value = sliceType;
                if (outputFlagPresent) {
                    out.pic_output_flag = reader.readBits(1, "pic_output_flag");
                }
                if ((spsInfo?.separate_colour_plane_flag ?? 0) !== 0) {
                    out.colour_plane_id = reader.readBits(2, "colour_plane_id");
                }
                if (!isIDR) {
                    const pocBits = log2MaxPicOrderCntLsbMinus4 + 4;
                    out.slice_pic_order_cnt_lsb = reader.readBits(pocBits, "slice_pic_order_cnt_lsb");
                    const stRpsFlag = reader.readBits(1, "short_term_ref_pic_set_sps_flag");
                    out.short_term_ref_pic_set_sps_flag = stRpsFlag;
                    if (!stRpsFlag) {
                        const numNeg = reader.readUE("num_negative_pics");
                        out.num_negative_pics = numNeg;
                        const numPos = reader.readUE("num_positive_pics");
                        out.num_positive_pics = numPos;
                        for (let ne = 0; ne < numNeg; ne++) {
                            out[`delta_poc_s0_minus1[${ne}]`] = reader.readUE(`delta_poc_s0_minus1[${ne}]`);
                            out[`used_by_curr_pic_s0_flag[${ne}]`] = reader.readBits(
                                1,
                                `used_by_curr_pic_s0_flag[${ne}]`,
                            );
                        }
                        for (let ne = 0; ne < numPos; ne++) {
                            out[`delta_poc_s1_minus1[${ne}]`] = reader.readUE(`delta_poc_s1_minus1[${ne}]`);
                            out[`used_by_curr_pic_s1_flag[${ne}]`] = reader.readBits(
                                1,
                                `used_by_curr_pic_s1_flag[${ne}]`,
                            );
                        }
                    }
                    if (spsInfo?.sps_temporal_mvp_enabled_flag ?? 0) {
                        out.slice_temporal_mvp_enabled_flag = reader.readBits(
                            1,
                            "slice_temporal_mvp_enabled_flag",
                        );
                    }
                }
                if (spsInfo?.sample_adaptive_offset_enabled_flag ?? 0) {
                    out.slice_sao_luma_flag = reader.readBits(1, "slice_sao_luma_flag");
                    if ((spsInfo?.chroma_format_idc ?? 1) !== 0) {
                        out.slice_sao_chroma_flag = reader.readBits(1, "slice_sao_chroma_flag");
                    }
                }
                if (sliceType !== 2) {
                    const numRefIdxOverride = reader.readBits(1, "num_ref_idx_active_override_flag");
                    out.num_ref_idx_active_override_flag = numRefIdxOverride;
                    if (numRefIdxOverride) {
                        out.num_ref_idx_l0_active_minus1 = reader.readUE("num_ref_idx_l0_active_minus1");
                        if (sliceType === 0) {
                            out.num_ref_idx_l1_active_minus1 = reader.readUE(
                                "num_ref_idx_l1_active_minus1",
                            );
                        }
                    }
                    const listsMod = ppsInfo?.lists_modification_present_flag ?? 0;
                    const stRpsSize = (out.num_negative_pics ?? 0) + (out.num_positive_pics ?? 0);
                    if (listsMod && stRpsSize > 1) {
                        const rfl0 = reader.readBits(1, "ref_pic_list_modification_flag_l0");
                        out.ref_pic_list_modification_flag_l0 = rfl0;
                        if (sliceType === 0) {
                            out.ref_pic_list_modification_flag_l1 = reader.readBits(
                                1,
                                "ref_pic_list_modification_flag_l1",
                            );
                        }
                    }
                }
                if (sliceType === 0) {
                    out.mvd_l1_zero_flag = reader.readBits(1, "mvd_l1_zero_flag");
                }
                if (
                    sliceType !== 2 &&
                    (ppsInfo?.cabac_init_present_flag ?? 0) !== 0
                ) {
                    out.cabac_init_flag = reader.readBits(1, "cabac_init_flag");
                }
                if (out.slice_temporal_mvp_enabled_flag) {
                    let collocatedFromL0 = 1;
                    if (sliceType === 0) {
                        collocatedFromL0 = reader.readBits(1, "collocated_from_l0_flag");
                        out.collocated_from_l0_flag = collocatedFromL0;
                    }
                    const nL0 =
                        out.num_ref_idx_l0_active_minus1 ??
                        ppsInfo?.num_ref_idx_l0_default_active_minus1 ??
                        0;
                    const nL1 =
                        out.num_ref_idx_l1_active_minus1 ??
                        ppsInfo?.num_ref_idx_l1_default_active_minus1 ??
                        0;
                    if ((collocatedFromL0 && nL0 > 0) || (!collocatedFromL0 && nL1 > 0)) {
                        out.collocated_ref_idx = reader.readUE("collocated_ref_idx");
                    }
                }
                if (sliceType !== 2) {
                    const wpred = ppsInfo?.weighted_pred_flag ?? 0;
                    const wbipred = ppsInfo?.weighted_bipred_flag ?? 0;
                    if ((wpred && sliceType === 1) || (wbipred && sliceType === 0)) {
                        out.luma_log2_weight_denom = reader.readUE("luma_log2_weight_denom");
                        const cfmt = spsInfo?._chroma_format_idc_value ?? 1;
                        if (cfmt !== 0) {
                            out.delta_chroma_log2_weight_denom = reader.readSE(
                                "delta_chroma_log2_weight_denom",
                            );
                        }
                        const nL0w =
                            out.num_ref_idx_l0_active_minus1 ??
                            ppsInfo?.num_ref_idx_l0_default_active_minus1 ??
                            0;
                        for (let Z = 0; Z <= nL0w; Z++) {
                            const lw = reader.readBits(1, `luma_weight_l0_flag[${Z}]`);
                            out[`luma_weight_l0_flag[${Z}]`] = lw;
                            if (lw) {
                                out[`delta_luma_weight_l0[${Z}]`] = reader.readSE(`delta_luma_weight_l0[${Z}]`);
                                out[`luma_offset_l0[${Z}]`] = reader.readSE(`luma_offset_l0[${Z}]`);
                            }
                        }
                        if (cfmt !== 0) {
                            for (let Z = 0; Z <= nL0w; Z++) {
                                const cw = reader.readBits(1, `chroma_weight_l0_flag[${Z}]`);
                                out[`chroma_weight_l0_flag[${Z}]`] = cw;
                                if (cw) {
                                    for (let se = 0; se < 2; se++) {
                                        out[`delta_chroma_weight_l0[${Z}][${se}]`] = reader.readSE(
                                            `delta_chroma_weight_l0[${Z}][${se}]`,
                                        );
                                        out[`delta_chroma_offset_l0[${Z}][${se}]`] = reader.readSE(
                                            `delta_chroma_offset_l0[${Z}][${se}]`,
                                        );
                                    }
                                }
                            }
                        }
                        if (sliceType === 0) {
                            const nL1w =
                                out.num_ref_idx_l1_active_minus1 ??
                                ppsInfo?.num_ref_idx_l1_default_active_minus1 ??
                                0;
                            for (let ne = 0; ne <= nL1w; ne++) {
                                const lw1 = reader.readBits(1, `luma_weight_l1_flag[${ne}]`);
                                out[`luma_weight_l1_flag[${ne}]`] = lw1;
                                if (lw1) {
                                    out[`delta_luma_weight_l1[${ne}]`] = reader.readSE(
                                        `delta_luma_weight_l1[${ne}]`,
                                    );
                                    out[`luma_offset_l1[${ne}]`] = reader.readSE(`luma_offset_l1[${ne}]`);
                                }
                            }
                            if (cfmt !== 0) {
                                for (let ne = 0; ne <= nL1w; ne++) {
                                    const cw1 = reader.readBits(1, `chroma_weight_l1_flag[${ne}]`);
                                    out[`chroma_weight_l1_flag[${ne}]`] = cw1;
                                    if (cw1) {
                                        for (let ee = 0; ee < 2; ee++) {
                                            out[`delta_chroma_weight_l1[${ne}][${ee}]`] = reader.readSE(
                                                `delta_chroma_weight_l1[${ne}][${ee}]`,
                                            );
                                            out[`delta_chroma_offset_l1[${ne}][${ee}]`] = reader.readSE(
                                                `delta_chroma_offset_l1[${ne}][${ee}]`,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if (sliceType !== 2) {
                    out.five_minus_max_num_merge_cand = reader.readUE("five_minus_max_num_merge_cand");
                }
                out.slice_qp_delta = reader.readSE("slice_qp_delta");
                if (ppsInfo?.pps_slice_chroma_qp_offsets_present_flag ?? 0) {
                    out.slice_cb_qp_offset = reader.readSE("slice_cb_qp_offset");
                    out.slice_cr_qp_offset = reader.readSE("slice_cr_qp_offset");
                }
                if (ppsInfo?.deblocking_filter_override_enabled_flag ?? 0) {
                    const dfo = reader.readBits(1, "deblocking_filter_override_flag");
                    out.deblocking_filter_override_flag = dfo;
                    if (dfo) {
                        const sdf = reader.readBits(1, "slice_deblocking_filter_disabled_flag");
                        out.slice_deblocking_filter_disabled_flag = sdf;
                        if (!sdf) {
                            out.slice_beta_offset_div2 = reader.readSE("slice_beta_offset_div2");
                            out.slice_tc_offset_div2 = reader.readSE("slice_tc_offset_div2");
                        }
                    }
                }
                if (ppsInfo?.pps_loop_filter_across_slices_enabled_flag ?? 0) {
                    out.slice_loop_filter_across_slices_enabled_flag = reader.readBits(
                        1,
                        "slice_loop_filter_across_slices_enabled_flag",
                    );
                }
                const tilesOn = ppsInfo?.tiles_enabled_flag ?? 0;
                const entropySync = ppsInfo?.entropy_coding_sync_enabled_flag ?? 0;
                if (tilesOn || entropySync) {
                    const numEntry = reader.readUE("num_entry_point_offsets");
                    out.num_entry_point_offsets = numEntry;
                    if (numEntry > 0) {
                        const offsetLenM1 = reader.readUE("offset_len_minus1");
                        out.offset_len_minus1 = offsetLenM1;
                        const blen = offsetLenM1 + 1;
                        for (let Y = 0; Y < numEntry; Y++) {
                            out[`entry_point_offset_minus1[${Y}]`] = reader.readBits(
                                blen,
                                `entry_point_offset_minus1[${Y}]`,
                            );
                        }
                    }
                }
                if (ppsInfo?.slice_segment_header_extension_present_flag ?? 0) {
                    const extLen = reader.readUE("slice_segment_header_extension_length");
                    out.slice_segment_header_extension_length = extLen;
                    for (let Q = 0; Q < extLen; Q++) {
                        out[`slice_segment_header_extension_data_byte[${Q}]`] = reader.readBits(
                            8,
                            `slice_segment_header_extension_data_byte[${Q}]`,
                        );
                    }
                }
                if (reader.bitPosition < combined.length * 8) {
                    out.alignment_bit_equal_to_one = reader.readBits(1, "alignment_bit_equal_to_one");
                    let z = 0;
                    while (reader.bitPosition % 8 !== 0 && reader.bitPosition < combined.length * 8) {
                        out[`alignment_bit_equal_to_zero[${z}]`] = reader.readBits(
                            1,
                            `alignment_bit_equal_to_zero[${z}]`,
                        );
                        z++;
                    }
                }
        }
    } catch (err) {
        const e = err;
        console.warn("HEVC slice header parsing incomplete:", e.message);
        out._parseError = e.message;
    }
    return out;
}

export const hevcSliceCodec = Object.freeze({
    parseHevcSliceNaluPayload,
});
