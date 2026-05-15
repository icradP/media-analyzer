export const DEFAULT_ORT_WEBGPU_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.webgpu.min.js";
export const DEFAULT_ORT_WASM_BASE_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";
export const DEFAULT_LOCAL_OBJECT_DETECTION_MODEL_URL = "./model.onnx";
export const DEFAULT_OBJECT_DETECTION_MODEL_URL = "https://huggingface.co/flotek/yolo26n-onnx/resolve/main/model.onnx";

export const COCO_80_LABELS = Object.freeze([
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
    "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard",
    "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone",
    "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush",
]);

const SCRIPT_LOADS = new Map();

export async function loadOnnxRuntimeWeb(options = {}) {
    const {
        scriptUrl = DEFAULT_ORT_WEBGPU_SCRIPT_URL,
        wasmBaseUrl = DEFAULT_ORT_WASM_BASE_URL,
    } = options;
    if (globalThis.ort?.InferenceSession) {
        configureOrtEnvironment(globalThis.ort, { wasmBaseUrl });
        return globalThis.ort;
    }
    await loadScriptOnce(scriptUrl);
    if (!globalThis.ort?.InferenceSession) {
        throw new Error("ONNX Runtime Web failed to load: global `ort` is unavailable.");
    }
    configureOrtEnvironment(globalThis.ort, { wasmBaseUrl });
    return globalThis.ort;
}

function configureOrtEnvironment(ort, options = {}) {
    const wasmBaseUrl = String(options.wasmBaseUrl || "");
    if (wasmBaseUrl && ort?.env?.wasm) {
        ort.env.wasm.wasmPaths = wasmBaseUrl;
    }
    if (ort?.env?.webgpu) {
        ort.env.webgpu.profiling = false;
    }
}

function loadScriptOnce(src) {
    const url = String(src || "").trim();
    if (!url) throw new Error("ONNX Runtime script URL is required.");
    if (SCRIPT_LOADS.has(url)) return SCRIPT_LOADS.get(url);
    const promise = new Promise((resolve, reject) => {
        const existing = Array.from(document.scripts || []).find((s) => s.src === url);
        if (existing) {
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener("error", () => reject(new Error(`Failed to load script: ${url}`)), { once: true });
            if (globalThis.ort?.InferenceSession) resolve();
            return;
        }
        const script = document.createElement("script");
        script.src = url;
        script.async = true;
        script.crossOrigin = "anonymous";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
        document.head.appendChild(script);
    });
    SCRIPT_LOADS.set(url, promise);
    return promise;
}

export class OnnxObjectDetector {
    constructor(options = {}) {
        this.modelUrl = options.modelUrl || DEFAULT_OBJECT_DETECTION_MODEL_URL;
        this.modelInputSize = positiveInt(options.modelInputSize, 640);
        this.preferredProvider = options.provider || "auto";
        this.scriptUrl = options.scriptUrl || DEFAULT_ORT_WEBGPU_SCRIPT_URL;
        this.wasmBaseUrl = options.wasmBaseUrl || DEFAULT_ORT_WASM_BASE_URL;
        this.scoreThreshold = finiteNumber(options.scoreThreshold, 0.35);
        this.iouThreshold = finiteNumber(options.iouThreshold, 0.45);
        this.maxDetections = positiveInt(options.maxDetections, 20);
        this.labels = Array.isArray(options.labels) ? options.labels : COCO_80_LABELS;
        this.ort = null;
        this.session = null;
        this.inputName = "";
        this.outputNames = [];
        this.activeExecutionProvider = "";
    }

    async init() {
        if (this.session) return this;
        this.ort = await loadOnnxRuntimeWeb({
            scriptUrl: this.scriptUrl,
            wasmBaseUrl: this.wasmBaseUrl,
        });
        const providerList = resolveExecutionProviders(this.preferredProvider);
        try {
            this.session = await this.ort.InferenceSession.create(this.modelUrl, {
                executionProviders: providerList,
            });
            this.activeExecutionProvider = providerList.join(" -> ");
        } catch (err) {
            if (!providerList.includes("webgpu")) throw err;
            this.session = await this.ort.InferenceSession.create(this.modelUrl, {
                executionProviders: ["wasm"],
            });
            this.activeExecutionProvider = "wasm";
        }
        this.inputName = this.session.inputNames?.[0] || "images";
        this.outputNames = Array.from(this.session.outputNames || []);
        return this;
    }

    async detectCanvas(canvas, options = {}) {
        await this.init();
        const size = positiveInt(options.modelInputSize, this.modelInputSize);
        const scoreThreshold = finiteNumber(options.scoreThreshold, this.scoreThreshold);
        const iouThreshold = finiteNumber(options.iouThreshold, this.iouThreshold);
        const maxDetections = positiveInt(options.maxDetections, this.maxDetections);
        const startedAt = performance.now();
        const preprocessed = preprocessCanvasToNchw(canvas, { size });
        const inputTensor = new this.ort.Tensor("float32", preprocessed.tensorData, [1, 3, size, size]);
        const feeds = { [this.inputName]: inputTensor };
        const rawOutputs = await this.session.run(feeds);
        const inferenceMs = performance.now() - startedAt;
        const detections = parseDetectionOutputs(rawOutputs, {
            labels: this.labels,
            meta: preprocessed.meta,
            scoreThreshold,
            iouThreshold,
            maxDetections,
        });
        return {
            detections,
            provider: this.activeExecutionProvider,
            modelUrl: this.modelUrl,
            inputName: this.inputName,
            outputNames: this.outputNames,
            modelInputSize: size,
            sourceWidth: preprocessed.meta.sourceWidth,
            sourceHeight: preprocessed.meta.sourceHeight,
            inferenceMs,
        };
    }

    async dispose() {
        if (this.session && typeof this.session.release === "function") {
            await this.session.release();
        }
        this.session = null;
    }
}

export function createObjectDetector(options = {}) {
    return new OnnxObjectDetector(options);
}

export class ObjectDetectionStabilizer {
    constructor(options = {}) {
        this.iouThreshold = finiteNumber(options.iouThreshold, 0.35);
        this.jitterThresholdPx = finiteNumber(options.jitterThresholdPx, 8);
        this.smoothAlpha = finiteNumber(options.smoothAlpha, 0.55);
        this.maxMissed = positiveInt(options.maxMissed, 3);
        this.resetFrameGap = positiveInt(options.resetFrameGap, 8);
        this.tracks = [];
        this.nextTrackId = 1;
        this.lastFrameIndex = null;
    }

    reset() {
        this.tracks = [];
        this.nextTrackId = 1;
        this.lastFrameIndex = null;
    }

    update(detections, options = {}) {
        const frameIndex = Number(options.frameIndex);
        if (Number.isFinite(frameIndex) && Number.isFinite(this.lastFrameIndex)) {
            const delta = frameIndex - this.lastFrameIndex;
            if (delta < 0 || delta > this.resetFrameGap) this.reset();
        }
        if (Number.isFinite(frameIndex)) this.lastFrameIndex = frameIndex;

        const incoming = (Array.isArray(detections) ? detections : [])
            .filter((d) => d && Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.width) && Number.isFinite(d.height))
            .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
        const matchedTracks = new Set();
        const matchedDetections = new Set();
        const activeTracks = new Set();

        for (let i = 0; i < incoming.length; i++) {
            const det = incoming[i];
            let bestTrack = null;
            let bestScore = -Infinity;
            for (const track of this.tracks) {
                if (matchedTracks.has(track.id) || track.classId !== det.classId) continue;
                const iou = boxIou(track, det);
                const distScore = centerDistanceScore(track, det);
                const score = iou * 1.4 + distScore;
                if ((iou >= this.iouThreshold || distScore > 0.72) && score > bestScore) {
                    bestTrack = track;
                    bestScore = score;
                }
            }
            if (!bestTrack) continue;
            const stable = stabilizeBox(bestTrack, det, {
                jitterThresholdPx: this.jitterThresholdPx,
                smoothAlpha: this.smoothAlpha,
            });
            Object.assign(bestTrack, stable, {
                score: Math.max(Number(det.score) || 0, (Number(bestTrack.score) || 0) * 0.9),
                label: det.label,
                source: det.source,
                missed: 0,
                hits: (bestTrack.hits || 0) + 1,
            });
            matchedTracks.add(bestTrack.id);
            activeTracks.add(bestTrack.id);
            matchedDetections.add(i);
        }

        for (let i = 0; i < incoming.length; i++) {
            if (matchedDetections.has(i)) continue;
            const det = incoming[i];
            const id = this.nextTrackId++;
            this.tracks.push({
                ...det,
                id,
                stableId: id,
                missed: 0,
                hits: 1,
            });
            activeTracks.add(id);
        }

        for (const track of this.tracks) {
            if (!activeTracks.has(track.id)) {
                track.missed = (track.missed || 0) + 1;
                track.score = (Number(track.score) || 0) * 0.82;
            }
        }

        this.tracks = this.tracks.filter((track) => (track.missed || 0) <= this.maxMissed && (Number(track.score) || 0) > 0.05);
        return this.tracks
            .filter((track) => (track.hits || 0) >= 1)
            .map((track) => ({
                x: track.x,
                y: track.y,
                width: track.width,
                height: track.height,
                score: track.score,
                classId: track.classId,
                label: track.label,
                source: track.source,
                stableId: track.stableId || track.id,
                missed: track.missed || 0,
            }))
            .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    }
}

export function createObjectDetectionStabilizer(options = {}) {
    return new ObjectDetectionStabilizer(options);
}

function resolveExecutionProviders(provider) {
    const preferred = String(provider || "auto").toLowerCase();
    if (preferred === "wasm") return ["wasm"];
    if (preferred === "webgpu") return ["webgpu"];
    if (typeof navigator !== "undefined" && navigator.gpu) return ["webgpu", "wasm"];
    return ["wasm"];
}

export function preprocessCanvasToNchw(sourceCanvas, options = {}) {
    if (!(sourceCanvas instanceof HTMLCanvasElement) && !(sourceCanvas instanceof OffscreenCanvas)) {
        throw new Error("A canvas with a decoded video frame is required.");
    }
    const size = positiveInt(options.size, 640);
    const sourceWidth = Math.max(1, Math.floor(sourceCanvas.width || 0));
    const sourceHeight = Math.max(1, Math.floor(sourceCanvas.height || 0));
    if (sourceWidth <= 1 || sourceHeight <= 1) throw new Error("Canvas is empty. Decode a video frame first.");

    const workCanvas = typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(size, size)
        : Object.assign(document.createElement("canvas"), { width: size, height: size });
    workCanvas.width = size;
    workCanvas.height = size;
    const ctx = workCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas context is unavailable for object detection preprocessing.");

    const scale = Math.min(size / sourceWidth, size / sourceHeight);
    const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
    const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
    const padX = Math.floor((size - drawWidth) / 2);
    const padY = Math.floor((size - drawHeight) / 2);
    ctx.fillStyle = "rgb(0, 0, 0)";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(sourceCanvas, 0, 0, sourceWidth, sourceHeight, padX, padY, drawWidth, drawHeight);

    const imageData = ctx.getImageData(0, 0, size, size).data;
    const planeSize = size * size;
    const tensorData = new Float32Array(3 * planeSize);
    for (let i = 0, p = 0; i < imageData.length; i += 4, p++) {
        tensorData[p] = imageData[i] / 255;
        tensorData[planeSize + p] = imageData[i + 1] / 255;
        tensorData[planeSize * 2 + p] = imageData[i + 2] / 255;
    }
    return {
        tensorData,
        meta: {
            inputSize: size,
            sourceWidth,
            sourceHeight,
            scale,
            padX,
            padY,
            drawWidth,
            drawHeight,
        },
    };
}

export function parseDetectionOutputs(outputs, options = {}) {
    const entries = Object.entries(outputs || {});
    const tensorEntry = entries.find(([, value]) => value?.dims && value?.data);
    if (!tensorEntry) throw new Error("Object detection model returned no tensor output.");
    const [outputName, tensor] = tensorEntry;
    const dims = Array.from(tensor.dims || []);
    const data = tensorDataToFloatArray(tensor);
    const meta = options.meta || {};
    let detections = [];
    if (looksLikeNms6(dims)) {
        detections = parseNms6Output(data, dims, { ...options, outputName });
    } else if (looksLikeYoloRaw(dims)) {
        detections = parseYoloRawOutput(data, dims, { ...options, outputName });
    } else {
        throw new Error(`Unsupported object detection output shape: ${dims.join("x") || "unknown"}. Expected [1,N,6] or YOLO [1,84,N].`);
    }
    return detections
        .map((det) => mapDetectionToSource(det, meta))
        .filter((det) => det.width > 1 && det.height > 1)
        .slice(0, positiveInt(options.maxDetections, 20));
}

function looksLikeNms6(dims) {
    return dims.length === 3 && dims[2] >= 6 && dims[2] <= 16 && dims[1] > 0;
}

function looksLikeYoloRaw(dims) {
    if (dims.length !== 3) return false;
    const a = Number(dims[1]);
    const b = Number(dims[2]);
    return (a >= 6 && b > a) || (b >= 6 && a > b);
}

function parseNms6Output(data, dims, options = {}) {
    const rows = Number(dims[1]) || 0;
    const stride = Number(dims[2]) || 0;
    const inputSize = options.meta?.inputSize || 640;
    const scoreThreshold = finiteNumber(options.scoreThreshold, 0.35);
    const out = [];
    for (let i = 0; i < rows; i++) {
        const off = i * stride;
        const score = Number(data[off + 4]);
        if (!Number.isFinite(score) || score < scoreThreshold) continue;
        let x1 = Number(data[off]);
        let y1 = Number(data[off + 1]);
        let x2 = Number(data[off + 2]);
        let y2 = Number(data[off + 3]);
        if ([x1, y1, x2, y2].every((v) => Number.isFinite(v) && Math.abs(v) <= 1.5)) {
            x1 *= inputSize;
            y1 *= inputSize;
            x2 *= inputSize;
            y2 *= inputSize;
        }
        const classId = Math.max(0, Math.round(Number(data[off + 5]) || 0));
        out.push(makeDetection({ x1, y1, x2, y2, score, classId, labels: options.labels, source: "nms6" }));
    }
    return nms(out, finiteNumber(options.iouThreshold, 0.45));
}

function parseYoloRawOutput(data, dims, options = {}) {
    const d1 = Number(dims[1]);
    const d2 = Number(dims[2]);
    const transposed = d1 < d2;
    const attrs = transposed ? d1 : d2;
    const boxes = transposed ? d2 : d1;
    const inputSize = options.meta?.inputSize || 640;
    const scoreThreshold = finiteNumber(options.scoreThreshold, 0.35);
    const candidates = [];
    for (let i = 0; i < boxes; i++) {
        const at = (attr) => transposed ? data[attr * boxes + i] : data[i * attrs + attr];
        const cx = Number(at(0));
        const cy = Number(at(1));
        const w = Number(at(2));
        const h = Number(at(3));
        if (![cx, cy, w, h].every(Number.isFinite)) continue;
        let bestScore = -Infinity;
        let bestClass = 0;
        for (let c = 4; c < attrs; c++) {
            const score = Number(at(c));
            if (score > bestScore) {
                bestScore = score;
                bestClass = c - 4;
            }
        }
        if (!Number.isFinite(bestScore) || bestScore < scoreThreshold) continue;
        let x1 = cx - w / 2;
        let y1 = cy - h / 2;
        let x2 = cx + w / 2;
        let y2 = cy + h / 2;
        if ([x1, y1, x2, y2].every((v) => Math.abs(v) <= 1.5)) {
            x1 *= inputSize;
            y1 *= inputSize;
            x2 *= inputSize;
            y2 *= inputSize;
        }
        candidates.push(makeDetection({
            x1,
            y1,
            x2,
            y2,
            score: bestScore,
            classId: bestClass,
            labels: options.labels,
            source: "yolo-raw",
        }));
    }
    return nms(candidates, finiteNumber(options.iouThreshold, 0.45));
}

function makeDetection({ x1, y1, x2, y2, score, classId, labels, source }) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const right = Math.max(x1, x2);
    const bottom = Math.max(y1, y2);
    const id = Number.isFinite(classId) ? Math.max(0, Math.round(classId)) : 0;
    return {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
        score: Number(score) || 0,
        classId: id,
        label: labels?.[id] || `class ${id}`,
        source,
    };
}

function mapDetectionToSource(det, meta) {
    const scale = finiteNumber(meta.scale, 1);
    const padX = Number(meta.padX) || 0;
    const padY = Number(meta.padY) || 0;
    const sourceWidth = Math.max(1, Number(meta.sourceWidth) || 1);
    const sourceHeight = Math.max(1, Number(meta.sourceHeight) || 1);
    const x1 = clamp((det.x - padX) / scale, 0, sourceWidth);
    const y1 = clamp((det.y - padY) / scale, 0, sourceHeight);
    const x2 = clamp((det.x + det.width - padX) / scale, 0, sourceWidth);
    const y2 = clamp((det.y + det.height - padY) / scale, 0, sourceHeight);
    return {
        ...det,
        x: x1,
        y: y1,
        width: Math.max(0, x2 - x1),
        height: Math.max(0, y2 - y1),
    };
}

export function drawObjectDetections(canvas, detections, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rows = Array.isArray(detections) ? detections : [];
    const palette = options.palette || ["#5da8ff", "#58d798", "#ffae5d", "#ff6f7d", "#d889ff", "#4cd3ff"];
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) / 260));
    ctx.font = `${Math.max(12, Math.round(Math.min(canvas.width, canvas.height) / 42))}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial`;
    ctx.textBaseline = "top";
    for (let i = 0; i < rows.length; i++) {
        const det = rows[i];
        const color = palette[i % palette.length];
        const x = Math.round(det.x);
        const y = Math.round(det.y);
        const w = Math.round(det.width);
        const h = Math.round(det.height);
        if (w <= 0 || h <= 0) continue;
        ctx.strokeStyle = color;
        ctx.strokeRect(x, y, w, h);
        const label = `${det.label || "object"} ${(det.score * 100).toFixed(0)}%`;
        const metrics = ctx.measureText(label);
        const labelW = Math.ceil(metrics.width + 10);
        const labelH = Math.ceil(parseInt(ctx.font, 10) + 7);
        const labelY = Math.max(0, y - labelH);
        ctx.fillStyle = color;
        ctx.fillRect(x, labelY, labelW, labelH);
        ctx.fillStyle = "#06111f";
        ctx.fillText(label, x + 5, labelY + 3);
    }
    ctx.restore();
}

function nms(detections, iouThreshold) {
    const sorted = [...detections]
        .filter((d) => d.width > 0 && d.height > 0 && Number.isFinite(d.score))
        .sort((a, b) => b.score - a.score);
    const kept = [];
    for (const det of sorted) {
        let suppress = false;
        for (const prev of kept) {
            if (det.classId === prev.classId && boxIou(det, prev) > iouThreshold) {
                suppress = true;
                break;
            }
        }
        if (!suppress) kept.push(det);
    }
    return kept;
}

function boxIou(a, b) {
    const ax2 = a.x + a.width;
    const ay2 = a.y + a.height;
    const bx2 = b.x + b.width;
    const by2 = b.y + b.height;
    const ix1 = Math.max(a.x, b.x);
    const iy1 = Math.max(a.y, b.y);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);
    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    const union = a.width * a.height + b.width * b.height - inter;
    return union > 0 ? inter / union : 0;
}

function centerDistanceScore(a, b) {
    const acx = a.x + a.width / 2;
    const acy = a.y + a.height / 2;
    const bcx = b.x + b.width / 2;
    const bcy = b.y + b.height / 2;
    const diag = Math.hypot(Math.max(a.width, b.width), Math.max(a.height, b.height)) || 1;
    const dist = Math.hypot(acx - bcx, acy - bcy);
    return Math.max(0, 1 - dist / Math.max(1, diag));
}

function stabilizeBox(prev, next, options) {
    const threshold = finiteNumber(options.jitterThresholdPx, 8);
    const alpha = Math.max(0, Math.min(0.95, finiteNumber(options.smoothAlpha, 0.55)));
    const pcx = prev.x + prev.width / 2;
    const pcy = prev.y + prev.height / 2;
    const ncx = next.x + next.width / 2;
    const ncy = next.y + next.height / 2;
    const centerDelta = Math.hypot(ncx - pcx, ncy - pcy);
    const sizeDelta = Math.max(Math.abs(next.width - prev.width), Math.abs(next.height - prev.height));
    if (centerDelta <= threshold && sizeDelta <= threshold) {
        return {
            x: prev.x,
            y: prev.y,
            width: prev.width,
            height: prev.height,
        };
    }
    return {
        x: lerp(next.x, prev.x, alpha),
        y: lerp(next.y, prev.y, alpha),
        width: lerp(next.width, prev.width, alpha),
        height: lerp(next.height, prev.height, alpha),
    };
}

function lerp(next, prev, alpha) {
    return prev * alpha + next * (1 - alpha);
}

function tensorDataToFloatArray(tensor) {
    const data = tensor?.data;
    if (data instanceof Float32Array) return data;
    if (data instanceof Float64Array) return Float32Array.from(data);
    if (data instanceof Int32Array || data instanceof Uint32Array || data instanceof Int16Array || data instanceof Uint16Array || data instanceof Uint8Array) {
        if (tensor?.type === "float16" && data instanceof Uint16Array) {
            const out = new Float32Array(data.length);
            for (let i = 0; i < data.length; i++) out[i] = float16ToFloat32(data[i]);
            return out;
        }
        return Float32Array.from(data);
    }
    if (Array.isArray(data)) return Float32Array.from(data);
    throw new Error(`Unsupported tensor data type: ${tensor?.type || typeof data}`);
}

function float16ToFloat32(h) {
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / Math.pow(2, 10));
    if (e === 0x1f) return f ? NaN : ((s ? -1 : 1) * Infinity);
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / Math.pow(2, 10));
}

function finiteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function positiveInt(value, fallback) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, Number(v) || 0));
}

export const onnxObjectDetectionCodec = Object.freeze({
    DEFAULT_ORT_WEBGPU_SCRIPT_URL,
    DEFAULT_ORT_WASM_BASE_URL,
    DEFAULT_LOCAL_OBJECT_DETECTION_MODEL_URL,
    DEFAULT_OBJECT_DETECTION_MODEL_URL,
    COCO_80_LABELS,
    OnnxObjectDetector,
    ObjectDetectionStabilizer,
    createObjectDetector,
    createObjectDetectionStabilizer,
    loadOnnxRuntimeWeb,
    preprocessCanvasToNchw,
    parseDetectionOutputs,
    drawObjectDetections,
});
