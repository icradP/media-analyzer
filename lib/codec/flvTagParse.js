/**
 * FLV 单 tag：**仅数据处理**（输入 `Uint8Array` + 偏移 + 可选 sequence header → 输出解析对象）。
 * 不包含 bundle 的 `Kv` 字段树、`_displayMetadata`、截断 hex（`_rawData` 等）；UI 层自行从 `offset`/`dataSize`/`fieldOffsets` 取字节。
 */

import Be from "../core/Be.js";
import { flvTagTypeName } from "./flvMediaLabels.js";
import { parseFlvAudioTagBody } from "./flvAudioTag.js";
import { parseFlvVideoTagBody } from "./flvVideoTagBody.js";
import { parseFlvScriptTagBody } from "./flvAmf.js";

export function parseFlvTagHeaderFields(reader, tagStartOffset, dataSize, fieldOffsets) {
    const tagType = reader.readBits(8, "tagType");
    reader.readBits(24, "dataSize");
    const tsLow = reader.readBits(24, "timestamp");
    const tsExt = reader.readBits(8, "timestampExtended");
    const tsFull = (tsExt << 24) | tsLow;
    const streamID = reader.readBits(24, "streamID");
    const tag = {
        tagType,
        tagTypeName: flvTagTypeName(tagType),
        dataSize,
        timestamp: tsLow,
        timestampExtended: tsExt,
        timestampFull: tsFull,
        streamID,
        offset: tagStartOffset,
        fieldOffsets,
    };
    fieldOffsets.tagTypeName = fieldOffsets.tagType;
    fieldOffsets.timestampFull = {
        offset: tagStartOffset + 4,
        length: 4,
        bitOffset: 0,
        bitLength: 32,
    };
    return { tag, timestampFull: tsFull };
}

export function parseFlvTagPayload(fileBytes, bodyOffset, dataSize, tag, sequenceHeaderConfig) {
    const tt = tag.tagType;
    const body = new Uint8Array(fileBytes.buffer, fileBytes.byteOffset + bodyOffset, dataSize);
    const reader = new Be(body, 0, bodyOffset, tag.fieldOffsets, "");
    if (tt === 8) {
        parseFlvAudioTagBody(reader, dataSize, tag);
    } else if (tt === 9) {
        parseFlvVideoTagBody(reader, dataSize, tag, sequenceHeaderConfig);
    } else if (tt === 18) {
        parseFlvScriptTagBody(reader, dataSize, tag);
    }
}

export function parseFlvPreviousTagSize(reader, dataSize, tag) {
    reader.bitPosition = (11 + dataSize) * 8;
    tag.previousTagSize = reader.readBits(32, "previousTagSize");
}

/** @param {Record<string, unknown>} tag */
export function getFlvTagRemark(tag) {
    if (tag._hasNaluError) return "[NALU_ERROR]";
    if (tag.tagType === 9) {
        if (tag._isExHeader_value === 1) {
            const a = tag._packetType_value;
            const i = tag._fourCC_value;
            if (a === 0) {
                if (i === "hvc1" || i === "hev1") return "HEVC Sequence Header (VPS/SPS/PPS)";
                if (i === "av01") return "AV1 Sequence Header";
                if (i === "vp09") return "VP9 Sequence Header";
                return "Enhanced: Sequence Start";
            }
            if (a === 1) return "";
            if (a === 2) return "Enhanced: Sequence End";
            if (a === 3) return "";
            if (a === 4) return "Metadata";
            if (a === 5) return "Enhanced: MPEG2-TS Sequence Start";
        }
        if (tag._avcPacketType_value === 0) return "AVC Sequence Header";
        if (tag._avcPacketType_value === 2) return "AVC End of Sequence";
        if (tag._hevcPacketType_value === 0) return "HEVC Sequence Header";
        if (tag._hevcPacketType_value === 2) return "HEVC End of Sequence";
        for (let idx = 0; idx < 100; idx++) {
            const nalu = tag[`nalu[${idx}]`];
            if (!nalu) break;
            const nt = nalu.naluHeader?._nal_unit_type_value ?? nalu._nal_unit_type_value;
            if (nt === 6) return "SEI";
        }
        return "";
    }
    if (tag.tagType === 8) {
        return tag._aacPacketType_value === 0 ? "Audio Specific Config" : "";
    }
    if (tag.tagType === 18) return "Script Data (Metadata)";
    return "";
}

/** @param {Record<string, unknown>} tag */
export function getFlvTagCodecFormat(tag) {
    if (tag.tagType === 18) return "";
    if (tag.tagType === 9) return tag.codecId || "Unknown";
    if (tag.tagType === 8) return tag.soundFormat || "Unknown";
    return "-";
}

/** @param {Record<string, unknown>} tag */
export function getFlvTagMediaType(tag) {
    if (tag.tagType === 9) return "video";
    if (tag.tagType === 8) return "audio";
    if (tag.tagType === 18) return "script";
    return "unknown";
}

/** @param {Record<string, unknown>} tag */
export function getFlvTagPictureType(tag) {
    if (tag.tagType !== 9) return null;
    const a = tag["nalu[0]"];
    if (a && a.slice_type) {
        const r = String(a.slice_type);
        if (r.includes("I slice") || r.includes("I (Intra)") || r.includes("SI slice")) return "I";
        if (r.includes("P slice") || r.includes("P (Predictive)") || r.includes("SP slice")) return "P";
        if (r.includes("B slice") || r.includes("B (Bi-predictive)")) return "B";
    }
    const ft = tag._frameType_value;
    if (ft === 1) return "I";
    if (ft === 2) return "P";
    if (ft === 3) return "B";
    return null;
}

/**
 * @param {Uint8Array} fileBytes
 * @param {number} offset — tag 起始（含 11 字节头）
 * @param {Record<string, unknown>|null} [sequenceHeaderConfig=null] — 当前视频 sequence header 解析结果
 */
export function parseFlvTagAt(fileBytes, offset, sequenceHeaderConfig = null) {
    if (offset + 11 > fileBytes.byteLength) return null;
    const dataSize =
        (fileBytes[offset + 1] << 16) | (fileBytes[offset + 2] << 8) | fileBytes[offset + 3];
    const totalSize = 11 + dataSize + 4;
    if (offset + totalSize > fileBytes.byteLength) return null;
    const tagBytes = new Uint8Array(fileBytes.buffer, fileBytes.byteOffset + offset, totalSize);
    const fieldOffsets = {};
    const reader = new Be(tagBytes, 0, offset, fieldOffsets, "");
    const { tag } = parseFlvTagHeaderFields(reader, offset, dataSize, fieldOffsets);
    fieldOffsets.data = { offset: offset + 11, length: dataSize };
    if (dataSize > 0) {
        parseFlvTagPayload(fileBytes, offset + 11, dataSize, tag, sequenceHeaderConfig);
    }
    parseFlvPreviousTagSize(reader, dataSize, tag);
    /** 本 tag 在文件中的总字节数（11 + dataSize + 4） */
    tag.byteLength = totalSize;
    tag.remark = getFlvTagRemark(tag);
    tag.codecFormat = getFlvTagCodecFormat(tag);
    tag.mediaType = getFlvTagMediaType(tag);
    tag.pictureType = getFlvTagPictureType(tag);
    return tag;
}

export const flvTagParseCodec = Object.freeze({
    parseFlvTagAt,
    parseFlvTagHeaderFields,
    parseFlvTagPayload,
    parseFlvPreviousTagSize,
    getFlvTagRemark,
    getFlvTagCodecFormat,
    getFlvTagMediaType,
    getFlvTagPictureType,
});
