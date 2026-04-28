export class MediaClock {
    constructor({ playbackRate = 1 } = {}) {
        this.playbackRate = normalizePlaybackRate(playbackRate);
        this.baseMediaTimeSec = 0;
        this.baseWallTimeMs = 0;
        this.paused = true;
        this.pausedMediaTimeSec = 0;
    }

    start(baseMediaTimeSec = 0, wallTimeMs = performance.now()) {
        this.baseMediaTimeSec = finiteNumber(baseMediaTimeSec, 0);
        this.baseWallTimeMs = finiteNumber(wallTimeMs, performance.now());
        this.pausedMediaTimeSec = this.baseMediaTimeSec;
        this.paused = false;
    }

    pause(wallTimeMs = performance.now()) {
        if (this.paused) return;
        this.pausedMediaTimeSec = this.mediaTimeSec(wallTimeMs);
        this.paused = true;
    }

    resume(wallTimeMs = performance.now()) {
        if (!this.paused) return;
        this.baseMediaTimeSec = this.pausedMediaTimeSec;
        this.baseWallTimeMs = finiteNumber(wallTimeMs, performance.now());
        this.paused = false;
    }

    setPlaybackRate(playbackRate, wallTimeMs = performance.now()) {
        const currentMediaTime = this.mediaTimeSec(wallTimeMs);
        this.playbackRate = normalizePlaybackRate(playbackRate);
        this.baseMediaTimeSec = currentMediaTime;
        this.baseWallTimeMs = finiteNumber(wallTimeMs, performance.now());
        if (this.paused) this.pausedMediaTimeSec = currentMediaTime;
    }

    mediaTimeSec(wallTimeMs = performance.now()) {
        if (this.paused) return this.pausedMediaTimeSec;
        return this.baseMediaTimeSec + ((wallTimeMs - this.baseWallTimeMs) / 1000) * this.playbackRate;
    }

    wallTimeForMediaTime(mediaTimeSec) {
        return this.baseWallTimeMs + ((finiteNumber(mediaTimeSec, this.baseMediaTimeSec) - this.baseMediaTimeSec) * 1000) / this.playbackRate;
    }

    delayMsForMediaTime(mediaTimeSec, wallTimeMs = performance.now()) {
        return this.wallTimeForMediaTime(mediaTimeSec) - wallTimeMs;
    }
}

function normalizePlaybackRate(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.min(16, Math.max(0.0625, n));
}

function finiteNumber(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

export const mediaClockCodec = {
    MediaClock,
};
