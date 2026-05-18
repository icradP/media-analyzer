import { buildH264SeiNaluFromPayload } from "../browser/seiEditorModel.js";
import {
    DETECTION_SEI_UUID_BYTES,
    normalizeDetectionSeiPayload,
} from "./detectionSeiSchema.js";

const textEncoder = new TextEncoder();

export function encodeDetectionSeiPayloadJson(payload) {
    const normalized = normalizeDetectionSeiPayload(payload);
    return textEncoder.encode(JSON.stringify(normalized));
}

/** @deprecated Use buildDetectionSeiNalu; kept for callers expecting UUID+payload assembly. */
export function buildH264UserDataUnregisteredSeiNalu(uuidBytes, userDataBytes) {
    if (!(uuidBytes instanceof Uint8Array) || uuidBytes.length !== 16) {
        throw new Error("user_data_unregistered UUID must be exactly 16 bytes.");
    }
    if (!(userDataBytes instanceof Uint8Array)) throw new Error("SEI user data bytes are required.");
    return buildH264SeiNaluFromPayload(5, userDataBytes, {
        protectedPrefixBytes: uuidBytes,
        autoProtectedPrefix: false,
    });
}

export function buildDetectionSeiNalu(payload) {
    return buildH264SeiNaluFromPayload(5, encodeDetectionSeiPayloadJson(payload), {
        protectedPrefixBytes: DETECTION_SEI_UUID_BYTES,
        autoProtectedPrefix: false,
    });
}
