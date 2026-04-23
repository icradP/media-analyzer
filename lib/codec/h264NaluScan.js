/** Length-prefixed 与 Annex B 的 H.264 NAL 扫描。 */

import Be from "../core/Be.js";
import {
    getAVCProfileName,
    getAVCLevelName,
    getChromaFormatName,
} from "../core/Constants.js";
import { readH264NalUnitHeader } from "./h264Sps.js";
import { parseH264SpsNaluPayload } from "./h264Sps.js";
import { parseH264PpsNaluPayload } from "./h264AvccPps.js";
import { parseH264SeiNaluPayload } from "./h264Sei.js";
import { parseH264SliceNaluPayload } from "./h264Slice.js";

/** NAL unit type 展示名 */
const NAL_UNIT_TYPE_NAMES = {
    0: "Unspecified",
    1: "Coded slice of a non-IDR picture",
    2: "Coded slice data partition A",
    3: "Coded slice data partition B",
    4: "Coded slice data partition C",
    5: "Coded slice of an IDR picture",
    6: "SEI (Supplemental enhancement information)",
    7: "SPS (Sequence parameter set)",
    8: "PPS (Picture parameter set)",
    9: "Access unit delimiter",
    10: "End of sequence",
    11: "End of stream",
    12: "Filler data",
    13: "SPS extension",
    14: "Prefix NAL unit",
    15: "Subset SPS",
    19: "Coded slice of an auxiliary coded picture",
    20: "Coded slice extension",
};

function nalUnitTypeLabel(type) {
    return NAL_UNIT_TYPE_NAMES[type] ?? `Reserved (${type})`;
}

/**
 * @param {DataView} view
 * @param {number} byteOffset — 样本内起始字节
 * @param {number} byteLength — 扫描区间长度
 * @param {number} [lengthSizeMinusOne=3] — avcC 中 lengthSizeMinusOne（每 NAL 长度域字节数 = 此值 + 1）
 * @param {Record<string, unknown>} [fieldOffsets={}]
 * @param {Record<string, unknown>|null} [decoderConfig=null] — 可含 `sps[0]` / `pps[0]`
 * @returns {object[]}  数组上可挂 `spsInfo`（来自 decoderConfig 或本扫描内解析到的 SPS）
 */
export function parseAvcLengthPrefixedNalUnits(
    view,
    byteOffset,
    byteLength,
    lengthSizeMinusOne = 3,
    fieldOffsets = {},
    decoderConfig = null,
) {
    const o = [];
    let f = byteOffset;
    const m = byteOffset + byteLength;
    const h = lengthSizeMinusOne + 1;
    let g = 0;
    let v = decoderConfig?.["sps[0]"] ?? null;
    let p = decoderConfig?.["pps[0]"] ?? null;
    for (; f + h < m; ) {
        let b = 0;
        if (h === 4) b = view.getUint32(f, false);
        else if (h === 2) b = view.getUint16(f, false);
        else if (h === 1) b = view.getUint8(f);
        else break;
        if (b === 0 || f + h + b > m) break;
        const x = f + h;
        const T = new Uint8Array(view.buffer, view.byteOffset + x, b);
        if (T.length < 1) break;
        const N = `nalu[${g}]`;
        const A = T.slice(0, 1);
        const L = new Be(A, 0, x, fieldOffsets, N);
        const I = readH264NalUnitHeader(L);
        const O = I.nal_unit_type;
        const F = typeof O === "number" ? O : 0;
        const E = I.forbidden_zero_bit === 1;
        const j = {
            type: "h264",
            naluLength: b,
            forbidden_zero_bit: I.forbidden_zero_bit,
            nal_ref_idc: I.nal_ref_idc,
            nal_unit_type: `${F} (${nalUnitTypeLabel(F)})`,
            _nal_unit_type_value: F,
            index: g,
            offset: x,
            _hasForbiddenBitError: E,
        };
        if (fieldOffsets) {
            fieldOffsets[`${N}.naluLength`] = { offset: f, length: h };
        }
        try {
            if (F === 1 || F === 5) {
                Object.assign(j, parseH264SliceNaluPayload(T, fieldOffsets, g, x, v, p));
            } else if (F === 6) {
                Object.assign(j, parseH264SeiNaluPayload(T, x, fieldOffsets, N));
            } else if (F === 7) {
                Object.assign(j, parseH264SpsNaluPayload(T, x, fieldOffsets, N));
                v = v || j;
            } else if (F === 8) {
                Object.assign(j, parseH264PpsNaluPayload(T, x, fieldOffsets, N));
                p = p || j;
            }
        } catch {
            /* 单条失败不影响后续 NAL */
        }
        o.push(j);
        f = x + b;
        g++;
    }
    let S = null;
    if (v) {
        const b = v._profile_idc_value;
        const x = v._level_idc_value;
        const T = v._chroma_format_idc_value;
        const N = v._bit_depth_luma_value;
        S = {
            profile: b,
            profileName: b !== undefined ? getAVCProfileName(b) : undefined,
            level: x,
            levelName: x !== undefined ? getAVCLevelName(x) : undefined,
            chroma: T,
            chromaName: T !== undefined ? getChromaFormatName(T) : undefined,
            bitDepth: N ?? 8,
        };
    }
    o.spsInfo = S;
    return o;
}

/**
 * Annex B start-code 扫描（wu）；流内解析到的 SPS/PPS 会写入 `parsedSpsInfo` / `parsedPpsInfo` 并供 slice 使用。
 * @param {Uint8Array} bytes
 * @param {number} baseOffset — 绝对字节基准（写入 fieldOffsets）
 * @param {Record<string, unknown>} [fieldOffsets={}]
 * @param {Record<string, unknown>|null} [decoderConfig=null]
 */
export function parseAnnexBH264NalUnits(bytes, baseOffset = 0, fieldOffsets = {}, decoderConfig = null) {
    const s = [];
    let c = 0;
    let o = 0;
    let f = decoderConfig?.["sps[0]"] ?? null;
    let m = decoderConfig?.["pps[0]"] ?? null;
    for (; c < bytes.length; ) {
        let g = 0;
        if (c + 3 <= bytes.length && bytes[c] === 0 && bytes[c + 1] === 0 && bytes[c + 2] === 1) {
            g = 3;
        } else if (
            c + 4 <= bytes.length &&
            bytes[c] === 0 &&
            bytes[c + 1] === 0 &&
            bytes[c + 2] === 0 &&
            bytes[c + 3] === 1
        ) {
            g = 4;
        } else {
            c++;
            continue;
        }
        const v = c;
        c += g;
        let p = bytes.length;
        for (let j = c; j < bytes.length - 2; j++) {
            if (bytes[j] === 0 && bytes[j + 1] === 0) {
                if (bytes[j + 2] === 1) {
                    p = j;
                    break;
                }
                if (j + 3 < bytes.length && bytes[j + 2] === 0 && bytes[j + 3] === 1) {
                    p = j;
                    break;
                }
            }
        }
        const S = bytes.slice(c, p);
        const b = baseOffset + c;
        if (S.length === 0) {
            c = p;
            continue;
        }
        const x = `nalu[${o}]`;
        const T = `${x}.start_code`;
        fieldOffsets[T] = { offset: baseOffset + v, length: g };
        const N = S.slice(0, 1);
        const A = new Be(N, 0, b, fieldOffsets, x);
        const L = readH264NalUnitHeader(A);
        const I = L.nal_unit_type;
        const O = typeof I === "number" ? I : 0;
        const F = L.forbidden_zero_bit === 1;
        const E = {
            type: "h264",
            startCodeLength: g,
            startCodeOffset: baseOffset + v,
            naluLength: S.length,
            totalLength: p - v,
            forbidden_zero_bit: L.forbidden_zero_bit,
            nal_ref_idc: L.nal_ref_idc,
            nal_unit_type: `${O} (${nalUnitTypeLabel(O)})`,
            _nal_unit_type_value: O,
            index: o,
            offset: b,
            _hasForbiddenBitError: F,
        };
        try {
            if (O === 1 || O === 5) {
                Object.assign(E, parseH264SliceNaluPayload(S, fieldOffsets, o, b, f, m));
            } else if (O === 6) {
                Object.assign(E, parseH264SeiNaluPayload(S, b, fieldOffsets, x));
            } else if (O === 7) {
                const j = parseH264SpsNaluPayload(S, b, fieldOffsets, x);
                Object.assign(E, j);
                f = f || j;
            } else if (O === 8) {
                const j = parseH264PpsNaluPayload(S, b, fieldOffsets, x);
                Object.assign(E, j);
                m = m || j;
            }
        } catch {
            /* 单条失败不影响后续 */
        }
        s.push(E);
        o++;
        c = p;
    }
    let h = null;
    if (f) {
        const g = f._profile_idc_value;
        const v = f._level_idc_value;
        const p = f._chroma_format_idc_value;
        const S = f._bit_depth_luma_value;
        h = {
            profile: g,
            profileName: g !== undefined ? getAVCProfileName(g) : undefined,
            level: v,
            levelName: v !== undefined ? getAVCLevelName(v) : undefined,
            chroma: p,
            chromaName: p !== undefined ? getChromaFormatName(p) : undefined,
            bitDepth: S ?? 8,
        };
    }
    s.spsInfo = h;
    s.parsedSpsInfo = f;
    s.parsedPpsInfo = m;
    return s;
}

export const h264NaluScanCodec = Object.freeze({
    parseAvcLengthPrefixedNalUnits,
    parseAnnexBH264NalUnits,
    NAL_UNIT_TYPE_NAMES,
});
