export const MP4_LIKE_TOP_LEVEL_BOX_IDS = Object.freeze(
    new Set(["ftyp", "styp", "moov", "moof", "mdat", "free", "skip", "mvhd", "trak", "uuid"]),
);

/** @param {Uint8Array} buffer @param {number} offset */
export function readUint32BE(buffer, offset) {
    return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0;
}

/** @param {Uint8Array} buffer @param {number} offset */
export function readFourCC(buffer, offset) {
    return String.fromCharCode(buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]);
}

export function isFlvSignaturePrefix(bytes) {
    return bytes.length >= 3 && bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56;
}

export function isPsPackHeader(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0xba;
}

export function isWavSignature(bytes) {
    return (
        bytes.length >= 12
        && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
    );
}

export function isFlacSignature(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43;
}

export function isOggSignature(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
}

export function isOggOpusSignature(bytes) {
    if (bytes.length < 64 || !isOggSignature(bytes)) return false;
    const probe = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 128)));
    return probe.includes("OpusHead");
}

export function isAacAdtsSignature(bytes) {
    return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
}

export function isMp3Signature(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
    const maxProbe = Math.min(bytes.length - 1, 2048);
    for (let i = 0; i < maxProbe; i++) {
        if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) return true;
    }
    return false;
}

export function hasMpegTsMultiSyncPattern(bytes) {
    if (bytes.length < 188 || bytes[0] !== 0x47) return false;
    return (bytes.length >= 376 && bytes[188] === 0x47) || (bytes.length >= 564 && bytes[376] === 0x47);
}

export function coarseLooksLikeMp4OrFmp4(bytes) {
    if (bytes.length < 8 || isFlvSignaturePrefix(bytes) || hasMpegTsMultiSyncPattern(bytes)) {
        return false;
    }
    const firstType = readFourCC(bytes, 4);
    if (MP4_LIKE_TOP_LEVEL_BOX_IDS.has(firstType)) return true;
    const limit = Math.min(bytes.length, 1024 * 1024);
    let offset = 0;
    while (offset + 8 <= limit) {
        const size = readUint32BE(bytes, offset);
        const type = readFourCC(bytes, offset + 4);
        if (MP4_LIKE_TOP_LEVEL_BOX_IDS.has(type)) return true;
        if (size < 8 || offset + size > limit) break;
        offset += size;
    }
    return false;
}

export const mediaSignaturesCodec = Object.freeze({
    MP4_LIKE_TOP_LEVEL_BOX_IDS,
    readUint32BE,
    readFourCC,
    isFlvSignaturePrefix,
    isPsPackHeader,
    isWavSignature,
    isFlacSignature,
    isOggSignature,
    isOggOpusSignature,
    isAacAdtsSignature,
    isMp3Signature,
    hasMpegTsMultiSyncPattern,
    coarseLooksLikeMp4OrFmp4,
});
