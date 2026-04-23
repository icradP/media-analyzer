/**
 * PES 分包重组及由 PMT 构建 `streamMap`。
 */

import { detectMpegTsPacketSize } from "./tsPacketSize.js";
import { parseTsTransportPacketFull } from "./tsTransportPacketFull.js";
import { parseMpegTsPatAndPmts } from "./tsPmtParse.js";
import { streamTypeToCodecCategory, streamTypeDisplayName } from "./tsStreamTypes.js";

/**
 * @param {object[]} pmts — `parsePmtTableFromTsPacket` 结果列表
 * @returns {Map<number, { pid: number; streamType: number; streamTypeName: string; codecType: string; codecName: string; descriptors?: object[] }>}
 */
export function buildTsStreamMapFromPmts(pmts) {
    const b = new Map();
    for (const pmt of pmts) {
        for (const Z of pmt.streams || []) {
            let ne = streamTypeToCodecCategory(Z.stream_type);
            let se = Z.streamTypeName || streamTypeDisplayName(Z.stream_type);
            if (Z.stream_type === 6 && Z.descriptors) {
                for (const ee of Z.descriptors) {
                    if (ee.tag === 5 && ee.format_identifier === "GA94") {
                        ne = "subtitle";
                        se = "EIA-608";
                        break;
                    }
                    if (ee.tag === 89 && ee.isSubtitle) {
                        ne = "subtitle";
                        se = "DVB Subtitle";
                        break;
                    }
                    if (ee.tag === 134 && ee.isSubtitle) {
                        ne = "subtitle";
                        se =
                            ee.isCEA608 && ee.isCEA708
                                ? "EIA-608/CEA-708"
                                : ee.isCEA608
                                  ? "EIA-608"
                                  : ee.isCEA708
                                    ? "CEA-708"
                                    : "Closed Captions";
                        break;
                    }
                    if (ee.tag === 86) {
                        ne = "subtitle";
                        se = "Teletext";
                        break;
                    }
                }
            }
            b.set(Z.elementary_PID, {
                pid: Z.elementary_PID,
                streamType: Z.stream_type,
                streamTypeName: Z.streamTypeName,
                codecType: ne,
                codecName: se,
                descriptors: Z.descriptors,
            });
        }
    }
    return b;
}

function flushCurrentPesAssembly(slot, completedPesPackets) {
    if (!slot?.currentPES || slot.pesBufferArray.length === 0) return;
    const parts = slot.pesBufferArray;
    const total = parts.reduce((c, o) => c + o.length, 0);
    const r = new Uint8Array(total);
    let s = 0;
    for (const c of parts) {
        r.set(c, s);
        s += c.length;
    }
    const cur = slot.currentPES;
    cur.buffer = r;
    cur.size = total;
    cur.endPacketIndex = slot.lastPacket ? slot.lastPacket.index : cur.startPacketIndex;
    cur.byteLength = slot.lastPacket
        ? slot.lastPacket.offset + slot.lastPacket.size - cur.offset
        : total;
    completedPesPackets.push(cur);
    slot.currentPES = null;
    slot.pesBufferArray = [];
}

/**
 * @param {object} packet — `parseTsTransportPacketFull` 结果（或字段兼容对象）
 * @param {Map<number, object>} streamMapByPid — `buildTsStreamMapFromPmts` 产物
 * @param {{
 *   assemblyByPid: Map<number, { currentPES: object|null; pesBufferArray: Uint8Array[]; lastPacket: object|null }>,
 *   completedPesPackets: object[],
 *   maxPtsByPid?: Map<number, number>|null,
 * }} state
 */
export function feedTsPesFromTransportPacket(packet, streamMapByPid, state) {
    const t = packet;
    if (!streamMapByPid.get(t.PID) || !t.payload || t.payload.length === 0) return;
    const { assemblyByPid, completedPesPackets, maxPtsByPid } = state;
    if (!assemblyByPid.has(t.PID)) {
        assemblyByPid.set(t.PID, { currentPES: null, pesBufferArray: [], lastPacket: null });
    }
    const o = assemblyByPid.get(t.PID);
    const pusi = t.payload_unit_start_indicator === 1;
    if (pusi) {
        if (o.currentPES && o.pesBufferArray.length > 0) {
            flushCurrentPesAssembly(o, completedPesPackets);
        }
        const f = t.payload;
        if (f.length >= 6 && f[0] === 0 && f[1] === 0 && f[2] === 1) {
            const m = f[3];
            const h = (f[4] << 8) | f[5];
            const g = {
                offset: t.payloadOffset ?? 0,
                size: 0,
                byteLength: 0,
                pid: t.PID,
                stream_id: m,
                PES_packet_length: h,
                startPacketIndex: t.index,
                endPacketIndex: t.index,
                pts: undefined,
                dts: undefined,
                isKeyframe: false,
            };
            o.currentPES = g;
            if (t.adaptation_field?.random_access_indicator) g.isKeyframe = true;
            if (f.length >= 9) {
                const v = (f[7] >> 6) & 3;
                if (v >= 2 && f.length >= 14) {
                    const p = (f[9] >> 1) & 7;
                    const S = ((f[10] << 7) | (f[11] >> 1)) & 32767;
                    const b = ((f[12] << 7) | (f[13] >> 1)) & 32767;
                    g.pts = p * 2 ** 30 + S * 2 ** 15 + b;
                    if (maxPtsByPid && g.pts !== undefined) {
                        const x = maxPtsByPid.get(t.PID) ?? 0;
                        if (g.pts > x) maxPtsByPid.set(t.PID, g.pts);
                    }
                    if (v === 3 && f.length >= 19) {
                        const x = (f[14] >> 1) & 7;
                        const T = ((f[15] << 7) | (f[16] >> 1)) & 32767;
                        const N = ((f[17] << 7) | (f[18] >> 1)) & 32767;
                        g.dts = x * 2 ** 30 + T * 2 ** 15 + N;
                    }
                }
            }
            o.pesBufferArray = [f];
        } else {
            o.pesBufferArray = [];
            o.currentPES = null;
        }
    } else if (o.currentPES) {
        o.pesBufferArray.push(t.payload);
        if (t.adaptation_field?.random_access_indicator) o.currentPES.isKeyframe = true;
    }
    o.lastPacket = t;
}

/** 对每个 PID 将未结束的 PES flush 到 `completedPesPackets` */
export function flushTsPesAssembly(state) {
    for (const slot of state.assemblyByPid.values()) {
        flushCurrentPesAssembly(slot, state.completedPesPackets);
    }
}

export function createTsPesAssemblyState(options = {}) {
    return {
        assemblyByPid: new Map(),
        completedPesPackets: [],
        maxPtsByPid: options.trackMaxPts ? new Map() : null,
    };
}

/**
 * 单遍：PAT/PMT → `streamMap` → 全包解析 → `vb`/`A_`。
 *
 * @param {Uint8Array} bytes
 * @param {{ maxPackets?: number; trackMaxPts?: boolean }} [options]
 */
export function parseMpegTsPesAssemblyPass(bytes, options = {}) {
    const packetSize = detectMpegTsPacketSize(bytes);
    if (packetSize == null) {
        return {
            packetSize: null,
            pat: null,
            pmts: [],
            streamMap: new Map(),
            pesPackets: [],
        };
    }
    const { pat, pmts } = parseMpegTsPatAndPmts(bytes, options);
    const streamMap = buildTsStreamMapFromPmts(pmts);
    const state = createTsPesAssemblyState({ trackMaxPts: options.trackMaxPts !== false });
    let index = 0;
    for (let o = 0; o + packetSize <= bytes.length; o += packetSize, index++) {
        if (options.maxPackets != null && index >= options.maxPackets) break;
        const p = parseTsTransportPacketFull(bytes, o, packetSize, index, {});
        if (!p) continue;
        feedTsPesFromTransportPacket(p, streamMap, state);
    }
    flushTsPesAssembly(state);
    return {
        packetSize,
        pat,
        pmts,
        streamMap,
        pesPackets: state.completedPesPackets,
        maxPtsByPid: state.maxPtsByPid,
    };
}

export const tsPesAssembleCodec = Object.freeze({
    buildTsStreamMapFromPmts,
    feedTsPesFromTransportPacket,
    flushTsPesAssembly,
    createTsPesAssemblyState,
    parseMpegTsPesAssemblyPass,
});
