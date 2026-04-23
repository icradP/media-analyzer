/**
 * 将 `lib/core/MP4Parser.js` 接到 WebSocket-fMP4 管线。
 * 提供两层能力：
 * - `parseIsoBmffBoxesMinimal`: 仅 box 树
 * - `parseIsoBmffForAnalysis`: 提取 format/streams/frames 的轻量分析
 */

import MP4Parser from "../core/MP4Parser.js";
import { parseH264SpsNaluPayload } from "../codec/h264Sps.js";
import { parseHevcSpsNaluPayload } from "../codec/hevcNaluUnits.js";

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{ format: object; formatSpecific: object; streams: []; frames: [] }>}
 */
export async function parseIsoBmffBoxesMinimal(bytes) {
    const parsed = await MP4Parser.parse(bytes);
    return {
        format: {
            formatName: "mp4",
            formatLongName: "ISO Base Media File Format (MP4Parser.parse)",
        },
        formatSpecific: {
            boxes: parsed.boxes ?? [],
            fileData: bytes,
        },
        streams: [],
        frames: [],
    };
}

function walkBoxes(boxes, visitor, parent = null) {
    if (!Array.isArray(boxes)) return;
    for (const box of boxes) {
        visitor(box, parent);
        if (Array.isArray(box.children)) walkBoxes(box.children, visitor, box);
    }
}

function findFirstChild(box, type) {
    return Array.isArray(box?.children) ? box.children.find((c) => c.type === type) || null : null;
}

function getTrackTypeFromHandler(hdlr) {
    const t = hdlr?.data?.handlerType;
    if (t === "vide") return "video";
    if (t === "soun") return "audio";
    if (t === "text" || t === "sbtl" || t === "subt") return "subtitle";
    return "data";
}

function computeDurationSeconds(duration, timescale) {
    return duration != null && timescale ? duration / timescale : 0;
}

function sumEditListDurationSeconds(elstBox, movieTimescale) {
    const entries = elstBox?.data?.entries;
    if (!Array.isArray(entries) || entries.length === 0 || !movieTimescale) return 0;
    let total = 0;
    for (const entry of entries) {
        const segDur = Number(entry?.segmentDuration || 0);
        if (Number.isFinite(segDur) && segDur > 0) total += segDur;
    }
    return total > 0 ? total / movieTimescale : 0;
}

function estimateFrameRate(sttsBox, durationSec, sampleCount) {
    const entries = sttsBox?.data?.entries;
    if (Array.isArray(entries) && entries.length > 0) {
        let totalSamples = 0;
        let totalTicks = 0;
        for (const e of entries) {
            totalSamples += e.count || 0;
            totalTicks += (e.count || 0) * (e.delta || 0);
        }
        if (totalTicks > 0 && durationSec > 0) return totalSamples / durationSec;
    }
    if (durationSec > 0 && sampleCount > 0) return sampleCount / durationSec;
    return undefined;
}

function estimateTrackPayloadBytes(stszBox, sampleCount) {
    const sampleSize = stszBox?.data?.sampleSize || 0;
    const entrySizes = stszBox?.data?.entrySizes;
    if (sampleSize > 0 && sampleCount > 0) return sampleSize * sampleCount;
    if (Array.isArray(entrySizes) && entrySizes.length > 0) {
        return entrySizes.reduce((n, v) => n + (v || 0), 0);
    }
    return 0;
}

function buildSampleOffsets(stscBox, stcoBox, stszBox, sampleCount) {
    if (sampleCount <= 0) return [];
    const stsc = stscBox?.data?.entries;
    const chunkOffsets = stcoBox?.data?.offsets;
    if (!Array.isArray(stsc) || !stsc.length || !Array.isArray(chunkOffsets) || !chunkOffsets.length) {
        return new Array(sampleCount).fill(0);
    }
    const sampleSizes =
        stszBox?.data?.sampleSize > 0
            ? new Array(sampleCount).fill(stszBox.data.sampleSize)
            : Array.isArray(stszBox?.data?.entrySizes)
                ? stszBox.data.entrySizes.slice(0, sampleCount)
                : new Array(sampleCount).fill(0);
    while (sampleSizes.length < sampleCount) sampleSizes.push(0);

    const sampleToChunk = [];
    for (let i = 0; i < stsc.length; i++) {
        const cur = stsc[i];
        const next = stsc[i + 1];
        const startChunk = Math.max(0, (cur?.firstChunk || 1) - 1);
        const endChunk = next ? Math.max(0, (next.firstChunk || 1) - 1) : chunkOffsets.length;
        const perChunk = Math.max(0, cur?.samplesPerChunk || 0);
        for (let c = startChunk; c < endChunk; c++) {
            for (let j = 0; j < perChunk; j++) {
                sampleToChunk.push({
                    chunkIndex: c,
                    sampleIndexInChunk: j,
                    samplesPerChunk: perChunk,
                });
                if (sampleToChunk.length >= sampleCount) break;
            }
            if (sampleToChunk.length >= sampleCount) break;
        }
        if (sampleToChunk.length >= sampleCount) break;
    }
    while (sampleToChunk.length < sampleCount) {
        sampleToChunk.push({
            chunkIndex: Math.max(0, chunkOffsets.length - 1),
            sampleIndexInChunk: 0,
            samplesPerChunk: 1,
        });
    }

    const offsets = [];
    for (let s = 0; s < sampleCount; s++) {
        const mapping = sampleToChunk[s];
        if (!mapping) {
            offsets.push(0);
            continue;
        }
        const chunkBase = chunkOffsets[mapping.chunkIndex] || 0;
        let inChunkOffset = 0;
        for (let n = 0; n < mapping.sampleIndexInChunk; n++) {
            const prevIndex = s - mapping.sampleIndexInChunk + n;
            inChunkOffset += sampleSizes[prevIndex] || 0;
        }
        offsets.push(chunkBase + inChunkOffset);
    }
    return offsets;
}

function channelLayoutFromChannels(channels) {
    if (channels == null) return undefined;
    return (
        {
            1: "Mono",
            2: "Stereo",
            3: "2.1",
            4: "Quad",
            5: "5.0",
            6: "5.1",
            7: "6.1",
            8: "7.1",
        }[channels] || `${channels} channels`
    );
}

function parseVideoCodecDetails(sampleEntry, codecName) {
    if (!sampleEntry) return {};
    if ((codecName === "avc1" || codecName === "avc3") && sampleEntry.config) {
        const cfg = sampleEntry.config;
        const profile = cfg.profile;
        const level = cfg.level;
        let profileName;
        let levelName;
        let chroma;
        let chromaName;
        let bitDepth;
        const firstSps = cfg.sps?.[0];
        if (firstSps && firstSps.length > 3) {
            try {
                const sps = parseH264SpsNaluPayload(firstSps, 0, null, 0);
                profileName = sps.profile_idc;
                levelName = sps.level_idc;
                chroma = sps._chroma_format_idc_value;
                chromaName =
                    typeof sps.chroma_format_idc === "string"
                        ? sps.chroma_format_idc
                        : undefined;
                bitDepth = sps._bit_depth_luma_value;
            } catch {
                // keep avcC base fields
            }
        }
        return {
            profile,
            profileName,
            level,
            levelName,
            chroma,
            chromaName,
            bitDepth: bitDepth ?? 8,
        };
    }
    if ((codecName === "hvc1" || codecName === "hev1") && sampleEntry.config) {
        const cfg = sampleEntry.config;
        let profile = cfg.profile;
        let profileName;
        let level = cfg.level;
        let levelName;
        let chroma = cfg.chroma;
        let chromaName;
        let bitDepth =
            cfg.bitDepthLumaMinus8 != null ? cfg.bitDepthLumaMinus8 + 8 : undefined;
        const firstSps = cfg.sps?.[0];
        if (firstSps && firstSps.length > 4) {
            try {
                const sps = parseHevcSpsNaluPayload(firstSps, 0, null, 0);
                const spsProfile = sps?.profile_tier_level?._general_profile_idc_value;
                const spsProfileName = sps?.profile_tier_level?.general_profile_idc;
                const spsLevel = sps?.profile_tier_level?._general_level_idc_value;
                const spsLevelName = sps?.profile_tier_level?.general_level_idc;
                const spsChroma = sps?._chroma_format_idc_value;
                const spsChromaName =
                    typeof sps.chroma_format_idc === "string"
                        ? sps.chroma_format_idc
                        : undefined;
                const spsBitDepth = sps?._bit_depth_luma_value;
                if (spsProfile != null) profile = spsProfile;
                if (spsProfileName != null) profileName = spsProfileName;
                if (spsLevel != null) level = spsLevel;
                if (spsLevelName != null) levelName = spsLevelName;
                if (spsChroma != null) chroma = spsChroma;
                if (spsChromaName != null) chromaName = spsChromaName;
                if (spsBitDepth != null) bitDepth = spsBitDepth;
            } catch {
                // keep hvcC base fields
            }
        }
        return {
            profile,
            profileName,
            level,
            levelName,
            chroma,
            chromaName,
            bitDepth: bitDepth ?? 8,
        };
    }
    return {};
}

function buildSampleDeltas(sttsBox, sampleCount) {
    const entries = sttsBox?.data?.entries;
    if (!Array.isArray(entries) || entries.length === 0 || sampleCount <= 0) {
        return new Array(sampleCount).fill(0);
    }
    const deltas = [];
    for (const e of entries) {
        const count = e?.count || 0;
        const delta = e?.delta || 0;
        for (let i = 0; i < count && deltas.length < sampleCount; i++) deltas.push(delta);
        if (deltas.length >= sampleCount) break;
    }
    const fallback = entries[entries.length - 1]?.delta || 0;
    while (deltas.length < sampleCount) deltas.push(fallback);
    return deltas;
}

function buildCompositionOffsets(cttsBox, sampleCount) {
    const entries = cttsBox?.data?.entries;
    if (!Array.isArray(entries) || entries.length === 0 || sampleCount <= 0) {
        return new Array(sampleCount).fill(0);
    }
    const offsets = [];
    for (const e of entries) {
        const count = e?.sampleCount || e?.count || 0;
        const offset = e?.sampleOffset || e?.offset || 0;
        for (let i = 0; i < count && offsets.length < sampleCount; i++) offsets.push(offset);
        if (offsets.length >= sampleCount) break;
    }
    while (offsets.length < sampleCount) offsets.push(0);
    return offsets;
}

function computeEditListShiftTicks(elstBox, hasCtts, firstSampleDelta, firstCompositionOffset) {
    const entries = elstBox?.data?.entries;
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    let mediaTime = 0;
    let hasLeadingEmptyEdit = false;
    for (const entry of entries) {
        const mt = entry?.mediaTime;
        if (mt == null) continue;
        if (mt === -1 || mt === 0xffffffff) {
            hasLeadingEmptyEdit = true;
            continue;
        }
        if (mt >= 0) {
            mediaTime = mt;
            break;
        }
    }
    if (!hasCtts) return mediaTime;
    if (hasLeadingEmptyEdit) return mediaTime - (firstSampleDelta || 0);
    if (mediaTime > 0) return mediaTime;
    return firstCompositionOffset || 0;
}

function estimateMp4PictureType(isKeyframe, codecType) {
    if (codecType !== "video") return null;
    // MP4 light mode does not fully parse slice headers; key sample => I, others => P fallback.
    return isKeyframe ? "I" : "P";
}

/**
 * 轻量 MP4/fMP4 分析：track 维度汇总 + 基于 sample table 的帧条目（不解码 NAL）。
 * @param {Uint8Array} bytes
 */
export async function parseIsoBmffForAnalysis(bytes) {
    const parsed = await MP4Parser.parse(bytes);
    const topBoxes = parsed.boxes ?? [];
    let mvhd = null;
    walkBoxes(topBoxes, (b) => {
        if (!mvhd && b.type === "mvhd") mvhd = b;
    });
    const movieDurationSec = computeDurationSeconds(mvhd?.data?.duration, mvhd?.data?.timescale);

    const trakBoxes = [];
    walkBoxes(topBoxes, (b) => {
        if (b.type === "trak") trakBoxes.push(b);
    });

    const streams = [];
    const frames = [];
    let frameIndex = 0;
    for (let i = 0; i < trakBoxes.length; i++) {
        const trak = trakBoxes[i];
        const mdia = findFirstChild(trak, "mdia");
        const hdlr = findFirstChild(mdia, "hdlr");
        const mdhd = findFirstChild(mdia, "mdhd");
        const minf = findFirstChild(mdia, "minf");
        const stbl = findFirstChild(minf, "stbl");
        const stsd = findFirstChild(stbl, "stsd");
        const stsz = findFirstChild(stbl, "stsz");
        const stsc = findFirstChild(stbl, "stsc");
        const stco = findFirstChild(stbl, "stco") || findFirstChild(stbl, "co64");
        const stts = findFirstChild(stbl, "stts");
        const ctts = findFirstChild(stbl, "ctts");
        const stss = findFirstChild(stbl, "stss");
        const tkhd = findFirstChild(trak, "tkhd");
        const edts = findFirstChild(trak, "edts");
        const elst = findFirstChild(edts, "elst");

        const codecType = getTrackTypeFromHandler(hdlr);
        const sampleEntry = stsd?.children?.[0] || stsd?.data?.entries?.[0] || null;
        const codecName = sampleEntry?.type || null;
        const sampleCount = stsz?.data?.sampleCount || 0;
        const mediaDurationSec = computeDurationSeconds(mdhd?.data?.duration, mdhd?.data?.timescale);
        const tkhdDurationSec = computeDurationSeconds(
            tkhd?.data?.duration,
            mvhd?.data?.timescale,
        );
        const presentationDurationSec =
            sumEditListDurationSeconds(elst, mvhd?.data?.timescale) ||
            tkhdDurationSec ||
            mediaDurationSec ||
            movieDurationSec ||
            0;
        const trackDurationSec = mediaDurationSec || movieDurationSec || 0;
        const frameRate = codecType === "video" ? estimateFrameRate(stts, trackDurationSec, sampleCount) : undefined;
        const payloadBytes = estimateTrackPayloadBytes(stsz, sampleCount);
        const videoDetails =
            codecType === "video" ? parseVideoCodecDetails(sampleEntry, codecName) : {};

        streams.push({
            index: i,
            codecType,
            codecName,
            duration: trackDurationSec,
            durationMediaSec: mediaDurationSec || null,
            durationPresentationSec: presentationDurationSec || null,
            frameRate: frameRate != null ? Number(frameRate.toFixed(3)) : undefined,
            width: sampleEntry?.width,
            height: sampleEntry?.height,
            sampleRate: sampleEntry?.sampleRate,
            channels: sampleEntry?.channelCount,
            channelLayout: channelLayoutFromChannels(sampleEntry?.channelCount),
            sampleFormat: sampleEntry?.sampleSize ? `${sampleEntry.sampleSize}-bit` : undefined,
            sampleCount,
            bitrate:
                trackDurationSec > 0 && payloadBytes > 0
                    ? Math.round((payloadBytes * 8) / trackDurationSec)
                    : undefined,
            trackId: tkhd?.data?.trackId ?? null,
            decoderConfig: sampleEntry?.config || undefined,
            editList:
                Array.isArray(elst?.data?.entries) && elst.data.entries.length > 0
                    ? elst.data.entries
                    : undefined,
            ...videoDetails,
        });

        // 仅按 sample table 生成轻量 frame 记录，供上层时间轴/数量展示。
        const syncSet = new Set(stss?.data?.syncSamples || []);
        const sampleDeltas = buildSampleDeltas(stts, sampleCount);
        const compositionOffsets = buildCompositionOffsets(ctts, sampleCount);
        const sampleOffsets = buildSampleOffsets(stsc, stco, stsz, sampleCount);
        const hasCtts = Array.isArray(ctts?.data?.entries) && ctts.data.entries.length > 0;
        const timelineShiftTicks = computeEditListShiftTicks(
            elst,
            hasCtts,
            sampleDeltas[0] || 0,
            compositionOffsets[0] || 0,
        );
        const timescale = mdhd?.data?.timescale || 1;
        streams[streams.length - 1].timelineShiftTicks = timelineShiftTicks;
        streams[streams.length - 1].timelineShiftSec =
            timescale > 0 ? timelineShiftTicks / timescale : undefined;
        let dtsTicks = 0;
        for (let s = 0; s < sampleCount; s++) {
            const oneBased = s + 1;
            const size = stsz?.data?.sampleSize || stsz?.data?.entrySizes?.[s] || 0;
            const isKeyframe = syncSet.size > 0 ? syncSet.has(oneBased) : codecType !== "video";
            const pictureType = estimateMp4PictureType(isKeyframe, codecType);
            const sampleDelta = sampleDeltas[s] || 0;
            const compositionOffset = compositionOffsets[s] || 0;
            const ptsTicks = dtsTicks + compositionOffset - timelineShiftTicks;
            const normalizedDts = dtsTicks - timelineShiftTicks;
            frames.push({
                index: frameIndex++,
                streamIndex: i,
                mediaType: codecType,
                codecName: codecName || undefined,
                pts: ptsTicks,
                dts: normalizedDts,
                ptsTime: ptsTicks / timescale,
                dtsTime: normalizedDts / timescale,
                offset: sampleOffsets[s] || 0,
                size,
                flags: pictureType === "I" ? "K" : "_",
                isKeyframe,
                pictureType: pictureType || undefined,
                displayName: `${codecName || "sample"} #${oneBased}`,
                formatSpecific: {
                    sampleIndex: oneBased,
                    sampleDelta,
                    compositionOffset,
                    timelineShiftTicks,
                    sampleOffset: sampleOffsets[s] || 0,
                    pictureType: pictureType || undefined,
                },
            });
            dtsTicks += sampleDelta;
        }
    }

    return {
        format: {
            formatName: "mp4",
            formatLongName: "ISO Base Media File Format (light analysis)",
            duration: movieDurationSec || undefined,
            size: bytes.byteLength,
        },
        formatSpecific: {
            boxes: topBoxes,
            fileData: bytes,
        },
        streams,
        frames,
    };
}

export const mp4ParserWsAdapterCodec = Object.freeze({
    parseIsoBmffBoxesMinimal,
    parseIsoBmffForAnalysis,
});
