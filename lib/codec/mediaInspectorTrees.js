/**
 * 用于 UI 的字段树与 HEVC 短名表。
 * H.264/H.265 字段树由 Constants、h264Sei 及本文件静态表拼装。
 */

import {
    AVC_PROFILES,
    HEVC_PROFILES,
    SLICE_TYPES,
    getAVCLevelName,
    getHEVCLevelName,
} from "../core/Constants.js";
import { SEI_PAYLOAD_TYPE_NAMES } from "./h264Sei.js";

/** HEVC nal_unit_type 短名 */
export const HEVC_NAL_UNIT_TYPE_SHORT_NAMES = Object.freeze({
    0: "TRAIL_N",
    1: "TRAIL_R",
    2: "TSA_N",
    3: "TSA_R",
    4: "STSA_N",
    5: "STSA_R",
    6: "RADL_N",
    7: "RADL_R",
    8: "RASL_N",
    9: "RASL_R",
    16: "BLA_W_LP",
    17: "BLA_W_RADL",
    18: "BLA_N_LP",
    19: "IDR_W_RADL",
    20: "IDR_N_LP",
    21: "CRA_NUT",
    32: "VPS_NUT",
    33: "SPS_NUT",
    34: "PPS_NUT",
    35: "AUD_NUT",
    36: "EOS_NUT",
    37: "EOB_NUT",
    38: "FD_NUT",
    39: "PREFIX_SEI_NUT",
    40: "SUFFIX_SEI_NUT",
});

/** HEVC SEI payloadType */
export const HEVC_SEI_PAYLOAD_TYPE_LABELS = Object.freeze({
    0: "buffering_period",
    1: "pic_timing",
    2: "pan_scan_rect",
    3: "filler_payload",
    4: "user_data_registered_itu_t_t35",
    5: "user_data_unregistered",
    6: "recovery_point",
    129: "active_parameter_sets",
    132: "decoded_picture_hash",
    137: "mastering_display_colour_volume",
    144: "content_light_level_info",
    147: "alternative_transfer_characteristics",
});

export function hevcNalUnitTypeShortName(type) {
    return HEVC_NAL_UNIT_TYPE_SHORT_NAMES[type] ?? `Reserved (${type})`;
}

function entriesToFieldValues(obj, nameFmt = (t, n) => `${n}`) {
    return Object.entries(obj).map(([t, n]) => ({
        value: String(t),
        name: nameFmt(t, n),
    }));
}

/** H.264 inspector 字段树（profile/slice/level/SEI 来自 Constants + h264Sei） */
export function buildH264InspectorFieldTreeVv() {
    const levelIdcs = [10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62];
    return Object.freeze({
        nal_ref_idc: {
            title: "NAL Reference IDC",
            values: [
                { value: "0", name: "Not used for reference" },
                { value: "1", name: "Low priority reference" },
                { value: "2", name: "High priority reference" },
                { value: "3", name: "Highest priority reference" },
            ],
        },
        nal_unit_type: {
            title: "H.264/AVC NALU Type",
            values: [
                { value: "1", name: "Coded slice of a non-IDR picture" },
                { value: "5", name: "Coded slice of an IDR picture" },
                { value: "6", name: "SEI (Supplemental enhancement information)" },
                { value: "7", name: "SPS (Sequence parameter set)" },
                { value: "8", name: "PPS (Picture parameter set)" },
                { value: "9", name: "Access unit delimiter" },
            ],
        },
        profile_idc: {
            title: "H.264 Profile",
            values: entriesToFieldValues(AVC_PROFILES, (t, n) => `${t} (${n})`),
        },
        slice_type: {
            title: "H.264/AVC Slice Type",
            values: entriesToFieldValues(SLICE_TYPES, (t, n) => `${t} (${n})`),
        },
        field_pic_flag: {
            title: "Field Picture Flag",
            values: [
                { value: "0", name: "Frame coding" },
                { value: "1", name: "Field coding" },
            ],
        },
        bottom_field_flag: {
            title: "Bottom Field Flag",
            values: [
                { value: "0", name: "Top field" },
                { value: "1", name: "Bottom field" },
            ],
        },
        direct_spatial_mv_pred_flag: {
            title: "Direct Spatial MV Prediction",
            values: [
                { value: "0", name: "Temporal prediction" },
                { value: "1", name: "Spatial prediction" },
            ],
        },
        level_idc: {
            title: "H.264 Level",
            values: levelIdcs.map((v) => ({
                value: String(v),
                name: `${v} (${getAVCLevelName(v)})`,
            })),
        },
        payloadType: {
            title: "H.264 SEI Payload Type",
            values: Object.entries(SEI_PAYLOAD_TYPE_NAMES).map(([t, n]) => ({
                value: String(t),
                name: `${t} (${n})`,
            })),
        },
    });
}

/** H.265 inspector 字段树；nal 类型文案在短名基础上补充 tier */
export function buildHevcInspectorFieldTreeWv() {
    const nalValues = Object.entries(HEVC_NAL_UNIT_TYPE_SHORT_NAMES).map(([t, short]) => ({
        value: String(t),
        name: `${short} (${t})`,
    }));
    const hevcLevels = [90, 93, 96, 99, 120, 123, 126, 129, 153, 156, 186].map((v) => ({
        value: String(v),
        name: `${v} (${getHEVCLevelName(v)})`,
    }));
    return Object.freeze({
        nal_unit_type: {
            title: "H.265/HEVC NALU Type",
            values: nalValues,
        },
        general_profile_idc: {
            title: "H.265/HEVC Profile",
            values: entriesToFieldValues(HEVC_PROFILES, (t, n) => `${t} (${n})`),
        },
        general_tier_flag: {
            title: "H.265/HEVC Tier",
            values: [
                { value: "0", name: "Main" },
                { value: "1", name: "High" },
            ],
        },
        general_level_idc: {
            title: "H.265/HEVC Level",
            values: hevcLevels,
        },
        slice_type: {
            title: "H.265/HEVC Slice Type",
            values: [
                { value: "0", name: "B slice" },
                { value: "1", name: "P slice" },
                { value: "2", name: "I slice" },
            ],
        },
        first_slice_segment_in_pic_flag: {
            title: "First Slice Segment in Picture",
            values: [
                { value: "0", name: "Not the first slice segment" },
                { value: "1", name: "First slice segment in picture" },
            ],
        },
        no_output_of_prior_pics_flag: {
            title: "No Output of Prior Pictures",
            values: [
                { value: "0", name: "Output prior pictures normally" },
                { value: "1", name: "Do not output prior pictures" },
            ],
        },
        dependent_slice_segment_flag: {
            title: "Dependent Slice Segment",
            values: [
                { value: "0", name: "Independent slice segment" },
                { value: "1", name: "Dependent slice segment" },
            ],
        },
        pic_output_flag: {
            title: "Picture Output Flag",
            values: [
                { value: "0", name: "Do not output this picture" },
                { value: "1", name: "Output this picture" },
            ],
        },
        colour_plane_id: {
            title: "Colour Plane ID",
            values: [
                { value: "0", name: "Y (Luma)" },
                { value: "1", name: "Cb (Chroma blue)" },
                { value: "2", name: "Cr (Chroma red)" },
            ],
        },
        short_term_ref_pic_set_sps_flag: {
            title: "Short-term Reference Picture Set from SPS",
            values: [
                { value: "0", name: "RPS signaled in slice header" },
                { value: "1", name: "RPS from SPS" },
            ],
        },
        slice_sao_luma_flag: {
            title: "SAO Luma Flag",
            values: [
                { value: "0", name: "SAO disabled for luma" },
                { value: "1", name: "SAO enabled for luma" },
            ],
        },
        slice_sao_chroma_flag: {
            title: "SAO Chroma Flag",
            values: [
                { value: "0", name: "SAO disabled for chroma" },
                { value: "1", name: "SAO enabled for chroma" },
            ],
        },
        slice_temporal_mvp_enabled_flag: {
            title: "Temporal Motion Vector Prediction",
            values: [
                { value: "0", name: "Temporal MVP disabled" },
                { value: "1", name: "Temporal MVP enabled" },
            ],
        },
        ref_pic_list_modification_flag_l0: {
            title: "Ref Pic List Modification Flag L0",
            values: [
                { value: "0", name: "No modification to reference picture list 0" },
                { value: "1", name: "Reference picture list 0 is modified" },
            ],
        },
        ref_pic_list_modification_flag_l1: {
            title: "Ref Pic List Modification Flag L1",
            values: [
                { value: "0", name: "No modification to reference picture list 1" },
                { value: "1", name: "Reference picture list 1 is modified" },
            ],
        },
        mvd_l1_zero_flag: {
            title: "MVD L1 Zero Flag",
            values: [
                { value: "0", name: "L1 motion vector difference can be non-zero" },
                { value: "1", name: "L1 motion vector difference is zero" },
            ],
        },
        cabac_init_flag: {
            title: "CABAC Init Flag",
            values: [
                { value: "0", name: "Use initialization table 0" },
                { value: "1", name: "Use initialization table 1" },
            ],
        },
        collocated_from_l0_flag: {
            title: "Collocated From L0 Flag",
            values: [
                { value: "0", name: "Collocated picture from L1" },
                { value: "1", name: "Collocated picture from L0" },
            ],
        },
        deblocking_filter_override_flag: {
            title: "Deblocking Filter Override Flag",
            values: [
                { value: "0", name: "Use PPS deblocking filter parameters" },
                { value: "1", name: "Override PPS deblocking filter parameters" },
            ],
        },
        slice_deblocking_filter_disabled_flag: {
            title: "Slice Deblocking Filter Disabled",
            values: [
                { value: "0", name: "Deblocking filter enabled" },
                { value: "1", name: "Deblocking filter disabled" },
            ],
        },
        slice_loop_filter_across_slices_enabled_flag: {
            title: "Loop Filter Across Slices",
            values: [
                { value: "0", name: "Loop filter disabled across slices" },
                { value: "1", name: "Loop filter enabled across slices" },
            ],
        },
        alignment_bit_equal_to_one: {
            title: "Alignment Bit (1)",
            values: [{ value: "1", name: "Alignment bit (must be 1)" }],
        },
        alignment_bit_equal_to_zero: {
            title: "Alignment Bit (0)",
            values: [{ value: "0", name: "Alignment bit (must be 0)" }],
        },
        payloadType: {
            title: "SEI Payload Type",
            values: Object.entries(HEVC_SEI_PAYLOAD_TYPE_LABELS).map(([t, n]) => ({
                value: String(t),
                name: `${t} (${n})`,
            })),
        },
    });
}

export const INSPECTOR_FIELD_TREE_PORT = Object.freeze({
    h264Vv: buildH264InspectorFieldTreeVv(),
    hevcWv: buildHevcInspectorFieldTreeWv(),
});

export const mediaInspectorTreesCodec = Object.freeze({
    HEVC_NAL_UNIT_TYPE_SHORT_NAMES,
    HEVC_SEI_PAYLOAD_TYPE_LABELS,
    INSPECTOR_FIELD_TREE_PORT,
    buildH264InspectorFieldTreeVv,
    buildHevcInspectorFieldTreeWv,
    hevcNalUnitTypeShortName,
});
