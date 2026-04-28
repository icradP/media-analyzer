import { buildVideoDecodePlan, collectVideoFrames, pickPrimaryMediaResult } from "../browser/framePlayback.js";
import { resolveVideoDecoderCodecForStream } from "../browser/videoDecodeOrchestrator.js";
import { Canvas2DVideoRenderer } from "./canvas2dRenderer.js";
import { MediaClock } from "./mediaClock.js";
import { FrameQueue } from "./mediaQueue.js";

export class VideoSegmentPlayer {
    constructor({
        mediaInfo,
        canvas = null,
        renderer = null,
        stream = null,
        playbackRate = 1,
        maxQueuedFrames = 120,
        dropLateFrames = true,
        lateFrameThresholdMs = 250,
        onStatus = null,
        onFrame = null,
        onError = null,
    } = {}) {
        if (!mediaInfo) throw new Error("mediaInfo is required.");
        this.mediaInfo = mediaInfo;
        this.primary = pickPrimaryMediaResult(mediaInfo);
        if (!this.primary) throw new Error("No media result.");
        this.stream = stream || (this.primary.streams || []).find((s) => s.codecType === "video") || null;
        this.renderer = renderer || new Canvas2DVideoRenderer(canvas);
        this.clock = new MediaClock({ playbackRate });
        this.frameQueue = new FrameQueue({
            maxSize: maxQueuedFrames,
            onDrop: (item) => closeVideoFrame(item?.frame),
        });
        this.dropLateFrames = !!dropLateFrames;
        this.lateFrameThresholdMs = Number.isFinite(Number(lateFrameThresholdMs)) ? Number(lateFrameThresholdMs) : 250;
        this.onStatus = typeof onStatus === "function" ? onStatus : null;
        this.onFrame = typeof onFrame === "function" ? onFrame : null;
        this.onError = typeof onError === "function" ? onError : null;
        this.decoder = null;
        this.renderJobs = [];
        this.token = 0;
        this.state = "idle";
        this.sequence = 0;
    }

    setPlaybackRate(playbackRate) {
        this.clock.setPlaybackRate(playbackRate);
    }

    stop() {
        this.token += 1;
        this.state = "stopped";
        this.closeDecoder();
        for (const job of this.renderJobs) {
            clearTimeout(job.timerId);
            closeVideoFrame(job.item?.frame);
        }
        this.renderJobs = [];
        this.frameQueue.clear();
    }

    pause() {
        if (this.state !== "playing") return;
        this.state = "paused";
        this.clock.pause();
        const jobs = this.renderJobs;
        this.renderJobs = [];
        for (const job of jobs) {
            clearTimeout(job.timerId);
            if (job.item) this.frameQueue.push(job.item);
        }
    }

    resume() {
        if (this.state !== "paused") return;
        this.state = "playing";
        this.clock.resume();
        this.scheduleQueuedFrames(this.token);
    }

    async playSegment({ startSec, endSec, frames = null, codecString = null } = {}) {
        const start = Number(startSec);
        const end = Number(endSec);
        if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("startSec/endSec must be numbers.");
        if (end < start) throw new Error("endSec must be >= startSec.");
        this.stop();
        this.state = "playing";
        const token = this.token;
        const targetFrames = this.pickSegmentFrames(start, end, frames);
        if (!targetFrames.length) throw new Error("No video frames in selected segment.");
        const realFrames = targetFrames.filter((f) => !isVideoConfigFrame(f));
        if (!realFrames.length) throw new Error("Segment contains only video config frames, no decodable picture.");
        const groups = buildDecodeGroups(realFrames, collectVideoFrames(this.mediaInfo));
        if (!groups.length) throw new Error("No decodable GOP group found for selected segment.");
        const firstPts = frameTimeSec(realFrames[0], start);
        const lastPts = frameTimeSec(realFrames[realFrames.length - 1], firstPts);
        const resolvedCodec = codecString || await resolveVideoDecoderCodecForStream(this.stream);
        if (!resolvedCodec) throw new Error(`Unsupported codecName for WebCodecs: ${this.stream?.codecName || "unknown"}`);
        this.clock.start(firstPts);
        this.status(`Video segment play: frames=${realFrames.length}, GOPs=${groups.length}, pts=[${start.toFixed(3)}, ${end.toFixed(3)}], rate=${this.clock.playbackRate}x`);
        try {
            for (const group of groups) {
                if (token !== this.token) return { stopped: true };
                await this.decodeGroup({
                    group,
                    codecString: resolvedCodec,
                    token,
                });
                this.scheduleQueuedFrames(token);
            }
            const waitMs = this.clock.delayMsForMediaTime(lastPts) + 50;
            if (waitMs > 1) await sleep(waitMs);
            if (token !== this.token) return { stopped: true };
            this.scheduleQueuedFrames(token);
            await this.waitForRenderDrain(token);
            if (token !== this.token) return { stopped: true };
            this.status("Video segment play done.");
            this.state = "idle";
            return {
                stopped: false,
                frames: realFrames.length,
                groups: groups.length,
                codecString: resolvedCodec,
            };
        } catch (err) {
            if (token === this.token) {
                this.state = "error";
                if (this.onError) this.onError(err);
            }
            throw err;
        } finally {
            if (token === this.token) this.closeDecoder();
        }
    }

    pickSegmentFrames(startSec, endSec, frames) {
        const sourceFrames = Array.isArray(frames) && frames.length
            ? frames.map(unwrapFrame).filter(Boolean)
            : collectVideoFrames(this.mediaInfo);
        return sourceFrames
            .filter((frame) => frame?.mediaType === "video" || frame?._mediaType === "video" || !frame?.mediaType)
            .filter((frame) => {
                const t = frameTimeSec(frame, null);
                return typeof t === "number" && t >= startSec && t <= endSec;
            })
            .sort(compareFramesByTimeThenIndex);
    }

    async decodeGroup({ group, codecString, token }) {
        if (typeof VideoDecoder === "undefined") {
            throw new Error("VideoDecoder API is not available in this browser.");
        }
        const lastTarget = group.frames[group.frames.length - 1];
        const targetFrameIndex = frameIndex(lastTarget);
        if (targetFrameIndex === null) return;
        const plan = buildVideoDecodePlan({
            mediaInfo: this.mediaInfo,
            targetFrameIndex,
        });
        const visibleFrameIndexes = new Set(group.frames.map(frameIndex).filter((idx) => idx !== null));
        const timestampMeta = new Map();
        const metas = Array.isArray(plan.encodedFrameMeta) ? plan.encodedFrameMeta : [];
        const timestampStepUs = 33333;
        let lastQueuedChunk = null;
        let decodeError = null;
        let decodeErrorAt = null;
        const decoder = new VideoDecoder({
            output: (frame) => {
                if (token !== this.token) {
                    closeVideoFrame(frame);
                    return;
                }
                const meta = timestampMeta.get(frame.timestamp);
                const idx = Number(meta?.frameIndex);
                if (!Number.isFinite(idx) || !visibleFrameIndexes.has(idx)) {
                    closeVideoFrame(frame);
                    return;
                }
                const ptsTime = frameTimeSec(meta, this.clock.baseMediaTimeSec);
                this.frameQueue.push({
                    frame,
                    meta,
                    frameIndex: idx,
                    ptsTime,
                    sequence: this.sequence++,
                });
                this.scheduleQueuedFrames(token);
            },
            error: (err) => {
                decodeError = err || new Error("VideoDecoder error");
                decodeErrorAt = lastQueuedChunk;
            },
        });
        this.closeDecoder();
        this.decoder = decoder;
        decoder.configure({
            codec: codecString,
            description: plan.description || undefined,
            optimizeForLatency: true,
        });
        for (let i = 0; i < plan.encodedFrames.length; i++) {
            if (token !== this.token) return;
            const item = plan.encodedFrames[i];
            const data = item?.data;
            if (!(data instanceof Uint8Array) || data.length === 0) continue;
            const meta = metas[i] || null;
            const timestampUs = i * timestampStepUs;
            timestampMeta.set(timestampUs, meta);
            const chunkType = item?.type === "key" ? "key" : "delta";
            lastQueuedChunk = {
                chunkIndex: i,
                type: chunkType,
                timestampUs,
                size: data.length,
                frameIndex: meta?.frameIndex ?? null,
                pts: meta?.pts ?? null,
                dts: meta?.dts ?? null,
                ptsTime: meta?.ptsTime ?? null,
                dtsTime: meta?.dtsTime ?? null,
            };
            try {
                decoder.decode(new EncodedVideoChunk({
                    type: chunkType,
                    timestamp: timestampUs,
                    data,
                }));
            } catch (err) {
                throw wrapDecodeError(err, {
                    message: `VideoSegmentPlayer.decode failed at chunk ${i}`,
                    stage: "decode",
                    codecString,
                    plan,
                    chunk: lastQueuedChunk,
                });
            }
        }
        try {
            await decoder.flush();
        } catch (err) {
            if (token !== this.token) return;
            throw wrapDecodeError(err, {
                message: "VideoSegmentPlayer.flush failed",
                stage: "flush",
                codecString,
                plan,
                chunk: decodeErrorAt || lastQueuedChunk,
            });
        }
        if (decodeError && token === this.token) {
            throw wrapDecodeError(decodeError, {
                message: "VideoSegmentPlayer decoder error callback",
                stage: "decoder-error-callback",
                codecString,
                plan,
                chunk: decodeErrorAt || lastQueuedChunk,
            });
        }
        if (this.decoder === decoder) this.decoder = null;
        try {
            decoder.close();
        } catch {
            // ignore close error
        }
    }

    scheduleQueuedFrames(token) {
        if (this.state !== "playing") return;
        const items = this.frameQueue.toArray();
        this.frameQueue.items = [];
        for (const item of items) {
            if (token !== this.token) {
                closeVideoFrame(item?.frame);
                continue;
            }
            this.scheduleRender(item, token);
        }
    }

    scheduleRender(item, token) {
        const delay = this.clock.delayMsForMediaTime(item.ptsTime);
        if (this.dropLateFrames && delay < -this.lateFrameThresholdMs) {
            closeVideoFrame(item?.frame);
            return;
        }
        const job = { timerId: null, item };
        job.timerId = setTimeout(() => {
            const jobIdx = this.renderJobs.indexOf(job);
            if (jobIdx >= 0) this.renderJobs.splice(jobIdx, 1);
            try {
                if (token !== this.token || this.state !== "playing") return;
                this.renderer.render(item.frame);
                if (this.onFrame) this.onFrame(item);
            } finally {
                closeVideoFrame(item?.frame);
            }
        }, Math.max(0, delay));
        this.renderJobs.push(job);
    }

    async waitForRenderDrain(token) {
        while (token === this.token && this.renderJobs.length > 0) {
            await sleep(10);
        }
    }

    closeDecoder() {
        if (!this.decoder) return;
        try {
            this.decoder.close();
        } catch {
            // ignore close error
        }
        this.decoder = null;
    }

    status(text) {
        if (this.onStatus) this.onStatus(text);
    }
}

function buildDecodeGroups(frames, allVideoFrames = frames) {
    const sorted = frames.slice().sort(compareFramesByTimeThenIndex);
    const allVideo = sortedAllVideoFramesForGrouping(allVideoFrames);
    const groupsByKey = new Map();
    for (const frame of sorted) {
        const key = previousKeyFrameIndex(frame, allVideo);
        if (key === null) continue;
        if (!groupsByKey.has(key)) groupsByKey.set(key, { keyFrameIndex: key, frames: [] });
        groupsByKey.get(key).frames.push(frame);
    }
    return Array.from(groupsByKey.values()).sort((a, b) => {
        const af = a.frames[0];
        const bf = b.frames[0];
        return compareFramesByTimeThenIndex(af, bf);
    });
}

function sortedAllVideoFramesForGrouping(frames) {
    const source = frames.map(unwrapFrame).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const frame of source) {
        const idx = frameIndex(frame);
        if (idx === null || seen.has(idx)) continue;
        seen.add(idx);
        out.push(frame);
    }
    return out.sort((a, b) => (frameIndex(a) ?? 0) - (frameIndex(b) ?? 0));
}

function previousKeyFrameIndex(frame, videoFrames) {
    const idx = frameIndex(frame);
    if (idx === null) return null;
    const pos = videoFrames.findIndex((item) => frameIndex(item) === idx);
    if (pos < 0) return idx;
    let probe = pos;
    while (probe > 0 && !isKeyFrame(videoFrames[probe])) probe -= 1;
    return frameIndex(videoFrames[probe]) ?? idx;
}

function unwrapFrame(frame) {
    return frame?._rawFrame || frame || null;
}

function frameIndex(frame) {
    const idx = Number(frame?.index ?? frame?._rawFrame?.index);
    return Number.isFinite(idx) ? idx : null;
}

function frameTimeSec(frame, fallback = null) {
    if (typeof frame?.ptsTime === "number" && Number.isFinite(frame.ptsTime)) return frame.ptsTime;
    if (typeof frame?.dtsTime === "number" && Number.isFinite(frame.dtsTime)) return frame.dtsTime;
    const tick = frame?.pts ?? frame?.dts ?? frame?.timestamp;
    if (typeof tick === "number" && Number.isFinite(tick)) return tick / 1000;
    return fallback;
}

function compareFramesByTimeThenIndex(a, b) {
    const at = frameTimeSec(a, Number.POSITIVE_INFINITY);
    const bt = frameTimeSec(b, Number.POSITIVE_INFINITY);
    if (at !== bt) return at - bt;
    return (frameIndex(a) ?? Number.POSITIVE_INFINITY) - (frameIndex(b) ?? Number.POSITIVE_INFINITY);
}

function isKeyFrame(frame) {
    const fs = frame?.formatSpecific || {};
    return !!(
        frame?.isKeyframe ||
        frame?.isKeyFrame ||
        frame?.keyframe ||
        frame?._isKeyFrame ||
        frame?.pictureType === "I" ||
        frame?.pictureType === "IDR" ||
        fs.keyframe === true ||
        fs._frameType_value === 1
    );
}

function isVideoConfigFrame(frame) {
    const fs = frame?.formatSpecific || {};
    if (Number(fs?._avcPacketType_value) === 0) return true;
    if (Number(fs?._hevcPacketType_value) === 0) return true;
    if (Number(fs?._isExHeader_value) === 1 && Number(fs?._packetType_value) === 0) return true;
    return false;
}

function closeVideoFrame(frame) {
    try {
        frame?.close?.();
    } catch {
        // ignore close error
    }
}

function wrapDecodeError(err, { message, stage, codecString, plan, chunk }) {
    const wrapped = new Error(`${message}: ${err?.message || String(err)}`);
    wrapped.cause = err;
    wrapped.diagnostics = {
        stage,
        codecString,
        hasDescription: !!plan?.description,
        descriptionLength: plan?.description ? plan.description.length : 0,
        chunk,
        decodePlan: {
            decodeWindowStartFrameIndex: plan?.decodeWindowStartFrameIndex ?? null,
            decodeWindowEndFrameIndex: plan?.decodeWindowEndFrameIndex ?? null,
            targetFrameIndex: plan?.targetFrameIndex ?? null,
            encodedFrames: plan?.encodedFrames?.length ?? 0,
            bitstreamFormat: plan?.bitstreamFormat ?? null,
        },
    };
    return wrapped;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export const videoSegmentPlayerCodec = {
    VideoSegmentPlayer,
};
