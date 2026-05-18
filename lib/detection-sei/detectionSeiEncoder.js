import {
    DETECTION_SEI_UUID_BYTES,
    normalizeDetectionSeiPayload,
} from "./detectionSeiSchema.js";

const textEncoder = new TextEncoder();

export function encodeDetectionSeiPayloadJson(payload) {
    const normalized = normalizeDetectionSeiPayload(payload);
    return textEncoder.encode(JSON.stringify(normalized));
}

export function buildDetectionSeiNalu(payload) {
    return buildH264UserDataUnregisteredSeiNalu(DETECTION_SEI_UUID_BYTES, encodeDetectionSeiPayloadJson(payload));
}

export function buildH264UserDataUnregisteredSeiNalu(uuidBytes, userDataBytes) {
    if (!(uuidBytes instanceof Uint8Array) || uuidBytes.length !== 16) {
        throw new Error("user_data_unregistered UUID must be exactly 16 bytes.");
    }
    if (!(userDataBytes instanceof Uint8Array)) throw new Error("SEI user data bytes are required.");
    const fullPayload = concatBytes([uuidBytes, userDataBytes]);
    const rbsp = [];
    appendSeiVarLen(rbsp, 5);
    appendSeiVarLen(rbsp, fullPayload.length);
    for (const b of fullPayload) rbsp.push(b);
    rbsp.push(0x80);
    const ebsp = insertEmulationPreventionBytes(Uint8Array.from(rbsp));
    const out = new Uint8Array(1 + ebsp.length);
    out[0] = 0x06;
    out.set(ebsp, 1);
    return out;
}

function appendSeiVarLen(out, value) {
    let n = Math.max(0, Math.round(Number(value) || 0));
    while (n >= 255) {
        out.push(0xff);
        n -= 255;
    }
    out.push(n & 0xff);
}

function insertEmulationPreventionBytes(rbsp) {
    const out = [];
    let zeroRun = 0;
    for (const b of rbsp) {
        if (zeroRun >= 2 && b <= 0x03) {
            out.push(0x03);
            zeroRun = 0;
        }
        out.push(b);
        zeroRun = b === 0 ? zeroRun + 1 : 0;
    }
    return Uint8Array.from(out);
}

function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + (part?.length || 0), 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of parts) {
        if (!(part instanceof Uint8Array) || part.length <= 0) continue;
        out.set(part, off);
        off += part.length;
    }
    return out;
}

export const detectionSeiEncoder = Object.freeze({
    encodeDetectionSeiPayloadJson,
    buildDetectionSeiNalu,
    buildH264UserDataUnregisteredSeiNalu,
});
