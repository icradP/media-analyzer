import { sliceFrameBytes } from "../browser/framePlayback.js";
import {
    detectLengthSizeAndSplitNalUnits,
    splitAnnexBNalUnits,
} from "./h264Bitstream.js";

export function shouldPreferAvccForFrame(frame, result) {
    const formatName = String(result?.format?.formatName || "").toLowerCase();
    const fs = frame?.formatSpecific || {};
    if (formatName === "flv" || formatName === "mp4" || formatName === "mov") return true;
    if (fs?.tagType === 9 || Number(fs?._avcPacketType_value) === 1) return true;
    if (fs?.fieldOffsets?.avcData) return true;
    return false;
}

export function extractVideoFrameNaluPayload(frame, result) {
    const fileData = result?.formatSpecific?.fileData || null;
    const fs = frame?.formatSpecific || {};
    const codecRange = fs?.fieldOffsets?.avcData || null;
    let payload = null;
    let preferredTransport = null;
    if (
        fileData instanceof Uint8Array &&
        codecRange &&
        Number.isFinite(codecRange.offset) &&
        Number.isFinite(codecRange.length) &&
        codecRange.length > 0
    ) {
        const start = Number(codecRange.offset);
        const end = start + Number(codecRange.length);
        if (start >= 0 && end <= fileData.length) {
            payload = fileData.subarray(start, end);
            preferredTransport = "avcc";
        }
    }
    if (!(payload instanceof Uint8Array) || payload.length === 0) {
        payload = sliceFrameBytes(frame, fileData);
    }
    if (!(payload instanceof Uint8Array) || payload.length === 0) {
        return { payload: null, preferredTransport: null };
    }
    if (result?.format?.formatName === "flv" || fs?.tagType === 9 || payload[0] === 9) {
        if (payload[0] === 9 && payload.length > 16) {
            payload = payload.subarray(11);
            const codecId = payload[0] & 0x0f;
            const packetType = payload[1];
            if ((codecId === 7 || codecId === 12) && packetType === 1 && payload.length > 5) {
                payload = payload.subarray(5);
                if (codecId === 7) preferredTransport = "avcc";
            }
        } else if (payload.length > 5 && payload[1] === 1) {
            payload = payload.subarray(5);
            preferredTransport = "avcc";
        }
    }
    return { payload, preferredTransport };
}

export function collectH264NalUnitsFromFrame(frameWrapper, result, videoStream = null) {
    const frame = frameWrapper?._rawFrame || frameWrapper;
    if (!frame || (frameWrapper?._mediaType && frameWrapper._mediaType !== "video")) return [];
    const { payload, preferredTransport } = extractVideoFrameNaluPayload(frame, result);
    if (!(payload instanceof Uint8Array) || payload.length <= 0) return [];
    const hintLengthSize = Number(videoStream?.decoderConfig?.lengthSizeMinusOne) + 1;
    const preferAvcc = preferredTransport === "avcc" || shouldPreferAvccForFrame(frame, result);
    if (preferAvcc) {
        const parsed = detectLengthSizeAndSplitNalUnits(payload, hintLengthSize);
        if (parsed?.nalus?.length) return parsed.nalus;
    }
    const annex = splitAnnexBNalUnits(payload);
    if (annex.length) return annex;
    const parsed = detectLengthSizeAndSplitNalUnits(payload, hintLengthSize);
    return parsed?.nalus || [];
}
