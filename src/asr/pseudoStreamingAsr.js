import { resampleFloat32 } from "./audioExtractor.js";
import { detectEnergyVad } from "./energyVad.js";
import { PcmRingBuffer } from "./audioRingBuffer.js";
import { TranscriptMerger } from "./transcriptMerger.js";
import { normalizeSubtitleCue } from "./subtitleGenerator.js";

export const DEFAULT_WHISPER_STREAMING_OPTIONS = Object.freeze({
    windowMs: 15000,
    stepMs: 1000,
    overlapMs: 5000,
    minStableRepeats: 2,
    maxLookbackMs: 30000,
    commitDelayMs: 2500,
    language: "auto",
    useVad: true,
    useVadClip: true,
});

export class WhisperPseudoStreamingAsr {
    constructor(options = {}) {
        this.options = normalizeWhisperStreamingOptions(options);
        this.asrManager = options.asrManager || null;
        this.model = options.model || "";
        this.device = options.device || "auto";
        this.language = options.language || this.options.language || "auto";
        this.vadOptions = options.vadOptions || {};
        this.onTranscript = typeof options.onTranscript === "function" ? options.onTranscript : null;
        this.onStats = typeof options.onStats === "function" ? options.onStats : null;
        this.onError = typeof options.onError === "function" ? options.onError : null;
        this.onModelProgress = typeof options.onModelProgress === "function" ? options.onModelProgress : null;
        this.merger = new TranscriptMerger({
            overlapTimeToleranceMs: options.overlapTimeToleranceMs,
            textSimilarityThreshold: options.textSimilarityThreshold,
            maxMergeGapMs: options.maxMergeGapMs,
            preferLongerText: options.preferLongerText,
            preferHigherConfidence: options.preferHigherConfidence,
            language: this.language,
            commitDelayMs: this.options.commitDelayMs,
        });
        this.ring = new PcmRingBuffer({
            sampleRate: 16000,
            maxDurationMs: this.options.maxLookbackMs,
            timelineStartMs: Number(options.timelineStartMs) || 0,
        });
        this.timer = 0;
        this.running = false;
        this.busy = false;
        this.skippedTicks = 0;
        this.lastSnapshot = null;
        this.partialText = "";
        this.stableText = "";
        this.segments = [];
        this.windowIndex = 0;
    }

    start() {
        if (this.running) return;
        if (!this.asrManager) throw new Error("Pseudo-streaming ASR requires an AsrManager.");
        this.running = true;
        this.timer = setInterval(() => {
            this.tick().catch((err) => this.handleError(err));
        }, this.options.stepMs);
        this.tick().catch((err) => this.handleError(err));
    }

    async stop(options = {}) {
        this.running = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = 0;
        if (options.flush !== false) this.flushFinal();
    }

    handleAudioChunk(pcm, sampleRate = 48000) {
        if (!(pcm instanceof Float32Array) || pcm.length === 0) return;
        const resampled = Math.round(Number(sampleRate) || 0) === 16000
            ? pcm.slice(0)
            : resampleFloat32(pcm, sampleRate, 16000);
        this.ring.push(resampled);
    }

    async createAudioWorkletNode(audioContext) {
        if (!audioContext?.audioWorklet) throw new Error("AudioWorklet is not available in this browser.");
        await ensurePcmCaptureWorklet(audioContext);
        const node = new AudioWorkletNode(audioContext, PCM_CAPTURE_WORKLET_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
        });
        node.port.onmessage = (event) => {
            const data = event.data || {};
            if (data.type !== "pcm" || !data.pcm) return;
            this.handleAudioChunk(new Float32Array(data.pcm), data.sampleRate || audioContext.sampleRate);
        };
        return node;
    }

    async tick() {
        if (!this.running || this.busy) {
            if (this.busy) this.skippedTicks += 1;
            return;
        }
        const snapshot = this.ring.snapshotRecent(this.options.windowMs);
        if (snapshot.durationMs < Math.min(1500, this.options.windowMs * 0.25)) return;
        let asrInput = snapshot;
        if (this.options.useVad) {
            const vad = detectEnergyVad(snapshot.pcm, {
                ...this.vadOptions,
                sampleRate: snapshot.sampleRate,
            });
            this.lastVad = vad;
            asrInput = this.options.useVadClip ? selectVadSpeechClip(snapshot, vad, {
                maxMergeGapMs: Math.max(300, Number(this.vadOptions.minSilenceMs) || 300),
            }) : snapshot;
            if (!vad.segments.length || !asrInput?.pcm?.length) {
                this.partialText = "";
                const mergeResult = this.merger.advanceWindow(snapshot.endMs);
                this.applyMergeResult(mergeResult);
                this.emitTranscript(snapshot, null, {
                    inferenceMs: 0,
                    realtimeFactor: 0,
                    skippedTicks: this.skippedTicks,
                    vad,
                    skippedByVad: true,
                    rawText: "",
                    mergedText: this.stableText,
                    mergeDecisions: [],
                    mergedCount: 0,
                    dedupedCount: 0,
                    rawSegments: 0,
                    partialSegments: mergeResult.unstablePartialSegments.length,
                });
                return;
            }
        }

        this.busy = true;
        const startedAt = performance.now();
        try {
            const pcm = asrInput.pcm.slice(0);
            const result = await this.asrManager.transcribeChunk(pcm, {
                model: this.model,
                device: this.device,
                language: this.language,
                durationMs: asrInput.durationMs,
                chunkLengthSec: Math.max(1, asrInput.durationMs / 1000),
                strideLengthSec: 0,
                onProgress: this.onModelProgress,
            });
            const inferenceMs = performance.now() - startedAt;
            const windowResult = this.buildWindowResult(result, asrInput);
            const mergeResult = this.merger.mergeWindowResult(windowResult);
            this.applyMergeResult(mergeResult);
            this.lastSnapshot = asrInput;
            this.emitTranscript(snapshot, result, {
                inferenceMs,
                latencyMs: inferenceMs,
                realtimeFactor: asrInput.durationMs > 0 ? inferenceMs / asrInput.durationMs : 0,
                skippedTicks: this.skippedTicks,
                vad: this.lastVad || null,
                rawText: result?.text || "",
                mergedText: this.stableText,
                mergeDecisions: mergeResult.decisions,
                mergedCount: mergeResult.mergedCount,
                dedupedCount: mergeResult.dedupedCount,
                rawSegments: windowResult.segments.length,
                partialSegments: mergeResult.unstablePartialSegments.length,
                asrInputStartMs: asrInput.startMs,
                asrInputEndMs: asrInput.endMs,
                asrInputDurationMs: asrInput.durationMs,
            });
        } finally {
            this.busy = false;
        }
    }

    flushFinal() {
        const snapshot = this.lastSnapshot || this.ring.snapshotRecent(this.options.windowMs);
        const mergeResult = this.merger.flush();
        this.applyMergeResult(mergeResult);
        this.partialText = "";
        this.emitTranscript(snapshot, null, {
            inferenceMs: 0,
            latencyMs: 0,
            realtimeFactor: 0,
            skippedTicks: this.skippedTicks,
            final: true,
        });
    }

    buildWindowResult(result, snapshot) {
        const windowId = `asr-window-${++this.windowIndex}`;
        const rawSegments = Array.isArray(result?.segments) && result.segments.length
            ? result.segments
            : [{ startMs: 0, endMs: snapshot.durationMs, text: result?.text || "", confidence: result?.confidence }];
        const segments = rawSegments.map((segment) => {
            const start = Number(segment?.startMs);
            const end = Number(segment?.endMs);
            const startMs = snapshot.startMs + (Number.isFinite(start) ? start : 0);
            const endMs = snapshot.startMs + (Number.isFinite(end) ? end : snapshot.durationMs);
            return {
                startMs: clampRange(startMs, snapshot.startMs, snapshot.endMs),
                endMs: clampRange(endMs, snapshot.startMs, snapshot.endMs),
                text: segment?.text || result?.text || "",
                confidence: segment?.confidence,
            };
        });
        return {
            windowId,
            windowStartMs: snapshot.startMs,
            windowEndMs: snapshot.endMs,
            text: result?.text || "",
            segments,
            confidence: result?.confidence,
        };
    }

    applyMergeResult(mergeResult) {
        this.segments = mergeResult.stableSegments || [];
        const partialSegments = mergeResult.unstablePartialSegments || [];
        this.partialText = partialSegments.map((segment) => segment.text).filter(Boolean).join(" ").trim();
        this.stableText = this.segments.map((segment) => segment.text).filter(Boolean).join(" ").trim();
    }

    emitTranscript(snapshot, result, stats) {
        const payload = {
            stableText: this.stableText,
            partialText: this.partialText,
            startMs: snapshot.startMs,
            endMs: snapshot.endMs,
            result,
            track: this.getSubtitleTrack(),
            segments: this.segments.slice(),
            stats,
        };
        this.onTranscript?.(payload);
        this.onStats?.(stats);
    }

    handleError(err) {
        this.onError?.(err);
    }

    getSubtitleTrack(options = {}) {
        return {
            language: options.language || (this.language === "auto" ? undefined : this.language),
            cues: this.segments
                .filter((segment) => String(segment.text || "").trim())
                .map((segment, index) => normalizeSubtitleCue(segment, index)),
        };
    }
}

export function createWhisperPseudoStreamingAsr(options = {}) {
    return new WhisperPseudoStreamingAsr(options);
}

export function normalizeWhisperStreamingOptions(options = {}) {
    const windowMs = clampNumber(options.windowMs, 3000, 60000, DEFAULT_WHISPER_STREAMING_OPTIONS.windowMs);
    const stepMs = clampNumber(options.stepMs, 500, 10000, DEFAULT_WHISPER_STREAMING_OPTIONS.stepMs);
    const overlapMs = clampNumber(options.overlapMs, 0, Math.max(0, windowMs - 1000), DEFAULT_WHISPER_STREAMING_OPTIONS.overlapMs);
    const maxLookbackMs = Math.max(windowMs, clampNumber(options.maxLookbackMs, 5000, 120000, DEFAULT_WHISPER_STREAMING_OPTIONS.maxLookbackMs));
    return {
        windowMs,
        stepMs,
        overlapMs,
        maxLookbackMs,
        minStableRepeats: clampInteger(options.minStableRepeats, 1, 10, DEFAULT_WHISPER_STREAMING_OPTIONS.minStableRepeats),
        commitDelayMs: clampNumber(options.commitDelayMs, 0, 10000, DEFAULT_WHISPER_STREAMING_OPTIONS.commitDelayMs),
        language: options.language || DEFAULT_WHISPER_STREAMING_OPTIONS.language,
        useVad: options.useVad !== false,
        useVadClip: options.useVadClip !== false,
    };
}

export function selectVadSpeechClip(snapshot, vad, options = {}) {
    const segments = Array.isArray(vad?.segments) ? vad.segments.filter((seg) => Number(seg?.endMs) > Number(seg?.startMs)) : [];
    if (!snapshot?.pcm?.length || !segments.length) return null;
    const sampleRate = Math.max(1, Number(snapshot.sampleRate) || 16000);
    const durationMs = Math.max(0, Number(snapshot.durationMs) || (snapshot.pcm.length / sampleRate) * 1000);
    const maxMergeGapMs = Math.max(0, Number(options.maxMergeGapMs) || 300);
    const maxClipMs = Math.max(1000, Number(options.maxClipMs) || 8000);
    let firstIndex = segments.length - 1;
    let startMs = Math.max(0, Number(segments[firstIndex].startMs) || 0);
    let endMs = Math.min(durationMs, Number(segments[firstIndex].endMs) || durationMs);
    for (let i = segments.length - 2; i >= 0; i--) {
        const segStart = Math.max(0, Number(segments[i].startMs) || 0);
        const segEnd = Math.min(durationMs, Number(segments[i].endMs) || 0);
        const gap = startMs - segEnd;
        if (gap > maxMergeGapMs || endMs - segStart > maxClipMs) break;
        firstIndex = i;
        startMs = segStart;
    }
    if (endMs <= startMs) return null;
    const startSample = Math.max(0, Math.floor((startMs * sampleRate) / 1000));
    const endSample = Math.min(snapshot.pcm.length, Math.ceil((endMs * sampleRate) / 1000));
    if (endSample <= startSample) return null;
    const pcm = snapshot.pcm.slice(startSample, endSample);
    const absoluteStartMs = snapshot.startMs + startMs;
    const absoluteEndMs = snapshot.startMs + endMs;
    return {
        pcm,
        sampleRate,
        startMs: absoluteStartMs,
        endMs: absoluteEndMs,
        durationMs: (pcm.length / sampleRate) * 1000,
        sourceWindowStartMs: snapshot.startMs,
        sourceWindowEndMs: snapshot.endMs,
        vadSegments: segments.slice(firstIndex).map((seg) => ({
            ...seg,
            startMs: snapshot.startMs + Math.max(0, Number(seg.startMs) || 0),
            endMs: snapshot.startMs + Math.max(0, Number(seg.endMs) || 0),
        })),
    };
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function clampRange(value, min, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function clampInteger(value, min, max, fallback) {
    return Math.round(clampNumber(value, min, max, fallback));
}

const PCM_CAPTURE_WORKLET_NAME = "asr-pcm-capture";
let pcmCaptureWorkletUrl = "";

async function ensurePcmCaptureWorklet(audioContext) {
    if (audioContext.__asrPcmCaptureWorkletLoaded) return;
    pcmCaptureWorkletUrl ||= URL.createObjectURL(new Blob([`
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const channels = input.length;
    const len = channels > 0 && input[0] ? input[0].length : 0;
    if (len > 0) {
      for (let i = 0; i < len; i++) {
        let sample = 0;
        for (let ch = 0; ch < channels; ch++) sample += input[ch][i] || 0;
        this.buffer[this.offset++] = sample / Math.max(1, channels);
        if (this.offset >= this.buffer.length) this.flush();
      }
    }
    if (output[0]) {
      for (let ch = 0; ch < output.length; ch++) {
        if (input[ch]) output[ch].set(input[ch]);
        else output[ch].fill(0);
      }
    }
    return true;
  }
  flush() {
    if (!this.offset) return;
    const chunk = this.buffer.slice(0, this.offset);
    this.offset = 0;
    this.port.postMessage({ type: "pcm", sampleRate, pcm: chunk.buffer }, [chunk.buffer]);
  }
}
registerProcessor("${PCM_CAPTURE_WORKLET_NAME}", PcmCaptureProcessor);
`], { type: "text/javascript" }));
    await audioContext.audioWorklet.addModule(pcmCaptureWorkletUrl);
    audioContext.__asrPcmCaptureWorkletLoaded = true;
}

export const pseudoStreamingAsr = Object.freeze({
    DEFAULT_WHISPER_STREAMING_OPTIONS,
    WhisperPseudoStreamingAsr,
    createWhisperPseudoStreamingAsr,
    normalizeWhisperStreamingOptions,
    selectVadSpeechClip,
});
