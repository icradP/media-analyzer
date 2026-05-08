export class MseLiveController {
    constructor({
        videoEl,
        onLog = null,
        onStatus = null,
        formatTime = null,
        keepBehindSec = 30,
        targetLatencySec = 2,
        maxLatencySec = 6,
    } = {}) {
        if (!(videoEl instanceof HTMLVideoElement)) throw new Error("videoEl is required.");
        this.videoEl = videoEl;
        this.onLog = typeof onLog === "function" ? onLog : null;
        this.onStatus = typeof onStatus === "function" ? onStatus : null;
        this.formatTime = typeof formatTime === "function" ? formatTime : ((n) => Number(n || 0).toFixed(3));
        this.keepBehindSec = Math.max(5, Number(keepBehindSec) || 30);
        this.targetLatencySec = Math.max(0.25, Number(targetLatencySec) || 2);
        this.maxLatencySec = Math.max(this.targetLatencySec + 0.5, Number(maxLatencySec) || 6);
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.objectUrl = "";
        this.appendChain = Promise.resolve();
        this.opened = false;
        this.started = false;
        this.mime = "";
    }

    async open({ mime, initSegment }) {
        const MediaSourceCtor = window.MediaSource || window.WebKitMediaSource;
        if (!MediaSourceCtor) throw new Error("MediaSource API is not available in this browser.");
        if (!mime || (typeof MediaSourceCtor.isTypeSupported === "function" && !MediaSourceCtor.isTypeSupported(mime))) {
            throw new Error(`Unsupported live MSE mime: ${mime || "-"}`);
        }
        if (!(initSegment instanceof Uint8Array) || initSegment.length <= 0) throw new Error("Missing live fMP4 init segment.");
        this.stop({ release: true });
        this.mime = mime;
        this.mediaSource = new MediaSourceCtor();
        this.objectUrl = URL.createObjectURL(this.mediaSource);
        const sourceOpen = waitEvent(this.mediaSource, "sourceopen", 10000);
        this.videoEl.src = this.objectUrl;
        await sourceOpen;
        this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
        try {
            this.sourceBuffer.mode = "segments";
        } catch {
            // Some browsers expose the property but do not allow changing it.
        }
        try {
            this.mediaSource.duration = Infinity;
        } catch {
            // Live MediaSource duration may be readonly in some engines.
        }
        await this.#appendNow(initSegment);
        this.opened = true;
        this.log(`[live mse] opened ${mime}, init=${initSegment.length} bytes.`);
    }

    appendSegment(segment) {
        if (!(segment instanceof Uint8Array) || segment.length <= 0) return this.appendChain;
        if (!this.sourceBuffer) return Promise.reject(new Error("Live MSE SourceBuffer is not open."));
        this.appendChain = this.appendChain
            .then(() => this.#appendNow(segment))
            .then(() => this.#afterAppend())
            .catch((err) => {
                this.log(`[live mse] append failed: ${err?.message || String(err)}`);
                throw err;
            });
        return this.appendChain;
    }

    async #appendNow(bytes) {
        if (!this.sourceBuffer) throw new Error("Live MSE SourceBuffer is not open.");
        await appendMseBytes(this.sourceBuffer, bytes);
    }

    async #afterAppend() {
        await this.#trimBehind();
        this.#adjustLiveLatency();
        if (!this.started) await this.#startWhenReady();
    }

    async #startWhenReady() {
        const ranges = this.videoEl.buffered;
        if (!ranges || ranges.length <= 0) return;
        const end = ranges.end(ranges.length - 1);
        const start = ranges.start(ranges.length - 1);
        const ahead = end - start;
        if (ahead < this.targetLatencySec) return;
        this.videoEl.currentTime = Math.max(start, end - this.targetLatencySec);
        try {
            await this.videoEl.play();
            this.started = true;
            this.status(`Live MSE playing, latency=${this.targetLatencySec.toFixed(1)}s.`);
        } catch (err) {
            this.log(`[live mse] play() failed: ${err?.message || String(err)}`);
        }
    }

    #adjustLiveLatency() {
        const ranges = this.videoEl.buffered;
        if (!ranges || ranges.length <= 0 || this.videoEl.paused) return;
        const end = ranges.end(ranges.length - 1);
        const latency = end - this.videoEl.currentTime;
        if (latency > this.maxLatencySec) {
            const target = Math.max(ranges.start(ranges.length - 1), end - this.targetLatencySec);
            this.videoEl.currentTime = target;
            this.log(`[live mse] latency catch-up seek ${this.formatTime(target)} (latency=${latency.toFixed(2)}s).`);
        }
    }

    async #trimBehind() {
        const sb = this.sourceBuffer;
        const ranges = sb?.buffered;
        if (!sb || !ranges || ranges.length <= 0 || sb.updating) return;
        const current = Number(this.videoEl.currentTime);
        if (!Number.isFinite(current) || current <= this.keepBehindSec) return;
        const removeEnd = current - this.keepBehindSec;
        for (let i = 0; i < ranges.length; i++) {
            const start = ranges.start(i);
            const end = Math.min(ranges.end(i), removeEnd);
            if (end > start + 0.2) {
                await removeMseRange(sb, start, end);
                this.log(`[live mse] trimmed ${this.formatTime(start)}-${this.formatTime(end)}.`);
                break;
            }
        }
    }

    stop({ release = false } = {}) {
        try {
            this.videoEl.pause();
        } catch {
            // ignore
        }
        this.appendChain = Promise.resolve();
        this.opened = false;
        this.started = false;
        if (!release) return;
        this.sourceBuffer = null;
        this.mediaSource = null;
        this.videoEl.removeAttribute("src");
        try {
            this.videoEl.load();
        } catch {
            // ignore
        }
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = "";
        }
    }

    log(text) {
        if (this.onLog) this.onLog(text);
    }

    status(text) {
        if (this.onStatus) this.onStatus(text);
        else this.log(text);
    }
}

export function buildLiveFmp4InitSegment({
    avcC,
    width = 1920,
    height = 1080,
    videoTimescale = 1000,
    audio = null,
} = {}) {
    const hasVideo = avcC instanceof Uint8Array && avcC.length >= 7;
    if (!hasVideo && !audio) throw new Error("Missing tracks for live fMP4 init.");
    const brands = [asciiBytes("isom"), asciiBytes("iso6"), asciiBytes("avc1"), asciiBytes("mp41"), asciiBytes("mp42")];
    const ftyp = mp4Box("ftyp", asciiBytes("isom"), u32(0x00000200), ...brands);
    const moov = buildMoov({ avcC: hasVideo ? avcC : null, width, height, videoTimescale, audio });
    return concatBytes([ftyp, moov]);
}

export function buildLiveFmp4MediaSegment({
    sequenceNumber = 1,
    videoSamples = [],
    audioSamples = [],
    videoBaseDecodeTime = 0,
    audioBaseDecodeTime = 0,
} = {}) {
    const samples = [
        ...videoSamples.map((sample) => sample.data),
        ...audioSamples.map((sample) => sample.data),
    ];
    if (!samples.length) return null;
    const moof = buildMoof({
        sequenceNumber,
        videoSamples,
        audioSamples,
        videoBaseDecodeTime,
        audioBaseDecodeTime,
    });
    const mdat = mp4Box("mdat", concatBytes(samples));
    return concatBytes([moof, mdat]);
}

export function h264CodecFromAvcC(avcC) {
    if (!(avcC instanceof Uint8Array) || avcC.length < 4) return "avc1.42E01E";
    const hex = [avcC[1], avcC[2], avcC[3]]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
    return `avc1.${hex}`;
}

export function forceAvcC4ByteLengthSize(avcC) {
    if (!(avcC instanceof Uint8Array) || avcC.length < 5) return null;
    const out = avcC.slice(0);
    out[4] = (out[4] & 0xfc) | 0x03;
    return out;
}

export function avcLengthSizeFromAvcC(avcC) {
    return avcC instanceof Uint8Array && avcC.length >= 5 ? ((avcC[4] & 0x03) + 1) || 4 : 4;
}

export function normalizeAvcSamplePayload(payload, lengthSize = 4) {
    const nalus = splitLengthPrefixedNalUnits(payload, lengthSize) || splitLengthPrefixedNalUnits(payload, 4);
    if (!nalus?.length) return null;
    const kept = [];
    let hasVcl = false;
    for (const nalu of nalus) {
        if (!(nalu instanceof Uint8Array) || nalu.length <= 0) continue;
        const type = nalu[0] & 0x1f;
        if (type === 9 || type === 12) continue;
        if (![1, 5, 6, 7, 8].includes(type)) continue;
        if (type === 1 || type === 5) hasVcl = true;
        kept.push(nalu);
    }
    if (!hasVcl || !kept.length) return null;
    return concatBytes(kept.map((nalu) => concatBytes([u32(nalu.length), nalu])));
}

export function h264NalTypes(payload) {
    const nalus = splitLengthPrefixedNalUnits(payload, 4) || [];
    return nalus.map((nalu) => nalu[0] & 0x1f);
}

export function h264PayloadHasIdr(payload) {
    return h264NalTypes(payload).includes(5);
}

export function prependAvcParameterSetsToIdr(sampleData, avcC) {
    if (!(sampleData instanceof Uint8Array) || !h264PayloadHasIdr(sampleData)) return sampleData;
    const { sps, pps } = parseAvcCParameterSets(avcC);
    const spsBytes = sps ? concatBytes([u32(sps.length), sps]) : null;
    const ppsBytes = pps ? concatBytes([u32(pps.length), pps]) : null;
    return spsBytes && ppsBytes ? concatBytes([spsBytes, ppsBytes, sampleData]) : sampleData;
}

function buildMoov({ avcC, width, height, videoTimescale, audio }) {
    const videoTrackId = 1;
    const audioTrackId = 2;
    const hasVideo = avcC instanceof Uint8Array && avcC.length >= 7;
    const traks = [];
    const trexs = [];
    if (hasVideo) {
        const videoTrak = mp4Box(
            "trak",
            buildTkhd({ trackId: videoTrackId, width, height, duration: 0, volume: 0 }),
            mp4Box(
                "mdia",
                buildMdhd(videoTimescale, 0),
                buildHdlr("vide", "VideoHandler"),
                mp4Box(
                    "minf",
                    fullMp4Box("vmhd", 0, 0x000001, u16(0), u16(0), u16(0), u16(0)),
                    buildDinf(),
                    buildVideoStbl(width, height, avcC),
                ),
            ),
        );
        traks.push(videoTrak);
        trexs.push(buildTrex(videoTrackId));
    }
    if (audio) {
        const sampleRate = Math.max(1, Math.round(Number(audio.sampleRate) || 48000));
        traks.push(mp4Box(
            "trak",
            buildTkhd({ trackId: audioTrackId, duration: 0, volume: 0x0100 }),
            mp4Box(
                "mdia",
                buildMdhd(sampleRate, 0),
                buildHdlr("soun", "SoundHandler"),
                mp4Box(
                    "minf",
                    fullMp4Box("smhd", 0, 0, u16(0), u16(0)),
                    buildDinf(),
                    buildAudioStbl(audio),
                ),
            ),
        ));
        trexs.push(buildTrex(audioTrackId));
    }
    const nextTrackId = traks.length + 1;
    return mp4Box("moov", buildMvhd(1000, 0, nextTrackId), ...traks, mp4Box("mvex", ...trexs));
}

function buildMoof({ sequenceNumber, videoSamples, audioSamples, videoBaseDecodeTime, audioBaseDecodeTime }) {
    const mfhd = fullMp4Box("mfhd", 0, 0, u32(sequenceNumber));
    const trafs = buildTrafs({ videoSamples, audioSamples, videoBaseDecodeTime, audioBaseDecodeTime, dataOffsets: null });
    let moof = mp4Box("moof", mfhd, ...trafs);
    const videoBytes = videoSamples.reduce((sum, sample) => sum + sample.data.length, 0);
    const dataOffsets = {
        video: moof.length + 8,
        audio: moof.length + 8 + videoBytes,
    };
    return mp4Box("moof", mfhd, ...buildTrafs({ videoSamples, audioSamples, videoBaseDecodeTime, audioBaseDecodeTime, dataOffsets }));
}

function buildTrafs({ videoSamples, audioSamples, videoBaseDecodeTime, audioBaseDecodeTime, dataOffsets }) {
    const trafs = [];
    if (videoSamples.length) {
        trafs.push(mp4Box(
            "traf",
            fullMp4Box("tfhd", 0, 0x020000, u32(1)),
            fullMp4Box("tfdt", 1, 0, u64(videoBaseDecodeTime)),
            buildVideoTrun(videoSamples, dataOffsets?.video || 0),
        ));
    }
    if (audioSamples.length) {
        trafs.push(mp4Box(
            "traf",
            fullMp4Box("tfhd", 0, 0x020000, u32(2)),
            fullMp4Box("tfdt", 1, 0, u64(audioBaseDecodeTime)),
            buildAudioTrun(audioSamples, dataOffsets?.audio || 0),
        ));
    }
    return trafs;
}

function buildMvhd(timescale, duration, nextTrackId) {
    return fullMp4Box("mvhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), mp4Matrix(), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(nextTrackId));
}
function buildTkhd({ trackId, width = 0, height = 0, duration = 0, volume = 0 }) {
    return fullMp4Box("tkhd", 0, 0x000007, u32(0), u32(0), u32(trackId), u32(0), u32(duration), u32(0), u32(0), u16(0), u16(0), u16(volume), u16(0), mp4Matrix(), fixed16_16(width), fixed16_16(height));
}
function buildMdhd(timescale, duration) { return fullMp4Box("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)); }
function buildHdlr(handlerType, name) { return fullMp4Box("hdlr", 0, 0, u32(0), asciiBytes(handlerType), u32(0), u32(0), u32(0), asciiBytes(`${name}\0`)); }
function buildDinf() { const url = fullMp4Box("url ", 0, 0x000001); return mp4Box("dinf", fullMp4Box("dref", 0, 0, u32(1), url)); }
function buildTrex(trackId) { return fullMp4Box("trex", 0, 0, u32(trackId), u32(1), u32(0), u32(0), u32(0)); }
function buildVideoStbl(width, height, avcC) {
    return mp4Box("stbl", fullMp4Box("stsd", 0, 0, u32(1), buildAvc1SampleEntry(width, height, avcC)), fullMp4Box("stts", 0, 0, u32(0)), fullMp4Box("stsc", 0, 0, u32(0)), fullMp4Box("stsz", 0, 0, u32(0), u32(0)), fullMp4Box("stco", 0, 0, u32(0)));
}
function buildAudioStbl(audio) {
    return mp4Box("stbl", fullMp4Box("stsd", 0, 0, u32(1), buildMp4aSampleEntry(audio)), fullMp4Box("stts", 0, 0, u32(0)), fullMp4Box("stsc", 0, 0, u32(0)), fullMp4Box("stsz", 0, 0, u32(0), u32(0)), fullMp4Box("stco", 0, 0, u32(0)));
}
function buildAvc1SampleEntry(width, height, avcC) {
    return mp4Box("avc1", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), u16(0), u16(0), u32(0), u32(0), u32(0), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Uint8Array(32), u16(0x0018), u16(0xffff), mp4Box("avcC", avcC));
}
function buildMp4aSampleEntry({ sampleRate = 48000, channels = 1, audioSpecificConfig = buildAacAudioSpecificConfig(2, sampleRate, channels), avgBitrate = 64000 }) {
    const rate = Math.max(1, Math.round(Number(sampleRate) || 48000));
    const ch = Math.max(1, Math.min(8, Math.round(Number(channels) || 1)));
    return mp4Box("mp4a", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), u32(0), u32(0), u16(ch), u16(16), u16(0), u16(0), u32(rate * 65536), buildEsds(audioSpecificConfig, avgBitrate));
}
function buildEsds(audioSpecificConfig, avgBitrate) {
    const asc = audioSpecificConfig instanceof Uint8Array ? audioSpecificConfig : buildAacAudioSpecificConfig(2, 48000, 1);
    const decoderSpecific = concatBytes([u8(0x05), descriptorLength(asc.length), asc]);
    const decoderConfigBody = concatBytes([u8(0x40), u8(0x15), u24(0), u32(avgBitrate || 0), u32(avgBitrate || 0), decoderSpecific]);
    const decoderConfig = concatBytes([u8(0x04), descriptorLength(decoderConfigBody.length), decoderConfigBody]);
    const slConfig = concatBytes([u8(0x06), descriptorLength(1), u8(0x02)]);
    const esBody = concatBytes([u16(1), u8(0), decoderConfig, slConfig]);
    return fullMp4Box("esds", 0, 0, u8(0x03), descriptorLength(esBody.length), esBody);
}
function buildVideoTrun(samples, dataOffset) {
    const rows = [];
    for (const s of samples) rows.push(u32(s.duration), u32(s.data.length), u32(s.isKeyframe ? 0x02000000 : 0x01010000), i32(s.compositionOffset || 0));
    return fullMp4Box("trun", 1, 0x000f01, u32(samples.length), i32(dataOffset), ...rows);
}
function buildAudioTrun(samples, dataOffset) {
    const rows = [];
    for (const s of samples) rows.push(u32(s.duration), u32(s.data.length));
    return fullMp4Box("trun", 0, 0x000301, u32(samples.length), i32(dataOffset), ...rows);
}

export function buildAacAudioSpecificConfig(objectType = 2, sampleRate = 48000, channels = 1) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const ot = Math.max(1, Math.min(31, Math.round(Number(objectType) || 2)));
    let sampleRateIndex = rates.indexOf(Math.round(Number(sampleRate) || 48000));
    if (sampleRateIndex < 0) sampleRateIndex = 3;
    const channelConfig = Math.max(1, Math.min(15, Math.round(Number(channels) || 1)));
    return Uint8Array.of(((ot & 0x1f) << 3) | ((sampleRateIndex >> 1) & 0x07), ((sampleRateIndex & 0x01) << 7) | ((channelConfig & 0x0f) << 3));
}

function parseAvcCParameterSets(avcC) {
    if (!(avcC instanceof Uint8Array) || avcC.length < 7) return { sps: null, pps: null };
    let off = 5;
    const spsCount = avcC[off++] & 0x1f;
    let sps = null;
    for (let i = 0; i < spsCount && off + 2 <= avcC.length; i++) {
        const len = (avcC[off] << 8) | avcC[off + 1];
        off += 2;
        if (len <= 0 || off + len > avcC.length) break;
        if (!sps) sps = avcC.slice(off, off + len);
        off += len;
    }
    const ppsCount = avcC[off++] || 0;
    let pps = null;
    for (let i = 0; i < ppsCount && off + 2 <= avcC.length; i++) {
        const len = (avcC[off] << 8) | avcC[off + 1];
        off += 2;
        if (len <= 0 || off + len > avcC.length) break;
        if (!pps) pps = avcC.slice(off, off + len);
        off += len;
    }
    return { sps, pps };
}

function splitLengthPrefixedNalUnits(bytes, lengthSize) {
    if (!(bytes instanceof Uint8Array) || lengthSize < 1 || lengthSize > 4) return null;
    const nalus = [];
    let off = 0;
    while (off + lengthSize <= bytes.length) {
        let len = 0;
        for (let i = 0; i < lengthSize; i++) len = (len * 256) + bytes[off + i];
        off += lengthSize;
        if (len <= 0 || off + len > bytes.length) return null;
        nalus.push(bytes.subarray(off, off + len));
        off += len;
    }
    return off === bytes.length && nalus.length ? nalus : null;
}

function appendMseBytes(sourceBuffer, bytes) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            sourceBuffer.removeEventListener("updateend", onDone);
            sourceBuffer.removeEventListener("error", onError);
        };
        const onDone = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("MSE SourceBuffer append failed.")); };
        sourceBuffer.addEventListener("updateend", onDone, { once: true });
        sourceBuffer.addEventListener("error", onError, { once: true });
        sourceBuffer.appendBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    });
}

function removeMseRange(sourceBuffer, start, end) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            sourceBuffer.removeEventListener("updateend", onDone);
            sourceBuffer.removeEventListener("error", onError);
        };
        const onDone = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error("MSE SourceBuffer remove failed.")); };
        sourceBuffer.addEventListener("updateend", onDone, { once: true });
        sourceBuffer.addEventListener("error", onError, { once: true });
        sourceBuffer.remove(start, end);
    });
}

function waitEvent(target, eventName, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Timeout waiting ${eventName}`)); }, timeoutMs);
        const onDone = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error(`Error while waiting ${eventName}`)); };
        const cleanup = () => {
            clearTimeout(timer);
            target.removeEventListener(eventName, onDone);
            target.removeEventListener("error", onError);
        };
        target.addEventListener(eventName, onDone, { once: true });
        target.addEventListener("error", onError, { once: true });
    });
}

function concatBytes(parts) {
    const input = (parts || []).filter((p) => p instanceof Uint8Array && p.length > 0);
    const total = input.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of input) {
        out.set(part, off);
        off += part.length;
    }
    return out;
}
function asciiBytes(text) { const s = String(text); const out = new Uint8Array(s.length); for (let i = 0; i < out.length; i++) out[i] = s.charCodeAt(i) & 0xff; return out; }
function u8(v) { return Uint8Array.of(Number(v) & 0xff); }
function u16(v) { const n = Math.max(0, Math.min(0xffff, Math.round(Number(v) || 0))); return Uint8Array.of((n >>> 8) & 0xff, n & 0xff); }
function u24(v) { const n = Math.max(0, Math.min(0xffffff, Math.round(Number(v) || 0))); return Uint8Array.of((n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
function u32(v) { const n = Math.max(0, Math.min(0xffffffff, Math.round(Number(v) || 0))); return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
function i32(v) { const n = Math.round(Number(v) || 0) >>> 0; return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
function u64(v) { const n = Math.max(0, Math.floor(Number(v) || 0)); const hi = Math.floor(n / 0x100000000); const lo = n % 0x100000000; return concatBytes([u32(hi), u32(lo)]); }
function fixed16_16(v) { return u32(Math.round((Number(v) || 0) * 65536)); }
function mp4Matrix() { return concatBytes([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]); }
function mp4Box(type, ...payloads) { const body = concatBytes(payloads); const out = new Uint8Array(8 + body.length); out.set(u32(out.length), 0); out.set(asciiBytes(type).subarray(0, 4), 4); out.set(body, 8); return out; }
function fullMp4Box(type, version, flags, ...payloads) { return mp4Box(type, u8(version), u24(flags), ...payloads); }
function descriptorLength(length) { return u8(Math.max(0, Math.min(0x7f, Number(length) || 0))); }

export const mseLiveControllerCodec = Object.freeze({
    MseLiveController,
    buildLiveFmp4InitSegment,
    buildLiveFmp4MediaSegment,
    h264CodecFromAvcC,
    buildAacAudioSpecificConfig,
});
