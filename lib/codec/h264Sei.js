/** H.264 SEI NAL（nal_unit_type 6）解析。 */

import Be from "../core/Be.js";
import { removeEmulationPrevention } from "../core/Constants.js";
import { readH264NalUnitHeader } from "./h264Sps.js";

/** SEI payloadType → 名称 */
export const SEI_PAYLOAD_TYPE_NAMES = {
    0: "buffering_period",
    1: "pic_timing",
    2: "pan_scan_rect",
    3: "filler_payload",
    4: "user_data_registered_itu_t_t35",
    5: "user_data_unregistered",
    6: "recovery_point",
    7: "dec_ref_pic_marking_repetition",
    8: "spare_pic",
    9: "scene_info",
    10: "sub_seq_info",
    11: "sub_seq_layer_characteristics",
    12: "sub_seq_characteristics",
    13: "full_frame_freeze",
    14: "full_frame_freeze_release",
    15: "full_frame_snapshot",
    16: "progressive_refinement_segment_start",
    17: "progressive_refinement_segment_end",
    18: "motion_constrained_slice_group_set",
    19: "film_grain_characteristics",
    20: "deblocking_filter_display_preference",
    21: "stereo_video_info",
    22: "post_filter_hint",
    23: "tone_mapping_info",
    45: "frame_packing_arrangement",
    47: "display_orientation",
    128: "frame_packing_arrangement",
    129: "display_orientation",
    130: "mastering_display_colour_volume",
    137: "mastering_display_info",
    144: "content_light_level_info",
    147: "alternative_transfer_characteristics",
};

function seiPayloadTypeName(type) {
    return SEI_PAYLOAD_TYPE_NAMES[type] ?? null;
}

/** 原 _v */
function lookupSeiPayloadTypeName(type) {
    return seiPayloadTypeName(type);
}

/** 原 gv — 解析单条 SEI message 的 payload 字节 */
function readSeiMessagePayload(reader, out, messageIndex, payloadType, payloadSize) {
    const i = messageIndex;
    if (payloadType === 4 && payloadSize >= 3) {
        const c = Math.floor(reader.bitPosition / 8);
        reader.startField(`itu_t_t35_country_code[${i}]`);
        const o = reader._readBitsRaw(8);
        reader._finishField();
        out[`itu_t_t35_country_code[${i}]`] = `0x${o.toString(16).padStart(2, "0")}`;
        let f = 0;
        if (o === 181 && payloadSize >= 4) {
            reader.startField(`itu_t_t35_provider_code[${i}]`);
            f = (reader._readBitsRaw(8) << 8) | reader._readBitsRaw(8);
            reader._finishField();
            out[`itu_t_t35_provider_code[${i}]`] = `0x${f.toString(16).padStart(4, "0")}`;
            if (f === 49 && payloadSize >= 7) {
                const g = reader.readString(4, `user_identifier[${i}]`);
                out[`user_identifier[${i}]`] = g;
                if (g === "GA94") {
                    out._hasClosedCaptions = true;
                    out[`caption_type[${i}]`] = "EIA-608/CEA-708";
                }
            }
        }
        const m = Math.floor(reader.bitPosition / 8) - c;
        const h = payloadSize - m;
        if (h > 0) {
            reader.startField(`user_data_payload_byte[${i}]`);
            for (let g = 0; g < h; g++) reader._readBitsRaw(8);
            reader._finishField();
            out[`user_data_payload_byte[${i}]`] = `Uint8Array(${h})`;
        }
    } else if (payloadType === 5 && payloadSize >= 16) {
        reader.startField(`uuid_iso_iec_11578[${i}]`);
        const c = [];
        for (let h = 0; h < 16; h++) c.push(reader._readBitsRaw(8));
        reader._finishField();
        const o = c.map((h) => h.toString(16).padStart(2, "0")).join("");
        const f = `${o.slice(0, 8)}-${o.slice(8, 12)}-${o.slice(12, 16)}-${o.slice(16, 20)}-${o.slice(20, 32)}`;
        out[`uuid_iso_iec_11578[${i}]`] = f;
        const m = payloadSize - 16;
        if (m > 0) {
            reader.startField(`user_data_payload_byte[${i}]`);
            for (let h = 0; h < m; h++) reader._readBitsRaw(8);
            reader._finishField();
            out[`user_data_payload_byte[${i}]`] = `Uint8Array(${m})`;
        }
    } else {
        for (let c = 0; c < payloadSize; c++) {
            out[`payload_byte[${c}]`] = reader.readBits(8, `payload_byte[${c}]`);
        }
    }
}

/** 原 u_ — 循环读取 SEI messages；`lookupPayloadType` 可换为 HEVC 表 */
export function parseSeiRbspMessageLoop(reader, rbspBytes, out, lookupPayloadType = lookupSeiPayloadTypeName) {
    const a = rbspBytes;
    let r = 0;
    for (; Math.floor(reader.bitPosition / 8) < a.length - 1; ) {
        const s = Math.floor(reader.bitPosition / 8);
        if (s >= a.length - 1) break;
        let c = 0;
        let o = 0;
        for (; s + o < a.length && a[s + o] === 255; ) {
            c += 255;
            o++;
        }
        if (s + o >= a.length) break;
        c += a[s + o];
        o++;
        reader.startField(`payloadType[${r}]`);
        for (let p = 0; p < o; p++) reader._readBitsRaw(8);
        reader._finishField();
        let f = 0;
        let m = s + o;
        let h = 0;
        for (; m + h < a.length && a[m + h] === 255; ) {
            f += 255;
            h++;
        }
        if (m + h >= a.length) break;
        f += a[m + h];
        h++;
        reader.startField(`payloadSize[${r}]`);
        for (let p = 0; p < h; p++) reader._readBitsRaw(8);
        reader._finishField();
        if (Math.floor(reader.bitPosition / 8) + f > a.length) break;
        const v = lookupPayloadType(c);
        out[`payloadType[${r}]`] = v ? `${c} (${v})` : c;
        out[`_payloadType[${r}]_value`] = c;
        out[`payloadSize[${r}]`] = f;
        readSeiMessagePayload(reader, out, r, c, f);
        r++;
    }
    if (r === 0) out._note = "No SEI messages found";
}

/** RBSP 尾部 stop bit 与填充位处理（H.264 / HEVC SEI 共用） */
export function readSeiRbspTrailingBits(reader, rbspBytes, out) {
    const a = rbspBytes;
    if (reader.bitPosition < a.length * 8) {
        out.rbsp_stop_one_bit = reader.readBits(1, "rbsp_stop_one_bit");
        let s = 0;
        for (; reader.bitPosition % 8 !== 0 && reader.bitPosition < a.length * 8; ) {
            out[`rbsp_alignment_zero_bit[${s}]`] = reader.readBits(
                1,
                `rbsp_alignment_zero_bit[${s}]`,
            );
            s++;
        }
    }
}

/**
 * 解析单条 SEI NALU：1 字节 NAL header + RBSP（可含 emulation prevention）。
 * @param {Uint8Array} nalu
 * @param {number} [baseByteOffset=0]
 * @param {Record<string, unknown>} [fieldOffsets={}]
 * @param {number|string} [seiIndex=0]
 */
export function parseH264SeiNaluPayload(
    nalu,
    baseByteOffset = 0,
    fieldOffsets = {},
    seiIndex = 0,
) {
    if (!nalu || nalu.length < 1) return {};
    try {
        const s = {};
        const c = typeof seiIndex === "string" ? seiIndex : `sequenceHeader.sei[${seiIndex}]`;
        const o = nalu.slice(0, 1);
        const { data: m, removedPositions: h } = removeEmulationPrevention(nalu.slice(1));
        const g = new Uint8Array(o.length + m.length);
        g.set(o, 0);
        g.set(m, o.length);
        const v = h.map((T) => T + 1);
        const p = new Be(g, 0, baseByteOffset, fieldOffsets, c, v);
        const S = readH264NalUnitHeader(p);
        s.forbidden_zero_bit = S.forbidden_zero_bit;
        s.nal_ref_idc = S.nal_ref_idc;
        s.nal_unit_type = S.nal_unit_type;
        const b = p.bitPosition;
        if (g.length - Math.floor(b / 8) <= 1) {
            s._note = "SEI data too short or empty";
            return s;
        }
        parseSeiRbspMessageLoop(p, g, s);
        readSeiRbspTrailingBits(p, g, s);
        return s;
    } catch {
        return {};
    }
}

export const h264SeiCodec = Object.freeze({
    parseH264SeiNaluPayload,
    SEI_PAYLOAD_TYPE_NAMES,
    parseSeiRbspMessageLoop,
    readSeiRbspTrailingBits,
});
