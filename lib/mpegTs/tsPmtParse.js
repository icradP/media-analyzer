/**
 * PMT（Program Map Table，`table_id === 2`）。
 * 使用 `lib/core/Be.js`；
 * 描述子展开为 `parseMpegTsDescriptorPayload`。
 *
 * 默认返回不含 `_rawData`；若传入 `packet.fieldOffsets` 则写入字段偏移。
 */

import Be from "../core/Be.js";
import { streamTypeDisplayName } from "./tsStreamTypes.js";
import { parseMpegTsDescriptorPayload } from "./tsDescriptorParse.js";
import { detectMpegTsPacketSize } from "./tsPacketSize.js";
import { parseTsTransportPacket } from "./tsTransportPacket.js";
import { findFirstPatInTsBuffer } from "./tsPatParse.js";
import { TS_PAT_PID } from "./tsWellKnownPids.js";

/**
 * @param {{
 *   PID: number,
 *   payload: Uint8Array,
 *   payloadOffset?: number,
 *   fieldOffsets?: object|null,
 *   payload_unit_start_indicator?: number,
 *   payloadUnitStartIndicator?: number,
 * }} packet
 * @param {number} [pmtPID] — 默认 `packet.PID`
 */
export function parsePmtTableFromTsPacket(packet, pmtPID) {
    if (!packet?.payload) return null;
    const a = packet.payload;
    const rOff = packet.payloadOffset ?? 0;
    const pid = pmtPID ?? packet.PID;
    const fieldOffsets = packet.fieldOffsets ?? null;
    const pusi =
        packet.payload_unit_start_indicator ?? packet.payloadUnitStartIndicator;
    try {
        const s = {
            pmtPID: pid,
            streams: [],
        };
        if (fieldOffsets) s.fieldOffsets = fieldOffsets;
        const c = new Be(a, 0, rOff, fieldOffsets, "");
        if (pusi) {
            const x = c.readBits(8, "pointer_field");
            s.pointer_field = x;
            for (let T = 0; T < x; T++) c.readBits(8, `stuffing_byte[${T}]`);
        }
        if (c.getCurrentByteOffset() + 11 > a.length) return null;
        const o = c.readBits(8, "table_id");
        if (o !== 2) return null;
        s.table_id = o;
        s.section_syntax_indicator = c.readBits(1, "section_syntax_indicator");
        s.zero_bit = c.readBits(1, "zero_bit");
        s.reserved_1 = c.readBits(2, "reserved_1");
        s.section_length = c.readBits(12, "section_length");
        s.program_number = c.readBits(16, "program_number");
        s.reserved_2 = c.readBits(2, "reserved_2");
        s.version_number = c.readBits(5, "version_number");
        s.current_next_indicator = c.readBits(1, "current_next_indicator");
        s.section_number = c.readBits(8, "section_number");
        s.last_section_number = c.readBits(8, "last_section_number");
        s.reserved_3 = c.readBits(3, "reserved_3");
        s.PCR_PID = c.readBits(13, "PCR_PID");
        s.reserved_4 = c.readBits(4, "reserved_4");
        s.program_info_length = c.readBits(12, "program_info_length");
        s.programDescriptors = [];
        let f = 0;
        let m = 0;
        const h = s.program_info_length ?? 0;
        for (; f < h && c.getCurrentByteOffset() < a.length;) {
            const tag = c.readBits(8, `programDescriptors[${m}].tag`);
            const len = c.readBits(8, `programDescriptors[${m}].length`);
            const N = c.getCurrentByteOffset();
            const bytes = [];
            for (let I = 0; I < len; I++) bytes.push(c.readBits(8));
            const data = new Uint8Array(bytes);
            if (len > 0 && fieldOffsets) {
                fieldOffsets[`payload.programDescriptors[${m}].data`] = {
                    offset: rOff + N,
                    length: len,
                };
            }
            const L = parseMpegTsDescriptorPayload(
                tag,
                data,
                rOff + N,
                fieldOffsets,
                `payload.programDescriptors[${m}]`,
            );
            s.programDescriptors.push({
                tag,
                length: len,
                data,
                ...L,
            });
            f += 2 + len;
            m++;
        }
        const g = s.section_length ?? 0;
        const v = 9 + h;
        const p = g - v - 4;
        let S = 0;
        let b = 0;
        for (; S < p && b < 100;) {
            const x = c.getCurrentByteOffset();
            const st = c.readBits(8, `streams[${b}].stream_type`);
            const N = c.readBits(3, `streams[${b}].reserved1`);
            const elemPid = c.readBits(13, `streams[${b}].elementary_PID`);
            const L = c.readBits(4, `streams[${b}].reserved2`);
            const I = c.readBits(12, `streams[${b}].ES_info_length`);
            const O = {
                stream_type: st,
                streamTypeName: streamTypeDisplayName(st),
                reserved1: N,
                elementary_PID: elemPid,
                reserved2: L,
                ES_info_length: I,
                descriptors: [],
            };
            let F = 0;
            let E = 0;
            for (; F < I && c.getCurrentByteOffset() < a.length;) {
                const C = c.readBits(8, `streams[${b}].descriptors[${E}].tag`);
                const B = c.readBits(8, `streams[${b}].descriptors[${E}].length`);
                const P = c.getCurrentByteOffset();
                const k = [];
                for (let M = 0; M < B; M++) k.push(c.readBits(8));
                const data = new Uint8Array(k);
                if (B > 0 && fieldOffsets) {
                    fieldOffsets[`payload.streams[${b}].descriptors[${E}].data`] = {
                        offset: rOff + P,
                        length: B,
                    };
                }
                const U = parseMpegTsDescriptorPayload(
                    C,
                    data,
                    rOff + P,
                    fieldOffsets,
                    `payload.streams[${b}].descriptors[${E}]`,
                );
                O.descriptors.push({
                    tag: C,
                    length: B,
                    data,
                    ...U,
                });
                F += 2 + B;
                E++;
            }
            s.streams.push(O);
            const j = c.getCurrentByteOffset();
            S += j - x;
            b++;
        }
        if (c.getCurrentByteOffset() + 4 <= a.length) {
            s.CRC_32 = c.readBits(32, "CRC_32");
        }
        return s;
    } catch {
        return null;
    }
}

/**
 * 先找 PAT，再按 `program_map_PID` 收集各 PMT（每 PID 取第一节可解析结果）。
 *
 * @param {Uint8Array} bytes
 * @param {{ maxPackets?: number }} [options]
 */
export function parseMpegTsPatAndPmts(bytes, options = {}) {
    const first = findFirstPatInTsBuffer(bytes, options);
    const { packetSize, pat } = first;
    if (!packetSize || !pat) {
        return { packetSize, pat: null, pmts: [] };
    }
    const pmtPids = new Set(
        pat.programs.filter((p) => p.program_number !== 0).map((p) => p.program_map_PID),
    );
    const pmts = [];
    const seen = new Set();
    let index = 0;
    for (let o = 0; o + packetSize <= bytes.length; o += packetSize, index++) {
        if (options.maxPackets != null && index >= options.maxPackets) break;
        const p = parseTsTransportPacket(bytes, o, packetSize, index);
        if (!p?.payload || p.PID === TS_PAT_PID || !pmtPids.has(p.PID) || seen.has(p.PID)) continue;
        const pmt = parsePmtTableFromTsPacket(p, p.PID);
        if (pmt) {
            pmts.push(pmt);
            seen.add(p.PID);
            if (seen.size === pmtPids.size) break;
        }
    }
    return { packetSize, pat, pmts };
}

export const tsPmtParseCodec = Object.freeze({
    parsePmtTableFromTsPacket,
    parseMpegTsPatAndPmts,
});
