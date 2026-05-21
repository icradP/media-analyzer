import { extractPcm16kChunks } from "./audioExtractor.js";
import { createWhisperProvider } from "./whisperProvider.js";
import { mergeSubtitleTracks, segmentsToSubtitleTrack } from "./subtitleGenerator.js";
import { createEnergyVadProvider, slicePcmByVadSegment } from "./energyVad.js";

export class AsrManager {
    constructor(options = {}) {
        this.providerOptions = options.providerOptions || {};
        this.useWorker = options.useWorker !== false;
        this.worker = null;
        this.jobs = new Map();
        this.nextJobId = 1;
        this.directProvider = null;
    }

    async generateSubtitles(options = {}) {
        const {
            frames,
            mediaInfo,
            language = "auto",
            model,
            device = "auto",
            chunkDurationSec = 30,
            useVad = true,
            vadOptions = {},
            signal,
            onProgress,
        } = options;
        const decodeStartedAt = performance.now();
        const extracted = await extractPcm16kChunks({
            frames,
            mediaInfo,
            chunkDurationSec,
            signal,
            onProgress,
        });
        const tracks = [];
        const vadSegments = [];
        let audioMs = 0;
        let inferMs = 0;
        const asrUnits = [];
        for (let i = 0; i < extracted.chunks.length; i++) {
            if (signal?.aborted) throw new DOMException("Subtitle generation cancelled.", "AbortError");
            const chunk = extracted.chunks[i];
            if (useVad) {
                const vad = this.detectSpeechSegments(chunk, { vadOptions });
                for (const seg of vad.segments) {
                    vadSegments.push({ ...seg, startMs: chunk.startMs + seg.startMs, endMs: chunk.startMs + seg.endMs });
                    const pcm = slicePcmByVadSegment(chunk.pcm, seg, chunk.sampleRate || 16000);
                    if (pcm.length) asrUnits.push({
                        pcm,
                        startMs: chunk.startMs + seg.startMs,
                        endMs: chunk.startMs + seg.endMs,
                        parentChunk: chunk,
                        vadSegment: seg,
                    });
                }
                onProgress?.({
                    stage: "vad",
                    current: i + 1,
                    total: extracted.chunks.length,
                    message: formatVadProgressMessage(vad),
                    segment: chunk,
                    vad,
                });
            } else {
                asrUnits.push({
                    pcm: chunk.pcm,
                    startMs: chunk.startMs,
                    endMs: chunk.endMs,
                    parentChunk: chunk,
                    vadSegment: null,
                });
            }
        }
        if (!asrUnits.length) {
            return {
                track: { language: language === "auto" ? undefined : language, cues: [] },
                vadSegments,
                stats: {
                    chunks: extracted.chunks.length,
                    asrSegments: 0,
                    decodeElapsedMs: performance.now() - decodeStartedAt,
                    inferElapsedMs: 0,
                    audioDurationMs: 0,
                    speed: 0,
                    model,
                    device,
                    vad: useVad ? "energy" : "off",
                },
            };
        }
        for (let i = 0; i < asrUnits.length; i++) {
            if (signal?.aborted) throw new DOMException("Subtitle generation cancelled.", "AbortError");
            const unit = asrUnits[i];
            onProgress?.({
                stage: "asr",
                current: i + 1,
                total: asrUnits.length,
                message: `ASR speech segment ${i + 1}/${asrUnits.length}`,
                segment: unit,
            });
            const result = await this.transcribeChunk(unit.pcm, {
                language,
                model,
                device,
                durationMs: unit.endMs - unit.startMs,
                signal,
                onProgress: (progress) => onProgress?.({
                    stage: "model",
                    current: i + 1,
                    total: asrUnits.length,
                    message: progress?.status || progress?.file || "loading model",
                    segment: unit,
                    detail: progress,
                }),
            });
            audioMs += result.audioDurationMs || (unit.endMs - unit.startMs);
            inferMs += result.elapsedMs || 0;
            tracks.push(segmentsToSubtitleTrack(result.segments, {
                offsetMs: unit.startMs,
                language: language === "auto" ? undefined : language,
            }));
            onProgress?.({
                stage: "asr",
                current: i + 1,
                total: asrUnits.length,
                message: `ASR speech segment ${i + 1}/${asrUnits.length} done`,
                segment: unit,
                speed: result.speed,
            });
        }
        const track = mergeSubtitleTracks(tracks, { language: language === "auto" ? undefined : language });
        return {
            track,
            vadSegments,
            stats: {
                chunks: extracted.chunks.length,
                asrSegments: asrUnits.length,
                decodeElapsedMs: performance.now() - decodeStartedAt - inferMs,
                inferElapsedMs: inferMs,
                audioDurationMs: audioMs,
                speed: inferMs > 0 ? audioMs / inferMs : 0,
                model,
                device,
                vad: useVad ? "energy" : "off",
            },
        };
    }

    detectSpeechSegments(chunk, options = {}) {
        const provider = createEnergyVadProvider(options.vadOptions || {});
        return provider.detect(chunk.pcm, {
            ...(options.vadOptions || {}),
            sampleRate: chunk.sampleRate || 16000,
        });
    }

    transcribeChunk(pcm, options = {}) {
        if (this.useWorker && typeof Worker !== "undefined") {
            try {
                return this.transcribeChunkInWorker(pcm, options);
            } catch {
                // Fall through to direct provider when worker creation is blocked.
            }
        }
        this.directProvider ||= createWhisperProvider(this.providerOptions);
        return this.directProvider.transcribe(pcm, options);
    }

    transcribeChunkInWorker(pcm, options = {}) {
        const worker = this.ensureWorker();
        const id = this.nextJobId++;
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                this.jobs.delete(id);
                options.signal?.removeEventListener?.("abort", onAbort);
            };
            const onAbort = () => {
                cleanup();
                reject(new DOMException("Subtitle generation cancelled.", "AbortError"));
            };
            this.jobs.set(id, {
                resolve: (value) => {
                    cleanup();
                    resolve(value);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
                onProgress: options.onProgress,
            });
            options.signal?.addEventListener?.("abort", onAbort, { once: true });
            worker.postMessage({
                id,
                type: "transcribe",
                payload: {
                    pcm: pcm.buffer,
                    providerOptions: this.providerOptions,
                    options: stripWorkerOptions(options),
                },
            }, [pcm.buffer]);
        });
    }

    ensureWorker() {
        if (this.worker) return this.worker;
        this.worker = new Worker(new URL("./asr.worker.js", import.meta.url), { type: "module" });
        this.worker.onmessage = (event) => {
            const { id, type, payload, error } = event.data || {};
            const job = this.jobs.get(id);
            if (!job) return;
            if (type === "progress") job.onProgress?.(payload);
            else if (type === "result") job.resolve(payload);
            else if (type === "error") job.reject(new Error(error?.message || "ASR worker failed."));
        };
        this.worker.onerror = (event) => {
            const err = new Error(event.message || "ASR worker failed.");
            for (const job of this.jobs.values()) job.reject(err);
            this.jobs.clear();
            this.worker?.terminate?.();
            this.worker = null;
        };
        return this.worker;
    }

    terminate() {
        this.worker?.terminate?.();
        this.worker = null;
        this.jobs.clear();
    }
}

export function createAsrManager(options = {}) {
    return new AsrManager(options);
}

function stripWorkerOptions(options) {
    const out = { ...options };
    delete out.onProgress;
    delete out.signal;
    return out;
}

function formatVadProgressMessage(vad = {}) {
    const speech = Array.isArray(vad.segments) ? vad.segments.length : 0;
    const backend = vad.backend || vad.source || "vad";
    if (Number.isFinite(Number(vad.thresholdDb))) {
        return `${backend}: speech=${speech}, threshold=${Number(vad.thresholdDb).toFixed(1)}dB`;
    }
    return `${backend}: speech=${speech}`;
}

export const asrManager = Object.freeze({ AsrManager, createAsrManager });
