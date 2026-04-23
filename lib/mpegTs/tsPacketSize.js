/** MPEG-TS 传输包长度检测。 */

export const MPEG_TS_SYNC_BYTE = 0x47;

export const CANDIDATE_PACKET_SIZES = Object.freeze([188, 192, 204]);

/**
 * @param {Uint8Array} bytes
 * @returns {188|192|204|null}
 */
export function detectMpegTsPacketSize(bytes) {
    for (const packetSize of CANDIDATE_PACKET_SIZES) {
        let hits = 0;
        const packetCount = Math.min(10, Math.floor(bytes.byteLength / packetSize));
        if (packetCount <= 0) continue;
        for (let c = 0; c < packetCount; c++) {
            const o = c * packetSize;
            if (bytes[o] === MPEG_TS_SYNC_BYTE) hits++;
        }
        if (hits >= Math.min(5, packetCount)) return packetSize;
    }
    return null;
}

export const tsPacketSizeCodec = Object.freeze({
    MPEG_TS_SYNC_BYTE,
    CANDIDATE_PACKET_SIZES,
    detectMpegTsPacketSize,
});
