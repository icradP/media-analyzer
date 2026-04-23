/**
 * MPEG-TS 传输包解析（数据子集：4 字节头 + adaptation 长度跳过 + payload 切片）。
 * 不含 `recordCompositeField` / `_displayMetadata`；完整 adaptation（PCR 等）与 UI 树由上层处理。
 */

import { MPEG_TS_SYNC_BYTE, detectMpegTsPacketSize } from "./tsPacketSize.js";

/**
 * @param {Uint8Array} fileBytes
 * @param {number} byteOffset — 包起点
 * @param {number} packetSize — 188 | 192 | 204
 * @param {number} [packetIndex=0]
 * @returns {object|null}
 */
export function parseTsTransportPacket(fileBytes, byteOffset, packetSize, packetIndex = 0) {
    if (byteOffset + packetSize > fileBytes.byteLength) return null;
    const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
    const sync = view.getUint8(byteOffset);
    if (sync !== MPEG_TS_SYNC_BYTE) return null;
    const b1 = view.getUint8(byteOffset + 1);
    const b2 = view.getUint8(byteOffset + 2);
    const b3 = view.getUint8(byteOffset + 3);
    const transport_error_indicator = (b1 & 0x80) >> 7;
    const payload_unit_start_indicator = (b1 & 0x40) >> 6;
    const transport_priority = (b1 & 0x20) >> 5;
    const PID = ((b1 & 0x1f) << 8) | b2;
    const transport_scrambling_control = (b3 & 0xc0) >> 6;
    const adaptation_field_control = (b3 & 0x30) >> 4;
    const continuity_counter = b3 & 0x0f;

    let payloadStart = byteOffset + 4;
    let adaptation_field = null;
    if (adaptation_field_control === 2 || adaptation_field_control === 3) {
        if (payloadStart >= fileBytes.byteLength) return null;
        const afLength = view.getUint8(payloadStart);
        adaptation_field = { length: afLength };
        payloadStart += 1 + afLength;
    }

    let payload = null;
    let payloadSize = 0;
    if (adaptation_field_control === 1 || adaptation_field_control === 3) {
        const end = byteOffset + packetSize;
        if (payloadStart < end) {
            payload = fileBytes.subarray(payloadStart, end);
            payloadSize = payload.length;
        }
    }

    return {
        index: packetIndex,
        offset: byteOffset,
        size: packetSize,
        sync_byte: sync,
        transport_error_indicator,
        payload_unit_start_indicator,
        transport_priority,
        PID,
        transport_scrambling_control,
        adaptation_field_control,
        continuity_counter,
        adaptation_field,
        payload,
        payloadOffset: payload ? payloadStart : undefined,
        payloadSize,
    };
}

/**
 * @param {Uint8Array} fileBytes
 * @param {{ maxPackets?: number }} [options]
 * @returns {{ packetSize: number|null; packets: object[] }}
 */
export function iterateTsTransportPackets(fileBytes, options = {}) {
    const { maxPackets } = options;
    const packetSize = detectMpegTsPacketSize(fileBytes);
    if (packetSize == null) return { packetSize: null, packets: [] };
    const packets = [];
    let index = 0;
    for (let o = 0; o + packetSize <= fileBytes.byteLength; o += packetSize) {
        const p = parseTsTransportPacket(fileBytes, o, packetSize, index);
        if (!p) break;
        packets.push(p);
        index++;
        if (maxPackets != null && index >= maxPackets) break;
    }
    return { packetSize, packets };
}