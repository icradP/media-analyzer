/**
 * TS analysis:
 * - parses PAT/PMT
 * - assembles PES by PID
 * - returns format/streams/frames/formatSpecific
 *
 * UI-specific `_displayMetadata` is intentionally excluded.
 */

import { iterateTsTransportPackets } from "./tsTransportPacket.js";
import { parseMpegTsPatAndPmts } from "./tsPmtParse.js";
import {
    flushAllTsPesAssemblerStates,
    pushTsPacketToPesAssembler,
} from "./tsPesAssembler.js";
import {
    classifyPesStreamId,
    detectAnnexBVideoCodecFromPesPayload,
    detectPictureTypeFromPesPayload,
    parsePesPacket,
} from "./tsPesParse.js";
import { streamTypeDisplayName } from "./tsStreamTypes.js";
import { bitrateBpsFromBytesAndDuration } from "../core/mediaMath.js";
import { parseH264SpsNaluPayload } from "../codec/h264Sps.js";
import {
    parseHevcSpsNaluPayload,
    readHevcNalUnitHeader,
    parseHevcVpsNaluPayload,
    parseHevcPpsNaluPayload,
} from "../codec/hevcNaluUnits.js";
import { parseAudioSpecificConfig } from "../codec/aacAudioSpecificConfig.js";
import { parseAnnexBH264NalUnits } from "../codec/h264NaluScan.js";
import { parseHevcSliceNaluPayload } from "../codec/hevcSlice.js";
import Be from "../core/Be.js";

const AAC_SAMPLE_RATES = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350, 0, 0, 0,
];
const TS_ANALYSIS_PACKET_LIMIT = 20000;

function mapStreamsFromPmts(pmts) {
    const streamMap = new Map();
    for (const pmt of pmts || []) {
        for (const s of pmt.streams || []) {
            streamMap.set(s.elementary_PID, s);
        }
    }
    return streamMap;
}

function normalizeCodecName(streamInfo, parsedPes, mediaType) {
    const streamTypeName =
        streamInfo?.stream_type != null ? streamTypeDisplayName(streamInfo.stream_type) : null;
    if (mediaType === "video") {
        const annexBCodec = detectAnnexBVideoCodecFromPesPayload(
            parsedPes?.payload || new Uint8Array(0),
        );
        if (annexBCodec === "h264") return "H.264";
        if (annexBCodec === "h265") return "H.265";
    }
    if (streamTypeName) return streamTypeName;
    if (mediaType === "video") {
        const codec = detectAnnexBVideoCodecFromPesPayload(parsedPes?.payload || new Uint8Array(0));
        if (codec === "h264") return "H.264";
        if (codec === "h265") return "H.265";
    }
    return parsedPes?.codecName || null;
}

function pesHasDataAlignmentIndicator(pes) {
    const b = pes?.buffer;
    return !!(b && b.length >= 7 && ((b[6] >> 2) & 1) === 1);
}

function assembleEsPayloadFromPesPackets(packets) {
    if (!Array.isArray(packets) || packets.length === 0) return new Uint8Array(0);
    const chunks = [];
    for (const p of packets) {
        const b = p?.buffer;
        if (!b || b.length === 0) continue;
        let offset = 6;
        if (b.length >= 9) offset = 9 + b[8];
        if (offset < b.length) chunks.push(b.slice(offset));
    }
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

function groupPesPacketsToFrameUnits(pesPackets, streamMap) {
    const grouped = [];
    const states = new Map();
    const flushPid = (pid) => {
        const st = states.get(pid);
        if (!st || st.packets.length === 0) return;
        grouped.push({
            pid,
            packets: st.packets.slice(),
            mediaType: st.mediaType,
        });
        st.packets = [];
    };
    const getPesTimestamp = (pes) => pes?.dts ?? pes?.pts ?? null;
    for (const pes of pesPackets) {
        const streamInfo = streamMap.get(pes.pid) || null;
        const cls = classifyPesStreamId(pes.stream_id);
        const mediaType = cls.mediaType || "data";
        const streamTypeName =
            streamInfo?.stream_type != null ? streamTypeDisplayName(streamInfo.stream_type) : null;
        let codecHint = null;
        if (streamTypeName === "H.264") codecHint = "h264";
        else if (streamTypeName === "H.265") codecHint = "h265";
        else {
            const pesCodec = detectAnnexBVideoCodecFromPesPayload(
                assembleEsPayloadFromPesPackets([pes]),
            );
            codecHint = pesCodec === "h264" || pesCodec === "h265" ? pesCodec : null;
        }
        if (!states.has(pes.pid)) states.set(pes.pid, { mediaType, packets: [] });
        const st = states.get(pes.pid);
        st.mediaType = mediaType;
        const hasPts = pes.pts != null;
        const isVideo = mediaType === "video";
        const startBoundary = isVideo ? (pesHasDataAlignmentIndicator(pes) || hasPts) : true;
        if (startBoundary && st.packets.length > 0) {
            const prevTs = getPesTimestamp(st.packets[0]);
            const currTs = getPesTimestamp(pes);
            const sameTimestampFrame =
                isVideo && prevTs != null && currTs != null && prevTs === currTs;
            if (sameTimestampFrame) {
                st.packets.push(pes);
                continue;
            }
            const prevEs = assembleEsPayloadFromPesPackets(st.packets);
            const currEs = assembleEsPayloadFromPesPackets([pes]);
            const prevIsParameterSetOnly = !hasVclNaluInAnnexB(prevEs, codecHint);
            const currIsParameterSetOnly = !hasVclNaluInAnnexB(currEs, codecHint);
            // Keep buffering when previous segment carries only VPS/SPS/PPS.
            if (!(prevIsParameterSetOnly && currIsParameterSetOnly) && !prevIsParameterSetOnly) {
                flushPid(pes.pid);
            }
        }
        st.packets.push(pes);
        if (!isVideo) flushPid(pes.pid);
    }
    for (const [pid] of states) flushPid(pid);
    return grouped;
}

class TsFrameAssembler {
    constructor(streamMap) {
        this.streamMap = streamMap;
        this.state = new Map();
        this.units = [];
        this.context = {
            cachedSequenceInfo: {},
            pendingUnits: [],
        };
    }

    getCodecHint(streamInfo, pes) {
        const streamTypeName =
            streamInfo?.stream_type != null ? streamTypeDisplayName(streamInfo.stream_type) : null;
        if (streamTypeName === "H.264") return "h264";
        if (streamTypeName === "H.265") return "h265";
        const pesCodec = detectAnnexBVideoCodecFromPesPayload(assembleEsPayloadFromPesPackets([pes]));
        return pesCodec === "h264" || pesCodec === "h265" ? pesCodec : null;
    }

    isParameterSetOnly(esPayload, codecHint) {
        return !hasVclNaluInAnnexB(esPayload, codecHint);
    }

    flushPid(pid) {
        const st = this.state.get(pid);
        if (!st || st.packets.length === 0) return;
        const first = st.firstPes || st.packets[0];
        const esData = assembleEsPayloadFromPesPackets(st.packets);
        const parsedEs = parseEsDataUr(
            esData,
            { codecType: st.mediaType, codecName: st.codecName || "" },
            this.context.cachedSequenceInfo?.spsInfo ? this.context.cachedSequenceInfo : null,
        );
        let pictureType = null;
        if (parsedEs?.nalus?.length) {
            pictureType = pictureTypeFromNalusMr(parsedEs.nalus);
            const vps = parsedEs.nalus.parsedVpsInfo;
            const sps = parsedEs.nalus.parsedSpsInfo;
            const pps = parsedEs.nalus.parsedPpsInfo;
            if (vps) this.context.cachedSequenceInfo.vpsInfo = vps;
            if (sps) this.context.cachedSequenceInfo.spsInfo = sps;
            if (pps) this.context.cachedSequenceInfo.ppsInfo = pps;
            if (!pictureType && !this.context.cachedSequenceInfo.spsInfo) {
                this.context.pendingUnits.push({ pid, index: this.units.length, esData });
            }
        }
        this.units.push({
            pid,
            mediaType: st.mediaType,
            packets: st.packets.slice(),
            firstPes: first,
            esData,
            parsedEs,
            pictureType,
        });
        st.packets = [];
        st.firstPes = null;
    }

    processPESPacket(pes) {
        const streamInfo = this.streamMap.get(pes.pid) || null;
        const cls = classifyPesStreamId(pes.stream_id);
        const mediaType = cls.mediaType || "data";
        if (!this.state.has(pes.pid)) {
            const codecHint = this.getCodecHint(streamInfo, pes);
            this.state.set(pes.pid, {
                mediaType,
                packets: [],
                firstPes: null,
                codecName:
                    mediaType === "video"
                        ? codecHint === "h264"
                            ? "H.264"
                            : codecHint === "h265"
                              ? "H.265"
                              : cls.codecName || ""
                        : cls.codecName || "",
            });
        }
        const st = this.state.get(pes.pid);
        st.mediaType = mediaType;

        const isVideo = mediaType === "video";
        const hasPts = pes.pts != null;
        const hasBoundary = isVideo ? (pesHasDataAlignmentIndicator(pes) || hasPts) : true;
        if (hasBoundary && st.packets.length > 0) {
            const codecHint = this.getCodecHint(streamInfo, pes);
            const prevEs = assembleEsPayloadFromPesPackets(st.packets);
            const currEs = assembleEsPayloadFromPesPackets([pes]);
            if (codecHint === "h264" && isH264ContinuationAu(currEs)) {
                st.packets.push(pes);
                if (!st.firstPes) st.firstPes = pes;
                return;
            }
            const prevPsOnly = this.isParameterSetOnly(prevEs, codecHint);
            const currPsOnly = this.isParameterSetOnly(currEs, codecHint);
            const prevTs = st.firstPes?.dts ?? st.firstPes?.pts ?? null;
            const currTs = pes?.dts ?? pes?.pts ?? null;
            const sameTs = prevTs != null && currTs != null && prevTs === currTs;
            if (!sameTs && !(prevPsOnly && currPsOnly) && !prevPsOnly) {
                this.flushPid(pes.pid);
            }
        }
        st.packets.push(pes);
        if (!st.firstPes) st.firstPes = pes;
        if (!isVideo) this.flushPid(pes.pid);
    }

    finalizeAll() {
        for (const [pid] of this.state) this.flushPid(pid);
        if (this.context.pendingUnits.length > 0 && this.context.cachedSequenceInfo.spsInfo) {
            for (const p of this.context.pendingUnits) {
                const u = this.units[p.index];
                if (!u || !u.esData?.length || u.mediaType !== "video") continue;
                const reparsed = parseEsDataUr(
                    u.esData,
                    { codecType: "video", codecName: u?.parsedEs?.nalus?.[0]?.type === "h265" ? "H.265" : "H.264" },
                    this.context.cachedSequenceInfo,
                );
                if (reparsed?.nalus?.length) {
                    u.parsedEs = reparsed;
                    u.pictureType = pictureTypeFromNalusMr(reparsed.nalus) || u.pictureType;
                }
            }
            this.context.pendingUnits = [];
        }
        return this.units;
    }
}

function findAnnexBStartCodeOffset(payload, from = 0) {
    for (let i = from; i < payload.length - 3; i++) {
        if (payload[i] === 0x00 && payload[i + 1] === 0x00) {
            if (payload[i + 2] === 0x01) return i + 3;
            if (i + 3 < payload.length && payload[i + 2] === 0x00 && payload[i + 3] === 0x01) return i + 4;
        }
    }
    return -1;
}

function parseVideoDetailsFromAnnexB(payload, codecHint) {
    if (!payload?.length || !codecHint) return null;
    let off = findAnnexBStartCodeOffset(payload, 0);
    while (off > 0 && off < payload.length) {
        if (codecHint === "h264") {
            const nalType = payload[off] & 0x1f;
            if (nalType === 7) {
                try {
                    const sps = parseH264SpsNaluPayload(payload.subarray(off), 0, null, 0);
                    return {
                        width: sps?._actualWidth,
                        height: sps?._actualHeight,
                        bitDepth: sps?._bit_depth_luma_value,
                        chroma: sps?.chroma_format_idc,
                        profile: sps?.profile_idc,
                        level: sps?.level_idc,
                    };
                } catch {
                    return null;
                }
            }
        } else if (codecHint === "h265") {
            const nalType = (payload[off] >> 1) & 0x3f;
            if (nalType === 33) {
                try {
                    const sps = parseHevcSpsNaluPayload(payload.subarray(off), 0, null, 0);
                    return {
                        width: sps?._actualWidth,
                        height: sps?._actualHeight,
                        bitDepth: sps?._bit_depth_luma_value,
                        chroma: sps?.chroma_format_idc,
                        profile: sps?.profile_tier_level?.general_profile_idc,
                        level: sps?.profile_tier_level?.general_level_idc,
                    };
                } catch {
                    return null;
                }
            }
        }
        off = findAnnexBStartCodeOffset(payload, off + 1);
    }
    return null;
}

function hasVclNaluInAnnexB(payload, codecHint) {
    if (!payload?.length || !codecHint) return false;
    let off = findAnnexBStartCodeOffset(payload, 0);
    while (off > 0 && off < payload.length) {
        if (codecHint === "h264") {
            const nalType = payload[off] & 0x1f;
            if (nalType === 1 || nalType === 5) return true;
        } else if (codecHint === "h265") {
            const nalType = (payload[off] >> 1) & 0x3f;
            if ((nalType >= 0 && nalType <= 9) || (nalType >= 16 && nalType <= 21)) return true;
        }
        off = findAnnexBStartCodeOffset(payload, off + 1);
    }
    return false;
}

function isH264ContinuationAu(esPayload) {
    if (!esPayload?.length) return false;
    try {
        const nalus = parseAnnexBH264NalUnits(esPayload, 0, {}, null);
        if (!Array.isArray(nalus) || nalus.length === 0) return false;
        for (const n of nalus) {
            const t = n?._nal_unit_type_value;
            if (t === 9) return false;
            if (t === 1 || t === 5) {
                const firstMb = Number(n?.first_mb_in_slice);
                return Number.isFinite(firstMb) && firstMb > 0;
            }
        }
        return false;
    } catch {
        return false;
    }
}

function hasH264Aud(esPayload) {
    if (!esPayload?.length) return false;
    try {
        const nalus = parseAnnexBH264NalUnits(esPayload, 0, {}, null);
        if (!Array.isArray(nalus) || nalus.length === 0) return false;
        return nalus.some((n) => n?._nal_unit_type_value === 9);
    } catch {
        return false;
    }
}

function mergeUint8Arrays(chunks) {
    if (!Array.isArray(chunks) || chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];
    const total = chunks.reduce((n, c) => n + (c?.length || 0), 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        if (!c?.length) continue;
        out.set(c, at);
        at += c.length;
    }
    return out;
}

function mergeFrameUnits(frameUnits) {
    if (!Array.isArray(frameUnits) || frameUnits.length === 0) return [];
    const merged = [];
    let pendingVideo = null;

    const flushVideo = () => {
        if (!pendingVideo) return;
        const esData = mergeUint8Arrays(pendingVideo.map((u) => u.esData || new Uint8Array(0)));
        merged.push({
            ...pendingVideo[0],
            packets: pendingVideo.flatMap((u) => u.packets || []),
            esData,
            parsedEs: pendingVideo[0].parsedEs,
            pictureType: pendingVideo.find((u) => u.pictureType)?.pictureType || pendingVideo[0].pictureType || null,
        });
        pendingVideo = null;
    };


    const getH264AuKey = (unit) => {
        const nalus = unit?.parsedEs?.nalus;
        if (!Array.isArray(nalus) || nalus.length === 0) return null;
        const firstVcl = nalus.find((n) => {
            const t = n?._nal_unit_type_value;
            return t === 1 || t === 5;
        });
        if (!firstVcl) return null;
        const frameNum = firstVcl?.frame_num;
        const poc = firstVcl?.pic_order_cnt_lsb;
        if (frameNum == null || poc == null) return null;
        return `${frameNum}:${poc}`;
    };

    for (const unit of frameUnits) {
        if (unit.mediaType === "video") {
            const pts = unit.firstPes?.pts ?? null;
            const dts = unit.firstPes?.dts ?? pts;
            const ts = dts ?? pts;
            const isAudStart = hasH264Aud(unit.esData);
            const currAuKey = getH264AuKey(unit);
            if (!pendingVideo) {
                pendingVideo = [unit];
                continue;
            }
            const prev = pendingVideo[pendingVideo.length - 1];
            const prevAuKey = getH264AuKey(prev);
            const prevPts = prev.firstPes?.pts ?? null;
            const prevDts = prev.firstPes?.dts ?? prevPts;
            const prevTs = prevDts ?? prevPts;
            const tsChanged = ts != null && prevTs != null && ts !== prevTs;
            if (currAuKey && prevAuKey && currAuKey === prevAuKey) {
                pendingVideo.push(unit);
                continue;
            }
            if (isAudStart || tsChanged) {
                flushVideo();
                pendingVideo = [unit];
            } else {
                pendingVideo.push(unit);
            }
            continue;
        }
        if (unit.mediaType === "audio") {
            flushVideo();
            merged.push(unit);
            continue;
        }
        flushVideo();
        merged.push(unit);
    }
    flushVideo();
    return merged;
}

function parseAnnexBHevcNalUnits(bytes, decoderConfig = null) {
    const out = [];
    let offset = 0;
    let index = 0;
    let vps = decoderConfig?.["vps[0]"] ?? null;
    let sps = decoderConfig?.["sps[0]"] ?? null;
    let pps = decoderConfig?.["pps[0]"] ?? null;
    while (offset < bytes.length - 4) {
        let startLen = 0;
        if (bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 1) startLen = 3;
        else if (bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 0 && bytes[offset + 3] === 1) startLen = 4;
        if (!startLen) {
            offset++;
            continue;
        }
        const naluStart = offset + startLen;
        let naluEnd = bytes.length;
        for (let i = naluStart; i < bytes.length - 3; i++) {
            if (bytes[i] === 0 && bytes[i + 1] === 0 && (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1))) {
                naluEnd = i;
                break;
            }
        }
        const nalu = bytes.slice(naluStart, naluEnd);
        if (nalu.length >= 2) {
            const reader = new Be(nalu.slice(0, 2), 0, 0, {}, `nalu[${index}]`);
            const h = readHevcNalUnitHeader(reader);
            const entry = { type: "h265", _nal_unit_type_value: h.nal_unit_type, naluLength: nalu.length, index };
            try {
                const t = h.nal_unit_type;
                if ((t >= 0 && t <= 9) || (t >= 16 && t <= 21)) {
                    Object.assign(entry, parseHevcSliceNaluPayload(nalu, {}, index, 0, sps, pps));
                } else if (t === 32) {
                    const info = parseHevcVpsNaluPayload(nalu, 0, {}, `nalu[${index}]`);
                    Object.assign(entry, info);
                    vps = vps || info;
                } else if (t === 33) {
                    const info = parseHevcSpsNaluPayload(nalu, 0, {}, `nalu[${index}]`);
                    Object.assign(entry, info);
                    sps = sps || info;
                } else if (t === 34) {
                    const info = parseHevcPpsNaluPayload(nalu, 0, {}, `nalu[${index}]`);
                    Object.assign(entry, info);
                    pps = pps || info;
                }
            } catch {}
            out.push(entry);
            index++;
        }
        offset = naluEnd;
    }
    out.parsedVpsInfo = vps;
    out.parsedSpsInfo = sps;
    out.parsedPpsInfo = pps;
    out.spsInfo = sps
        ? {
              profile: sps?.profile_tier_level?._general_profile_idc_value,
              level: sps?.profile_tier_level?._general_level_idc_value,
              chroma: sps?._chroma_format_idc_value,
              bitDepth: sps?._bit_depth_luma_value || 8,
          }
        : null;
    return out;
}

function parseEsDataUr(esData, streamInfo, cachedSequenceInfo = null) {
    const out = { offset: 0, size: esData.length, data: esData, fieldOffsets: {} };
    if (!streamInfo || esData.length === 0) return out;
    if (streamInfo.codecType === "video") {
        const name = (streamInfo.codecName || "").toLowerCase().replace(/\./g, "");
        let codec = null;
        if (name.includes("h264") || name.includes("avc")) codec = "h264";
        else if (name.includes("h265") || name.includes("hevc")) codec = "h265";
        else codec = detectAnnexBVideoCodecFromPesPayload(esData);
        if (codec === "h264") {
            const cfg =
                cachedSequenceInfo && (cachedSequenceInfo.spsInfo || cachedSequenceInfo.ppsInfo)
                    ? { "sps[0]": cachedSequenceInfo.spsInfo, "pps[0]": cachedSequenceInfo.ppsInfo }
                    : null;
            out.nalus = parseAnnexBH264NalUnits(esData, 0, out.fieldOffsets, cfg);
        } else if (codec === "h265") {
            const cfg =
                cachedSequenceInfo &&
                (cachedSequenceInfo.vpsInfo || cachedSequenceInfo.spsInfo || cachedSequenceInfo.ppsInfo)
                    ? { "vps[0]": cachedSequenceInfo.vpsInfo, "sps[0]": cachedSequenceInfo.spsInfo, "pps[0]": cachedSequenceInfo.ppsInfo }
                    : null;
            out.nalus = parseAnnexBHevcNalUnits(esData, cfg);
        }
    }
    if (streamInfo.codecType === "audio" && (streamInfo.codecName?.toLowerCase() || "").includes("aac")) {
        out.audioConfig = parseAacAdtsHeader(esData);
    }
    return out;
}

function pictureTypeFromNalusMr(nalus) {
    if (!nalus || nalus.length === 0) return null;
    for (const n of nalus) {
        const v = n?._slice_type_value;
        if (v == null) continue;
        if (n.type === "h264") {
            if (v === 2 || v === 7) return "I";
            if (v === 0 || v === 5) return "P";
            if (v === 1 || v === 6) return "B";
        } else if (n.type === "h265") {
            if (v === 2) return "I";
            if (v === 1) return "P";
            if (v === 0) return "B";
        }
    }
    return null;
}

function parseAacAdtsHeader(payload) {
    if (!payload || payload.length < 7) return null;
    const maxProbe = Math.min(payload.length - 7, 64);
    for (let i = 0; i <= maxProbe; i++) {
        if (payload[i] === 0xff && (payload[i + 1] & 0xf0) === 0xf0) {
            const sfIdx = (payload[i + 2] >> 2) & 0x0f;
            const channels = ((payload[i + 2] & 0x01) << 2) | ((payload[i + 3] >> 6) & 0x03);
            return {
                sampleRate: AAC_SAMPLE_RATES[sfIdx] || undefined,
                channels: channels || undefined,
            };
        }
    }
    return null;
}

function pictureTypeFromH264SliceType(sliceTypeValue) {
    if (sliceTypeValue == null) return null;
    const n = Number(sliceTypeValue) % 5;
    if (n === 2 || n === 4) return "I";
    if (n === 0 || n === 3) return "P";
    if (n === 1) return "B";
    return null;
}

function analyzeH264AnnexB(payload) {
    try {
        const nalus = parseAnnexBH264NalUnits(payload, 0, {}, null);
        if (!Array.isArray(nalus) || nalus.length === 0) return null;
        let pictureType = null;
        let vclBytes = 0;
        for (const n of nalus) {
            const t = n?._nal_unit_type_value;
            if (t === 1 || t === 5) {
                vclBytes += n?.naluLength || 0;
                if (pictureType == null) {
                    pictureType = pictureTypeFromH264SliceType(n?._slice_type_value);
                }
            }
        }
        return {
            pictureType,
            vclBytes: vclBytes > 0 ? vclBytes : null,
        };
    } catch {
        return null;
    }
}

function channelLayoutFromChannels(channels) {
    if (channels == null) return undefined;
    return { 1: "Mono", 2: "Stereo", 6: "5.1", 8: "7.1" }[channels] || `${channels} channels`;
}

export function buildMpegTsAnalysisResult(fileBytes, scan, pesPackets, streamMap, maxPtsByPid = new Map()) {
    const streamsByPid = new Map();
    const frames = [];
    const assembler = new TsFrameAssembler(streamMap);
    for (const pes of pesPackets) assembler.processPESPacket(pes);
    const frameUnits = mergeFrameUnits(assembler.finalizeAll());
    let frameIndex = 0;
    let minPts = null;
    let maxPts = null;
    for (const unit of frameUnits) {
        const pes = unit.packets[0];
        const parsed = parsePesPacket(
            { payload: pes.buffer, payloadOffset: pes.offset },
            { includeRawPayload: false },
        );
        const pid = pes.pid;
        const streamInfo = streamMap.get(pid) || null;
        const cls = classifyPesStreamId(pes.stream_id);
        const mediaType = unit.mediaType || cls.mediaType || "data";
        const codecName = normalizeCodecName(streamInfo, { ...parsed, codecName: cls.codecName }, mediaType);
        const rawPayload = assembleEsPayloadFromPesPackets(unit.packets);
        const codecHint = codecName === "H.264" ? "h264" : codecName === "H.265" ? "h265" : null;
        const hasVcl =
            mediaType === "video" ? hasVclNaluInAnnexB(rawPayload, codecHint) : true;
        if (mediaType === "video" && !hasVcl) {
            continue;
        }
        const h264Analysis =
            mediaType === "video" && codecHint === "h264"
                ? analyzeH264AnnexB(rawPayload)
                : null;
        const pictureType =
            mediaType === "video"
                ? unit.pictureType ||
                  (codecHint === "h264"
                      ? h264Analysis?.pictureType || null
                      : detectPictureTypeFromPesPayload(rawPayload, codecHint))
                : null;
        const pts = parsed?.PTS ?? pes.pts ?? null;
        const dts = parsed?.DTS ?? pes.dts ?? pts;
        const payloadSize =
            (mediaType === "video" ? h264Analysis?.vclBytes : null) ||
            rawPayload.length ||
            unit.packets.reduce((n, p) => n + (p.size || 0), 0);
        if (!streamsByPid.has(pid)) {
            const descriptorAsc = streamInfo?.descriptors?.find((d) => d?.audioSpecificConfig)?.audioSpecificConfig;
            const ascParsed =
                descriptorAsc && descriptorAsc.length >= 2
                    ? parseAudioSpecificConfig(descriptorAsc, 0, null, "", 0)
                    : null;
            streamsByPid.set(pid, {
                pid,
                codecType: mediaType,
                codecName,
                streamType: streamInfo?.stream_type,
                streamTypeName: streamInfo?.streamTypeName || (streamInfo?.stream_type != null ? streamTypeDisplayName(streamInfo.stream_type) : undefined),
                bytes: 0,
                firstPts: null,
                lastPts: null,
                frameCount: 0,
                sampleRate: ascParsed?.samplingFrequency,
                channels: ascParsed?.channels,
                channelLayout: ascParsed?.channelLayout,
                width: null,
                height: null,
                bitDepth: null,
                chroma: null,
                profile: null,
                level: null,
            });
        }
        const st = streamsByPid.get(pid);
        st.bytes += payloadSize;
        st.frameCount += 1;
        if (!st.codecName && codecName) st.codecName = codecName;
        if (pts != null) {
            if (st.firstPts == null || pts < st.firstPts) st.firstPts = pts;
            if (st.lastPts == null || pts > st.lastPts) st.lastPts = pts;
            if (minPts == null || pts < minPts) minPts = pts;
            if (maxPts == null || pts > maxPts) maxPts = pts;
        }
        if (mediaType === "video" && (st.width == null || st.height == null || st.bitDepth == null)) {
            const esSpsInfo = unit?.parsedEs?.nalus?.spsInfo || null;
            if (esSpsInfo) {
                if (st.chroma == null && (esSpsInfo.chromaName != null || esSpsInfo.chroma != null)) {
                    st.chroma = esSpsInfo.chromaName ?? esSpsInfo.chroma;
                }
                if (st.profile == null && (esSpsInfo.profileName != null || esSpsInfo.profile != null)) {
                    st.profile = esSpsInfo.profileName ?? esSpsInfo.profile;
                }
                if (st.level == null && (esSpsInfo.levelName != null || esSpsInfo.level != null)) {
                    st.level = esSpsInfo.levelName ?? esSpsInfo.level;
                }
            }
            const details = parseVideoDetailsFromAnnexB(rawPayload, codecHint);
            if (details) {
                if (st.width == null && details.width != null) st.width = details.width;
                if (st.height == null && details.height != null) st.height = details.height;
                if (st.bitDepth == null && details.bitDepth != null) st.bitDepth = details.bitDepth;
                if (st.chroma == null && details.chroma != null) st.chroma = details.chroma;
                if (st.profile == null && details.profile != null) st.profile = details.profile;
                if (st.level == null && details.level != null) st.level = details.level;
            }
        } else if (mediaType === "audio" && (st.sampleRate == null || st.channels == null)) {
            const adts = parseAacAdtsHeader(rawPayload);
            if (adts) {
                if (st.sampleRate == null && adts.sampleRate != null) st.sampleRate = adts.sampleRate;
                if (st.channels == null && adts.channels != null) st.channels = adts.channels;
                if (st.channelLayout == null && adts.channels != null) {
                    st.channelLayout = channelLayoutFromChannels(adts.channels);
                }
            }
        }
        const isKeyframe =
            mediaType === "video"
                ? pictureType === "I"
                : !!pes.isKeyframe;
        frames.push({
            index: frameIndex++,
            streamIndex: -1,
            mediaType,
            codecName: codecName || undefined,
            pts: pts ?? 0,
            dts: dts ?? 0,
            ptsTime: pts != null ? pts / 90000 : undefined,
            dtsTime: dts != null ? dts / 90000 : undefined,
            size: payloadSize,
            offset: pes.offset ?? 0,
            flags: isKeyframe ? "K" : "_",
            isKeyframe,
            pictureType: pictureType || undefined,
            displayName: `PES PID ${pid} #${st.frameCount}`,
            remark: st.streamTypeName || "",
            // Keep assembled ES bytes on each frame so browser playback can feed
            // contiguous Annex-B access units directly to decoders.
            _assembledESData: rawPayload,
            formatSpecific: {
                pid,
                stream_id: pes.stream_id,
                PES_packet_length: parsed?.PES_packet_length ?? pes.PES_packet_length,
                packetRange: [
                    unit.packets[0]?.startPacketIndex ?? pes.startPacketIndex,
                    unit.packets[unit.packets.length - 1]?.endPacketIndex ?? pes.endPacketIndex,
                ],
                pictureType: pictureType || undefined,
                pesCount: unit.packets.length,
                _assembledESData: rawPayload,
            },
        });
    }
    const maxPtsFromTail =
        maxPtsByPid && maxPtsByPid.size > 0
            ? Math.max(...maxPtsByPid.values())
            : null;
    const maxPtsForDuration =
        maxPtsFromTail != null && maxPts != null ? Math.max(maxPtsFromTail, maxPts) : (maxPtsFromTail ?? maxPts);
    const globalDuration =
        minPts != null && maxPtsForDuration != null && maxPtsForDuration >= minPts
            ? (maxPtsForDuration - minPts) / 90000
            : 0;
    const streams = [...streamsByPid.values()].map((s, idx) => {
        const maxPts = maxPtsByPid.get(s.pid);
        const sampledDur =
            s.firstPts != null && s.lastPts != null && s.lastPts >= s.firstPts
                ? (s.lastPts - s.firstPts) / 90000
                : globalDuration;
        const dur =
            s.firstPts != null && maxPts != null && maxPts >= s.firstPts
                ? (maxPts - s.firstPts) / 90000
                : s.firstPts != null && s.lastPts != null && s.lastPts >= s.firstPts
                  ? sampledDur
                  : globalDuration;
        const durForBitrate =
            s.firstPts != null && maxPts != null && maxPts >= s.firstPts
                ? (maxPts - s.firstPts) / 90000
                : dur;
        const frameRate =
            s.codecType === "video" && sampledDur > 0 && s.frameCount > 0
                ? Number((s.frameCount / sampledDur).toFixed(3))
                : undefined;
        return {
            index: idx,
            pid: s.pid,
            codecType: s.codecType,
            codecName: s.codecName,
            streamType: s.streamType,
            streamTypeName: s.streamTypeName,
            duration: dur,
            bitrate: durForBitrate > 0 ? bitrateBpsFromBytesAndDuration(s.bytes, durForBitrate) : undefined,
            frameCount: s.frameCount,
            frameRate,
            width: s.width,
            height: s.height,
            bitDepth: s.bitDepth,
            chroma: s.chroma,
            profile: s.profile,
            level: s.level,
            sampleRate: s.sampleRate,
            channels: s.channels,
            channelLayout: s.channelLayout,
        };
    });
    frames.forEach((f) => {
        const pid = f.formatSpecific?.pid;
        f.streamIndex = streams.findIndex((s) => s.pid === pid);
    });
    return {
        format: {
            formatName: "mpeg-ts",
            formatLongName: "MPEG Transport Stream (analysis)",
            duration: globalDuration || undefined,
            bitrate: globalDuration > 0 ? bitrateBpsFromBytesAndDuration(fileBytes.byteLength, globalDuration) : undefined,
            size: fileBytes.byteLength,
            packetSize: scan.packetSize,
            packetCount: scan.packetCount,
        },
        streams,
        frames,
        formatSpecific: {
            pat: scan.pat || null,
            pmts: scan.pmts || [],
            pids: scan.pids || [],
            packetCount: scan.packetCount || 0,
            pesCount: pesPackets.length,
            groupedFrameCount: frameUnits.length,
            packets: scan.packets || [],
            fileData: fileBytes,
        },
    };
}

/**
 * @param {Uint8Array} fileBytes
 * @param {{ maxPackets?: number, includePackets?: boolean }} [options]
 */
export function parseMpegTsForAnalysis(fileBytes, options = {}) {
    const { maxPackets, includePackets = false } = options;
    const { packetSize, packets } = iterateTsTransportPackets(fileBytes, { maxPackets });
    if (!packetSize) {
        return {
            format: { formatName: "mpeg-ts", formatLongName: "MPEG Transport Stream", detected: false },
            streams: [],
            frames: [],
            formatSpecific: { fileData: fileBytes, pesCount: 0, packetCount: 0 },
        };
    }
    const { pat, pmts } = parseMpegTsPatAndPmts(fileBytes, { maxPackets });
    const streamMap = mapStreamsFromPmts(pmts);
    const assemblerMap = new Map();
    const pesPackets = [];
    const maxPtsByPid = new Map();
    const isLargeTs = packets.length > TS_ANALYSIS_PACKET_LIMIT;
    const isAudioOrVideoPid = (pid) => streamMap.has(pid);
    const updateMaxPtsFromPacketStart = (p) => {
        if (!p?.payload || p.payload.length < 14) return;
        if (p.payload[0] !== 0x00 || p.payload[1] !== 0x00 || p.payload[2] !== 0x01) return;
        const ptsDtsFlags = (p.payload[7] >> 6) & 0x03;
        if (ptsDtsFlags < 2) return;
        const ptsHigh = (p.payload[9] >> 1) & 0x07;
        const ptsMid = ((p.payload[10] << 7) | (p.payload[11] >> 1)) & 0x7fff;
        const ptsLow = ((p.payload[12] << 7) | (p.payload[13] >> 1)) & 0x7fff;
        const pts = ptsHigh * 2 ** 30 + ptsMid * 2 ** 15 + ptsLow;
        const prev = maxPtsByPid.get(p.PID) ?? 0;
        if (pts > prev) maxPtsByPid.set(p.PID, pts);
    };
    for (let idx = 0; idx < packets.length; idx++) {
        const p = packets[idx];
        // Fallback for TS samples without PAT/PMT:
        // if payload starts with PES start code, treat PID as parsable stream.
        if (
            !streamMap.has(p.PID) &&
            p.payload_unit_start_indicator === 1 &&
            p.payload &&
            p.payload.length >= 4 &&
            p.payload[0] === 0x00 &&
            p.payload[1] === 0x00 &&
            p.payload[2] === 0x01
        ) {
            streamMap.set(p.PID, {
                elementary_PID: p.PID,
                stream_type: undefined,
                streamTypeName: undefined,
            });
        }
        if (isLargeTs && idx >= TS_ANALYSIS_PACKET_LIMIT) {
            if (isAudioOrVideoPid(p.PID) && p.payload_unit_start_indicator === 1) {
                updateMaxPtsFromPacketStart(p);
            }
            continue;
        }
        pushTsPacketToPesAssembler(p, streamMap, assemblerMap, pesPackets, maxPtsByPid);
    }
    flushAllTsPesAssemblerStates(assemblerMap, pesPackets);
    const scan = {
        packetSize,
        packetCount: packets.length,
        pids: [...new Set(packets.map((p) => p.PID))].sort((a, b) => a - b),
        packets: includePackets ? packets : [],
        pat,
        pmts,
    };
    return buildMpegTsAnalysisResult(fileBytes, scan, pesPackets, streamMap, maxPtsByPid);
}

export const parseMpegTsForAnalysisCodec = Object.freeze({
    buildMpegTsAnalysisResult,
    parseMpegTsForAnalysis,
});

