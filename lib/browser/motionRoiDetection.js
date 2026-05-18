/**
 * @typedef {Object} MotionROI
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} motionScore
 */

export class MotionRoiDetector {
    constructor(options = {}) {
        this.maxProcessWidth = positiveInt(options.maxProcessWidth, 320);
        this.threshold = positiveInt(options.threshold, 24);
        this.minArea = positiveInt(options.minArea, 18);
        this.mergeDistance = positiveInt(options.mergeDistance, 18);
        this.roiPadding = positiveInt(options.roiPadding, 18);
        this.currGray = null;
        this.prevGray = null;
        this.diff = null;
        this.mask = null;
        this.tmpMask = null;
        this.visited = null;
        this.queue = null;
        this.yuvBuffer = null;
        this.procWidth = 0;
        this.procHeight = 0;
        this.sourceWidth = 0;
        this.sourceHeight = 0;
        this.hasPrevious = false;
    }

    reset() {
        this.hasPrevious = false;
        if (this.prevGray) this.prevGray.fill(0);
        if (this.currGray) this.currGray.fill(0);
        if (this.diff) this.diff.fill(0);
        if (this.mask) this.mask.fill(0);
        if (this.tmpMask) this.tmpMask.fill(0);
        if (this.visited) this.visited.fill(0);
    }

    async processVideoFrame(frame, options = {}) {
        if (!frame || typeof frame.copyTo !== "function") {
            throw new Error("Motion ROI expects a WebCodecs VideoFrame.");
        }
        const sourceWidth = positiveInt(frame.visibleRect?.width || frame.displayWidth || frame.codedWidth, 0);
        const sourceHeight = positiveInt(frame.visibleRect?.height || frame.displayHeight || frame.codedHeight, 0);
        if (!sourceWidth || !sourceHeight) throw new Error("VideoFrame has no usable dimensions for motion ROI.");
        const copyOptions = { format: "I420" };
        const allocationSize = typeof frame.allocationSize === "function"
            ? frame.allocationSize(copyOptions)
            : Math.ceil(sourceWidth * sourceHeight * 1.5);
        if (!(this.yuvBuffer instanceof Uint8Array) || this.yuvBuffer.length < allocationSize) {
            this.yuvBuffer = new Uint8Array(allocationSize);
        }
        const layouts = await frame.copyTo(this.yuvBuffer, copyOptions);
        const yLayout = Array.isArray(layouts) ? layouts[0] : null;
        const yOffset = Number(yLayout?.offset) || 0;
        const yStride = positiveInt(yLayout?.stride, sourceWidth);
        return this.processYPlane(this.yuvBuffer, {
            sourceWidth,
            sourceHeight,
            yOffset,
            yStride,
            frameIndex: options.frameIndex,
            returnMask: options.returnMask,
        });
    }

    processCanvas(canvas, options = {}) {
        if (!(canvas instanceof HTMLCanvasElement) && !(canvas instanceof OffscreenCanvas)) {
            throw new Error("Motion ROI canvas fallback expects a canvas.");
        }
        const sourceWidth = positiveInt(canvas.width, 0);
        const sourceHeight = positiveInt(canvas.height, 0);
        if (!sourceWidth || !sourceHeight) throw new Error("Canvas has no usable dimensions for motion ROI.");
        this.ensureBuffers(sourceWidth, sourceHeight);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("2D canvas context is unavailable for motion ROI.");
        const imageData = ctx.getImageData(0, 0, sourceWidth, sourceHeight).data;
        downsampleRgbaLumaNearest(imageData, {
            sourceWidth,
            sourceHeight,
            out: this.currGray,
            outWidth: this.procWidth,
            outHeight: this.procHeight,
        });

        if (!this.hasPrevious) {
            this.prevGray.set(this.currGray);
            this.hasPrevious = true;
            return this.makeResult([], options, 0, 0);
        }

        const motionStats = buildMotionMask(this.prevGray, this.currGray, this.mask, this.diff, this.threshold);
        morphOpen(this.mask, this.tmpMask, this.procWidth, this.procHeight);
        const boxes = connectedComponents(this.tmpMask, {
            width: this.procWidth,
            height: this.procHeight,
            diff: this.diff,
            visited: this.visited,
            queue: this.queue,
            minArea: this.minArea,
        });
        const merged = mergeNearbyBoxes(boxes, this.mergeDistance);
        const rois = merged.map((box) => this.mapProcessBoxToSourceRoi(box)).filter((roi) => roi.width > 1 && roi.height > 1);
        const prev = this.prevGray;
        this.prevGray = this.currGray;
        this.currGray = prev;
        return this.makeResult(rois, options, motionStats.changedPixels, motionStats.avgDiff);
    }

    processYPlane(bytes, options = {}) {
        const sourceWidth = positiveInt(options.sourceWidth, 0);
        const sourceHeight = positiveInt(options.sourceHeight, 0);
        const yOffset = positiveInt(options.yOffset, 0);
        const yStride = positiveInt(options.yStride, sourceWidth);
        if (!(bytes instanceof Uint8Array) || !sourceWidth || !sourceHeight) {
            throw new Error("Invalid Y plane input for motion ROI.");
        }
        this.ensureBuffers(sourceWidth, sourceHeight);
        downsampleYPlaneNearest(bytes, {
            yOffset,
            yStride,
            sourceWidth,
            sourceHeight,
            out: this.currGray,
            outWidth: this.procWidth,
            outHeight: this.procHeight,
        });

        if (!this.hasPrevious) {
            this.prevGray.set(this.currGray);
            this.hasPrevious = true;
            return this.makeResult([], options, 0, 0);
        }

        const motionStats = buildMotionMask(this.prevGray, this.currGray, this.mask, this.diff, this.threshold);
        morphOpen(this.mask, this.tmpMask, this.procWidth, this.procHeight);
        const boxes = connectedComponents(this.tmpMask, {
            width: this.procWidth,
            height: this.procHeight,
            diff: this.diff,
            visited: this.visited,
            queue: this.queue,
            minArea: this.minArea,
        });
        const merged = mergeNearbyBoxes(boxes, this.mergeDistance);
        const rois = merged.map((box) => this.mapProcessBoxToSourceRoi(box)).filter((roi) => roi.width > 1 && roi.height > 1);
        const prev = this.prevGray;
        this.prevGray = this.currGray;
        this.currGray = prev;
        return this.makeResult(rois, options, motionStats.changedPixels, motionStats.avgDiff);
    }

    ensureBuffers(sourceWidth, sourceHeight) {
        const scale = Math.min(1, this.maxProcessWidth / sourceWidth);
        const procWidth = Math.max(1, Math.round(sourceWidth * scale));
        const procHeight = Math.max(1, Math.round(sourceHeight * scale));
        const size = procWidth * procHeight;
        if (this.procWidth === procWidth && this.procHeight === procHeight && this.currGray?.length === size) {
            this.sourceWidth = sourceWidth;
            this.sourceHeight = sourceHeight;
            return;
        }
        this.procWidth = procWidth;
        this.procHeight = procHeight;
        this.sourceWidth = sourceWidth;
        this.sourceHeight = sourceHeight;
        this.currGray = new Uint8Array(size);
        this.prevGray = new Uint8Array(size);
        this.diff = new Uint8Array(size);
        this.mask = new Uint8Array(size);
        this.tmpMask = new Uint8Array(size);
        this.visited = new Uint8Array(size);
        this.queue = new Int32Array(size);
        this.hasPrevious = false;
    }

    mapProcessBoxToSourceRoi(box) {
        const sx = this.sourceWidth / this.procWidth;
        const sy = this.sourceHeight / this.procHeight;
        const padX = this.roiPadding;
        const padY = this.roiPadding;
        const x1 = clamp(Math.floor(box.x * sx) - padX, 0, this.sourceWidth);
        const y1 = clamp(Math.floor(box.y * sy) - padY, 0, this.sourceHeight);
        const x2 = clamp(Math.ceil((box.x + box.width) * sx) + padX, 0, this.sourceWidth);
        const y2 = clamp(Math.ceil((box.y + box.height) * sy) + padY, 0, this.sourceHeight);
        return {
            x: x1,
            y: y1,
            width: Math.max(0, x2 - x1),
            height: Math.max(0, y2 - y1),
            motionScore: box.area > 0 ? box.diffSum / (box.area * 255) : 0,
        };
    }

    makeResult(rois, options, changedPixels, avgDiff) {
        const returnMask = !!options.returnMask;
        return {
            rois,
            frameIndex: Number.isFinite(Number(options.frameIndex)) ? Number(options.frameIndex) : null,
            sourceWidth: this.sourceWidth,
            sourceHeight: this.sourceHeight,
            processWidth: this.procWidth,
            processHeight: this.procHeight,
            changedPixels,
            avgDiff,
            mask: returnMask && this.tmpMask ? this.tmpMask.slice(0) : null,
        };
    }
}

export function createMotionRoiDetector(options = {}) {
    return new MotionRoiDetector(options);
}

export class MotionRoiWorkerClient {
    constructor(options = {}) {
        if (typeof Worker === "undefined") throw new Error("Worker is not available.");
        this.worker = new Worker(new URL("./motionRoiWorker.js", import.meta.url), { type: "module" });
        this.nextId = 1;
        this.pending = new Map();
        this.worker.onmessage = (ev) => {
            const msg = ev.data || {};
            const entry = this.pending.get(msg.id);
            if (!entry) return;
            this.pending.delete(msg.id);
            if (msg.ok) entry.resolve(msg.result);
            else entry.reject(new Error(msg.error || "Motion ROI worker failed."));
        };
        this.worker.onerror = (ev) => {
            const err = new Error(ev?.message || "Motion ROI worker error.");
            for (const entry of this.pending.values()) entry.reject(err);
            this.pending.clear();
        };
        this.worker.postMessage({ type: "configure", options });
    }

    processVideoFrame(frame, options = {}) {
        if (!frame) return Promise.reject(new Error("VideoFrame is required."));
        const id = this.nextId++;
        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        try {
            this.worker.postMessage({ type: "process", id, frame, options }, [frame]);
        } catch (err) {
            this.pending.delete(id);
            return Promise.reject(err);
        }
        return promise;
    }

    reset() {
        this.worker.postMessage({ type: "reset" });
    }

    terminate() {
        this.worker.terminate();
        this.pending.clear();
    }
}

export function createMotionRoiWorkerClient(options = {}) {
    return new MotionRoiWorkerClient(options);
}

export function createMotionRoiVideoFrameLoop(video, detector, onResult, options = {}) {
    if (!video || typeof onResult !== "function") {
        throw new Error("Motion ROI video loop expects a video element and result callback.");
    }
    const motionDetector = detector || new MotionRoiDetector(options.detectorOptions || {});
    const onError = typeof options.onError === "function" ? options.onError : null;
    let stopped = false;
    let handle = 0;
    let handleIsRaf = false;
    let frameIndex = 0;
    let inFlight = false;

    const schedule = () => {
        if (stopped) return;
        if (typeof video.requestVideoFrameCallback === "function") {
            handleIsRaf = false;
            handle = video.requestVideoFrameCallback(tick);
        } else {
            handleIsRaf = true;
            handle = requestAnimationFrame((now) => tick(now, {
                mediaTime: Number(video.currentTime) || 0,
                presentedFrames: frameIndex,
            }));
        }
    };

    const tick = async (_now, metadata = {}) => {
        if (stopped) return;
        if (inFlight) {
            schedule();
            return;
        }
        inFlight = true;
        let frame = null;
        try {
            if (typeof VideoFrame === "undefined") throw new Error("VideoFrame API is not available.");
            const mediaTime = Number(metadata.mediaTime);
            const init = Number.isFinite(mediaTime) ? { timestamp: Math.round(mediaTime * 1000000) } : undefined;
            frame = init ? new VideoFrame(video, init) : new VideoFrame(video);
            const result = await motionDetector.processVideoFrame(frame, {
                frameIndex: Number.isFinite(Number(metadata.presentedFrames)) ? Number(metadata.presentedFrames) : frameIndex,
                returnMask: !!options.returnMask,
            });
            frame.close?.();
            frame = null;
            frameIndex += 1;
            onResult(result, metadata);
        } catch (err) {
            if (onError) onError(err);
        } finally {
            try {
                frame?.close?.();
            } catch {
                // ignore close errors
            }
            inFlight = false;
            schedule();
        }
    };

    schedule();
    return {
        detector: motionDetector,
        stop() {
            stopped = true;
            if (!handle) return;
            if (!handleIsRaf && typeof video.cancelVideoFrameCallback === "function") {
                video.cancelVideoFrameCallback(handle);
            } else if (handleIsRaf && typeof cancelAnimationFrame === "function") {
                cancelAnimationFrame(handle);
            }
        },
    };
}

export function mapSourceRoiToCanvasRoi(roi, sourceWidth, sourceHeight, canvas, options = {}) {
    const canvasWidth = positiveInt(options.canvasWidth || canvas?.width, 0);
    const canvasHeight = positiveInt(options.canvasHeight || canvas?.height, 0);
    if (!roi || !sourceWidth || !sourceHeight || !canvasWidth || !canvasHeight) return null;
    const scale = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
    const dx = (canvasWidth - sourceWidth * scale) / 2;
    const dy = (canvasHeight - sourceHeight * scale) / 2;
    return {
        x: dx + roi.x * scale,
        y: dy + roi.y * scale,
        width: roi.width * scale,
        height: roi.height * scale,
        motionScore: roi.motionScore || 0,
        sourceRoi: roi,
    };
}

export function mapSourceRoisToCanvasRois(rois, sourceWidth, sourceHeight, canvas, options = {}) {
    return (Array.isArray(rois) ? rois : [])
        .map((roi) => mapSourceRoiToCanvasRoi(roi, sourceWidth, sourceHeight, canvas, options))
        .filter(Boolean);
}

export function drawMotionDebugOverlay(canvas, motionResult, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const mode = options.mode || "roi";
    const sourceWidth = positiveInt(motionResult?.sourceWidth, 0);
    const sourceHeight = positiveInt(motionResult?.sourceHeight, 0);
    const showLabels = options.showLabels !== false;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (mode === "mask" || mode === "mask-roi") {
        drawMaskBlocks(ctx, canvas, motionResult, sourceWidth, sourceHeight);
    }
    const canvasRois = mapSourceRoisToCanvasRois(motionResult?.rois || [], sourceWidth, sourceHeight, canvas);
    ctx.lineWidth = Math.max(1, Math.round(Math.min(canvas.width, canvas.height) / 380));
    ctx.strokeStyle = options.roiColor || "#ffd166";
    ctx.fillStyle = "rgba(255, 209, 102, 0.12)";
    ctx.font = `${Math.max(11, Math.round(Math.min(canvas.width, canvas.height) / 48))}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial`;
    ctx.textBaseline = "top";
    for (let i = 0; i < canvasRois.length; i++) {
        const roi = canvasRois[i];
        ctx.fillRect(roi.x, roi.y, roi.width, roi.height);
        ctx.strokeRect(roi.x, roi.y, roi.width, roi.height);
        if (!showLabels) continue;
        const label = `R${i + 1} c:${Math.round(roi.x)},${Math.round(roi.y)} ${Math.round(roi.width)}x${Math.round(roi.height)}`;
        const metrics = ctx.measureText(label);
        const labelW = Math.ceil(metrics.width + 8);
        const labelH = Math.max(16, Math.ceil(parseInt(ctx.font, 10) + 6));
        const labelX = clamp(Math.round(roi.x), 0, Math.max(0, canvas.width - labelW));
        const labelY = clamp(Math.round(roi.y), 0, Math.max(0, canvas.height - labelH));
        ctx.fillStyle = "rgba(255, 209, 102, 0.94)";
        ctx.fillRect(labelX, labelY, labelW, labelH);
        ctx.fillStyle = "#14191f";
        ctx.fillText(label, labelX + 4, labelY + 3);
        ctx.fillStyle = "rgba(255, 209, 102, 0.12)";
    }
    const candidateRois = Array.isArray(options.candidateRois) ? options.candidateRois : [];
    if (candidateRois.length) {
        ctx.strokeStyle = options.candidateColor || "#4cd3ff";
        ctx.fillStyle = "rgba(76, 211, 255, 0.08)";
        ctx.setLineDash([7, 5]);
        for (let i = 0; i < candidateRois.length; i++) {
            const roi = candidateRois[i];
            ctx.fillRect(roi.x, roi.y, roi.width, roi.height);
            ctx.strokeRect(roi.x, roi.y, roi.width, roi.height);
            if (!showLabels) continue;
            const source = Array.isArray(roi.sources) ? roi.sources.join("+") : (roi.source || "roi");
            const label = `C${i + 1} ${source} ${Math.round(roi.x)},${Math.round(roi.y)} ${Math.round(roi.width)}x${Math.round(roi.height)}`;
            const metrics = ctx.measureText(label);
            const labelW = Math.ceil(metrics.width + 8);
            const labelH = Math.max(16, Math.ceil(parseInt(ctx.font, 10) + 6));
            const labelX = clamp(Math.round(roi.x), 0, Math.max(0, canvas.width - labelW));
            const labelY = clamp(Math.round(roi.y + roi.height - labelH), 0, Math.max(0, canvas.height - labelH));
            ctx.setLineDash([]);
            ctx.fillStyle = "rgba(76, 211, 255, 0.94)";
            ctx.fillRect(labelX, labelY, labelW, labelH);
            ctx.fillStyle = "#06111f";
            ctx.fillText(label, labelX + 4, labelY + 3);
            ctx.fillStyle = "rgba(76, 211, 255, 0.08)";
            ctx.setLineDash([7, 5]);
        }
        ctx.setLineDash([]);
    }
    ctx.restore();
}

function drawMaskBlocks(ctx, canvas, motionResult, sourceWidth, sourceHeight) {
    const mask = motionResult?.mask;
    const w = positiveInt(motionResult?.processWidth, 0);
    const h = positiveInt(motionResult?.processHeight, 0);
    if (!(mask instanceof Uint8Array) || !w || !h || !sourceWidth || !sourceHeight) return;
    const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const dx = (canvas.width - sourceWidth * scale) / 2;
    const dy = (canvas.height - sourceHeight * scale) / 2;
    const cellW = (sourceWidth / w) * scale;
    const cellH = (sourceHeight / h) * scale;
    ctx.fillStyle = "rgba(255, 74, 96, 0.18)";
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (!mask[row + x]) continue;
            ctx.fillRect(dx + x * cellW, dy + y * cellH, Math.max(1, cellW), Math.max(1, cellH));
        }
    }
}

function downsampleYPlaneNearest(bytes, cfg) {
    const { yOffset, yStride, sourceWidth, sourceHeight, out, outWidth, outHeight } = cfg;
    for (let y = 0; y < outHeight; y++) {
        const sy = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / outHeight));
        const srcRow = yOffset + sy * yStride;
        const dstRow = y * outWidth;
        for (let x = 0; x < outWidth; x++) {
            const sx = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / outWidth));
            out[dstRow + x] = bytes[srcRow + sx];
        }
    }
}

function downsampleRgbaLumaNearest(bytes, cfg) {
    const { sourceWidth, sourceHeight, out, outWidth, outHeight } = cfg;
    for (let y = 0; y < outHeight; y++) {
        const sy = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / outHeight));
        const dstRow = y * outWidth;
        for (let x = 0; x < outWidth; x++) {
            const sx = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / outWidth));
            const off = (sy * sourceWidth + sx) * 4;
            out[dstRow + x] = ((bytes[off] * 77 + bytes[off + 1] * 150 + bytes[off + 2] * 29) >> 8);
        }
    }
}

function buildMotionMask(prev, curr, mask, diff, threshold) {
    let changedPixels = 0;
    let diffSum = 0;
    for (let i = 0; i < curr.length; i++) {
        const d = Math.abs(curr[i] - prev[i]);
        diff[i] = d;
        if (d >= threshold) {
            mask[i] = 1;
            changedPixels += 1;
            diffSum += d;
        } else {
            mask[i] = 0;
        }
    }
    return {
        changedPixels,
        avgDiff: changedPixels > 0 ? diffSum / changedPixels : 0,
    };
}

function morphOpen(mask, tmp, width, height) {
    erode(mask, tmp, width, height);
    dilate(tmp, mask, width, height);
    tmp.set(mask);
}

function erode(src, dst, width, height) {
    dst.fill(0);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            let n = 0;
            n += src[i];
            n += src[i - 1];
            n += src[i + 1];
            n += src[i - width];
            n += src[i + width];
            n += src[i - width - 1];
            n += src[i - width + 1];
            n += src[i + width - 1];
            n += src[i + width + 1];
            dst[i] = n >= 4 ? 1 : 0;
        }
    }
}

function dilate(src, dst, width, height) {
    dst.fill(0);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            if (!src[i]) continue;
            dst[i] = 1;
            dst[i - 1] = 1;
            dst[i + 1] = 1;
            dst[i - width] = 1;
            dst[i + width] = 1;
        }
    }
}

function connectedComponents(mask, cfg) {
    const { width, height, diff, visited, queue, minArea } = cfg;
    visited.fill(0);
    const boxes = [];
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || visited[start]) continue;
        let qh = 0;
        let qt = 0;
        queue[qt++] = start;
        visited[start] = 1;
        let minX = width;
        let minY = height;
        let maxX = 0;
        let maxY = 0;
        let area = 0;
        let diffSum = 0;
        while (qh < qt) {
            const idx = queue[qh++];
            const x = idx % width;
            const y = Math.floor(idx / width);
            area += 1;
            diffSum += diff?.[idx] || 0;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            pushNeighbor(idx - 1, x > 0);
            pushNeighbor(idx + 1, x < width - 1);
            pushNeighbor(idx - width, y > 0);
            pushNeighbor(idx + width, y < height - 1);
        }
        if (area >= minArea) {
            boxes.push({
                x: minX,
                y: minY,
                width: maxX - minX + 1,
                height: maxY - minY + 1,
                area,
                diffSum,
            });
        }
        function pushNeighbor(n, ok) {
            if (!ok || visited[n] || !mask[n]) return;
            visited[n] = 1;
            queue[qt++] = n;
        }
    }
    return boxes;
}

function mergeNearbyBoxes(boxes, distance) {
    const out = boxes.map((b) => ({ ...b }));
    let changed = true;
    while (changed) {
        changed = false;
        outer:
        for (let i = 0; i < out.length; i++) {
            for (let j = i + 1; j < out.length; j++) {
                if (!boxesNear(out[i], out[j], distance)) continue;
                out[i] = unionBoxes(out[i], out[j]);
                out.splice(j, 1);
                changed = true;
                break outer;
            }
        }
    }
    return out;
}

function boxesNear(a, b, d) {
    return !(a.x + a.width + d < b.x || b.x + b.width + d < a.x || a.y + a.height + d < b.y || b.y + b.height + d < a.y);
}

function unionBoxes(a, b) {
    const x1 = Math.min(a.x, b.x);
    const y1 = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.width, b.x + b.width);
    const y2 = Math.max(a.y + a.height, b.y + b.height);
    return {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
        area: a.area + b.area,
        diffSum: a.diffSum + b.diffSum,
    };
}

function positiveInt(value, fallback) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, Number(v) || 0));
}

export const motionRoiDetectionCodec = Object.freeze({
    MotionRoiDetector,
    MotionRoiWorkerClient,
    createMotionRoiDetector,
    createMotionRoiWorkerClient,
    createMotionRoiVideoFrameLoop,
    mapSourceRoiToCanvasRoi,
    mapSourceRoisToCanvasRois,
    drawMotionDebugOverlay,
});
