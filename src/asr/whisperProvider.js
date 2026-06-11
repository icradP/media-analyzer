import { whisperOutputToSegments } from "./subtitleGenerator.js";

export const DEFAULT_TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2";
export const DEFAULT_WHISPER_MODEL = "onnx-community/whisper-tiny";

export class WhisperProvider {
    constructor(options = {}) {
        this.libraryUrl = options.libraryUrl || DEFAULT_TRANSFORMERS_URL;
        this.defaultModel = options.model || DEFAULT_WHISPER_MODEL;
        this.defaultDevice = options.device || "auto";
        this.defaultDtype = options.dtype || null;
        this.localOnly = options.localOnly === true;
        this.pipeline = null;
        this.pipelineKey = "";
        this.mod = null;
    }

    async load(options = {}) {
        const model = options.model || this.defaultModel;
        const device = resolveDevice(options.device || this.defaultDevice);
        const dtype = options.dtype || this.defaultDtype || (device === "webgpu" ? "fp32" : "q8");
        const key = `${model}|${device}|${dtype}|${this.libraryUrl}`;
        if (this.pipeline && this.pipelineKey === key) return this.pipeline;
        const mod = await this.loadTransformersModule();
        configureTransformersEnv(mod, { localOnly: this.localOnly });
        const pipelineOptions = {
            device,
            dtype,
            progress_callback: options.onProgress,
        };
        try {
            this.pipeline = await mod.pipeline("automatic-speech-recognition", model, pipelineOptions);
            this.pipelineKey = key;
            return this.pipeline;
        } catch (err) {
            if ((options.device || this.defaultDevice) !== "auto" || device !== "webgpu") throw err;
            this.pipeline = await mod.pipeline("automatic-speech-recognition", model, {
                device: "wasm",
                dtype: options.dtype || "q8",
                progress_callback: options.onProgress,
            });
            this.pipelineKey = `${model}|wasm|${options.dtype || "q8"}|${this.libraryUrl}`;
            return this.pipeline;
        }
    }

    async transcribe(pcm, options = {}) {
        if (!(pcm instanceof Float32Array) || pcm.length === 0) throw new Error("ASR PCM input is empty.");
        const asr = await this.load(options);
        const startedAt = performance.now();
        const chunkLengthSec = Math.max(1, Number.isFinite(Number(options.chunkLengthSec)) ? Number(options.chunkLengthSec) : 30);
        const requestedStrideSec = Number.isFinite(Number(options.strideLengthSec)) ? Number(options.strideLengthSec) : 5;
        const strideLengthSec = Math.max(0, Math.min(requestedStrideSec, Math.max(0, chunkLengthSec - 0.25)));
        const result = await asr(pcm, {
            return_timestamps: true,
            chunk_length_s: chunkLengthSec,
            stride_length_s: strideLengthSec,
            language: normalizeLanguage(options.language),
            task: options.task || "transcribe",
        });
        const elapsedMs = performance.now() - startedAt;
        const durationMs = Number(options.durationMs) || (pcm.length / 16000) * 1000;
        return {
            text: result?.text || "",
            segments: whisperOutputToSegments(result, { durationMs }),
            elapsedMs,
            audioDurationMs: durationMs,
            speed: elapsedMs > 0 ? durationMs / elapsedMs : 0,
            raw: result,
        };
    }

    async loadTransformersModule() {
        if (this.mod) return this.mod;
        this.mod = await import(this.libraryUrl);
        return this.mod;
    }
}

export function createWhisperProvider(options = {}) {
    return new WhisperProvider(options);
}

function resolveDevice(device) {
    const raw = String(device || "auto").toLowerCase();
    if (raw === "wasm" || raw === "webgpu") return raw;
    return globalThis.navigator?.gpu ? "webgpu" : "wasm";
}

function normalizeLanguage(language) {
    const raw = String(language || "auto").trim();
    return raw && raw !== "auto" ? raw : undefined;
}

function configureTransformersEnv(mod, options = {}) {
    const env = mod?.env;
    if (!env) return;
    env.useBrowserCache = true;
    env.allowRemoteModels = options.localOnly !== true;
    env.allowLocalModels = true;
}

export const whisperProvider = Object.freeze({
    DEFAULT_TRANSFORMERS_URL,
    DEFAULT_WHISPER_MODEL,
    WhisperProvider,
    createWhisperProvider,
});
