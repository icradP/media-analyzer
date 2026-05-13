/**
 * Minimal FLV byte writer.
 *
 * RTMP audio/video/script messages already carry FLV tag bodies. A local
 * RTMP -> WS-FLV sidecar can therefore wrap those payloads with an FLV header
 * and FLV tag headers without transcoding or invoking FFmpeg.
 */

export const FLV_TAG_TYPE_AUDIO = 8;
export const FLV_TAG_TYPE_VIDEO = 9;
export const FLV_TAG_TYPE_SCRIPT = 18;

export function buildFlvHeader({ hasAudio = true, hasVideo = true } = {}) {
    const out = new Uint8Array(13);
    out[0] = 0x46;
    out[1] = 0x4c;
    out[2] = 0x56;
    out[3] = 0x01;
    out[4] = (hasAudio ? 0x04 : 0) | (hasVideo ? 0x01 : 0);
    writeU32(out, 5, 9);
    writeU32(out, 9, 0);
    return out;
}

export function buildFlvTag({ tagType, timestampMs = 0, streamId = 0, payload }) {
    if (!(payload instanceof Uint8Array)) throw new TypeError("FLV tag payload must be a Uint8Array.");
    const dataSize = payload.length;
    if (dataSize > 0xffffff) throw new RangeError("FLV tag payload exceeds 24-bit FLV dataSize.");
    const ts = Math.max(0, Math.trunc(Number(timestampMs) || 0));
    const out = new Uint8Array(11 + dataSize + 4);
    out[0] = tagType & 0xff;
    writeU24(out, 1, dataSize);
    writeU24(out, 4, ts & 0xffffff);
    out[7] = (ts >>> 24) & 0xff;
    writeU24(out, 8, Math.max(0, Math.trunc(Number(streamId) || 0)) & 0xffffff);
    out.set(payload, 11);
    writeU32(out, 11 + dataSize, 11 + dataSize);
    return out;
}

export function buildFlvAudioTag({ timestampMs = 0, payload }) {
    return buildFlvTag({ tagType: FLV_TAG_TYPE_AUDIO, timestampMs, payload });
}

export function buildFlvVideoTag({ timestampMs = 0, payload }) {
    return buildFlvTag({ tagType: FLV_TAG_TYPE_VIDEO, timestampMs, payload });
}

export function buildFlvScriptTag({ timestampMs = 0, payload }) {
    return buildFlvTag({ tagType: FLV_TAG_TYPE_SCRIPT, timestampMs, payload });
}

function writeU24(bytes, off, value) {
    const v = Math.max(0, Math.trunc(Number(value) || 0)) & 0xffffff;
    bytes[off] = (v >>> 16) & 0xff;
    bytes[off + 1] = (v >>> 8) & 0xff;
    bytes[off + 2] = v & 0xff;
}

function writeU32(bytes, off, value) {
    const v = Math.max(0, Math.trunc(Number(value) || 0));
    bytes[off] = Math.floor(v / 0x1000000) & 0xff;
    bytes[off + 1] = (v >>> 16) & 0xff;
    bytes[off + 2] = (v >>> 8) & 0xff;
    bytes[off + 3] = v & 0xff;
}

export const flvTagWriterCodec = Object.freeze({
    FLV_TAG_TYPE_AUDIO,
    FLV_TAG_TYPE_VIDEO,
    FLV_TAG_TYPE_SCRIPT,
    buildFlvHeader,
    buildFlvTag,
    buildFlvAudioTag,
    buildFlvVideoTag,
    buildFlvScriptTag,
});
