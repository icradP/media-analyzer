/** HEVC length-prefixed NAL 扫描。 */

import Be from "../core/Be.js";
import {
    getChromaFormatName,
    getHEVCLevelName,
    getHEVCProfileName,
} from "../core/Constants.js";
import {
    readHevcNalUnitHeader,
    parseHevcVpsNaluPayload,
    parseHevcSpsNaluPayload,
    parseHevcPpsNaluPayload,
    parseHevcSeiNaluPayload,
} from "./hevcNaluUnits.js";
import { parseHevcSliceNaluPayload } from "./hevcSlice.js";

/**
 * @param {DataView} view
 * @param {number} byteOffset
 * @param {number} byteLength
 * @param {number} [lengthSizeMinusOne=3]
 * @param {Record<string, unknown>} [fieldOffsets={}]
 * @param {Record<string, unknown>|null} [decoderConfig=null] — 含 `sps[0]` / `pps[0]`
 * @returns {object[] & { spsInfo?: object|null }}}
 */
export function parseHevcLengthPrefixedNalUnits(
    view,
    byteOffset,
    byteLength,
    lengthSizeMinusOne = 3,
    fieldOffsets = {},
    decoderConfig = null,
) {
    const out = [];
    let pos = byteOffset;
    const end = byteOffset + byteLength;
    const lenBytes = lengthSizeMinusOne + 1;
    let index = 0;
    let v = decoderConfig?.["sps[0]"] ?? null;
    let p = decoderConfig?.["pps[0]"] ?? null;
    for (; pos + lenBytes < end; ) {
        let nalLen = 0;
        if (lenBytes === 4) nalLen = view.getUint32(pos, false);
        else if (lenBytes === 2) nalLen = view.getUint16(pos, false);
        else if (lenBytes === 1) nalLen = view.getUint8(pos);
        else break;
        if (nalLen === 0 || pos + lenBytes + nalLen > end) break;
        const payloadOffset = pos + lenBytes;
        const N = new Uint8Array(view.buffer, view.byteOffset + payloadOffset, nalLen);
        if (N.length < 2) break;
        const key = `nalu[${index}]`;
        const L = N.slice(0, 2);
        const headerReader = new Be(L, 0, payloadOffset, fieldOffsets, key);
        const O = readHevcNalUnitHeader(headerReader);
        const forbidden = O.forbidden_zero_bit === 1;
        const entry = {
            type: "h265",
            naluLength: nalLen,
            forbidden_zero_bit: O.forbidden_zero_bit,
            nal_unit_type: `${O.nal_unit_type} (${O.nal_unit_type_name})`,
            nuh_layer_id: O.nuh_layer_id,
            nuh_temporal_id_plus1: O.nuh_temporal_id_plus1,
            _nal_unit_type_value: O.nal_unit_type,
            index,
            offset: payloadOffset,
            _hasForbiddenBitError: forbidden,
        };
        if (fieldOffsets) {
            fieldOffsets[`${key}.naluLength`] = { offset: pos, length: lenBytes };
        }
        const C = typeof O.nal_unit_type === "number" ? O.nal_unit_type : 0;
        try {
            if ((C >= 0 && C <= 9) || (C >= 16 && C <= 21)) {
                Object.assign(entry, parseHevcSliceNaluPayload(N, fieldOffsets, index, payloadOffset, v, p));
            } else if (C === 32) {
                Object.assign(entry, parseHevcVpsNaluPayload(N, payloadOffset, fieldOffsets, key));
            } else if (C === 33) {
                Object.assign(entry, parseHevcSpsNaluPayload(N, payloadOffset, fieldOffsets, key));
            } else if (C === 34) {
                Object.assign(entry, parseHevcPpsNaluPayload(N, payloadOffset, fieldOffsets, key));
            } else if (C === 39 || C === 40) {
                Object.assign(entry, parseHevcSeiNaluPayload(N, payloadOffset, fieldOffsets, key));
            }
        } catch (err) {
            console.error(`Error parsing HEVC NALU (type ${C}):`, err);
        }
        out.push(entry);
        pos = payloadOffset + nalLen;
        index++;
    }
    let spsInfo = null;
    if (v) {
        const ptl = v.profile_tier_level || {};
        const prof = ptl._general_profile_idc_value;
        const lev = ptl._general_level_idc_value;
        const chroma = v._chroma_format_idc_value;
        spsInfo = {
            profile: prof,
            profileName: prof !== undefined ? getHEVCProfileName(prof) : "Unknown",
            level: lev,
            levelName: getHEVCLevelName(lev ?? 0),
            chroma,
            chromaName: getChromaFormatName(chroma ?? 0),
            bitDepth: v._bit_depth_luma_value || 8,
        };
    }
    out.spsInfo = spsInfo;
    return out;
}

/**
 * Annex-B HEVC NAL scan with field offsets and slice details.
 *
 * @param {Uint8Array} bytes
 * @param {number} [baseOffset=0]
 * @param {Record<string, unknown>} [fieldOffsets={}]
 * @param {Record<string, unknown>|null} [decoderConfig=null]
 * @returns {object[] & { spsInfo?: object|null, parsedVpsInfo?: object|null, parsedSpsInfo?: object|null, parsedPpsInfo?: object|null }}
 */
export function parseAnnexBHevcNalUnits(
    bytes,
    baseOffset = 0,
    fieldOffsets = {},
    decoderConfig = null,
) {
    const out = [];
    if (!(bytes instanceof Uint8Array) || bytes.length < 4) {
        out.spsInfo = null;
        out.parsedVpsInfo = null;
        out.parsedSpsInfo = null;
        out.parsedPpsInfo = null;
        return out;
    }
    let offset = 0;
    let index = 0;
    let vps = decoderConfig?.["vps[0]"] ?? null;
    let sps = decoderConfig?.["sps[0]"] ?? null;
    let pps = decoderConfig?.["pps[0]"] ?? null;
    while (offset < bytes.length - 3) {
        let startCodeLen = 0;
        if (bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 1) startCodeLen = 3;
        else if (
            offset + 3 < bytes.length &&
            bytes[offset] === 0 &&
            bytes[offset + 1] === 0 &&
            bytes[offset + 2] === 0 &&
            bytes[offset + 3] === 1
        ) {
            startCodeLen = 4;
        }
        if (!startCodeLen) {
            offset++;
            continue;
        }
        const startCodeOffset = offset;
        const naluStart = offset + startCodeLen;
        let naluEnd = bytes.length;
        for (let i = naluStart; i < bytes.length - 3; i++) {
            if (
                bytes[i] === 0 &&
                bytes[i + 1] === 0 &&
                (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1))
            ) {
                naluEnd = i;
                break;
            }
        }
        const nalu = bytes.slice(naluStart, naluEnd);
        if (nalu.length >= 2) {
            const key = `nalu[${index}]`;
            if (fieldOffsets) fieldOffsets[`${key}.start_code`] = { offset: baseOffset + startCodeOffset, length: startCodeLen };
            const headerReader = new Be(nalu.slice(0, 2), 0, baseOffset + naluStart, fieldOffsets, key);
            const h = readHevcNalUnitHeader(headerReader);
            const entry = {
                type: "h265",
                startCodeLength: startCodeLen,
                startCodeOffset: baseOffset + startCodeOffset,
                naluLength: nalu.length,
                totalLength: naluEnd - startCodeOffset,
                forbidden_zero_bit: h.forbidden_zero_bit,
                nal_unit_type: `${h.nal_unit_type} (${h.nal_unit_type_name})`,
                nuh_layer_id: h.nuh_layer_id,
                nuh_temporal_id_plus1: h.nuh_temporal_id_plus1,
                _nal_unit_type_value: h.nal_unit_type,
                index,
                offset: baseOffset + naluStart,
                _hasForbiddenBitError: h.forbidden_zero_bit === 1,
            };
            const t = h.nal_unit_type;
            try {
                if ((t >= 0 && t <= 9) || (t >= 16 && t <= 21)) {
                    Object.assign(entry, parseHevcSliceNaluPayload(nalu, fieldOffsets, index, baseOffset + naluStart, sps, pps));
                } else if (t === 32) {
                    const info = parseHevcVpsNaluPayload(nalu, baseOffset + naluStart, fieldOffsets, key);
                    Object.assign(entry, info);
                    vps = vps || info;
                } else if (t === 33) {
                    const info = parseHevcSpsNaluPayload(nalu, baseOffset + naluStart, fieldOffsets, key);
                    Object.assign(entry, info);
                    sps = sps || info;
                } else if (t === 34) {
                    const info = parseHevcPpsNaluPayload(nalu, baseOffset + naluStart, fieldOffsets, key);
                    Object.assign(entry, info);
                    pps = pps || info;
                } else if (t === 39 || t === 40) {
                    Object.assign(entry, parseHevcSeiNaluPayload(nalu, baseOffset + naluStart, fieldOffsets, key));
                }
            } catch {
                // continue scanning subsequent NAL units
            }
            out.push(entry);
            index++;
        }
        offset = naluEnd;
    }
    let spsInfo = null;
    if (sps) {
        const ptl = sps.profile_tier_level || {};
        const prof = ptl._general_profile_idc_value;
        const lev = ptl._general_level_idc_value;
        const chroma = sps._chroma_format_idc_value;
        spsInfo = {
            profile: prof,
            profileName: prof !== undefined ? getHEVCProfileName(prof) : "Unknown",
            level: lev,
            levelName: getHEVCLevelName(lev ?? 0),
            chroma,
            chromaName: getChromaFormatName(chroma ?? 0),
            bitDepth: sps._bit_depth_luma_value || 8,
        };
    }
    out.spsInfo = spsInfo;
    out.parsedVpsInfo = vps;
    out.parsedSpsInfo = sps;
    out.parsedPpsInfo = pps;
    return out;
}

export const hevcNaluScanCodec = Object.freeze({
    parseHevcLengthPrefixedNalUnits,
    parseAnnexBHevcNalUnits,
});
