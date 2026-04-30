import { parseFlvFileForAnalysis } from "./flvAnalysis.js";
import { parseMpegTsForAnalysis } from "../mpegTs/parseMpegTsForAnalysis.js";
import { parseMpegPsForAnalysis } from "../mpegPs/psParse.js";
import { parseIsoBmffForAnalysis } from "../streaming/mp4ParserWsAdapter.js";
import { detectMpegTsPacketSize } from "../mpegTs/tsPacketSize.js";
import { parseMinimalAudioByFormat } from "./audioMinimalAnalysis.js";
import {
    coarseLooksLikeMp4OrFmp4,
    isFlacSignature,
    isFlvSignaturePrefix,
    isMp3Signature,
    isOggOpusSignature,
    isPsPackHeader,
    isWavSignature,
} from "../core/mediaSignatures.js";

function pickPrimaryStream(streams, codecType) {
    return streams.find((s) => s.codecType === codecType) || null;
}

function computeVideoFrameStats(frames, primaryVideoStream) {
    if (primaryVideoStream?.frameStats) return primaryVideoStream.frameStats;
    let iFrames = 0;
    let pFrames = 0;
    let bFrames = 0;
    for (const f of frames) {
        if (f.mediaType !== "video") continue;
        const pictureType =
            f.pictureType ||
            f.formatSpecific?.pictureType ||
            f.formatSpecific?._pictureType ||
            null;
        if (pictureType === "I") iFrames++;
        else if (pictureType === "P") pFrames++;
        else if (pictureType === "B") bFrames++;
        else if (f.isKeyframe) iFrames++;
    }
    const total = iFrames + pFrames + bFrames;
    return total > 0 ? { total, iFrames, pFrames, bFrames } : null;
}

function extractParenLabel(v) {
    const s = String(v ?? "");
    const m = s.match(/\(([^)]+)\)/);
    return m ? m[1] : s || null;
}

function normalizeChromaValue(v) {
    if (v == null) return null;
    const s = String(v);
    if (s.includes("4:2:0")) return "4:2:0";
    if (s.includes("4:2:2")) return "4:2:2";
    if (s.includes("4:4:4")) return "4:4:4";
    if (/^\d+$/.test(s)) {
        const n = Number(s);
        if (n === 1) return "4:2:0";
        if (n === 2) return "4:2:2";
        if (n === 3) return "4:4:4";
    }
    return s;
}

function normalizeVideoProfile(codec, rawProfile, rawProfileName) {
    if (rawProfileName) return extractParenLabel(rawProfileName);
    if (typeof rawProfile === "string") return extractParenLabel(rawProfile);
    const n = Number(rawProfile);
    if (!Number.isFinite(n)) return rawProfile ?? null;
    if (codec === "h264") {
        if (n === 66) return "Baseline";
        if (n === 77) return "Main";
        if (n === 100) return "High";
    }
    if (codec === "h265") {
        if (n === 1) return "Main";
        if (n === 2) return "Main 10";
    }
    return String(n);
}

function normalizeVideoLevel(codec, rawLevel, rawLevelName) {
    if (rawLevelName) {
        const p = extractParenLabel(rawLevelName);
        const m = String(p).match(/(\d+(?:\.\d+)?)/);
        return m ? m[1] : p;
    }
    if (typeof rawLevel === "string") {
        const p = extractParenLabel(rawLevel);
        const m = String(p).match(/(\d+(?:\.\d+)?)/);
        return m ? m[1] : p;
    }
    const n = Number(rawLevel);
    if (!Number.isFinite(n)) return rawLevel ?? null;
    if (codec === "h264") return (n / 10).toFixed(1);
    if (codec === "h265") return (n / 30).toFixed(1);
    return String(n);
}

function buildMediaOverview(result, detectedFormat, options = {}) {
    const streams = Array.isArray(result?.streams) ? result.streams : [];
    const frames = Array.isArray(result?.frames) ? result.frames : [];
    const format = result?.format || {};
    const fileMeta = options.fileMeta || {};
    const primaryVideo = pickPrimaryStream(streams, "video");
    const primaryAudio = pickPrimaryStream(streams, "audio");
    const primarySubtitle =
        pickPrimaryStream(streams, "subtitle") || pickPrimaryStream(streams, "text");
    const stats = computeVideoFrameStats(frames, primaryVideo);
    const codecNorm = String(primaryVideo?.codecName || "").toLowerCase();
    const codecFamily =
        codecNorm.includes("264") || codecNorm.includes("avc")
            ? "h264"
            : codecNorm.includes("265") || codecNorm.includes("hevc") || codecNorm.includes("hev1") || codecNorm.includes("hvc1")
              ? "h265"
              : null;
    const width = primaryVideo?.width;
    const height = primaryVideo?.height;
    const fileSize =
        fileMeta.fileSize ??
        format.size ??
        result?.formatSpecific?.fileData?.byteLength ??
        null;
    const fileWarnings = [];
    if (!streams.length) fileWarnings.push("noStreams");
    if (!frames.length) fileWarnings.push("noFrames");
    const noStreams = streams.length === 0;
    const fallbackFrameCount =
        streams.reduce(
            (n, s) => n + (s?.frameCount ?? s?.sampleCount ?? 0),
            0,
        ) || 0;
    const fsTotalFrames = result?.formatSpecific?.totalFrames;
    const totalFrames =
        typeof fsTotalFrames === "number" && fsTotalFrames >= 0
            ? fsTotalFrames
            : frames.length > 0
              ? frames.length
              : fallbackFrameCount;
    return {
        general: {
            fileName: fileMeta.fileName ?? null,
            fileSize,
            fileType: fileMeta.fileType ?? detectedFormat ?? format.formatName ?? "unknown",
            lastModified: fileMeta.lastModified ?? null,
            streams: streams.length,
            totalFrames,
            noStreams,
            fileWarnings,
        },
        videoInfo: {
            streamIndex: primaryVideo?.index ?? null,
            videoCodec: primaryVideo?.codecName ?? null,
            width: width ?? null,
            height: height ?? null,
            resolution:
                width != null && height != null ? `${width}x${height}` : null,
            aspectRatio:
                width != null && height ? Number((width / height).toFixed(4)) : null,
            totalPixels:
                width != null && height != null ? width * height : null,
            frameRate: primaryVideo?.frameRate ?? null,
            profile: normalizeVideoProfile(codecFamily, primaryVideo?.profile, primaryVideo?.profileName),
            level: normalizeVideoLevel(codecFamily, primaryVideo?.level, primaryVideo?.levelName),
            chroma: normalizeChromaValue(primaryVideo?.chromaName ?? primaryVideo?.chroma),
            bitDepth: primaryVideo?.bitDepth ?? null,
            durationSec: primaryVideo?.duration ?? format.duration ?? null,
            durationMediaSec: primaryVideo?.durationMediaSec ?? null,
            durationPresentationSec: primaryVideo?.durationPresentationSec ?? null,
            videoBitrate: primaryVideo?.bitrate ?? null,
            iFrames: stats?.iFrames ?? null,
            pFrames: stats?.pFrames ?? null,
            bFrames: stats?.bFrames ?? null,
        },
        audioInfo: {
            streamIndex: primaryAudio?.index ?? null,
            audioCodec: primaryAudio?.codecName ?? null,
            sampleRate: primaryAudio?.sampleRate ?? null,
            channels: primaryAudio?.channels ?? null,
            channelLayout: primaryAudio?.channelLayout ?? null,
            sampleFormat: primaryAudio?.sampleFormat ?? null,
            durationSec: primaryAudio?.duration ?? format.duration ?? null,
            durationMediaSec: primaryAudio?.durationMediaSec ?? null,
            durationPresentationSec: primaryAudio?.durationPresentationSec ?? null,
            audioBitrate: primaryAudio?.bitrate ?? null,
        },
        subtitleInfo: {
            streamIndex: primarySubtitle?.index ?? null,
            subtitleCodec: primarySubtitle?.codecName ?? null,
        },
    };
}

/**
 * @param {Uint8Array} bytes
 * @returns {"flv"|"mpeg-ts"|"ps"|"mp4"|"wav"|"mp3"|"flac"|"opus"|"unknown"}
 */
export function detectContainerFormat(bytes) {
    if (!bytes || bytes.length === 0) return "unknown";
    if (isFlvSignaturePrefix(bytes)) return "flv";
    if (detectMpegTsPacketSize(bytes) != null) return "mpeg-ts";
    if (isPsPackHeader(bytes)) return "ps";
    if (coarseLooksLikeMp4OrFmp4(bytes)) return "mp4";
    if (isWavSignature(bytes)) return "wav";
    if (isFlacSignature(bytes)) return "flac";
    if (isOggOpusSignature(bytes)) return "opus";
    if (isMp3Signature(bytes)) return "mp3";
    return "unknown";
}

/**
 * Unified analysis entry for mediaanlyzer lib.
 * @param {Uint8Array} bytes
 * @param {{
 *   forceFormat?: "flv"|"mpeg-ts"|"ps"|"mp4"|"wav"|"mp3"|"flac"|"opus";
 *   ts?: { maxPackets?: number; includePackets?: boolean };
 *   ps?: { maxPackets?: number; includePacketList?: boolean; includeRawPayload?: boolean };
 * }} [options]
 */
export async function analyzeByDetectedFormat(bytes, options = {}) {
    const format = options.forceFormat || detectContainerFormat(bytes);
    let out;
    if (format === "flv") out = parseFlvFileForAnalysis(bytes);
    else if (format === "mpeg-ts") out = parseMpegTsForAnalysis(bytes, options.ts || {});
    else if (format === "ps") out = parseMpegPsForAnalysis(bytes, options.ps || {});
    else if (format === "mp4") out = await parseIsoBmffForAnalysis(bytes);
    else if (format === "wav" || format === "mp3" || format === "flac" || format === "opus")
        out = parseMinimalAudioByFormat(bytes, format);
    else
        out = {
        format: {
            formatName: "unknown",
            formatLongName: "Unknown / unsupported container",
            size: bytes?.byteLength || 0,
        },
        streams: [],
        frames: [],
        formatSpecific: { fileData: bytes },
    };
    if (!out) {
        out = {
            format: {
                formatName: "unknown",
                formatLongName: "Unknown / unsupported container",
                size: bytes?.byteLength || 0,
            },
            streams: [],
            frames: [],
            formatSpecific: { fileData: bytes },
        };
    }
    if (!out.formatSpecific) out.formatSpecific = {};
    out.formatSpecific.mediaOverview = buildMediaOverview(out, format, options);
    return out;
}

export const analyzeByDetectedFormatCodec = Object.freeze({
    detectContainerFormat,
    analyzeByDetectedFormat,
    buildMediaOverview,
});
