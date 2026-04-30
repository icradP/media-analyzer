import { channelLayoutFromChannelCount } from "../core/mediaMath.js";

function readU16LE(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU24BE(bytes, offset) {
    return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function readU32LE(bytes, offset) {
    return (
        bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)
    ) >>> 0;
}

function readAscii(bytes, offset, len) {
    return String.fromCharCode(...bytes.subarray(offset, offset + len));
}

function findAscii(bytes, token, from = 0) {
    const sig = [...token].map((c) => c.charCodeAt(0));
    for (let i = from; i + sig.length <= bytes.length; i++) {
        let ok = true;
        for (let j = 0; j < sig.length; j++) {
            if (bytes[i + j] !== sig[j]) {
                ok = false;
                break;
            }
        }
        if (ok) return i;
    }
    return -1;
}

function parseWav(bytes) {
    if (bytes.length < 44) return null;
    if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") return null;
    let offset = 12;
    let channels;
    let sampleRate;
    let bitsPerSample;
    let audioFormat;
    let dataSize = 0;
    while (offset + 8 <= bytes.length) {
        const id = readAscii(bytes, offset, 4);
        const size = readU32LE(bytes, offset + 4);
        const body = offset + 8;
        if (id === "fmt " && size >= 16 && body + size <= bytes.length) {
            audioFormat = readU16LE(bytes, body);
            channels = readU16LE(bytes, body + 2);
            sampleRate = readU32LE(bytes, body + 4);
            bitsPerSample = readU16LE(bytes, body + 14);
        } else if (id === "data") {
            dataSize = size;
        }
        offset = body + size + (size % 2);
    }
    const duration = sampleRate && channels && bitsPerSample && dataSize
        ? dataSize / (sampleRate * channels * (bitsPerSample / 8))
        : undefined;
    return {
        format: {
            formatName: "wav",
            formatLongName: "Waveform Audio File Format",
            size: bytes.byteLength,
            duration,
            bitrate: sampleRate && channels && bitsPerSample ? sampleRate * channels * bitsPerSample : undefined,
        },
        streams: [
            {
                index: 0,
                codecType: "audio",
                codecName: audioFormat === 1 ? "PCM" : "WAV",
                sampleRate,
                channels,
                channelLayout: channelLayoutFromChannelCount(channels),
                sampleFormat: bitsPerSample ? `${bitsPerSample}-bit` : undefined,
                duration,
                bitrate: sampleRate && channels && bitsPerSample ? sampleRate * channels * bitsPerSample : undefined,
            },
        ],
        frames: [],
        formatSpecific: { fileData: bytes },
    };
}

function parseFlac(bytes) {
    if (bytes.length < 8 || readAscii(bytes, 0, 4) !== "fLaC") return null;
    let offset = 4;
    let sampleRate;
    let channels;
    let bitsPerSample;
    let totalSamples;
    while (offset + 4 <= bytes.length) {
        const header = bytes[offset];
        const isLast = (header & 0x80) !== 0;
        const blockType = header & 0x7f;
        const blockLen = readU24BE(bytes, offset + 1);
        const body = offset + 4;
        if (body + blockLen > bytes.length) break;
        if (blockType === 0 && blockLen >= 34) {
            sampleRate =
                (bytes[body + 10] << 12) | (bytes[body + 11] << 4) | ((bytes[body + 12] >> 4) & 0x0f);
            channels = ((bytes[body + 12] >> 1) & 0x07) + 1;
            bitsPerSample = (((bytes[body + 12] & 0x01) << 4) | ((bytes[body + 13] >> 4) & 0x0f)) + 1;
            totalSamples =
                ((bytes[body + 13] & 0x0f) * 2 ** 32) +
                (bytes[body + 14] << 24) +
                (bytes[body + 15] << 16) +
                (bytes[body + 16] << 8) +
                bytes[body + 17];
            break;
        }
        offset = body + blockLen;
        if (isLast) break;
    }
    const duration = sampleRate && totalSamples != null ? totalSamples / sampleRate : undefined;
    return {
        format: {
            formatName: "flac",
            formatLongName: "Free Lossless Audio Codec",
            size: bytes.byteLength,
            duration,
            bitrate: duration ? Math.round((bytes.byteLength * 8) / duration) : undefined,
        },
        streams: [
            {
                index: 0,
                codecType: "audio",
                codecName: "FLAC",
                sampleRate,
                channels,
                channelLayout: channelLayoutFromChannelCount(channels),
                sampleFormat: bitsPerSample ? `${bitsPerSample}-bit` : undefined,
                duration,
                bitrate: duration ? Math.round((bytes.byteLength * 8) / duration) : undefined,
            },
        ],
        frames: [],
        formatSpecific: { fileData: bytes },
    };
}

function parseMp3(bytes) {
    if (bytes.length < 4) return null;
    let offset = 0;
    if (readAscii(bytes, 0, 3) === "ID3" && bytes.length >= 10) {
        const id3Size =
            ((bytes[6] & 0x7f) << 21) |
            ((bytes[7] & 0x7f) << 14) |
            ((bytes[8] & 0x7f) << 7) |
            (bytes[9] & 0x7f);
        offset = 10 + id3Size;
    }
    while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
            offset += 1;
            continue;
        }
        const b1 = bytes[offset + 1];
        const b2 = bytes[offset + 2];
        const versionBits = (b1 >> 3) & 0x03;
        const layerBits = (b1 >> 1) & 0x03;
        const bitrateIndex = (b2 >> 4) & 0x0f;
        const sampleRateIndex = (b2 >> 2) & 0x03;
        const channelMode = (bytes[offset + 3] >> 6) & 0x03;
        const mpeg1 = versionBits === 0x03;
        const layer3 = layerBits === 0x01;
        const bitrateTable = mpeg1
            ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
            : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
        const sampleRates = mpeg1
            ? [44100, 48000, 32000, 0]
            : versionBits === 0x02
              ? [22050, 24000, 16000, 0]
              : [11025, 12000, 8000, 0];
        const sampleRate = sampleRates[sampleRateIndex] || undefined;
        const bitrateKbps = bitrateTable[bitrateIndex] || undefined;
        if (!sampleRate || !bitrateKbps || !layer3) {
            offset += 1;
            continue;
        }
        const channels = channelMode === 3 ? 1 : 2;
        const bitrate = bitrateKbps * 1000;
        const duration = bitrate > 0 ? (bytes.byteLength * 8) / bitrate : undefined;
        const samplesPerFrame = mpeg1 ? 1152 : 576;
        const frameCount =
            duration && sampleRate ? Math.max(0, Math.round((duration * sampleRate) / samplesPerFrame)) : undefined;
        return {
            format: {
                formatName: "mp3",
                formatLongName: "MPEG Audio Layer III",
                size: bytes.byteLength,
                duration,
                bitrate,
            },
            streams: [
                {
                    index: 0,
                    codecType: "audio",
                    codecName: "MPEG-1 Layer III (MP3)",
                    sampleRate,
                    channels,
                    channelLayout: channelLayoutFromChannelCount(channels),
                    duration,
                    bitrate,
                    frameCount,
                },
            ],
            frames: [],
            formatSpecific: { fileData: bytes },
        };
    }
    return null;
}

function parseOpus(bytes) {
    if (bytes.length < 32) return null;
    if (readAscii(bytes, 0, 4) !== "OggS") return null;
    const headOffset = findAscii(bytes, "OpusHead", 0);
    if (headOffset < 0 || headOffset + 19 > bytes.length) return null;
    const channels = bytes[headOffset + 9];
    const sampleRate = readU32LE(bytes, headOffset + 12) || 48000;
    return {
        format: {
            formatName: "opus",
            formatLongName: "Ogg Opus",
            size: bytes.byteLength,
        },
        streams: [
            {
                index: 0,
                codecType: "audio",
                codecName: "Opus",
                sampleRate,
                channels,
                channelLayout: channelLayoutFromChannelCount(channels),
            },
        ],
        frames: [],
        formatSpecific: { fileData: bytes },
    };
}

export function parseMinimalAudioByFormat(bytes, format) {
    if (format === "wav") return parseWav(bytes);
    if (format === "flac") return parseFlac(bytes);
    if (format === "mp3") return parseMp3(bytes);
    if (format === "opus") return parseOpus(bytes);
    return null;
}

export const audioMinimalAnalysisCodec = Object.freeze({
    parseMinimalAudioByFormat,
});
