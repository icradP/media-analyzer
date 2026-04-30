/**
 * FLV 整文件分析：**仅数据处理**（`Uint8Array` → `format` / `streams` / `frames` / `formatSpecific`）。
 * 无 UI 节点树；`frames[].formatSpecific` 为 `parseFlvTagAt` 的纯数据对象（无 `_displayMetadata` / 截断 raw）。
 */

import Be from "../core/Be.js";
import { parseFlvTagAt } from "./flvTagParse.js";
import {
    flvMetadataAudioCodecName,
    flvMetadataVideoCodecName,
    flvVideoTagBodyBitLength,
} from "./flvMediaLabels.js";
import { getAacRiProfileName } from "./aacMpeg4Constants.js";
import {
    bitrateBpsFromBytesAndDuration,
    frameRateFromFrameCountAndDuration,
} from "../core/mediaMath.js";

/** @template T @param {T} value @param {string} source */
export function sourceEntry(value, source) {
    return { value, source };
}

/** 多来源字段合并 */
export class StreamBuilder {
    /** @param {number} index @param {"video"|"audio"} codecType */
    constructor(index, codecType) {
        this.stream = { index, codecType };
        this.sources = {};
        this.alternatives = {};
    }

    /**
     * @param {string} key
     * @param {unknown} value
     * @param {string} [source]
     */
    setField(key, value, source) {
        if (value != null) {
            this.stream[key] = value;
            this.sources[key] = source;
        }
        return this;
    }

    /**
     * @param {string} key
     * @param {{ value: unknown; source: string }[]} candidates
     */
    setFieldWithPriority(key, candidates) {
        let chosen;
        let chosenSource;
        const all = [];
        for (const o of candidates) {
            if (o.value !== undefined && o.value !== null) {
                all.push({ value: o.value, source: o.source });
                if (chosen === undefined) {
                    chosen = o.value;
                    chosenSource = o.source;
                }
            }
        }
        if (chosen !== undefined && chosenSource !== undefined) {
            this.stream[key] = chosen;
            this.sources[key] = chosenSource;
            if (
                all.length > 1 &&
                all.some((f) => JSON.stringify(f.value) !== JSON.stringify(chosen))
            ) {
                this.alternatives[key] = all.filter(
                    (f) => JSON.stringify(f.value) !== JSON.stringify(chosen),
                );
            }
        }
        return this;
    }

    /** @param {Record<string, unknown>} fields */
    setFields(fields) {
        Object.assign(this.stream, fields);
        return this;
    }

    build() {
        if (Object.keys(this.sources).length > 0) {
            this.stream._sources = this.sources;
        }
        if (Object.keys(this.alternatives).length > 0) {
            this.stream._alternatives = this.alternatives;
        }
        return this.stream;
    }
}

/** FLV 文件头解析；仅数据字段。 */
export function parseFlvFileHeader(view, offset = 0) {
    const fieldOffsets = {};
    const r = new Uint8Array(view.buffer, view.byteOffset + offset, 9);
    const reader = new Be(r, 0, offset, fieldOffsets, "");
    const signature = reader.readString(3, "signature");
    const version = reader.readBits(8, "version");
    reader.skip(5);
    const TypeFlagsAudio = reader.readBits(1, "TypeFlagsAudio");
    reader.skip(1);
    const TypeFlagsVideo = reader.readBits(1, "TypeFlagsVideo");
    const dataOffset = reader.readBits(32, "dataOffset");
    return {
        signature,
        version,
        TypeFlagsAudio,
        TypeFlagsVideo,
        dataOffset,
        fieldOffsets,
        byteOffset: offset,
        byteLength: 9,
    };
}

export function isFlvConfigOrKeyframeTag(tag) {
    return (
        tag.tagType === 18 ||
        (tag.tagType === 9 &&
            (tag._avcPacketType_value === 0 ||
                tag._avcPacketType_value === 2 ||
                tag._hevcPacketType_value === 0 ||
                (tag._isExHeader_value === 1 && tag._packetType_value === 0) ||
                (tag._isExHeader_value === 1 && tag._packetType_value === 2) ||
                (tag._isExHeader_value === 1 && tag._packetType_value === 4) ||
                (tag._isExHeader_value === 1 && tag._packetType_value === 5))) ||
        (tag.tagType === 8 && tag._aacPacketType_value === 0)
    );
}

/**
 * @param {Record<string, unknown>|null|undefined} scriptMeta
 * @param {Record<string, unknown>|null|undefined} videoSeqHdr
 * @param {Record<string, unknown>|null|undefined} audioAsc
 * @param {number} maxTimestampMs
 * @param {number} totalPayloadBytes
 * @param {number} videoPayloadBytes
 * @param {number} audioPayloadBytes
 * @param {number} codedVideoFrameCount
 */
export function buildFlvMetadataSummary(
    scriptMeta,
    videoSeqHdr,
    audioAsc,
    maxTimestampMs,
    totalPayloadBytes,
    videoPayloadBytes,
    audioPayloadBytes,
    codedVideoFrameCount,
) {
    const sources = {};
    const out = { sources };
    if (scriptMeta?.duration !== undefined) {
        out.duration = scriptMeta.duration;
        sources.duration = "metadata";
    } else if (maxTimestampMs > 0) {
        out.duration = maxTimestampMs / 1000;
        sources.duration = `${maxTimestampMs}/1000`;
    }
    if (videoSeqHdr || scriptMeta || videoPayloadBytes > 0) {
        out.video = {};
        if (videoSeqHdr?.codec) {
            out.video.codec = videoSeqHdr.codec;
            sources.videoCodec = "sps";
        } else if (scriptMeta?.videocodecid !== undefined) {
            const codec = flvMetadataVideoCodecName(scriptMeta.videocodecid);
            if (codec !== undefined) {
                out.video.codec = codec;
                sources.videoCodec = "metadata";
            }
        }
        if (videoSeqHdr?.width && videoSeqHdr?.height) {
            out.video.width = videoSeqHdr.width;
            out.video.height = videoSeqHdr.height;
            sources.videoWidth = "sps";
            sources.videoHeight = "sps";
        } else if (scriptMeta?.width && scriptMeta?.height) {
            out.video.width = scriptMeta.width;
            out.video.height = scriptMeta.height;
            sources.videoWidth = "metadata";
            sources.videoHeight = "metadata";
        }
        if (videoSeqHdr?.profile) out.video.profile = videoSeqHdr.profile;
        if (videoSeqHdr?.level) out.video.level = videoSeqHdr.level;
        if (scriptMeta?.framerate !== undefined) {
            out.video.frameRate = scriptMeta.framerate;
            sources.videoFrameRate = "metadata";
        } else if (videoSeqHdr?.frameRate) {
            out.video.frameRate = videoSeqHdr.frameRate;
            sources.videoFrameRate = "sps";
        } else if (out.duration && out.duration > 0 && codedVideoFrameCount > 0) {
            out.video.frameRate = frameRateFromFrameCountAndDuration(codedVideoFrameCount, out.duration);
            sources.videoFrameRate = `${codedVideoFrameCount}/${out.duration.toFixed(3)}`;
        }
        if (
            scriptMeta?.videodatarate != null &&
            typeof scriptMeta.videodatarate === "number" &&
            scriptMeta.videodatarate > 0
        ) {
            out.video.bitrate = Math.round(scriptMeta.videodatarate * 1000);
            sources.videoBitrate = "metadata";
        } else if (out.duration && out.duration > 0 && videoPayloadBytes > 0) {
            out.video.bitrate = bitrateBpsFromBytesAndDuration(videoPayloadBytes, out.duration);
            sources.videoBitrate = `${videoPayloadBytes}*8/${out.duration.toFixed(3)}`;
        }
    }
    if (audioAsc || scriptMeta || audioPayloadBytes > 0) {
        out.audio = {};
        if (audioAsc?._profile != null) {
            out.audio.codec = "AAC";
            out.audio.profile = audioAsc._profile;
            sources.audioCodec = "AudioSpecificConfig";
            sources.audioProfile = "AudioSpecificConfig";
        } else if (scriptMeta?.audiocodecid !== undefined) {
            const codec = flvMetadataAudioCodecName(scriptMeta.audiocodecid);
            if (codec !== undefined) {
                out.audio.codec = codec;
                sources.audioCodec = "metadata";
            }
        }
        if (audioAsc?._samplingFrequency_value) {
            out.audio.sampleRate = audioAsc._samplingFrequency_value;
            sources.audioSampleRate = "AudioSpecificConfig";
        } else if (scriptMeta?.audiosamplerate !== undefined) {
            out.audio.sampleRate = scriptMeta.audiosamplerate;
            sources.audioSampleRate = "metadata";
        }
        if (audioAsc?._channelConfiguration_value != null) {
            out.audio.channels = audioAsc._channelConfiguration_value;
            out.audio.channelLayout = audioAsc._channelLayout;
            sources.audioChannels = "AudioSpecificConfig";
        } else if (scriptMeta?.stereo !== undefined) {
            out.audio.channels = scriptMeta.stereo ? 2 : 1;
            sources.audioChannels = "metadata";
        }
        if (
            scriptMeta?.audiodatarate != null &&
            typeof scriptMeta.audiodatarate === "number" &&
            scriptMeta.audiodatarate > 0
        ) {
            out.audio.bitrate = Math.round(scriptMeta.audiodatarate * 1000);
            sources.audioBitrate = "metadata";
        } else if (out.duration && out.duration > 0 && audioPayloadBytes > 0) {
            out.audio.bitrate = bitrateBpsFromBytesAndDuration(audioPayloadBytes, out.duration);
            sources.audioBitrate = `${audioPayloadBytes}*8/${out.duration.toFixed(3)}`;
        }
    }
    let sumBr = 0;
    const parts = [];
    if (out.video?.bitrate) {
        sumBr += out.video.bitrate;
        parts.push(`video:${out.video.bitrate}`);
    }
    if (out.audio?.bitrate) {
        sumBr += out.audio.bitrate;
        parts.push(`audio:${out.audio.bitrate}`);
    }
    if (sumBr > 0) {
        out.bitrate = sumBr;
        sources.bitrate = parts.join("+");
    } else if (
        scriptMeta?.totaldatarate != null &&
        typeof scriptMeta.totaldatarate === "number" &&
        scriptMeta.totaldatarate > 0
    ) {
        out.bitrate = Math.round(scriptMeta.totaldatarate * 1000);
        sources.bitrate = "metadata";
    } else if (out.duration && out.duration > 0 && totalPayloadBytes > 0) {
        out.bitrate = bitrateBpsFromBytesAndDuration(totalPayloadBytes, out.duration);
        sources.bitrate = `${totalPayloadBytes}*8/${out.duration.toFixed(3)}`;
    }
    return out;
}

/**
 * @param {Uint8Array} fileBytes
 * @param {Record<string, unknown>} header
 * @param {Record<string, unknown>[]} tags
 * @param {ReturnType<typeof buildFlvMetadataSummary>} summary
 * @param {Record<string, unknown>|null} scriptMeta
 * @param {boolean} hasVideo
 * @param {boolean} hasAudio
 * @param {Record<string, unknown>|null} naluSpsInfo
 * @param {number} iFrames
 * @param {number} pFrames
 * @param {number} bFrames
 */
export function buildFlvAnalysisResult(
    fileBytes,
    header,
    tags,
    summary,
    scriptMeta,
    hasVideo,
    hasAudio,
    naluSpsInfo,
    iFrames,
    pFrames,
    bFrames,
) {
    const format = {
        formatName: "flv",
        formatLongName: "FLV (Flash Video)",
        duration: summary.duration,
        bitrate: summary.bitrate,
        size: fileBytes.byteLength,
        metadata: scriptMeta || {},
    };
    const codedTotal = iFrames + pFrames + bFrames;
    const frameStats =
        codedTotal > 0
            ? {
                  total: codedTotal,
                  iFrames,
                  pFrames,
                  bFrames,
                  iPercent: ((iFrames / codedTotal) * 100).toFixed(1),
                  pPercent: ((pFrames / codedTotal) * 100).toFixed(1),
                  bPercent: ((bFrames / codedTotal) * 100).toFixed(1),
              }
            : undefined;
    const src = summary.sources || {};
    const streams = [];
    if (hasVideo) {
        const sb = new StreamBuilder(0, "video");
        sb.setFieldWithPriority("codecName", [
            sourceEntry(naluSpsInfo?.codecName, "sps"),
            sourceEntry(summary.video?.codec, src.videoCodec || "metadata"),
        ]);
        sb.setFieldWithPriority("width", [
            sourceEntry(naluSpsInfo?.width, "sps"),
            sourceEntry(summary.video?.width, src.videoWidth || "metadata"),
        ]);
        sb.setFieldWithPriority("height", [
            sourceEntry(naluSpsInfo?.height, "sps"),
            sourceEntry(summary.video?.height, src.videoHeight || "metadata"),
        ]);
        sb.setField("frameRate", summary.video?.frameRate, src.videoFrameRate || "calculated");
        sb.setField("bitrate", summary.video?.bitrate, src.videoBitrate || "calculated");
        sb.setField("duration", summary.duration, src.duration || "calculated");
        if (naluSpsInfo) {
            sb.setField("profile", naluSpsInfo.profile, "sps")
                .setField("profileName", naluSpsInfo.profileName, "sps")
                .setField("level", naluSpsInfo.level, "sps")
                .setField("levelName", naluSpsInfo.levelName, "sps")
                .setField("chroma", naluSpsInfo.chroma, "sps")
                .setField("chromaName", naluSpsInfo.chromaName, "sps")
                .setField("bitDepth", naluSpsInfo.bitDepth, "sps");
        }
        sb.setFields({ frameStats });
        streams.push(sb.build());
    }
    if (hasAudio) {
        const sb = new StreamBuilder(hasVideo ? 1 : 0, "audio");
        const prof = summary.audio?.profile;
        sb.setField("codecName", summary.audio?.codec, src.audioCodec || "metadata")
            .setField("profile", prof, src.audioProfile || "AudioSpecificConfig")
            .setField("profileName", getAacRiProfileName(prof), src.audioProfile || "AudioSpecificConfig")
            .setField("sampleRate", summary.audio?.sampleRate, src.audioSampleRate || "AudioSpecificConfig")
            .setField("channels", summary.audio?.channels, src.audioChannels || "AudioSpecificConfig")
            .setField("channelLayout", summary.audio?.channelLayout, src.audioChannels || "AudioSpecificConfig")
            .setField("bitrate", summary.audio?.bitrate, src.audioBitrate || "calculated")
            .setField("duration", summary.duration, src.duration || "calculated");
        streams.push(sb.build());
    }
    const frames = [];
    const typeNames = { 8: "Audio", 9: "Video", 18: "Script" };
    let lastVideoTs = null;
    let lastAudioTs = null;
    for (let idx = 0; idx < tags.length; idx++) {
        const tag = tags[idx];
        const tt = tag.tagType ?? 0;
        const mediaType = tt === 9 ? "video" : tt === 8 ? "audio" : "data";
        const name = typeNames[tt] || "Unknown";
        const dts = tag.timestampFull ?? tag.timestamp ?? 0;
        const comp = tt === 9 && typeof tag.compositionTime === "number" ? tag.compositionTime : 0;
        const pts = dts + comp;
        const isCfg = isFlvConfigOrKeyframeTag(tag);
        let interval = null;
        if (!isCfg) {
            if (mediaType === "video") {
                if (lastVideoTs !== null) interval = dts - lastVideoTs;
                lastVideoTs = dts;
            } else if (mediaType === "audio") {
                if (lastAudioTs !== null) interval = dts - lastAudioTs;
                lastAudioTs = dts;
            }
        }
        frames.push({
            index: idx,
            streamIndex: tt === 9 ? 0 : tt === 8 ? 1 : -1,
            mediaType,
            codecName: tag.codecFormat || undefined,
            pts,
            ptsTime: pts / 1000,
            dts,
            dtsTime: dts / 1000,
            duration: 0,
            durationTime: 0,
            size: tag.dataSize ?? 0,
            offset: tag.offset ?? 0,
            flags: tag._frameType_value === 1 ? "K" : "_",
            isKeyframe: tag._frameType_value === 1,
            pictureType: tag.pictureType || undefined,
            displayName: `Tag #${idx} - ${name}`,
            remark: tag.remark || "",
            interval: isCfg ? null : interval,
            formatSpecific: tag,
        });
    }
    const mediaFrameCount = tags.filter((t) => !isFlvConfigOrKeyframeTag(t)).length;
    return {
        format,
        streams,
        frames,
        formatSpecific: {
            header,
            totalFrames: mediaFrameCount,
            fileData: fileBytes,
        },
    };
}

/**
 * @param {Uint8Array} fileBytes
 * @returns {ReturnType<typeof buildFlvAnalysisResult>}
 */
export function parseFlvFileForAnalysis(fileBytes) {
    const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
    let i = 0;
    const header = parseFlvFileHeader(dv, i);
    i += 9;
    i += 4;
    const tags = [];
    let maxTs = 0;
    let videoPayloadSum = 0;
    let audioPayloadSum = 0;
    let totalPayloadSum = 0;
    let hasVideo = false;
    let hasAudio = false;
    let iFrames = 0;
    let pFrames = 0;
    let bFrames = 0;
    let scriptMeta = null;
    let videoSeqHdr = null;
    let audioAsc = null;
    let naluSpsInfo = null;
    let seqConfig = null;
    for (; i < fileBytes.byteLength - 4; ) {
        let tag;
        try {
            tag = parseFlvTagAt(fileBytes, i, seqConfig);
        } catch (e) {
            console.error(`Error parsing tag at offset ${i}:`, e);
            break;
        }
        if (!tag) break;
        tags.push(tag);
        const tf = tag.timestampFull ?? 0;
        if (tf > maxTs) maxTs = tf;
        let payloadBytes = 0;
        if (tag.tagType === 9) {
            hasVideo = true;
            payloadBytes = (tag.dataSize ?? 0) - flvVideoTagBodyBitLength(tag);
            videoPayloadSum += payloadBytes;
            if (tag.sequenceHeader && !videoSeqHdr) videoSeqHdr = tag.sequenceHeader;
            if (tag._naluSpsInfo && !naluSpsInfo) naluSpsInfo = tag._naluSpsInfo;
            if (
                tag._avcPacketType_value === 1 ||
                tag._hevcPacketType_value === 1 ||
                tag._packetType_value === 1 ||
                tag._packetType_value === 3
            ) {
                if (tag.pictureType === "I") iFrames++;
                else if (tag.pictureType === "P") pFrames++;
                else if (tag.pictureType === "B") bFrames++;
            }
            if (tag.sequenceHeader) seqConfig = tag.sequenceHeader;
        } else if (tag.tagType === 8) {
            hasAudio = true;
            payloadBytes = (tag.dataSize ?? 0) - 2;
            audioPayloadSum += payloadBytes;
            if (tag.audioSpecificConfig && !audioAsc) audioAsc = tag.audioSpecificConfig;
        } else if (tag.tagType === 18 && tag.metadata && !scriptMeta) {
            scriptMeta = tag.metadata;
        }
        totalPayloadSum += payloadBytes;
        i += 11 + (tag.dataSize ?? 0) + 4;
    }
    const codedVideoCount = iFrames + pFrames + bFrames;
    const summary = buildFlvMetadataSummary(
        scriptMeta,
        videoSeqHdr,
        audioAsc,
        maxTs,
        totalPayloadSum,
        videoPayloadSum,
        audioPayloadSum,
        codedVideoCount,
    );
    return buildFlvAnalysisResult(
        fileBytes,
        header,
        tags,
        summary,
        scriptMeta,
        hasVideo,
        hasAudio,
        naluSpsInfo,
        iFrames,
        pFrames,
        bFrames,
    );
}

export const flvAnalysisCodec = Object.freeze({
    parseFlvFileHeader,
    parseFlvFileForAnalysis,
    buildFlvMetadataSummary,
    buildFlvAnalysisResult,
    StreamBuilder,
    sourceEntry,
    isFlvConfigOrKeyframeTag,
});
