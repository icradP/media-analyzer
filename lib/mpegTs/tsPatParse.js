/**
 * PAT（Program Association Table，`table_id === 0`）。
 * 底层使用 **`lib/core/Be.js`**。
 *
 * 返回对象默认**不含** `_rawData` / `_byteOffset` / `_byteLength`（数据层）；若传入 `packet.fieldOffsets`，
 * `Be` 仍会写入该对象。
 *
 * 仅解析**落在单包 payload 内的一节** PSI；跨包拼 section 需上层缓冲。
 */

import Be from "../core/Be.js";
import { TS_PAT_PID } from "./tsWellKnownPids.js";
import { detectMpegTsPacketSize } from "./tsPacketSize.js";
import { parseTsTransportPacket } from "./tsTransportPacket.js";

/**
 * @param {{
 *   PID: number,
 *   payload: Uint8Array,
 *   payloadOffset?: number,
 *   fieldOffsets?: object|null,
 *   payload_unit_start_indicator?: number,
 *   payloadUnitStartIndicator?: number,
 * }} packet — 与 `parseTsTransportPacket` / bundle TS 包对象字段兼容
 * @returns {object|null}
 */
export function parsePatTableFromTsPacket(packet) {
    if (!packet?.payload || packet.PID !== TS_PAT_PID) return null;
    const a = packet.payload;
    const i = packet.payloadOffset ?? 0;
    const fieldOffsets = packet.fieldOffsets ?? null;
    const pusi =
        packet.payload_unit_start_indicator ?? packet.payloadUnitStartIndicator;
    try {
        const r = { programs: [] };
        if (fieldOffsets) r.fieldOffsets = fieldOffsets;
        const s = new Be(a, 0, i, fieldOffsets, "");
        if (pusi) {
            const g = s.readBits(8, "pointer_field");
            r.pointer_field = g;
            for (let v = 0; v < g; v++) s.readBits(8, `stuffing_byte[${v}]`);
        }
        if (s.getCurrentByteOffset() + 11 > a.length) return null;
        const c = s.readBits(8, "table_id");
        if (c !== 0) return null;
        r.table_id = c;
        r.section_syntax_indicator = s.readBits(1, "section_syntax_indicator");
        r.zero_bit = s.readBits(1, "zero_bit");
        r.reserved_1 = s.readBits(2, "reserved_1");
        r.section_length = s.readBits(12, "section_length");
        r.transport_stream_id = s.readBits(16, "transport_stream_id");
        r.reserved_2 = s.readBits(2, "reserved_2");
        r.version_number = s.readBits(5, "version_number");
        r.current_next_indicator = s.readBits(1, "current_next_indicator");
        r.section_number = s.readBits(8, "section_number");
        r.last_section_number = s.readBits(8, "last_section_number");
        const f = r.section_length - 5 - 4;
        let m = 0;
        let h = 0;
        for (; m < f && h < 100;) {
            const g = s.readBits(16, `programs[${h}].program_number`);
            const v = s.readBits(3, `programs[${h}].reserved`);
            const p = s.readBits(13, `programs[${h}].program_map_PID`);
            r.programs.push({
                program_number: g,
                reserved: v,
                program_map_PID: p,
            });
            m += 4;
            h++;
        }
        if (s.getCurrentByteOffset() + 4 <= a.length) {
            r.CRC_32 = s.readBits(32, "CRC_32");
        }
        return r;
    } catch {
        return null;
    }
}

/**
 * @param {Uint8Array} payload — TS 包 payload（已去掉 4 字节 TS 头）
 * @param {boolean|number|undefined} payloadUnitStart — PUSI
 */
export function parsePatPsiSectionBytes(payload, payloadUnitStart) {
    return parsePatTableFromTsPacket({
        PID: TS_PAT_PID,
        payload,
        payload_unit_start_indicator: payloadUnitStart,
    });
}

/**
 * 扫描缓冲，返回第一个可解析的 PAT。
 *
 * @param {Uint8Array} bytes
 * @param {{ maxPackets?: number }} [options]
 * @returns {{ packetSize: number|null; pat: object|null; packetIndex: number|null }}
 */
export function findFirstPatInTsBuffer(bytes, options = {}) {
    const packetSize = detectMpegTsPacketSize(bytes);
    if (packetSize == null) return { packetSize: null, pat: null, packetIndex: null };
    let index = 0;
    for (let o = 0; o + packetSize <= bytes.length; o += packetSize, index++) {
        if (options.maxPackets != null && index >= options.maxPackets) break;
        const p = parseTsTransportPacket(bytes, o, packetSize, index);
        if (!p || p.PID !== TS_PAT_PID || !p.payload) continue;
        const pat = parsePatTableFromTsPacket(p);
        if (pat) return { packetSize, pat, packetIndex: index };
    }
    return { packetSize, pat: null, packetIndex: null };
}

export const tsPatParseCodec = Object.freeze({
    parsePatTableFromTsPacket,
    parsePatPsiSectionBytes,
    findFirstPatInTsBuffer,
});
