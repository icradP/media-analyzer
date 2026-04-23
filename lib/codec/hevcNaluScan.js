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

export const hevcNaluScanCodec = Object.freeze({
    parseHevcLengthPrefixedNalUnits,
});
