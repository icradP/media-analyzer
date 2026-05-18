const FLV_VIDEO_CODEC_ID_LABELS = Object.freeze({
    7: "H.264",
    12: "H.265",
});

const MP4_SAMPLE_ENTRY_LABELS = Object.freeze({
    avc1: "H.264",
    avc3: "H.264",
    av01: "AV1",
    vp09: "VP9",
    hvc1: "H.265",
    hev1: "H.265",
});

export function fourccFromUint32(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
    const u = n >>> 0;
    const label = String.fromCharCode(
        (u >>> 24) & 0xff,
        (u >>> 16) & 0xff,
        (u >>> 8) & 0xff,
        u & 0xff,
    );
    return /^[\x20-\x7e]{4}$/.test(label) ? label : null;
}

export function mp4SampleEntryTypeLabel(fourcc) {
    const key = String(fourcc || "").toLowerCase();
    return MP4_SAMPLE_ENTRY_LABELS[key] || fourcc;
}

function numericCodecId(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
    return null;
}

/**
 * Normalize FLV metadata / stream codec fields to a human label (e.g. "H.264").
 * Handles AMF numeric fourcc (1635148593 → avc1) and FLV codec id integers (7 → H.264).
 */
export function normalizeVideoCodecLabel(value) {
    if (value == null) return undefined;
    const fourccDirect = fourccFromUint32(value);
    if (fourccDirect) return mp4SampleEntryTypeLabel(fourccDirect.toLowerCase());
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        const lower = trimmed.toLowerCase();
        if (MP4_SAMPLE_ENTRY_LABELS[lower]) return MP4_SAMPLE_ENTRY_LABELS[lower];
        const numeric = numericCodecId(trimmed);
        if (numeric != null) {
            const fourcc = fourccFromUint32(numeric);
            if (fourcc) return mp4SampleEntryTypeLabel(fourcc.toLowerCase());
            if (FLV_VIDEO_CODEC_ID_LABELS[numeric]) return FLV_VIDEO_CODEC_ID_LABELS[numeric];
        }
        if (lower.includes("264") || lower.includes("avc")) return "H.264";
        if (lower.includes("265") || lower.includes("hevc") || lower.includes("hvc")) return "H.265";
        return trimmed;
    }
    const numeric = numericCodecId(value);
    if (numeric != null) {
        const fourcc = fourccFromUint32(numeric);
        if (fourcc) return mp4SampleEntryTypeLabel(fourcc.toLowerCase());
        if (FLV_VIDEO_CODEC_ID_LABELS[numeric]) return FLV_VIDEO_CODEC_ID_LABELS[numeric];
    }
    return undefined;
}

export function videoCodecFamilyFromLabel(codecLabel) {
    const name = String(normalizeVideoCodecLabel(codecLabel) || codecLabel || "").toLowerCase();
    if (!name) return null;
    if (name.includes("264") || name.includes("avc")) return "h264";
    if (name.includes("265") || name.includes("hevc") || name.includes("hev1") || name.includes("hvc1")) return "hevc";
    return null;
}
