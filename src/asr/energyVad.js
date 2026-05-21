import {
    VAD_BACKENDS,
    VadProvider,
    average,
    clamp01,
    normalizeVadOptions,
    normalizeVadResult,
    slicePcmByVadSegment,
    vadFramesToSegments,
} from "./vadProvider.js";

const DB_FLOOR = -120;

export class EnergyVadProvider extends VadProvider {
    constructor(options = {}) {
        super({ backend: VAD_BACKENDS.ENERGY });
        this.options = normalizeVadOptions(options);
    }

    detect(pcm, options = {}) {
        return detectEnergyVad(pcm, { ...this.options, ...options });
    }
}

export function createEnergyVadProvider(options = {}) {
    return new EnergyVadProvider(options);
}

export { slicePcmByVadSegment };

export function detectEnergyVad(pcm, options = {}) {
    if (!(pcm instanceof Float32Array) || pcm.length === 0) {
        return normalizeVadResult({ segments: [], frames: [], thresholdDb: DB_FLOOR, noiseFloorDb: DB_FLOOR }, VAD_BACKENDS.ENERGY);
    }
    const opts = normalizeVadOptions(options);
    const sampleRate = Math.max(1, Number(options.sampleRate) || 16000);
    const frameSize = Math.max(1, Math.round((sampleRate * opts.frameMs) / 1000));
    const frames = [];
    for (let start = 0, index = 0; start < pcm.length; start += frameSize, index++) {
        const end = Math.min(pcm.length, start + frameSize);
        const rms = frameRms(pcm, start, end);
        const db = rmsToDb(rms);
        frames.push({
            index,
            startMs: (start / sampleRate) * 1000,
            endMs: (end / sampleRate) * 1000,
            rms,
            db,
        });
    }
    const smoothingFrames = Number.isFinite(Number(options.smoothingFrames)) ? Number(options.smoothingFrames) : 2;
    smoothFrameDb(frames, smoothingFrames);
    const noiseFloorDb = estimateNoiseFloorDb(frames);
    const manualThreshold = Number.isFinite(Number(opts.thresholdDb)) ? Number(opts.thresholdDb) : undefined;
    const adaptiveThreshold = Math.max(noiseFloorDb + 10, -48);
    const thresholdDb = opts.adaptiveNoiseFloor
        ? Math.max(adaptiveThreshold, manualThreshold ?? adaptiveThreshold)
        : (manualThreshold ?? -48);
    const exitThresholdDb = thresholdDb - Math.max(1, Math.min(12, Number(options.hysteresisDb) || 6));
    let active = false;
    for (const frame of frames) {
        const db = Number.isFinite(frame.smoothedDb) ? frame.smoothedDb : frame.db;
        frame.speech = active ? db >= exitThresholdDb : db >= thresholdDb;
        active = frame.speech;
        frame.score = clamp01((db - thresholdDb + 12) / 24);
    }
    return normalizeVadResult({
        segments: vadFramesToSegments(frames, opts, pcm.length / sampleRate * 1000, VAD_BACKENDS.ENERGY),
        frames,
        thresholdDb,
        exitThresholdDb,
        noiseFloorDb,
    }, VAD_BACKENDS.ENERGY);
}

function estimateNoiseFloorDb(frames) {
    const sorted = frames.map((frame) => frame.db).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return DB_FLOOR;
    const count = Math.max(1, Math.floor(sorted.length * 0.2));
    return average(sorted.slice(0, count));
}

function frameRms(pcm, start, end) {
    let sum = 0;
    const len = Math.max(1, end - start);
    for (let i = start; i < end; i++) sum += pcm[i] * pcm[i];
    return Math.sqrt(sum / len);
}

function rmsToDb(rms) {
    return rms > 0 ? 20 * Math.log10(rms) : DB_FLOOR;
}

function smoothFrameDb(frames, radius = 3) {
    const r = Math.max(0, Math.min(12, Math.floor(radius)));
    if (!r) {
        for (const frame of frames) frame.smoothedDb = frame.db;
        return;
    }
    for (let i = 0; i < frames.length; i++) {
        const values = [];
        for (let j = Math.max(0, i - r); j <= Math.min(frames.length - 1, i + r); j++) {
            values.push(frames[j].db);
        }
        frameSetSmoothedDb(frames[i], average(values));
    }
}

function frameSetSmoothedDb(frame, value) {
    frame.smoothedDb = Number.isFinite(value) ? value : frame.db;
}

export const energyVad = Object.freeze({
    EnergyVadProvider,
    createEnergyVadProvider,
    detectEnergyVad,
    slicePcmByVadSegment,
});
