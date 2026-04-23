const FORMAT_KEYS = Object.freeze([
    "flv",
    "mp4",
    "ts",
    "ps",
    "rtp",
    "mkv",
    "h264",
    "h265",
    "mp3",
    "wav",
    "flac",
    "opus",
]);

function resolveFormatKey(resultMap, preferredFormat = null) {
    if (preferredFormat && resultMap?.[preferredFormat]) return preferredFormat;
    for (const key of FORMAT_KEYS) {
        if (resultMap?.[key]) return key;
    }
    return null;
}

function pickPrimaryResult(resultMap, preferredFormat = null) {
    const formatKey = resolveFormatKey(resultMap, preferredFormat);
    return {
        formatKey,
        result: formatKey ? resultMap?.[formatKey] : null,
    };
}

function pickPictureType(frame) {
    return (
        frame?.pictureType ??
        frame?.formatSpecific?.pictureType ??
        frame?.formatSpecific?._pictureType ??
        null
    );
}

function pickTimestampMs(frame) {
    if (Number.isFinite(frame?.ptsTime)) return Math.round(frame.ptsTime * 1000);
    if (Number.isFinite(frame?.dtsTime)) return Math.round(frame.dtsTime * 1000);
    if (Number.isFinite(frame?.pts)) return frame.pts;
    if (Number.isFinite(frame?.dts)) return frame.dts;
    if (Number.isFinite(frame?.timestamp)) return frame.timestamp;
    return null;
}

function normalizeFrame(frame, index) {
    const pictureType = pickPictureType(frame);
    const mediaType = frame?.mediaType || frame?.formatSpecific?.mediaType || "video";
    return {
        type: "frame",
        data: frame?.formatSpecific || {},
        displayName: frame?.displayName || `Frame #${index}`,
        index,
        _index: index,
        _mediaType: mediaType,
        _timestamp: frame?.timestamp ?? frame?.pts ?? frame?.dts ?? null,
        _pts: pickTimestampMs(frame),
        _size: frame?.size ?? null,
        _pictureType: pictureType,
        _isKeyFrame: Boolean(frame?.isKeyframe || frame?.isKeyFrame),
        _interval: frame?.interval ?? null,
        _remark: frame?.remark || frame?.codecName || "-",
        _codecFormat: frame?.codecName || "-",
        _rawFrame: frame,
    };
}

export function getFrames(resultMap, preferredFormat = null) {
    const { result } = pickPrimaryResult(resultMap, preferredFormat);
    if (!result || !Array.isArray(result.frames)) return [];
    return result.frames.map((frame, index) => normalizeFrame(frame, index));
}

export function getFilteredFrames(resultMap, mediaType = "all", preferredFormat = null) {
    const frames = getFrames(resultMap, preferredFormat);
    if (!mediaType || mediaType === "all") return frames;
    return frames.filter((f) => f._mediaType === mediaType);
}

export function getAvailableMediaTypes(resultMap, preferredFormat = null) {
    const { result } = pickPrimaryResult(resultMap, preferredFormat);
    if (!result || !Array.isArray(result.frames)) return [];
    const set = new Set();
    for (const frame of result.frames) {
        set.add(frame?.mediaType || frame?.formatSpecific?.mediaType || "video");
    }
    return Array.from(set);
}

export function getFormatAndCodec(resultMap, preferredFormat = null) {
    const { formatKey, result } = pickPrimaryResult(resultMap, preferredFormat);
    if (!result) return { format: null, codec: null };
    const streams = Array.isArray(result.streams) ? result.streams : [];
    const video = streams.find((s) => s.codecType === "video");
    return {
        format: formatKey,
        codec: video?.codecName || null,
    };
}

export const multiFormatFrameAdapterCodec = Object.freeze({
    FORMAT_KEYS,
    resolveFormatKey,
    pickPrimaryResult,
    getFrames,
    getFilteredFrames,
    getAvailableMediaTypes,
    getFormatAndCodec,
});
