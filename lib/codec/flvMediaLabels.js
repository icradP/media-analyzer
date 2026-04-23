export function flvTagTypeName(tagType) {
    switch (tagType) {
        case 8:
            return "Audio";
        case 9:
            return "Video";
        case 18:
            return "Script Data";
        default:
            return `Unknown (${tagType})`;
    }
}

export function flvSoundFormatName(soundFormat) {
    return (
        {
            0: "Linear PCM, platform endian",
            1: "ADPCM",
            2: "MP3",
            3: "Linear PCM, little endian",
            4: "Nellymoser 16kHz mono",
            5: "Nellymoser 8kHz mono",
            6: "Nellymoser",
            7: "G.711 A-law",
            8: "G.711 mu-law",
            9: "reserved",
            10: "AAC",
            11: "Speex",
            14: "MP3 8kHz",
            15: "Device-specific sound",
        }[soundFormat] || `Unknown (${soundFormat})`
    );
}

export function flvSoundRateLabel(soundRate) {
    return { 0: "5.5kHz", 1: "11kHz", 2: "22kHz", 3: "44kHz" }[soundRate] || `Unknown (${soundRate})`;
}

export function flvVideoFrameTypeName(frameType) {
    return (
        {
            1: "keyframe (I-frame)",
            2: "inter frame (P-frame)",
            3: "disposable inter frame (B-frame)",
            4: "generated keyframe",
            5: "video info/command frame",
        }[frameType] || `Unknown (${frameType})`
    );
}

export function flvVideoCodecIdName(codecId) {
    return (
        {
            1: "JPEG",
            2: "Sorenson H.263",
            3: "Screen video",
            4: "On2 VP6",
            5: "On2 VP6 with alpha",
            6: "Screen video version 2",
            7: "H.264",
            12: "H.265",
        }[codecId] || `Unknown (${codecId})`
    );
}

export function flvAvcPacketTypeName(packetType) {
    return (
        { 0: "Sequence Header", 1: "AVC NALU", 2: "AVC end of sequence" }[packetType] ||
        `Unknown (${packetType})`
    );
}

export function flvHevcPacketTypeName(packetType) {
    return (
        {
            0: "Sequence Start",
            1: "Coded Frames",
            2: "Sequence End",
            3: "Coded Frames X (Progressive)",
            4: "Metadata",
            5: "MPEG2-TS Sequence Start",
        }[packetType] || `Unknown (${packetType})`
    );
}

export function mp4SampleEntryTypeLabel(fourcc) {
    return { av01: "AV1", vp09: "VP9", hvc1: "H.265" }[fourcc] || fourcc;
}

/** Ex-header 下读 bit 数 */
export function flvVideoTagBodyBitLength(tag) {
    return !(tag?._isExHeader_value === 1) || tag?._packetType_value === 3 ? 5 : 8;
}
