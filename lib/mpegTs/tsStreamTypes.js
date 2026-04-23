/** PMT stream_type → 大类与展示名。 */

const VIDEO_TYPES = new Set([
    1, 2, 16, 27, 28, 30, 31, 32, 33, 36, 37, 39, 66, 128, 160, 209, 234,
]);
/** 注意：28 同时可能出现在 video 与 audio 列表，先匹配 video，故此处不含 28。 */
const AUDIO_TYPES = new Set([3, 4, 15, 17, 129, 130, 131, 132, 133, 135, 138, 148]);
const SUBTITLE_TYPES = new Set([6, 144, 145, 146]);

/** @returns {"video"|"audio"|"subtitle"|"data"} */
export function streamTypeToCodecCategory(streamType) {
    if (VIDEO_TYPES.has(streamType)) return "video";
    if (AUDIO_TYPES.has(streamType)) return "audio";
    if (SUBTITLE_TYPES.has(streamType)) return "subtitle";
    return "data";
}

const STREAM_TYPE_NAMES = {
    1: "MPEG-1",
    2: "MPEG-2",
    3: "MPEG-1 Audio",
    4: "MPEG-2 Audio",
    6: "DVB Subtitle",
    15: "AAC",
    16: "MPEG-4",
    17: "AAC",
    27: "H.264",
    28: "MPEG-4 Audio",
    30: "MPEG-4 Auxiliary",
    31: "H.264 SVC",
    32: "H.264 MVC",
    33: "JPEG 2000",
    36: "H.265",
    37: "H.265 Temporal",
    39: "MVCD",
    66: "AVS",
    128: "DigiCipher II",
    129: "AC-3",
    130: "DTS",
    131: "TrueHD",
    132: "AC-3 Plus",
    133: "DTS-HD",
    134: "SCTE-35",
    135: "E-AC-3",
    138: "DTS",
    144: "PGS Subtitle",
    145: "Interactive Graphics",
    146: "Text Subtitle",
    148: "SDDS",
    160: "MSCODEC",
    209: "Dirac",
    234: "VC-1",
};

/** @param {number} streamType */
export function streamTypeDisplayName(streamType) {
    return STREAM_TYPE_NAMES[streamType] ?? "Unknown";
}

export const tsStreamTypesCodec = Object.freeze({
    streamTypeToCodecCategory,
    streamTypeDisplayName,
});
