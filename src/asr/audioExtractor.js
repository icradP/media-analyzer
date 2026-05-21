import { decodeAudioFramesToBufferWithWebAudio } from "../../lib/browser/framePlayback.js";

export function frameTimeSec(frame) {
    const raw = frame?._rawFrame || frame;
    for (const key of ["ptsTime", "dtsTime", "timestampTime"]) {
        const value = Number(raw?.[key]);
        if (Number.isFinite(value)) return value;
    }
    for (const key of ["pts", "dts", "timestamp"]) {
        const value = Number(raw?.[key]);
        if (Number.isFinite(value)) return value / 1000;
    }
    return null;
}

export function selectAudioFrames(frames = [], options = {}) {
    const startSec = Number.isFinite(Number(options.startSec)) ? Number(options.startSec) : -Infinity;
    const endSec = Number.isFinite(Number(options.endSec)) ? Number(options.endSec) : Infinity;
    return (Array.isArray(frames) ? frames : [])
        .filter((frame) => (frame?._mediaType || frame?.mediaType) === "audio")
        .filter((frame) => {
            const t = frameTimeSec(frame);
            return t == null || (t >= startSec && t <= endSec);
        })
        .sort((a, b) => (frameTimeSec(a) ?? 0) - (frameTimeSec(b) ?? 0));
}

export function unwrapAudioFrameForDecode(frame) {
    return frame?._rawFrame || frame || null;
}

export function groupAudioFramesByTime(frames = [], chunkDurationSec = 30) {
    const input = Array.isArray(frames) ? frames : [];
    if (!input.length) return [];
    const chunk = Math.max(5, Number(chunkDurationSec) || 30);
    const groups = [];
    let current = [];
    let groupStart = frameTimeSec(input[0]) ?? 0;
    for (const frame of input) {
        const t = frameTimeSec(frame);
        if (current.length && Number.isFinite(t) && t - groupStart >= chunk) {
            groups.push({ frames: current, startSec: groupStart });
            current = [];
            groupStart = t;
        }
        current.push(frame);
    }
    if (current.length) groups.push({ frames: current, startSec: groupStart });
    return groups;
}

export async function extractPcm16kChunks({
    frames,
    mediaInfo,
    audioContext = null,
    chunkDurationSec = 30,
    startSec,
    endSec,
    signal,
    onProgress,
} = {}) {
    const selected = selectAudioFrames(frames, { startSec, endSec });
    if (!selected.length) throw new Error("No audio frames available for ASR.");
    const groups = groupAudioFramesByTime(selected, chunkDurationSec);
    const chunks = [];
    let ctx = audioContext;
    for (let i = 0; i < groups.length; i++) {
        if (signal?.aborted) throw new DOMException("Subtitle generation cancelled.", "AbortError");
        const group = groups[i];
        onProgress?.({ stage: "decode", current: i + 1, total: groups.length, message: `decode audio chunk ${i + 1}/${groups.length}` });
        const rawFrames = group.frames.map(unwrapAudioFrameForDecode).filter(Boolean);
        const decoded = await decodeAudioFramesToBufferWithWebAudio({
            frames: rawFrames,
            mediaInfo,
            audioContext: ctx,
        });
        ctx = decoded.ctx || ctx;
        const pcm = audioBufferToMonoPcm(decoded.buffer, 16000);
        const start = Number.isFinite(group.startSec) ? group.startSec : (frameTimeSec(group.frames[0]) || 0);
        chunks.push({
            index: i,
            pcm,
            sampleRate: 16000,
            startMs: Math.max(0, Math.round(start * 1000)),
            endMs: Math.max(0, Math.round(start * 1000 + (pcm.length / 16000) * 1000)),
            sourceSampleRate: decoded.buffer.sampleRate,
            sourceChannels: decoded.buffer.numberOfChannels,
        });
    }
    return { chunks, audioContext: ctx };
}

export function audioBufferToMonoPcm(buffer, targetSampleRate = 16000) {
    if (!buffer || !Number.isFinite(buffer.sampleRate)) throw new Error("Invalid decoded audio buffer.");
    const channels = Math.max(1, buffer.numberOfChannels || 1);
    const mono = new Float32Array(buffer.length);
    for (let ch = 0; ch < channels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < mono.length; i++) mono[i] += data[i] / channels;
    }
    return resampleFloat32(mono, buffer.sampleRate, targetSampleRate);
}

export function resampleFloat32(input, sourceRate, targetRate) {
    if (!(input instanceof Float32Array)) throw new Error("PCM input must be Float32Array.");
    if (!Number.isFinite(sourceRate) || !Number.isFinite(targetRate) || sourceRate <= 0 || targetRate <= 0) {
        throw new Error("Invalid sample rate.");
    }
    if (Math.round(sourceRate) === Math.round(targetRate)) return input.slice(0);
    const ratio = sourceRate / targetRate;
    const outLength = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
        const pos = i * ratio;
        const left = Math.floor(pos);
        const right = Math.min(input.length - 1, left + 1);
        const frac = pos - left;
        out[i] = input[left] * (1 - frac) + input[right] * frac;
    }
    return out;
}

export const audioExtractor = Object.freeze({
    frameTimeSec,
    selectAudioFrames,
    groupAudioFramesByTime,
    unwrapAudioFrameForDecode,
    extractPcm16kChunks,
    audioBufferToMonoPcm,
    resampleFloat32,
});
