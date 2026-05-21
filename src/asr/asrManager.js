import { extractPcm16kChunks } from "./audioExtractor.js";
import { createWhisperProvider } from "./whisperProvider.js";
import { mergeSubtitleTracks, segmentsToSubtitleTrack } from "./subtitleGenerator.js";

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
        let audioMs = 0;
        let inferMs = 0;
        for (let i = 0; i < extracted.chunks.length; i++) {
            if (signal?.aborted) throw new DOMException("Subtitle generation cancelled.", "AbortError");
            const chunk = extracted.chunks[i];
            onProgress?.({
                stage: "asr",
                current: i + 1,
                total: extracted.chunks.length,
                message: `ASR chunk ${i + 1}/${extracted.chunks.length}`,
                segment: chunk,
            });
            const result = await this.transcribeChunk(chunk.pcm, {
                language,
                model,
                device,
                durationMs: chunk.endMs - chunk.startMs,
                signal,
                onProgress: (progress) => onProgress?.({
                    stage: "model",
                    current: i + 1,
                    total: extracted.chunks.length,
                    message: progress?.status || progress?.file || "loading model",
                    segment: chunk,
                    detail: progress,
                }),
            });
            audioMs += result.audioDurationMs || (chunk.endMs - chunk.startMs);
            inferMs += result.elapsedMs || 0;
            tracks.push(segmentsToSubtitleTrack(result.segments, {
                offsetMs: chunk.startMs,
                language: language === "auto" ? undefined : language,
            }));
            onProgress?.({
                stage: "asr",
                current: i + 1,
                total: extracted.chunks.length,
                message: `ASR chunk ${i + 1}/${extracted.chunks.length} done`,
                segment: chunk,
                speed: result.speed,
            });
        }
        const track = mergeSubtitleTracks(tracks, { language: language === "auto" ? undefined : language });
        return {
            track,
            stats: {
                chunks: extracted.chunks.length,
                decodeElapsedMs: performance.now() - decodeStartedAt - inferMs,
                inferElapsedMs: inferMs,
                audioDurationMs: audioMs,
                speed: inferMs > 0 ? audioMs / inferMs : 0,
                model,
                device,
            },
        };
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

export const asrManager = Object.freeze({ AsrManager, createAsrManager });
