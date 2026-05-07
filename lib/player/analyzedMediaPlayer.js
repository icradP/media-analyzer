import {
    collectAudioFrames,
    collectVideoFrames,
    decodeAudioFramesToBufferWithWebAudio,
    pickPrimaryMediaResult,
} from "../browser/framePlayback.js";
import { MediaClock } from "./mediaClock.js";
import { VideoSegmentPlayer } from "./videoSegmentPlayer.js";

export class AnalyzedMediaPlayer {
    constructor({
        mediaInfo = null,
        canvas = null,
        renderer = null,
        playbackRate = 1,
        videoDecodeStrategy = "frame-step",
        onStatus = null,
        onState = null,
        onProgress = null,
        onFrame = null,
        onError = null,
    } = {}) {
        this.mediaInfo = mediaInfo;
        this.primary = mediaInfo ? pickPrimaryMediaResult(mediaInfo) : null;
        this.renderer = renderer || null;
        this.canvas = canvas || null;
        this.clock = new MediaClock({ playbackRate });
        this.playbackRate = this.clock.playbackRate;
        this.videoDecodeStrategy = videoDecodeStrategy === "gop" ? "gop" : "frame-step";
        this.onStatus = typeof onStatus === "function" ? onStatus : null;
        this.onState = typeof onState === "function" ? onState : null;
        this.onProgress = typeof onProgress === "function" ? onProgress : null;
        this.onFrame = typeof onFrame === "function" ? onFrame : null;
        this.onError = typeof onError === "function" ? onError : null;
        this.videoPlayer = null;
        this.audioContext = null;
        this.audioSources = [];
        this.progressTimer = null;
        this.token = 0;
        this.state = "idle";
        this.currentSegment = null;
    }

    load(mediaInfo) {
        this.stop();
        this.mediaInfo = mediaInfo;
        this.primary = mediaInfo ? pickPrimaryMediaResult(mediaInfo) : null;
        this.status("Media loaded.");
        return this.describe();
    }

    describe() {
        const primary = this.primary || pickPrimaryMediaResult(this.mediaInfo);
        const streams = Array.isArray(primary?.streams) ? primary.streams : [];
        const videoFrames = this.mediaInfo ? collectVideoFrames(this.mediaInfo).length : 0;
        const audioFrames = this.mediaInfo ? collectAudioFrames(this.mediaInfo).length : 0;
        const timeline = createPlayerTimelineSnapshot(this.mediaInfo);
        return {
            formatName: primary?.format?.formatName || "unknown",
            duration: timeline.durationSec,
            streams,
            videoFrames,
            audioFrames,
            timeline,
        };
    }

    setPlaybackRate(playbackRate) {
        this.clock.setPlaybackRate(playbackRate);
        this.playbackRate = this.clock.playbackRate;
        this.videoPlayer?.setPlaybackRate?.(this.playbackRate);
        return this.playbackRate;
    }

    stop() {
        this.token += 1;
        this.videoPlayer?.stop?.();
        this.videoPlayer = null;
        this.stopAudio();
        this.clearProgressTimer();
        this.currentSegment = null;
        this.setState("idle");
    }

    pause() {
        if (this.state !== "playing") return;
        this.videoPlayer?.pause?.();
        this.clock.pause();
        this.setState("paused");
    }

    resume() {
        if (this.state !== "paused") return;
        this.videoPlayer?.resume?.();
        this.clock.resume();
        this.setState("playing");
    }

    async playSegment({
        startSec = null,
        endSec = null,
        video = true,
        audio = true,
        frames = null,
    } = {}) {
        if (!this.mediaInfo) throw new Error("No media loaded.");
        const timeline = createPlayerTimelineSnapshot(this.mediaInfo, { frames });
        const start = finiteNumber(startSec, timeline.startSec);
        const end = finiteNumber(endSec, timeline.endSec);
        if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Invalid segment bounds.");
        if (end < start) throw new Error("Segment end must be >= start.");
        this.stop();
        const token = this.token;
        this.currentSegment = { startSec: start, endSec: end };
        this.clock.start(start);
        this.setState("playing");
        this.startProgressTimer(token, start, end);
        this.status(`Play segment ${formatTime(start)} - ${formatTime(end)}.`);

        const tasks = [];
        const labels = [];
        if (video) {
            const videoFrames = this.getFramesBySegment("video", start, end, frames);
            if (videoFrames.length > 0 && (this.canvas || this.renderer)) {
                labels.push("video");
                tasks.push(this.playVideoSegment({ startSec: start, endSec: end, frames, token }));
            }
        }
        if (audio) {
            const audioFrames = this.getFramesBySegment("audio", start, end, frames);
            if (audioFrames.length > 0) {
                labels.push("audio");
                tasks.push(this.playAudioSegment({ frames: audioFrames, startSec: start, endSec: end, token }));
            }
        }
        if (!tasks.length) {
            this.stop();
            throw new Error("No playable audio or video frames in selected segment.");
        }

        const settled = await Promise.allSettled(tasks);
        if (token !== this.token) return { stopped: true, results: settled };
        const rejected = settled
            .map((item, i) => ({ item, label: labels[i] }))
            .filter(({ item }) => item.status === "rejected");
        if (rejected.length === settled.length) {
            const err = rejected[0]?.item?.reason || new Error("Segment playback failed.");
            this.handleError(err);
            this.stop();
            throw err;
        }
        if (rejected.length > 0) {
            this.status(`Segment finished with ${rejected.map((x) => x.label).join("+")} warning.`);
        } else {
            this.status("Segment play done.");
        }
        this.clearProgressTimer();
        this.emitProgress(end, start, end);
        this.setState("idle");
        return { stopped: false, results: settled };
    }

    getFramesBySegment(mediaType, startSec, endSec, frames = null) {
        const source = Array.isArray(frames) && frames.length
            ? frames.map(unwrapFrame).filter(Boolean)
            : mediaType === "audio"
                ? collectAudioFrames(this.mediaInfo)
                : collectVideoFrames(this.mediaInfo);
        return source
            .filter((frame) => !mediaType || frame?.mediaType === mediaType || frame?._mediaType === mediaType)
            .filter((frame) => {
                const t = frameTimeSec(frame, null);
                return Number.isFinite(t) && t >= startSec && t <= endSec;
            })
            .sort(compareFramesByTimeThenIndex);
    }

    async playVideoSegment({ startSec, endSec, frames, token }) {
        const primary = this.primary || pickPrimaryMediaResult(this.mediaInfo);
        const videoStream = (primary?.streams || []).find((stream) => stream.codecType === "video") || null;
        this.videoPlayer = new VideoSegmentPlayer({
            mediaInfo: this.mediaInfo,
            stream: videoStream,
            canvas: this.canvas,
            renderer: this.renderer,
            playbackRate: this.playbackRate,
            decodeStrategy: this.videoDecodeStrategy,
            onStatus: (text) => this.status(text),
            onFrame: (item) => {
                if (token !== this.token) return;
                this.emitProgress(item?.ptsTime, startSec, endSec);
                if (this.onFrame) this.onFrame(item);
            },
            onError: (err) => this.handleError(err),
        });
        return this.videoPlayer.playSegment({ startSec, endSec, frames });
    }

    async playAudioSegment({ frames, startSec, endSec, token }) {
        const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Ctx) throw new Error("WebAudio API is not available in this browser.");
        const ctx = this.audioContext || new Ctx();
        this.audioContext = ctx;
        if (ctx.state === "suspended") await ctx.resume();
        const decoded = await decodeAudioFramesToBufferWithWebAudio({
            frames,
            mediaInfo: this.mediaInfo,
            audioContext: ctx,
        });
        if (token !== this.token) return { stopped: true };
        this.audioContext = decoded.ctx;
        const src = decoded.ctx.createBufferSource();
        src.buffer = decoded.buffer;
        src.playbackRate.value = this.playbackRate;
        src.connect(decoded.ctx.destination);
        this.audioSources.push(src);
        const startWhen = decoded.ctx.currentTime + 0.035;
        src.start(startWhen);
        this.status(`Audio segment playing (${decoded.buffer.duration.toFixed(3)}s).`);
        await new Promise((resolve) => {
            src.onended = () => resolve();
        });
        this.audioSources = this.audioSources.filter((item) => item !== src);
        if (token !== this.token) return { stopped: true };
        this.emitProgress(endSec, startSec, endSec);
        return { stopped: false, source: decoded.source, duration: decoded.buffer.duration };
    }

    stopAudio() {
        for (const src of this.audioSources) {
            try {
                src.stop();
            } catch {
                // ignore stop errors
            }
        }
        this.audioSources = [];
    }

    startProgressTimer(token, startSec, endSec) {
        this.clearProgressTimer();
        this.progressTimer = setInterval(() => {
            if (token !== this.token || this.state !== "playing") return;
            this.emitProgress(this.clock.mediaTimeSec(), startSec, endSec);
        }, 80);
    }

    clearProgressTimer() {
        if (!this.progressTimer) return;
        clearInterval(this.progressTimer);
        this.progressTimer = null;
    }

    emitProgress(currentTimeSec, startSec, endSec) {
        if (!this.onProgress) return;
        const current = finiteNumber(currentTimeSec, startSec);
        const span = Math.max(0.000001, endSec - startSec);
        this.onProgress({
            currentTimeSec: current,
            startSec,
            endSec,
            progress: Math.max(0, Math.min(1, (current - startSec) / span)),
            state: this.state,
        });
    }

    status(text) {
        if (this.onStatus) this.onStatus(text);
    }

    setState(state) {
        if (this.state === state) return;
        this.state = state;
        if (this.onState) this.onState(state);
    }

    handleError(err) {
        if (this.onError) this.onError(err);
    }
}

export function createPlayerTimelineSnapshot(mediaInfo, { frames = null } = {}) {
    const videoFrames = Array.isArray(frames)
        ? frames.map(unwrapFrame).filter((frame) => frame?.mediaType === "video" || frame?._mediaType === "video")
        : collectVideoFrames(mediaInfo);
    const audioFrames = Array.isArray(frames)
        ? frames.map(unwrapFrame).filter((frame) => frame?.mediaType === "audio" || frame?._mediaType === "audio")
        : collectAudioFrames(mediaInfo);
    const videoTimes = videoFrames.map((frame) => frameTimeSec(frame, null)).filter(Number.isFinite);
    const audioTimes = audioFrames.map((frame) => frameTimeSec(frame, null)).filter(Number.isFinite);
    const allTimes = videoTimes.concat(audioTimes);
    const primary = mediaInfo ? pickPrimaryMediaResult(mediaInfo) : null;
    const formatDuration = Number(primary?.format?.duration);
    const startSec = allTimes.length ? Math.min(...allTimes) : 0;
    let endSec = allTimes.length ? Math.max(...allTimes) : (Number.isFinite(formatDuration) ? formatDuration : 0);
    if (Number.isFinite(formatDuration) && formatDuration > endSec) endSec = formatDuration;
    if (endSec <= startSec) endSec = startSec + 0.001;
    return {
        startSec,
        endSec,
        durationSec: endSec - startSec,
        videoFrames: videoFrames.length,
        audioFrames: audioFrames.length,
        videoTimes,
        audioTimes,
    };
}

function unwrapFrame(frame) {
    return frame?._rawFrame || frame || null;
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
    return (Number(a?.index) || 0) - (Number(b?.index) || 0);
}

function finiteNumber(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function formatTime(sec) {
    const n = finiteNumber(sec, 0);
    const mm = Math.floor(n / 60);
    const ss = Math.floor(n % 60);
    const ms = Math.floor((n - Math.floor(n)) * 1000);
    return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export const analyzedMediaPlayerCodec = {
    AnalyzedMediaPlayer,
    createPlayerTimelineSnapshot,
};
