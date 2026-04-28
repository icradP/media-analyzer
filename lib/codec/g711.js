export function decodeG711ALawSample(byte) {
    let value = (byte ^ 0x55) & 0xff;
    let sample = ((value & 0x0f) << 4) + 8;
    const segment = (value & 0x70) >> 4;
    if (segment >= 1) sample += 0x100;
    if (segment > 1) sample <<= segment - 1;
    return (value & 0x80) !== 0 ? sample : -sample;
}

export function decodeG711MuLawSample(byte) {
    const value = (~byte) & 0xff;
    let sample = ((value & 0x0f) << 3) + 0x84;
    sample <<= (value & 0x70) >> 4;
    sample -= 0x84;
    return (value & 0x80) !== 0 ? -sample : sample;
}

function clampPcm16ToFloat(sample) {
    return Math.max(-1, Math.min(1, sample / 32768));
}

export function decodeG711ToFloat32(payload, law = "alaw", channels = 1) {
    if (!(payload instanceof Uint8Array) || payload.length === 0) return [];
    const channelCount = Math.max(1, Number(channels) || 1);
    const frameCount = Math.floor(payload.length / channelCount);
    const out = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
    const decode = law === "mulaw" ? decodeG711MuLawSample : decodeG711ALawSample;
    for (let frame = 0; frame < frameCount; frame++) {
        for (let ch = 0; ch < channelCount; ch++) {
            out[ch][frame] = clampPcm16ToFloat(decode(payload[frame * channelCount + ch]));
        }
    }
    return out;
}

export const g711Codec = Object.freeze({
    decodeG711ALawSample,
    decodeG711MuLawSample,
    decodeG711ToFloat32,
});
