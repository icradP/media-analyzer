/**
 * @typedef {'energy'} VadBackend
 *
 * @typedef {Object} VadSegment
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} score
 * @property {VadBackend} backend
 */

export const VAD_BACKENDS = Object.freeze({
    ENERGY: "energy",
});

export class VadProvider {
    constructor(options = {}) {
        this.backend = normalizeVadBackend(options.backend || options.source || VAD_BACKENDS.ENERGY);
        this.source = this.backend;
    }

    async detect() {
        throw new Error("VadProvider.detect must be implemented by subclasses.");
    }
}

export function normalizeVadBackend(value = VAD_BACKENDS.ENERGY) {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "energy" || raw === "energy-vad") return VAD_BACKENDS.ENERGY;
    return VAD_BACKENDS.ENERGY;
}

export function normalizeVadOptions(options = {}) {
    const frameMs = [10, 20, 30].includes(Number(options.frameMs)) ? Number(options.frameMs) : 20;
    return {
        frameMs,
        minSpeechMs: clampNumber(options.minSpeechMs, 40, 10000, 250),
        minSilenceMs: clampNumber(options.minSilenceMs, 20, 5000, 300),
        paddingMs: clampNumber(options.paddingMs, 0, 5000, 200),
        thresholdDb: Number.isFinite(Number(options.thresholdDb)) ? Number(options.thresholdDb) : undefined,
        adaptiveNoiseFloor: options.adaptiveNoiseFloor !== false,
        sampleRate: normalizeVadSampleRate(options.sampleRate),
    };
}

export function normalizeVadSampleRate(value, fallback = 16000) {
    const n = Number(value);
    if (n === 48000) return 48000;
    if (n === 16000) return 16000;
    return fallback;
}

export function vadFramesToSegments(frames = [], options = {}, durationMs = 0, backend = VAD_BACKENDS.ENERGY) {
    const opts = normalizeVadOptions(options);
    const raw = [];
    let active = null;
    let silenceMs = 0;
    for (const frame of frames) {
        const startMs = finiteNumber(frame.startMs, 0);
        const endMs = Math.max(startMs, finiteNumber(frame.endMs, startMs));
        const score = clamp01(frame.score);
        if (frame.speech) {
            if (!active) active = { startMs, endMs, scores: [] };
            active.endMs = endMs;
            active.scores.push(score);
            silenceMs = 0;
        } else if (active) {
            silenceMs += endMs - startMs;
            if (silenceMs < opts.minSilenceMs) {
                active.endMs = endMs;
            } else {
                active.endMs = Math.max(active.startMs, active.endMs - silenceMs);
                raw.push(active);
                active = null;
                silenceMs = 0;
            }
        }
    }
    if (active) raw.push(active);

    const maxEndMs = Math.max(0, Math.round(Number(durationMs) || 0));
    const padded = raw
        .filter((seg) => seg.endMs - seg.startMs >= opts.minSpeechMs)
        .map((seg) => ({
            startMs: Math.max(0, Math.round(seg.startMs - opts.paddingMs)),
            endMs: maxEndMs > 0 ? Math.min(maxEndMs, Math.round(seg.endMs + opts.paddingMs)) : Math.round(seg.endMs + opts.paddingMs),
            score: average(seg.scores),
            backend: normalizeVadBackend(backend),
            source: normalizeVadBackend(backend),
        }))
        .filter((seg) => seg.endMs > seg.startMs);

    const merged = [];
    for (const seg of padded) {
        const last = merged[merged.length - 1];
        if (last && seg.startMs - last.endMs <= opts.minSilenceMs) {
            last.endMs = Math.max(last.endMs, seg.endMs);
            last.score = Math.max(last.score, seg.score);
        } else {
            merged.push(seg);
        }
    }
    return merged;
}

export function slicePcmByVadSegment(pcm, segment, sampleRate = 16000) {
    if (!(pcm instanceof Float32Array)) return new Float32Array();
    const sr = Math.max(1, Number(sampleRate) || 16000);
    const start = Math.max(0, Math.floor((Number(segment?.startMs) || 0) * sr / 1000));
    const end = Math.min(pcm.length, Math.ceil((Number(segment?.endMs) || 0) * sr / 1000));
    return end > start ? pcm.slice(start, end) : new Float32Array();
}

export function normalizeVadResult(result = {}, backend = VAD_BACKENDS.ENERGY) {
    const normalizedBackend = normalizeVadBackend(result.backend || result.source || backend);
    return {
        ...result,
        backend: normalizedBackend,
        source: normalizedBackend,
        segments: (Array.isArray(result.segments) ? result.segments : []).map((seg) => ({
            ...seg,
            startMs: Math.max(0, Math.round(Number(seg.startMs) || 0)),
            endMs: Math.max(0, Math.round(Number(seg.endMs) || 0)),
            score: clamp01(seg.score),
            backend: normalizeVadBackend(seg.backend || seg.source || normalizedBackend),
            source: normalizeVadBackend(seg.backend || seg.source || normalizedBackend),
        })).filter((seg) => seg.endMs > seg.startMs),
    };
}

export function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function clampInteger(value, min, max, fallback) {
    return Math.round(clampNumber(value, min, max, fallback));
}

export function finiteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function average(values) {
    const list = Array.isArray(values) ? values.filter(Number.isFinite) : [];
    return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0;
}

export function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

export const vadProvider = Object.freeze({
    VAD_BACKENDS,
    VadProvider,
    normalizeVadBackend,
    normalizeVadOptions,
    normalizeVadSampleRate,
    vadFramesToSegments,
    slicePcmByVadSegment,
    normalizeVadResult,
});
