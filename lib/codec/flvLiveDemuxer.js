/**
 * Incremental FLV tag demuxing for live streams.
 *
 * This is only a stream adapter. Tag parsing is delegated to the existing
 * FLV parser stack (`parseFlvTagAt` -> audio/video/script body parsers), so
 * live playback and file analysis do not drift into separate FLV parsers.
 */

import { parseFlvTagAt } from "./flvTagParse.js";

export class FlvLiveDemuxer {
    constructor() {
        this.reset();
    }

    reset() {
        this.buffer = new Uint8Array(0);
        this.offset = 0;
        this.headerParsed = false;
        this.hasAudio = null;
        this.hasVideo = null;
        this.sequenceHeaderConfig = null;
    }

    push(chunk) {
        if (!(chunk instanceof Uint8Array) || chunk.length <= 0) return [];
        this.buffer = concatBytes([this.buffer.subarray(this.offset), chunk]);
        this.offset = 0;

        const out = [];
        if (!this.headerParsed) {
            if (this.buffer.length < 13) return out;
            if (this.buffer[0] !== 0x46 || this.buffer[1] !== 0x4c || this.buffer[2] !== 0x56) {
                throw new Error("WebSocket payload is not FLV.");
            }
            const flags = this.buffer[4] || 0;
            this.hasAudio = (flags & 0x04) !== 0;
            this.hasVideo = (flags & 0x01) !== 0;
            const dataOffset = readU32(this.buffer, 5);
            if (this.buffer.length < dataOffset + 4) return out;
            this.offset = dataOffset + 4;
            this.headerParsed = true;
        }

        while (this.offset + 11 <= this.buffer.length) {
            const pos = this.offset;
            const dataSize = readU24(this.buffer, pos + 1);
            const total = 11 + dataSize + 4;
            if (pos + total > this.buffer.length) break;

            const parsedTag = parseFlvTagAt(this.buffer, pos, this.sequenceHeaderConfig);
            if (parsedTag?.sequenceHeader) this.sequenceHeaderConfig = parsedTag.sequenceHeader;

            const liveTag = adaptParsedFlvTagForLive(parsedTag, this.buffer);
            if (liveTag) out.push(liveTag);
            this.offset += total;
        }

        if (this.offset > 0 && this.offset >= this.buffer.length) {
            this.buffer = new Uint8Array(0);
            this.offset = 0;
        }
        return out;
    }
}

export function adaptParsedFlvTagForLive(tag, fileBytes) {
    if (!tag || !(fileBytes instanceof Uint8Array)) return null;
    if (tag.tagType === 9) return adaptParsedFlvVideoTagForLive(tag, fileBytes);
    if (tag.tagType === 8) return adaptParsedFlvAudioTagForLive(tag, fileBytes);
    return null;
}

export function adaptParsedFlvVideoTagForLive(tag, fileBytes) {
    if (tag._codecId_value !== 7) return null;
    const payload = sliceRange(fileBytes, tag.fieldOffsets?.avcData);
    if (!(payload instanceof Uint8Array)) return null;
    const timestampMs = Number(tag.timestampFull) >>> 0;

    if (tag._avcPacketType_value === 0) {
        return { kind: "avc-config", timestampMs, avcC: payload.slice(0), parsedTag: tag };
    }
    if (tag._avcPacketType_value !== 1 || payload.length <= 0) return null;

    const body = sliceFlvTagBody(tag, fileBytes);
    return {
        kind: "video",
        timestampMs,
        compositionTimeMs: body && body.length >= 5 ? readI24(body, 2) : 0,
        frameType: tag._frameType_value,
        isKeyframe: tag._frameType_value === 1,
        payload,
        parsedTag: tag,
    };
}

export function adaptParsedFlvAudioTagForLive(tag, fileBytes) {
    const soundFormat = tag._soundFormat_value;
    const body = sliceFlvTagBody(tag, fileBytes);
    if (!(body instanceof Uint8Array) || body.length <= 0) return null;
    const timestampMs = Number(tag.timestampFull) >>> 0;

    if (soundFormat === 10) {
        if (body.length < 2) return null;
        return {
            kind: "audio",
            timestampMs,
            soundFormat,
            soundRate: tag._soundRate_value,
            channels: tag._soundType_value === 1 ? 2 : 1,
            aacPacketType: tag._aacPacketType_value,
            payload: body.subarray(2),
            parsedTag: tag,
        };
    }
    if (soundFormat === 7 || soundFormat === 8) {
        return {
            kind: "audio",
            timestampMs,
            soundFormat,
            soundRate: tag._soundRate_value,
            channels: tag._soundType_value === 1 ? 2 : 1,
            payload: body.subarray(1),
            parsedTag: tag,
        };
    }
    return null;
}

function sliceFlvTagBody(tag, fileBytes) {
    const start = Number(tag.offset) + 11;
    const end = start + Number(tag.dataSize || 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > fileBytes.length) return null;
    return fileBytes.subarray(start, end);
}

function sliceRange(fileBytes, range) {
    if (!range) return null;
    const start = Number(range.offset);
    const end = start + Number(range.length || 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > fileBytes.length) return null;
    return fileBytes.subarray(start, end);
}

function concatBytes(parts) {
    const input = (parts || []).filter((part) => part instanceof Uint8Array && part.length > 0);
    const total = input.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of input) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function readU24(bytes, off) {
    return (bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2];
}

function readU32(bytes, off) {
    return bytes[off] * 0x1000000 + ((bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]);
}

function readI24(bytes, off) {
    let value = readU24(bytes, off);
    if (value & 0x800000) value -= 0x1000000;
    return value;
}

export const flvLiveDemuxerCodec = Object.freeze({
    FlvLiveDemuxer,
    adaptParsedFlvTagForLive,
    adaptParsedFlvVideoTagForLive,
    adaptParsedFlvAudioTagForLive,
});
