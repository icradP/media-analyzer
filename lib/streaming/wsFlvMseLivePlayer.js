import { decodeG711ToFloat32 } from "../codec/g711.js";
import { parseAvcDecoderConfigurationRecord } from "../codec/h264AvccPps.js";
import {
    MseLiveController,
    avcLengthSizeFromAvcC,
    buildAacAudioSpecificConfig,
    buildLiveFmp4InitSegment,
    buildLiveFmp4MediaSegment,
    forceAvcC4ByteLengthSize,
    h264CodecFromAvcC,
    h264PayloadHasIdr,
    normalizeAvcSamplePayload,
    prependAvcParameterSetsToIdr,
} from "../player/mseLiveController.js";

export class WsFlvMseLivePlayer {
    constructor({
        videoEl,
        onLog = null,
        onStatus = null,
        formatTime = null,
        segmentDurationMs = 3000,
        audioOnlySegmentDurationMs = 220,
        targetLatencySec = 3,
        audioOnlyTargetLatencySec = 0.45,
        keepBehindSec = 30,
        audioProbeMs = 800,
    } = {}) {
        this.videoEl = videoEl;
        this.onLog = typeof onLog === "function" ? onLog : null;
        this.onStatus = typeof onStatus === "function" ? onStatus : null;
        this.formatTime = typeof formatTime === "function" ? formatTime : ((n) => Number(n || 0).toFixed(3));
        this.segmentDurationMs = Math.max(250, Number(segmentDurationMs) || 1000);
        this.audioOnlySegmentDurationMs = Math.max(80, Number(audioOnlySegmentDurationMs) || 220);
        this.audioOnlyTargetLatencySec = Math.max(0.2, Number(audioOnlyTargetLatencySec) || 0.45);
        this.audioProbeMs = Math.max(0, Number(audioProbeMs) || 0);
        this.controller = new MseLiveController({
            videoEl,
            onLog,
            onStatus,
            formatTime,
            targetLatencySec,
            keepBehindSec,
        });
        this.demuxer = new FlvLiveDemuxer();
        this.ws = null;
        this.processChain = Promise.resolve();
        this.avcC = null;
        this.avcLengthSize = 4;
        this.videoCodec = "";
        this.width = 1920;
        this.height = 1080;
        this.audioInfo = null;
        this.audioDisabled = false;
        this.mseHasAudioTrack = false;
        this.g711AudioStarted = false;
        this.audioProbeDone = false;
        this.audioEncoder = null;
        this.baseTsMs = null;
        this.audioOnlyModeLogged = false;
        this.audioOnlyLowLatencyApplied = false;
        this.pendingVideoSample = null;
        this.videoSamples = [];
        this.audioSamples = [];
        this.sequenceNumber = 1;
        this.seenVideo = 0;
        this.seenAudio = 0;
        this.token = 0;
    }

    async start(url) {
        if (!/^wss?:\/\//i.test(String(url || ""))) throw new Error("Live MSE currently expects a ws:// or wss:// FLV URL.");
        this.stop();
        this.token += 1;
        const token = this.token;
        this.demuxer.reset();
        this.status("Connecting live WS-FLV...");
        this.ws = new WebSocket(url);
        this.ws.binaryType = "arraybuffer";
        this.ws.onopen = () => this.status("Live WS-FLV connected. Waiting for FLV tags...");
        this.ws.onmessage = (event) => {
            if (token !== this.token) return;
            this.processChain = this.processChain
                .then(() => this.#handleMessage(event.data))
                .catch((err) => this.#handleError(err));
        };
        this.ws.onerror = () => {
            if (token === this.token) this.#handleError(new Error("Live WebSocket error."));
        };
        this.ws.onclose = () => {
            if (token !== this.token) return;
            this.log("[live flv] WebSocket closed.");
            this.#flushVideo(true).catch((err) => this.#handleError(err));
        };
    }

    stop() {
        this.token += 1;
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // ignore
            }
        }
        this.ws = null;
        if (this.audioEncoder) {
            try {
                this.audioEncoder.close();
            } catch {
                // ignore
            }
        }
        this.audioEncoder = null;
        this.controller.stop({ release: true });
        this.demuxer.reset();
        this.avcC = null;
        this.avcLengthSize = 4;
        this.videoCodec = "";
        this.audioInfo = null;
        this.audioDisabled = false;
        this.mseHasAudioTrack = false;
        this.g711AudioStarted = false;
        this.audioProbeDone = false;
        this.baseTsMs = null;
        this.audioOnlyModeLogged = false;
        this.audioOnlyLowLatencyApplied = false;
        this.pendingVideoSample = null;
        this.videoSamples = [];
        this.audioSamples = [];
        this.sequenceNumber = 1;
        this.seenVideo = 0;
        this.seenAudio = 0;
        this.processChain = Promise.resolve();
    }

    async #handleMessage(data) {
        let chunk = null;
        if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
        else if (typeof Blob !== "undefined" && data instanceof Blob) chunk = new Uint8Array(await data.arrayBuffer());
        if (!(chunk instanceof Uint8Array) || chunk.length <= 0) return;
        const tags = this.demuxer.push(chunk);
        if (this.#isAudioOnlyStream() && !this.audioOnlyModeLogged) {
            this.audioOnlyModeLogged = true;
            this.log("[live flv] FLV header indicates audio-only stream; enabling audio-only MSE.");
            this.#applyAudioOnlyLowLatencyProfile();
        }
        for (const tag of tags) {
            if (tag.kind === "avc-config") this.#handleAvcConfig(tag);
            else if (tag.kind === "video") await this.#handleVideo(tag);
            else if (tag.kind === "audio") await this.#handleAudio(tag);
        }
    }

    #handleAvcConfig(tag) {
        this.avcC = forceAvcC4ByteLengthSize(tag.avcC);
        this.avcLengthSize = avcLengthSizeFromAvcC(this.avcC);
        this.videoCodec = h264CodecFromAvcC(this.avcC);
        const dims = dimensionsFromAvcC(this.avcC);
        if (dims.width > 0 && dims.height > 0) {
            this.width = dims.width;
            this.height = dims.height;
        }
        this.log(`[live flv] AVC config ${this.videoCodec}, ${this.width}x${this.height}, lengthSize=${this.avcLengthSize}.`);
    }

    async #handleVideo(tag) {
        if (!(this.avcC instanceof Uint8Array)) return;
        const normalized = normalizeAvcSamplePayload(tag.payload, this.avcLengthSize);
        if (!(normalized instanceof Uint8Array) || normalized.length <= 0) return;
        const hasIdr = h264PayloadHasIdr(normalized);
        if (this.baseTsMs === null) {
            if (!hasIdr) return;
            this.baseTsMs = tag.timestampMs;
        }
        const dtsMs = Math.max(0, tag.timestampMs - this.baseTsMs);
        const ptsMs = Math.max(0, dtsMs + tag.compositionTimeMs);
        let data = hasIdr ? prependAvcParameterSetsToIdr(normalized, this.avcC) : normalized;
        const sample = {
            data,
            dtsMs,
            ptsMs,
            duration: 33,
            compositionOffset: Math.round(ptsMs - dtsMs),
            isKeyframe: hasIdr,
        };
        this.#pushVideoSample(sample);
        this.seenVideo += 1;
        if (!this.controller.opened) {
            if (!this.#readyToOpenMse(dtsMs)) return;
            await this.#openMse();
        }
        if (this.seenVideo % 120 === 0) this.log(`[live flv] video samples=${this.seenVideo}, audio=${this.seenAudio}, buffered=${formatRanges(this.videoEl.buffered, this.formatTime)}.`);
        await this.#flushVideo(false);
    }

    async #handleAudio(tag) {
        this.seenAudio += 1;
        if (tag.soundFormat === 7 || tag.soundFormat === 8) {
            await this.#handleG711Audio(tag);
        } else if (tag.soundFormat === 10) {
            await this.#handleAacAudio(tag);
        }
    }

    async #handleG711Audio(tag) {
        if (this.audioDisabled) return;
        if (this.controller.opened && !this.mseHasAudioTrack) {
            this.audioDisabled = true;
            this.log("[live audio] audio arrived after video-only init; live audio disabled until next reconnect.");
            return;
        }
        const sourceRate = 8000;
        const targetRate = 48000;
        const channels = tag.channels || 1;
        if (!this.audioInfo) {
            this.audioInfo = {
                codec: "mp4a.40.2",
                sampleRate: targetRate,
                channels,
                audioSpecificConfig: buildAacAudioSpecificConfig(2, targetRate, channels),
                source: tag.soundFormat === 8 ? "g711-mulaw" : "g711-alaw",
            };
            await this.#ensureAudioEncoder();
        }
        if (this.baseTsMs === null && this.#isAudioOnlyStream()) this.baseTsMs = tag.timestampMs;
        if (!this.audioEncoder || this.baseTsMs === null || tag.timestampMs < this.baseTsMs) return;
        const decoded = decodeG711ToFloat32(tag.payload, tag.soundFormat === 8 ? "mulaw" : "alaw", channels);
        if (!decoded.length || !decoded[0]?.length) return;
        let timestampMs = Math.max(0, tag.timestampMs - this.baseTsMs);
        let interleaved = interleaveChannels(decoded, channels);
        if (!this.g711AudioStarted) {
            const leadingFrames = Math.max(0, Math.round((timestampMs / 1000) * sourceRate));
            if (leadingFrames > 0) {
                interleaved = prependInterleavedSilence(interleaved, leadingFrames, channels);
                this.log(`[live audio] prepend PCMA silence ${leadingFrames} samples (${(leadingFrames / sourceRate).toFixed(3)}s).`);
            }
            timestampMs = 0;
            this.g711AudioStarted = true;
        }
        const resampled = resampleInterleavedFloat32(interleaved, sourceRate, targetRate, channels);
        const audioData = new AudioData({
            format: "f32",
            sampleRate: targetRate,
            numberOfFrames: Math.floor(resampled.length / channels),
            numberOfChannels: channels,
            timestamp: Math.max(0, Math.round(timestampMs * 1000)),
            data: resampled,
        });
        this.audioEncoder.encode(audioData);
        audioData.close();
        await this.#maybeOpenAfterAudioInfo();
        if (this.controller.opened) await this.#flushVideo(false);
    }

    async #handleAacAudio(tag) {
        if (this.controller.opened && !this.mseHasAudioTrack) {
            this.audioDisabled = true;
            this.log("[live audio] AAC arrived after video-only init; live audio disabled until next reconnect.");
            return;
        }
        if (tag.aacPacketType === 0) {
            const parsed = parseAacAudioSpecificConfig(tag.payload);
            this.audioInfo = {
                codec: `mp4a.40.${parsed.objectType || 2}`,
                sampleRate: parsed.sampleRate || 44100,
                channels: parsed.channels || 2,
                audioSpecificConfig: tag.payload.slice(0),
                source: "aac",
            };
            this.log(`[live flv] AAC config sampleRate=${this.audioInfo.sampleRate}, channels=${this.audioInfo.channels}.`);
            await this.#maybeOpenAfterAudioInfo();
            return;
        }
        if (this.baseTsMs === null && this.#isAudioOnlyStream()) this.baseTsMs = tag.timestampMs;
        if (!this.audioInfo || this.baseTsMs === null || tag.timestampMs < this.baseTsMs || !(tag.payload instanceof Uint8Array) || tag.payload.length <= 0) return;
        const dtsUnits = Math.max(0, Math.round(((tag.timestampMs - this.baseTsMs) / 1000) * this.audioInfo.sampleRate));
        this.audioSamples.push({
            data: tag.payload.slice(0),
            duration: 1024,
            dtsUnits,
            dtsMs: (dtsUnits / this.audioInfo.sampleRate) * 1000,
        });
        await this.#maybeOpenAfterAudioInfo();
        if (this.controller.opened) await this.#flushVideo(false);
    }

    async #ensureAudioEncoder() {
        if (this.audioEncoder || this.audioDisabled || !this.audioInfo) return;
        if (typeof AudioEncoder !== "function" || typeof AudioData !== "function") {
            this.audioDisabled = true;
            this.log("[live audio] WebCodecs AudioEncoder unavailable; live audio disabled.");
            return;
        }
        const config = {
            codec: "mp4a.40.2",
            sampleRate: this.audioInfo.sampleRate,
            numberOfChannels: this.audioInfo.channels,
            bitrate: 64000,
        };
        if (typeof AudioEncoder.isConfigSupported === "function") {
            const support = await AudioEncoder.isConfigSupported(config).catch(() => null);
            if (!support?.supported) {
                this.audioDisabled = true;
                this.log(`[live audio] AAC encoder unsupported (${config.sampleRate}Hz/${config.numberOfChannels}ch); live audio disabled.`);
                return;
            }
        }
        this.audioEncoder = new AudioEncoder({
            output: (chunk, metadata) => this.#handleEncodedAudio(chunk, metadata),
            error: (err) => {
                this.audioDisabled = true;
                this.log(`[live audio] AAC encoder error: ${err?.message || String(err)}`);
            },
        });
        this.audioEncoder.configure(config);
        this.log(`[live audio] PCMA/PCMU -> AAC encoder ready ${config.sampleRate}Hz/${config.numberOfChannels}ch.`);
    }

    #handleEncodedAudio(chunk, metadata) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const adts = parseAdtsAac(data);
        const payload = adts?.raw instanceof Uint8Array ? adts.raw.slice(0) : data;
        if (metadata?.decoderConfig?.description instanceof Uint8Array && this.audioInfo) {
            this.audioInfo.audioSpecificConfig = metadata.decoderConfig.description.slice(0);
        }
        const sampleRate = this.audioInfo?.sampleRate || 48000;
        this.audioSamples.push({
            data: payload,
            duration: Number.isFinite(chunk.duration) && chunk.duration > 0 ? Math.max(1, Math.round((chunk.duration / 1000000) * sampleRate)) : 1024,
            dtsUnits: Math.max(0, Math.round(((Number(chunk.timestamp) || 0) / 1000000) * sampleRate)),
            dtsMs: (Number(chunk.timestamp) || 0) / 1000,
        });
    }

    async #openMse() {
        const audio = this.audioInfo && !this.audioDisabled ? this.audioInfo : null;
        this.mseHasAudioTrack = !!audio;
        const hasVideo = this.avcC instanceof Uint8Array;
        const initSegment = buildLiveFmp4InitSegment({
            avcC: hasVideo ? this.avcC : null,
            width: this.width,
            height: this.height,
            audio,
        });
        const codecs = [hasVideo ? (this.videoCodec || h264CodecFromAvcC(this.avcC)) : null, audio?.codec].filter(Boolean);
        const mime = `${hasVideo ? "video" : "audio"}/mp4; codecs="${codecs.join(",")}"`;
        await this.controller.open({ mime, initSegment });
        this.status(`Live MSE ready (${mime}).`);
    }

    #readyToOpenMse(dtsMs) {
        if (this.audioInfo || this.audioDisabled) return true;
        if (this.demuxer.hasAudio === false) return true;
        const shouldProbeAudio = this.demuxer.hasAudio !== false && this.audioProbeMs > 0;
        if (!shouldProbeAudio) return true;
        if (Number(dtsMs) < this.audioProbeMs) return false;
        this.audioProbeDone = true;
        this.audioDisabled = true;
        this.log(`[live audio] no audio tag found during ${this.audioProbeMs}ms probe; opening video-only MSE.`);
        return true;
    }

    async #maybeOpenAfterAudioInfo() {
        if (this.controller.opened || this.baseTsMs === null) return;
        if (this.#isAudioOnlyStream()) {
            if (!this.audioInfo || !this.audioSamples.length) return;
            await this.#openMse();
            await this.#flushVideo(false);
            return;
        }
        if (!this.pendingVideoSample) return;
        if (!this.audioInfo && !this.audioDisabled) return;
        await this.#openMse();
        await this.#flushVideo(false);
    }

    #pushVideoSample(sample) {
        if (this.pendingVideoSample) {
            const duration = sample.dtsMs - this.pendingVideoSample.dtsMs;
            this.pendingVideoSample.duration = Math.max(1, Math.round(duration > 0 ? duration : 33));
            this.videoSamples.push(this.pendingVideoSample);
        }
        this.pendingVideoSample = sample;
    }

    async #flushVideo(force) {
        if (force && this.pendingVideoSample) {
            this.videoSamples.push(this.pendingVideoSample);
            this.pendingVideoSample = null;
        }
        const audioOnly = this.#isAudioOnlyStream();
        if (!this.videoSamples.length && !(audioOnly && this.audioSamples.length)) return;
        const firstVideo = this.videoSamples[0] || null;
        const lastVideo = this.videoSamples.length ? this.videoSamples[this.videoSamples.length - 1] : null;
        const firstAudio = this.audioSamples[0] || null;
        const lastAudio = this.audioSamples.length ? this.audioSamples[this.audioSamples.length - 1] : null;
        const audioRate = this.audioInfo?.sampleRate || 48000;
        const firstMs = firstVideo ? firstVideo.dtsMs : (firstAudio?.dtsMs || 0);
        const videoEndMs = lastVideo ? (lastVideo.dtsMs + (lastVideo.duration || 33)) : 0;
        const audioEndMs = lastAudio ? (lastAudio.dtsMs + (((lastAudio.duration || 1024) / audioRate) * 1000)) : 0;
        const endMs = Math.max(videoEndMs, audioEndMs);
        if (endMs <= firstMs) return;
        if (!force && endMs - firstMs < this.segmentDurationMs) return;
        if (this.audioEncoder && !this.audioDisabled) {
            try {
                await this.audioEncoder.flush();
            } catch (err) {
                this.audioDisabled = true;
                this.log(`[live audio] AAC encoder flush failed: ${err?.message || String(err)}`);
            }
        }
        const videoSamples = this.videoSamples.splice(0);
        const audioCutMs = audioOnly ? endMs : (endMs + 120);
        const audioSamples = [];
        const keepAudio = [];
        for (const sample of this.audioSamples) {
            if (sample.dtsMs <= audioCutMs) audioSamples.push(sample);
            else keepAudio.push(sample);
        }
        this.audioSamples = keepAudio;
        const segment = buildLiveFmp4MediaSegment({
            sequenceNumber: this.sequenceNumber++,
            videoSamples,
            audioSamples,
            videoBaseDecodeTime: Math.max(0, Math.round(firstVideo?.dtsMs || 0)),
            audioBaseDecodeTime: Math.max(0, Math.round(audioSamples[0]?.dtsUnits || 0)),
        });
        if (!(segment instanceof Uint8Array) || segment.length <= 0) return;
        await this.controller.appendSegment(segment);
        this.log(`[live remux] append seq=${this.sequenceNumber - 1}, video=${videoSamples.length}, audio=${audioSamples.length}, range=${this.formatTime(firstMs / 1000)}-${this.formatTime(endMs / 1000)}, bytes=${segment.length}.`);
    }

    #handleError(err) {
        this.status(`Live play failed: ${err?.message || String(err)}`);
    }

    #isAudioOnlyStream() {
        return this.demuxer?.hasAudio === true && this.demuxer?.hasVideo === false;
    }

    #applyAudioOnlyLowLatencyProfile() {
        if (this.audioOnlyLowLatencyApplied) return;
        this.audioOnlyLowLatencyApplied = true;
        this.segmentDurationMs = this.audioOnlySegmentDurationMs;
        this.controller.targetLatencySec = Math.min(this.controller.targetLatencySec, this.audioOnlyTargetLatencySec);
        this.controller.maxLatencySec = Math.max(this.controller.targetLatencySec + 0.25, this.controller.targetLatencySec * 2);
        this.log(`[live audio] low-latency profile enabled: segment=${this.segmentDurationMs}ms, targetLatency=${this.controller.targetLatencySec.toFixed(2)}s.`);
    }

    log(text) {
        if (this.onLog) this.onLog(text);
    }

    status(text) {
        if (this.onStatus) this.onStatus(text);
        else this.log(text);
    }
}

class FlvLiveDemuxer {
    constructor() {
        this.reset();
    }

    reset() {
        this.buffer = new Uint8Array(0);
        this.offset = 0;
        this.headerParsed = false;
        this.hasAudio = null;
        this.hasVideo = null;
    }

    push(chunk) {
        if (!(chunk instanceof Uint8Array) || chunk.length <= 0) return [];
        this.buffer = concatBytes([this.buffer.subarray(this.offset), chunk]);
        this.offset = 0;
        const out = [];
        if (!this.headerParsed) {
            if (this.buffer.length < 13) return out;
            if (this.buffer[0] !== 0x46 || this.buffer[1] !== 0x4c || this.buffer[2] !== 0x56) {
                throw new Error("WebSocket payload is not FLV.");
            }
            const flags = this.buffer[4] || 0;
            this.hasAudio = (flags & 0x04) !== 0;
            this.hasVideo = (flags & 0x01) !== 0;
            const dataOffset = readU32(this.buffer, 5);
            if (this.buffer.length < dataOffset + 4) return out;
            this.offset = dataOffset + 4;
            this.headerParsed = true;
        }
        while (this.offset + 11 <= this.buffer.length) {
            const pos = this.offset;
            const tagType = this.buffer[pos];
            const dataSize = readU24(this.buffer, pos + 1);
            const timestampMs = readU24(this.buffer, pos + 4) + (this.buffer[pos + 7] << 24);
            const total = 11 + dataSize + 4;
            if (pos + total > this.buffer.length) break;
            const body = this.buffer.subarray(pos + 11, pos + 11 + dataSize);
            const tag = parseFlvLiveTag(tagType, timestampMs, body);
            if (tag) out.push(tag);
            this.offset += total;
        }
        if (this.offset > 0 && this.offset >= this.buffer.length) {
            this.buffer = new Uint8Array(0);
            this.offset = 0;
        }
        return out;
    }
}

function parseFlvLiveTag(tagType, timestampMs, body) {
    if (!(body instanceof Uint8Array) || body.length <= 0) return null;
    if (tagType === 9) return parseVideoTag(timestampMs, body);
    if (tagType === 8) return parseAudioTag(timestampMs, body);
    return null;
}

function parseVideoTag(timestampMs, body) {
    const header = body[0];
    const frameType = (header >>> 4) & 0x0f;
    const codecId = header & 0x0f;
    if (codecId !== 7 || body.length < 5) return null;
    const avcPacketType = body[1];
    const compositionTimeMs = readI24(body, 2);
    const payload = body.subarray(5);
    if (avcPacketType === 0) return { kind: "avc-config", timestampMs, avcC: payload.slice(0) };
    if (avcPacketType !== 1 || payload.length <= 0) return null;
    return {
        kind: "video",
        timestampMs,
        compositionTimeMs,
        frameType,
        isKeyframe: frameType === 1,
        payload,
    };
}

function parseAudioTag(timestampMs, body) {
    const header = body[0];
    const soundFormat = (header >>> 4) & 0x0f;
    const soundRate = (header >>> 2) & 0x03;
    const soundType = header & 0x01;
    if (soundFormat === 10) {
        if (body.length < 2) return null;
        return {
            kind: "audio",
            timestampMs,
            soundFormat,
            soundRate,
            channels: soundType === 1 ? 2 : 1,
            aacPacketType: body[1],
            payload: body.subarray(2),
        };
    }
    if (soundFormat === 7 || soundFormat === 8) {
        return {
            kind: "audio",
            timestampMs,
            soundFormat,
            soundRate,
            channels: soundType === 1 ? 2 : 1,
            payload: body.subarray(1),
        };
    }
    return null;
}

function dimensionsFromAvcC(avcC) {
    try {
        const parsed = parseAvcDecoderConfigurationRecord(avcC, 0, avcC.length, {});
        const sps = parsed?.["sps[0]"] || {};
        return {
            width: Number(sps._actualWidth) || 0,
            height: Number(sps._actualHeight) || 0,
        };
    } catch {
        return { width: 0, height: 0 };
    }
}

function interleaveChannels(channelsData, channels) {
    const ch = Math.max(1, Math.round(Number(channels) || 1));
    const frames = Math.max(0, channelsData[0]?.length || 0);
    const out = new Float32Array(frames * ch);
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < ch; c++) out[i * ch + c] = channelsData[c]?.[i] || 0;
    }
    return out;
}

function resampleInterleavedFloat32(input, fromRate, toRate, channels) {
    const srcRate = Math.max(1, Math.round(Number(fromRate) || 1));
    const dstRate = Math.max(1, Math.round(Number(toRate) || srcRate));
    const ch = Math.max(1, Math.round(Number(channels) || 1));
    if (!(input instanceof Float32Array) || input.length <= 0 || srcRate === dstRate) return input;
    const srcFrames = Math.floor(input.length / ch);
    const dstFrames = Math.max(1, Math.round((srcFrames * dstRate) / srcRate));
    const out = new Float32Array(dstFrames * ch);
    for (let i = 0; i < dstFrames; i++) {
        const srcPos = (i * srcRate) / dstRate;
        const left = Math.min(srcFrames - 1, Math.floor(srcPos));
        const right = Math.min(srcFrames - 1, left + 1);
        const frac = srcPos - left;
        for (let c = 0; c < ch; c++) {
            const a = input[left * ch + c] || 0;
            const b = input[right * ch + c] || 0;
            out[i * ch + c] = a + (b - a) * frac;
        }
    }
    return out;
}

function prependInterleavedSilence(input, silenceFrames, channels) {
    const ch = Math.max(1, Math.round(Number(channels) || 1));
    const leading = Math.max(0, Math.round(Number(silenceFrames) || 0));
    if (!(input instanceof Float32Array) || input.length <= 0 || leading <= 0) return input;
    const out = new Float32Array(input.length + leading * ch);
    out.set(input, leading * ch);
    return out;
}

function parseAacAudioSpecificConfig(config) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    if (!(config instanceof Uint8Array) || config.length < 2) return { objectType: 2, sampleRate: 44100, channels: 2 };
    const objectType = (config[0] >>> 3) & 0x1f;
    const sampleRateIndex = ((config[0] & 0x07) << 1) | (config[1] >>> 7);
    const channels = (config[1] >>> 3) & 0x0f;
    return { objectType, sampleRate: rates[sampleRateIndex] || 44100, channels: channels || 2 };
}

function parseAdtsAac(payload) {
    if (!(payload instanceof Uint8Array) || payload.length < 7 || payload[0] !== 0xff || (payload[1] & 0xf0) !== 0xf0) return null;
    const frameLength = ((payload[3] & 0x03) << 11) | (payload[4] << 3) | ((payload[5] >>> 5) & 0x07);
    const headerLength = (payload[1] & 0x01) ? 7 : 9;
    if (frameLength <= headerLength || frameLength > payload.length) return null;
    return { raw: payload.subarray(headerLength, frameLength) };
}

function formatRanges(ranges, formatTime) {
    if (!ranges || typeof ranges.length !== "number" || ranges.length <= 0) return "empty";
    const out = [];
    for (let i = 0; i < ranges.length; i++) {
        try {
            out.push(`${formatTime(ranges.start(i))}-${formatTime(ranges.end(i))}`);
        } catch {
            // ignore stale ranges
        }
    }
    return out.join(", ") || "empty";
}

function concatBytes(parts) {
    const input = (parts || []).filter((part) => part instanceof Uint8Array && part.length > 0);
    const total = input.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of input) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
function readU24(bytes, off) { return (bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2]; }
function readU32(bytes, off) { return bytes[off] * 0x1000000 + ((bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]); }
function readI24(bytes, off) {
    let value = readU24(bytes, off);
    if (value & 0x800000) value -= 0x1000000;
    return value;
}

export const wsFlvMseLivePlayerCodec = Object.freeze({
    WsFlvMseLivePlayer,
});
