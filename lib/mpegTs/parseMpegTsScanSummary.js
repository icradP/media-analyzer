/**
 * TS 缓冲摘要：包扫描；可选附带 PAT/PMT（`parseMpegTsPatAndPmts`，非完整 `Cr`）。
 */

import { iterateTsTransportPackets } from "./tsTransportPacket.js";
import { parseMpegTsPatAndPmts } from "./tsPmtParse.js";

/**
 * @param {Uint8Array} bytes
 * @param {{
 *   maxPackets?: number;
 *   includePackets?: boolean;
 *   includePsi?: boolean;
 * }} [options] `includePsi`: 解析第一节 PAT + 各 PMT（单包 section）
 */
export function parseMpegTsScanSummary(bytes, options = {}) {
    const { maxPackets, includePackets = false, includePsi = false } = options;
    const { packetSize, packets } = iterateTsTransportPackets(bytes, { maxPackets });
    if (packetSize == null) {
        return {
            format: {
                formatName: "mpeg-ts",
                formatLongName: "MPEG Transport Stream",
                detected: false,
            },
            packetSize: null,
            packetCount: 0,
            pids: [],
            packets: [],
        };
    }
    const pidSet = new Set();
    for (const p of packets) pidSet.add(p.PID);
    const pids = [...pidSet].sort((a, b) => a - b);
    const out = {
        format: {
            formatName: "mpeg-ts",
            formatLongName: includePsi
                ? "MPEG Transport Stream (packet scan + PAT/PMT)"
                : "MPEG Transport Stream (packet scan)",
            detected: true,
            packetSize,
            packetCount: packets.length,
            pidCount: pids.length,
        },
        packetSize,
        packetCount: packets.length,
        pids,
        packets: includePackets ? packets : [],
    };
    if (includePsi) {
        const { pat, pmts } = parseMpegTsPatAndPmts(bytes, { maxPackets });
        out.pat = pat;
        out.pmts = pmts;
        if (pat) {
            out.format.psi = true;
            out.format.pmtCount = pmts.length;
        }
    }
    return out;
}

export const parseMpegTsScanSummaryCodec = Object.freeze({
    parseMpegTsScanSummary,
});
