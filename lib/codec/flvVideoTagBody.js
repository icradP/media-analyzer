/**
 * FLV Video tag 体：**仅数据处理**（`Be` + `dataSize` + 可选 decoderConfig → 写 `tag` 字段与 `fieldOffsets`）。
 * 无 UI；NAL/sequenceHeader 等均为可序列化结构。
 */

import {
    flvVideoFrameTypeName,
    flvHevcPacketTypeName,
    flvVideoCodecIdName,
    flvAvcPacketTypeName,
    mp4SampleEntryTypeLabel,
} from "./flvMediaLabels.js";
import { parseAvcDecoderConfigurationRecord } from "./h264AvccPps.js";
import { parseAvcLengthPrefixedNalUnits } from "./h264NaluScan.js";
import { parseHevcDecoderConfigurationRecord } from "./hevcDecoderConfig.js";
import { parseHevcLengthPrefixedNalUnits } from "./hevcNaluScan.js";
import { readAmfValue } from "./flvAmf.js";

/**
 * @param {import("../core/Be.js").default} reader
 * @param {number} dataSize — tag body 字节数
 * @param {Record<string, unknown>} tag
 * @param {Record<string, unknown>|null} [decoderConfig=null] — 来自前序 sequence header（含 `lengthSizeMinusOne`、`sps[0]` 等）
 */
export function parseFlvVideoTagBody(reader, dataSize, tag, decoderConfig = null) {
    if (dataSize < 1) return;
    if (!tag.fieldOffsets) tag.fieldOffsets = {};
    const isEx = reader.readBits(1, "isExHeader");
    tag.isExHeader = isEx === 1 ? `${isEx} (Enhanced RTMP)` : `${isEx}`;
    tag._isExHeader_value = isEx;
    if (isEx === 1) {
        parseFlvExVideoTagBody(reader, dataSize, tag, decoderConfig);
    } else {
        parseFlvClassicVideoTagBody(reader, dataSize, tag, decoderConfig);
    }
}

function parseFlvExVideoTagBody(reader, dataSize, tag, decoderConfig) {
    const frameType = reader.readBits(3, "frameType");
    tag.frameType = `${frameType} (${flvVideoFrameTypeName(frameType)})`;
    tag._frameType_value = frameType;
    const packetType = reader.readBits(4, "packetType");
    tag.packetType = `${packetType} (${flvHevcPacketTypeName(packetType)})`;
    tag._packetType_value = packetType;
    if (Math.floor(reader.bitPosition / 8) + 4 > dataSize) return;
    const fourCC = reader.readString(4, "fourCC");
    const fourCCLabel = mp4SampleEntryTypeLabel(fourCC);
    tag.fourCC = `${fourCC} (${fourCCLabel})`;
    tag._fourCC_value = fourCC;
    tag.codecId = fourCCLabel;
    if (packetType === 0) {
        parseExSequenceHeader(reader, dataSize, tag, fourCC);
    } else if (packetType === 1 || packetType === 3) {
        parseExCodedFrames(reader, dataSize, tag, fourCC, packetType, decoderConfig);
    } else if (packetType !== 2) {
        if (packetType === 4) {
            parseExMetadata(reader, dataSize, tag);
        } else if (packetType === 5) {
            const h = reader.baseOffset + Math.floor(reader.bitPosition / 8);
            const g = Math.floor(reader.bitPosition / 8);
            const v = dataSize - g;
            if (v > 0) {
                tag.fieldOffsets.metadata = { offset: h, length: v };
            }
        }
    }
}

function parseExSequenceHeader(reader, dataSize, tag, fourCC) {
    const s = Math.floor(reader.bitPosition / 8);
    const c = reader.baseOffset + s;
    const o = dataSize - s;
    if (o > 0) {
        tag.fieldOffsets.configData = { offset: c, length: o };
        if (fourCC === "hvc1" || fourCC === "hev1") {
            const view = new DataView(reader.data.buffer);
            try {
                tag.sequenceHeader = parseHevcDecoderConfigurationRecord(view, c, o, tag.fieldOffsets);
            } catch {
                tag.sequenceHeader = null;
            }
        }
    }
}

function parseExCodedFrames(reader, dataSize, tag, fourCC, packetType, decoderConfig) {
    if (packetType === 1 && Math.floor(reader.bitPosition / 8) + 3 <= dataSize) {
        tag.compositionTime = reader.readBits(24, "compositionTime");
    }
    const o = Math.floor(reader.bitPosition / 8);
    const f = reader.baseOffset + o;
    const m = dataSize - o;
    if (m > 0) {
        tag.fieldOffsets.frameData = { offset: f, length: m };
        if (fourCC === "hvc1" || fourCC === "hev1") {
            const view = new DataView(reader.data.buffer);
            const ls = decoderConfig?.lengthSizeMinusOne ?? 3;
            const nalList = parseHevcLengthPrefixedNalUnits(view, f, m, ls, tag.fieldOffsets, decoderConfig);
            if (nalList.length > 0) {
                nalList.forEach((S, b) => {
                    tag[`nalu[${b}]`] = S;
                });
                tag._naluSpsInfo = nalList.spsInfo
                    ? { ...nalList.spsInfo, codecName: tag.codecId }
                    : { codecName: tag.codecId };
                if (nalList.some((T) => T._hasForbiddenBitError === true)) {
                    tag._hasNaluError = true;
                }
            }
        }
    }
}

function parseExMetadata(reader, dataSize, tag) {
    const r = Math.floor(reader.bitPosition / 8);
    const s = reader.baseOffset + r;
    const c = dataSize - r;
    if (c <= 0) return;
    const view = new DataView(reader.data.buffer);
    const f = s + c;
    let m = s;
    try {
        const { value: name, bytesRead: g } = readAmfValue(view, m, f, "metadataName");
        m += g;
        if (name) {
            tag.metadataName = name;
            tag.fieldOffsets.metadataName = { offset: s, length: g };
            const v = m;
            const { value: payload, bytesRead: S, fieldOffsets: b } = readAmfValue(view, m, f, String(name));
            if (payload && typeof payload === "object") {
                tag[String(name)] = payload;
                tag.fieldOffsets[String(name)] = { offset: v, length: S };
                if (b) Object.assign(tag.fieldOffsets, b);
            }
        }
    } catch {
        console.warn("Failed to parse Enhanced RTMP Metadata");
        tag.metadataError = "Metadata Parse Error";
    }
}

function parseFlvClassicVideoTagBody(reader, dataSize, tag, decoderConfig) {
    const frameType = reader.readBits(3, "frameType");
    tag.frameType = `${frameType} (${flvVideoFrameTypeName(frameType)})`;
    tag._frameType_value = frameType;
    const codecId = reader.readBits(4, "codecID");
    tag.codecID = `${codecId} (${flvVideoCodecIdName(codecId)})`;
    tag.codecId = flvVideoCodecIdName(codecId);
    tag._codecId_value = codecId;
    if (codecId === 7) {
        parseFlvAvcVideoPacket(reader, dataSize, tag, decoderConfig);
    } else if (codecId === 12) {
        parseFlvHevcVideoPacket(reader, dataSize, tag, decoderConfig);
    } else {
        const f = Math.floor(reader.bitPosition / 8);
        const m = reader.baseOffset + f;
        const h = dataSize - f;
        if (h > 0) {
            tag.fieldOffsets.videoPayload = { offset: m, length: h };
        }
    }
}

function parseFlvAvcVideoPacket(reader, dataSize, tag, decoderConfig) {
    if (Math.floor(reader.bitPosition / 8) >= dataSize) return;
    const packetType = reader.readBits(8, "avcPacketType");
    tag.avcPacketType = `${packetType} (${flvAvcPacketTypeName(packetType)})`;
    tag._avcPacketType_value = packetType;
    if (Math.floor(reader.bitPosition / 8) + 3 > dataSize) return;
    tag.compositionTime = reader.readBits(24, "compositionTime");
    const m = Math.floor(reader.bitPosition / 8);
    const h = reader.baseOffset + m;
    const g = dataSize - m;
    if (g <= 0) return;
    tag.fieldOffsets.avcData = { offset: h, length: g };
    const view = new DataView(reader.data.buffer);
    if (packetType === 0) {
        try {
            tag.sequenceHeader = parseAvcDecoderConfigurationRecord(view, h, g, tag.fieldOffsets);
        } catch {
            tag.sequenceHeader = null;
        }
    } else if (packetType === 1) {
        const ls = decoderConfig?.lengthSizeMinusOne ?? 3;
        const S = parseAvcLengthPrefixedNalUnits(view, h, g, ls, tag.fieldOffsets, decoderConfig);
        if (S.length > 0) {
            S.forEach((T, N) => {
                tag[`nalu[${N}]`] = T;
            });
            tag._naluSpsInfo = S.spsInfo ? { ...S.spsInfo, codecId: tag.codecId } : { codecId: tag.codecId };
            if (S.some((T) => T._hasForbiddenBitError === true)) {
                tag._hasNaluError = true;
            }
        }
    }
}

function parseFlvHevcVideoPacket(reader, dataSize, tag, decoderConfig) {
    if (Math.floor(reader.bitPosition / 8) >= dataSize) return;
    const packetType = reader.readBits(8, "hevcPacketType");
    tag.hevcPacketType = `${packetType} (${flvHevcPacketTypeName(packetType)})`;
    tag._hevcPacketType_value = packetType;
    if (Math.floor(reader.bitPosition / 8) + 3 > dataSize) return;
    tag.compositionTime = reader.readBits(24, "compositionTime");
    const m = Math.floor(reader.bitPosition / 8);
    const h = reader.baseOffset + m;
    const g = dataSize - m;
    if (g <= 0) return;
    tag.fieldOffsets.hevcData = { offset: h, length: g };
    const view = new DataView(reader.data.buffer);
    if (packetType === 0) {
        try {
            tag.sequenceHeader = parseHevcDecoderConfigurationRecord(view, h, g, tag.fieldOffsets);
        } catch {
            tag.sequenceHeader = null;
        }
    } else if (packetType === 1) {
        const ls = decoderConfig?.lengthSizeMinusOne ?? 3;
        const S = parseHevcLengthPrefixedNalUnits(view, h, g, ls, tag.fieldOffsets, decoderConfig);
        if (S.length > 0) {
            S.forEach((T, N) => {
                tag[`nalu[${N}]`] = T;
            });
            tag._naluSpsInfo = { ...S.spsInfo, codecName: tag.codecId };
            if (S.some((T) => T._hasForbiddenBitError === true)) {
                tag._hasNaluError = true;
            }
        }
    }
}

export const flvVideoTagBodyCodec = Object.freeze({
    parseFlvVideoTagBody,
});
