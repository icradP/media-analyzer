import {
    bytesEqual,
    decodeH264SeiRbspMessages,
} from "../codec/h264Bitstream.js";
import {
    DETECTION_SEI_UUID_BYTES,
    isDetectionSeiPayload,
    normalizeDetectionSeiPayload,
    normalizedBoxesToDetections,
} from "./detectionSeiSchema.js";
import { collectH264NalUnitsFromFrame } from "../codec/h264FrameAccess.js";

const textDecoder = new TextDecoder();

export { collectH264NalUnitsFromFrame } from "../codec/h264FrameAccess.js";

export function decodeDetectionSeiFromNalu(seiNalu) {
    for (const msg of decodeH264SeiRbspMessages(seiNalu)) {
        const payload = decodeDetectionSeiMessage(msg);
        if (payload) return payload;
    }
    return null;
}

export function decodeAllDetectionSeiFromNalu(seiNalu) {
    return decodeH264SeiRbspMessages(seiNalu)
        .map(decodeDetectionSeiMessage)
        .filter(Boolean);
}

export function isDetectionSeiNalu(seiNalu) {
    return !!decodeDetectionSeiFromNalu(seiNalu);
}

export function readDetectionSeiPayloadFromFrame(frameWrapper, result, videoStream = null) {
    const nalus = collectH264NalUnitsFromFrame(frameWrapper, result, videoStream);
    let latest = null;
    for (const nalu of nalus) {
        if (!(nalu instanceof Uint8Array) || nalu.length < 1 || (nalu[0] & 0x1f) !== 6) continue;
        const payload = decodeDetectionSeiFromNalu(nalu);
        if (payload) latest = payload;
    }
    return latest;
}

export function detectionSeiPayloadToCanvasDetections(payload, canvas) {
    if (!payload || !canvas) return [];
    return normalizedBoxesToDetections(
        payload,
        canvas.width || payload?.image?.width,
        canvas.height || payload?.image?.height,
    );
}

function decodeDetectionSeiMessage(message) {
    if (!message || Number(message.payloadType) !== 5) return null;
    const bytes = message.payloadBytes;
    if (!(bytes instanceof Uint8Array) || bytes.length <= 16) return null;
    if (!bytesEqual(bytes.subarray(0, 16), DETECTION_SEI_UUID_BYTES)) return null;
    try {
        const obj = JSON.parse(textDecoder.decode(bytes.subarray(16)));
        if (!isDetectionSeiPayload(obj)) return null;
        return normalizeDetectionSeiPayload(obj);
    } catch {
        return null;
    }
}
