export class DetectionScheduler {
    constructor(options = {}) {
        this.fullFrameInterval = positiveInt(options.fullFrameInterval, 15);
        this.roiFrameInterval = positiveInt(options.roiFrameInterval, 1);
        this.trackTTL = finiteNumber(options.trackTTL, 2.0);
        this.minMotionArea = positiveInt(options.minMotionArea, 96);
        this.maxRoiCount = positiveInt(options.maxRoiCount, 4);
        this.previousBoxPadding = finiteNumber(options.previousBoxPadding, 0.32);
        this.largeMotionRatio = finiteNumber(options.largeMotionRatio, 0.28);
        this.noMotionFullFrameInterval = positiveInt(options.noMotionFullFrameInterval, this.fullFrameInterval);
        this.staticScanTiles = positiveInt(options.staticScanTiles, 0);
        this.lastFullFrameIndex = null;
        this.lastRoiFrameIndex = null;
        this.noMotionFrames = 0;
    }

    reset() {
        this.lastFullFrameIndex = null;
        this.lastRoiFrameIndex = null;
        this.noMotionFrames = 0;
    }

    planFrame(options = {}) {
        const frameIndex = Number(options.frameIndex);
        const canvasWidth = positiveInt(options.canvasWidth, 0);
        const canvasHeight = positiveInt(options.canvasHeight, 0);
        const motionResult = options.motionResult || null;
        const motionRois = normalizeRois(options.motionRois, canvasWidth, canvasHeight)
            .filter((roi) => roi.width * roi.height >= this.minMotionArea)
            .map((roi) => ({ ...roi, source: roi.source || "motion" }));
        const trackRois = this.expandedTrackRois(options.tracks, canvasWidth, canvasHeight);
        const staticRois = this.staticScanRois(canvasWidth, canvasHeight, frameIndex);
        const candidateRois = mergeRois([...motionRois, ...trackRois, ...staticRois], {
            canvasWidth,
            canvasHeight,
            distance: 12,
        }).slice(0, this.maxRoiCount);

        if (motionRois.length) this.noMotionFrames = 0;
        else this.noMotionFrames += 1;

        const motionProcessArea = Math.max(1, positiveInt(motionResult?.processWidth, 0) * positiveInt(motionResult?.processHeight, 0));
        const motionRatio = positiveInt(motionResult?.changedPixels, 0) / motionProcessArea;
        const frameDeltaSinceFull = Number.isFinite(frameIndex) && Number.isFinite(this.lastFullFrameIndex)
            ? Math.max(0, frameIndex - this.lastFullFrameIndex)
            : Infinity;
        const frameDeltaSinceRoi = Number.isFinite(frameIndex) && Number.isFinite(this.lastRoiFrameIndex)
            ? Math.max(0, frameIndex - this.lastRoiFrameIndex)
            : Infinity;

        const reasons = [];
        if (options.forceFullFrame) reasons.push("force");
        if (this.lastFullFrameIndex === null) reasons.push("initial-full");
        else if (frameDeltaSinceFull >= this.fullFrameInterval) reasons.push("periodic-full");
        if (motionRatio >= this.largeMotionRatio) reasons.push("large-motion");
        if (!motionRois.length && this.noMotionFrames >= this.noMotionFullFrameInterval && frameDeltaSinceFull >= this.noMotionFullFrameInterval) {
            reasons.push("no-motion-fallback");
        }

        const runFullFrame = reasons.length > 0;
        const runRoi = !runFullFrame && candidateRois.length > 0 && frameDeltaSinceRoi >= this.roiFrameInterval;
        const mode = runFullFrame ? "full" : (runRoi ? "roi" : "track-cache");

        if (Number.isFinite(frameIndex)) {
            if (runFullFrame) this.lastFullFrameIndex = frameIndex;
            if (runRoi) this.lastRoiFrameIndex = frameIndex;
        }

        return {
            mode,
            runFullFrame,
            runRoi,
            candidateRois,
            motionRois,
            trackRois,
            staticRois,
            reasons: runFullFrame ? reasons : (runRoi ? ["roi-interval"] : ["track-cache"]),
            motionRatio,
            noMotionFrames: this.noMotionFrames,
        };
    }

    expandedTrackRois(tracks, canvasWidth, canvasHeight) {
        return (Array.isArray(tracks) ? tracks : [])
            .filter((track) => track && isFiniteBox(track))
            .map((track) => expandBox(track, this.previousBoxPadding, canvasWidth, canvasHeight, {
                source: "track",
                trackId: track.trackId ?? track.stableId ?? track.id ?? null,
                motionScore: 0.01,
            }))
            .filter(Boolean);
    }

    staticScanRois(canvasWidth, canvasHeight, frameIndex) {
        if (!this.staticScanTiles || !canvasWidth || !canvasHeight) return [];
        const cols = Math.ceil(Math.sqrt(this.staticScanTiles));
        const rows = Math.ceil(this.staticScanTiles / cols);
        const tileW = canvasWidth / cols;
        const tileH = canvasHeight / rows;
        const tileCount = cols * rows;
        const offset = Number.isFinite(Number(frameIndex)) ? Math.abs(Math.round(Number(frameIndex))) % tileCount : 0;
        const out = [];
        for (let i = 0; i < Math.min(this.staticScanTiles, tileCount); i++) {
            const n = (offset + i) % tileCount;
            const col = n % cols;
            const row = Math.floor(n / cols);
            out.push({
                x: Math.floor(col * tileW),
                y: Math.floor(row * tileH),
                width: Math.ceil(tileW),
                height: Math.ceil(tileH),
                source: "static",
                motionScore: 0,
            });
        }
        return normalizeRois(out, canvasWidth, canvasHeight);
    }
}

export function createDetectionScheduler(options = {}) {
    return new DetectionScheduler(options);
}

function normalizeRois(rois, canvasWidth, canvasHeight) {
    return (Array.isArray(rois) ? rois : [])
        .map((roi) => clampRoi(roi, canvasWidth, canvasHeight))
        .filter((roi) => roi && roi.width > 4 && roi.height > 4)
        .sort((a, b) => roiPriority(b) - roiPriority(a));
}

function mergeRois(rois, options = {}) {
    const canvasWidth = positiveInt(options.canvasWidth, 0);
    const canvasHeight = positiveInt(options.canvasHeight, 0);
    const distance = positiveInt(options.distance, 0);
    const out = normalizeRois(rois, canvasWidth, canvasHeight).map((roi) => ({ ...roi, sources: sourceList(roi) }));
    let changed = true;
    while (changed) {
        changed = false;
        outer:
        for (let i = 0; i < out.length; i++) {
            for (let j = i + 1; j < out.length; j++) {
                if (!boxesNear(out[i], out[j], distance)) continue;
                out[i] = unionRoi(out[i], out[j], canvasWidth, canvasHeight);
                out.splice(j, 1);
                changed = true;
                break outer;
            }
        }
    }
    return out.sort((a, b) => roiPriority(b) - roiPriority(a));
}

function expandBox(box, paddingRatio, canvasWidth, canvasHeight, extra = {}) {
    if (!isFiniteBox(box) || !canvasWidth || !canvasHeight) return null;
    const padX = Math.max(4, box.width * Math.max(0, paddingRatio));
    const padY = Math.max(4, box.height * Math.max(0, paddingRatio));
    return clampRoi({
        ...extra,
        x: box.x - padX,
        y: box.y - padY,
        width: box.width + padX * 2,
        height: box.height + padY * 2,
    }, canvasWidth, canvasHeight);
}

function unionRoi(a, b, canvasWidth, canvasHeight) {
    const x1 = Math.min(a.x, b.x);
    const y1 = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.width, b.x + b.width);
    const y2 = Math.max(a.y + a.height, b.y + b.height);
    return clampRoi({
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
        source: sourceList(a).concat(sourceList(b)).join("+"),
        sources: unique(sourceList(a).concat(sourceList(b))),
        trackId: a.trackId ?? b.trackId ?? null,
        motionScore: Math.max(Number(a.motionScore) || 0, Number(b.motionScore) || 0),
    }, canvasWidth, canvasHeight);
}

function sourceList(roi) {
    if (Array.isArray(roi?.sources)) return roi.sources.filter(Boolean);
    return String(roi?.source || "roi").split("+").filter(Boolean);
}

function unique(values) {
    return Array.from(new Set(values));
}

function boxesNear(a, b, d) {
    return !(a.x + a.width + d < b.x || b.x + b.width + d < a.x || a.y + a.height + d < b.y || b.y + b.height + d < a.y);
}

function roiPriority(roi) {
    const sourceBoost = String(roi?.source || "").includes("track") || sourceList(roi).includes("track") ? 1.35 : 1;
    return sourceBoost * (1 + Number(roi?.motionScore || 0)) * Math.max(1, Number(roi?.width) || 0) * Math.max(1, Number(roi?.height) || 0);
}

function clampRoi(roi, canvasWidth, canvasHeight) {
    if (!roi || !canvasWidth || !canvasHeight) return null;
    const x1 = clamp(Math.floor(Number(roi.x) || 0), 0, canvasWidth);
    const y1 = clamp(Math.floor(Number(roi.y) || 0), 0, canvasHeight);
    const x2 = clamp(Math.ceil((Number(roi.x) || 0) + (Number(roi.width) || 0)), 0, canvasWidth);
    const y2 = clamp(Math.ceil((Number(roi.y) || 0) + (Number(roi.height) || 0)), 0, canvasHeight);
    return {
        ...roi,
        x: x1,
        y: y1,
        width: Math.max(0, x2 - x1),
        height: Math.max(0, y2 - y1),
    };
}

function isFiniteBox(box) {
    return Number.isFinite(Number(box?.x)) &&
        Number.isFinite(Number(box?.y)) &&
        Number.isFinite(Number(box?.width)) &&
        Number.isFinite(Number(box?.height)) &&
        Number(box.width) > 0 &&
        Number(box.height) > 0;
}

function positiveInt(value, fallback) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function finiteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, Number(v) || 0));
}

export const detectionSchedulerCodec = Object.freeze({
    DetectionScheduler,
    createDetectionScheduler,
});
