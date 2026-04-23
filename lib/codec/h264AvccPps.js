/**
 * AVCDecoderConfigurationRecord（avcC）与 H.264 PPS NAL 解析。
 * SPS 子块调用 parseH264SpsNaluPayload。
 */

import Be from "../core/Be.js";
import { removeEmulationPrevention } from "../core/Constants.js";
import { readH264NalUnitHeader, parseH264SpsNaluPayload } from "./h264Sps.js";

function readUint16BE(buffer, byteOffset) {
    return new DataView(buffer, byteOffset, 2).getUint16(0, false);
}

/** RBSP 是否还有多于 trailing bits 的数据（原 xv） */
function hasMoreRbspData(rbspBytes, bitPositionBits) {
    const totalBits = rbspBytes.length * 8;
    if (bitPositionBits >= totalBits) return false;
    let r = rbspBytes.length - 1;
    for (; r >= 0 && rbspBytes[r] === 0; r--);
    if (r < 0) return false;
    const last = rbspBytes[r];
    let c = 0;
    for (let f = 0; f < 8; f++) {
        if ((last & (1 << f)) !== 0) {
            c = f;
            break;
        }
    }
    const lastRbspBit = r * 8 + (7 - c);
    return bitPositionBits < lastRbspBit;
}

/**
 * @param {Uint8Array} nalu — 1 字节 NAL header + PPS RBSP
 * @param {number} [baseByteOffset=0]
 * @param {Record<string, unknown>} [fieldOffsets={}]
 * @param {number|string} [ppsIndex=0]
 */
export function parseH264PpsNaluPayload(
    nalu,
    baseByteOffset = 0,
    fieldOffsets = {},
    ppsIndex = 0,
) {
    if (!nalu || nalu.length < 1) return {};
    try {
        const s = {};
        const c = typeof ppsIndex === "string" ? ppsIndex : `sequenceHeader.pps[${ppsIndex}]`;
        const o = nalu.slice(0, 1);
        const { data: m, removedPositions: h } = removeEmulationPrevention(nalu.slice(1));
        const g = new Uint8Array(o.length + m.length);
        g.set(o, 0);
        g.set(m, o.length);
        const v = h.map((E) => E + 1);
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
        const x = 0;
        s.pic_parameter_set_id = p.readUE("pic_parameter_set_id");
        s.seq_parameter_set_id = p.readUE("seq_parameter_set_id");
        const T = p.readBits(1, "entropy_coding_mode_flag");
        s.entropy_coding_mode_flag = `${T} (${T ? "CABAC" : "CAVLC"})`;
        s._entropy_coding_mode_flag_value = T;
        s.bottom_field_pic_order_in_frame_present_flag = p.readBits(
            1,
            "bottom_field_pic_order_in_frame_present_flag",
        );
        const N = p.readUE("num_slice_groups_minus1");
        s.num_slice_groups_minus1 = N;
        if (N > 0) {
            const E = p.readUE("slice_group_map_type");
            s.slice_group_map_type = E;
            const j = {};
            if (E === 0) {
                const C = [];
                for (let B = 0; B <= N; B++) C.push(p.readUE(`run_length_minus1[${B}]`));
                j.run_length_minus1 = C;
            } else if (E === 2) {
                const C = [];
                const B = [];
                for (let P = 0; P < N; P++) {
                    C.push(p.readUE(`top_left[${P}]`));
                    B.push(p.readUE(`bottom_right[${P}]`));
                }
                j.top_left = C;
                j.bottom_right = B;
            } else if (E === 3 || E === 4 || E === 5) {
                j.slice_group_change_direction_flag = p.readBits(
                    1,
                    "slice_group_change_direction_flag",
                );
                j.slice_group_change_rate_minus1 = p.readUE("slice_group_change_rate_minus1");
            } else if (E === 6) {
                const C = p.readUE("pic_size_in_map_units_minus1");
                j.pic_size_in_map_units_minus1 = C;
                const B = [];
                for (let P = 0; P <= C; P++) {
                    const k = Math.ceil(Math.log2(N + 1));
                    B.push(p.readBits(k, `slice_group_id[${P}]`));
                }
                j.slice_group_id = B;
            }
            s.slice_groups = j;
        }
        s.num_ref_idx_l0_default_active_minus1 = p.readUE("num_ref_idx_l0_default_active_minus1");
        s.num_ref_idx_l1_default_active_minus1 = p.readUE("num_ref_idx_l1_default_active_minus1");
        s.weighted_pred_flag = p.readBits(1, "weighted_pred_flag");
        const A = p.readBits(2, "weighted_bipred_idc");
        const L = { 0: "Default", 1: "Explicit", 2: "Implicit" };
        s.weighted_bipred_idc = `${A} (${L[A] || "Reserved"})`;
        s._weighted_bipred_idc_value = A;
        s.pic_init_qp_minus26 = p.readSE("pic_init_qp_minus26");
        s.pic_init_qs_minus26 = p.readSE("pic_init_qs_minus26");
        s.chroma_qp_index_offset = p.readSE("chroma_qp_index_offset");
        s.deblocking_filter_control_present_flag = p.readBits(
            1,
            "deblocking_filter_control_present_flag",
        );
        s.constrained_intra_pred_flag = p.readBits(1, "constrained_intra_pred_flag");
        s.redundant_pic_cnt_present_flag = p.readBits(1, "redundant_pic_cnt_present_flag");
        if (hasMoreRbspData(g, p.bitPosition)) {
            const E = p.readBits(1, "transform_8x8_mode_flag");
            s.transform_8x8_mode_flag = E;
            const j = p.readBits(1, "pic_scaling_matrix_present_flag");
            s.pic_scaling_matrix_present_flag = j;
            if (j) {
                const C = 6 + (E ? 2 : 0);
                const B = [];
                for (let P = 0; P < C; P++) {
                    const k = p.readBits(1, `pic_scaling_list_present_flag[${P}]`);
                    const U = { pic_scaling_list_present_flag: k };
                    if (k) {
                        const M = P < 6 ? 16 : 64;
                        const q = [];
                        let D = 8;
                        let z = 8;
                        for (let K = 0; K < M; K++) {
                            if (z !== 0) {
                                const V = p.readSE(`delta_scale[${P}][${K}]`);
                                z = (D + V + 256) % 256;
                            }
                            D = z === 0 ? D : z;
                            q.push(D);
                        }
                        U.scalingList = q;
                    }
                    B.push(U);
                }
                s.pic_scaling_list = B;
            }
            s.second_chroma_qp_index_offset = p.readSE("second_chroma_qp_index_offset");
        }
        const O = Math.ceil(p.bitPosition / 8) - x;
        if (fieldOffsets && O > 0) {
            const E = { offset: baseByteOffset + x, length: O };
            const j = (C, B) => {
                Object.keys(C).forEach((P) => {
                    if (!P.startsWith("_")) {
                        const k = `${B}.${P}`;
                        if (!fieldOffsets[k]) fieldOffsets[k] = E;
                        const U = C[P];
                        if (typeof U === "object" && U !== null && !Array.isArray(U)) {
                            j(U, k);
                        }
                    }
                });
            };
            Object.keys(s).forEach((C) => {
                if (
                    !C.startsWith("_") &&
                    C !== "forbidden_zero_bit" &&
                    C !== "nal_ref_idc" &&
                    C !== "nal_unit_type"
                ) {
                    const B = `${c}.${C}`;
                    if (!fieldOffsets[B]) fieldOffsets[B] = E;
                    const P = s[C];
                    if (typeof P === "object" && P !== null && !Array.isArray(P)) {
                        j(P, B);
                    }
                }
            });
        }
        s.rbsp_stop_one_bit = p.readBits(1, "rbsp_stop_one_bit");
        let F = 0;
        for (; p.bitPosition % 8 !== 0; ) {
            const E = p.readBits(1, `rbsp_alignment_zero_bit[${F}]`);
            s[`rbsp_alignment_zero_bit[${F}]`] = E;
            F++;
        }
        return s;
    } catch {
        return {};
    }
}

/**
 * 解析 ISO 14496-15 AVCDecoderConfigurationRecord（不含外层 box 头）。
 * @param {ArrayBuffer|ArrayBufferView} source
 * @param {number} byteOffset — 在 buffer 中的起始字节
 * @param {number} length — 记录长度 i
 * @param {Record<string, unknown>} [fieldOffsets={}]
 */
export function parseAvcDecoderConfigurationRecord(
    source,
    byteOffset,
    length,
    fieldOffsets = {},
) {
    if (length < 7) throw new Error("AVCDecoderConfigurationRecord too short");
    const buffer = source instanceof ArrayBuffer ? source : source.buffer;
    const abs =
        source instanceof ArrayBuffer ? byteOffset : source.byteOffset + byteOffset;
    const end = abs + length;

    const c = new Uint8Array(buffer, abs, length);
    const o = new Be(c, 0, abs, fieldOffsets, "sequenceHeader");
    const s = {};
    s.configurationVersion = o.readBits(8, "configurationVersion");
    s.AVCProfileIndication = o.readBits(8, "AVCProfileIndication");
    s.profile_compatibility = o.readBits(8, "profile_compatibility");
    s.AVCLevelIndication = o.readBits(8, "AVCLevelIndication");
    o._readBitsRaw(6);
    const f = o.readBits(2, "lengthSizeMinusOne");
    s.lengthSizeMinusOne = f;
    o._readBitsRaw(3);
    const m = o.readBits(5, "numSPS");
    s.numSPS = m;
    let h = abs + Math.floor(o.bitPosition / 8);
    for (let g = 0; g < m && !(h + 2 > end); g++) {
        const v = readUint16BE(buffer, h);
        if (h + 2 + v > end) break;
        const p = new Uint8Array(buffer, h + 2, v);
        const S = parseH264SpsNaluPayload(p, h + 2, fieldOffsets, g);
        s[`sps[${g}]`] = { naluLength: v, ...S };
        if (fieldOffsets) {
            fieldOffsets[`sequenceHeader.sps[${g}].naluLength`] = { offset: h, length: 2 };
        }
        h += 2 + v;
    }
    if (h < end) {
        const numPpsByte = new Uint8Array(buffer, h, 1);
        const v = new Be(numPpsByte, 0, h, fieldOffsets, "sequenceHeader").readBits(8, "numPPS");
        s.numPPS = v;
        h++;
        for (let p = 0; p < v && !(h + 2 > end); p++) {
            const S = readUint16BE(buffer, h);
            if (h + 2 + S > end) break;
            const b = new Uint8Array(buffer, h + 2, S);
            const x = parseH264PpsNaluPayload(b, h + 2, fieldOffsets, p);
            s[`pps[${p}]`] = { naluLength: S, ...x };
            if (fieldOffsets) {
                fieldOffsets[`sequenceHeader.pps[${p}].naluLength`] = { offset: h, length: 2 };
            }
            h += 2 + S;
        }
    }
    return s;
}

export const h264AvccPpsCodec = Object.freeze({
    parseAvcDecoderConfigurationRecord,
    parseH264PpsNaluPayload,
});
