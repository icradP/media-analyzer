export const DETECTION_SEI_TYPE = "zxb.detection";
export const DETECTION_SEI_VERSION = 1;
export const DETECTION_SEI_SOURCE = "onnx-webgpu-yolo";

// 16 bytes. ASCII label: "ZXB_DETECT_SEI1!".
export const DETECTION_SEI_UUID_BYTES = Uint8Array.from([
    0x5a, 0x58, 0x42, 0x5f, 0x44, 0x45, 0x54, 0x45,
    0x43, 0x54, 0x5f, 0x53, 0x45, 0x49, 0x31, 0x21,
]);

export const DETECTION_SEI_UUID_LABEL = "ZXB_DETECT_SEI1!";

export function normalizeDetectionSeiPayload(input = {}) {
    const imageWidth = positiveNumber(input?.image?.width, 0);
    const imageHeight = positiveNumber(input?.image?.height, 0);
    if (imageWidth <= 0 || imageHeight <= 0) throw new Error("Detection SEI image width/height are required.");
    const payload = {
        type: DETECTION_SEI_TYPE,
        version: DETECTION_SEI_VERSION,
        frameIndex: Math.max(0, Math.round(Number(input.frameIndex) || 0)),
        source: String(input.source || DETECTION_SEI_SOURCE),
        image: {
            width: imageWidth,
            height: imageHeight,
        },
        detections: normalizeDetectionBoxes(input.detections),
    };
    if (Number.isFinite(Number(input.pts))) payload.pts = Number(input.pts);
    if (Number.isFinite(Number(input.timeMs))) payload.timeMs = Number(input.timeMs);
    if (input.model && typeof input.model === "object") {
        const model = {};
        if (input.model.name) model.name = String(input.model.name);
        if (Number.isFinite(Number(input.model.inputSize))) model.inputSize = Math.max(1, Math.round(Number(input.model.inputSize)));
        if (Array.isArray(input.model.classes)) model.classes = input.model.classes.map((v) => String(v));
        if (Object.keys(model).length) payload.model = model;
    }
    return payload;
}

export function normalizeDetectionBoxes(input) {
    return (Array.isArray(input) ? input : [])
        .map((det) => {
            const x = clamp01(det?.x);
            const y = clamp01(det?.y);
            const w = clamp01(det?.w);
            const h = clamp01(det?.h);
            return {
                x,
                y,
                w: Math.min(w, 1 - x),
                h: Math.min(h, 1 - y),
                score: clamp01(det?.score),
                classId: Math.max(0, Math.round(Number(det?.classId) || 0)),
                ...(det?.label ? { label: String(det.label) } : {}),
            };
        })
        .filter((det) => det.w > 0 && det.h > 0);
}

export function isDetectionSeiPayload(value) {
    return value?.type === DETECTION_SEI_TYPE &&
        Number(value?.version) === DETECTION_SEI_VERSION &&
        value?.image &&
        Array.isArray(value?.detections);
}

export function detectionsToNormalizedBoxes(detections, imageWidth, imageHeight, maxDetections = 100) {
    const w = positiveNumber(imageWidth, 0);
    const h = positiveNumber(imageHeight, 0);
    if (w <= 0 || h <= 0) return [];
    return (Array.isArray(detections) ? detections : [])
        .slice(0, Math.max(0, Math.round(Number(maxDetections) || 0)))
        .map((det) => {
            const x = clamp01((Number(det?.x) || 0) / w);
            const y = clamp01((Number(det?.y) || 0) / h);
            const bw = clamp01((Number(det?.width) || 0) / w);
            const bh = clamp01((Number(det?.height) || 0) / h);
            return {
                x,
                y,
                w: Math.min(bw, 1 - x),
                h: Math.min(bh, 1 - y),
                score: clamp01(det?.score),
                classId: Math.max(0, Math.round(Number(det?.classId) || 0)),
                ...(det?.label ? { label: String(det.label) } : {}),
            };
        })
        .filter((det) => det.w > 0 && det.h > 0);
}

export function normalizedBoxesToDetections(payload, imageWidth, imageHeight) {
    const sourceWidth = positiveNumber(payload?.image?.width, 0);
    const sourceHeight = positiveNumber(payload?.image?.height, 0);
    const drawWidth = positiveNumber(imageWidth, sourceWidth || 1);
    const drawHeight = positiveNumber(imageHeight, sourceHeight || 1);
    return normalizeDetectionBoxes(payload?.detections).map((det) => ({
        x: det.x * drawWidth,
        y: det.y * drawHeight,
        width: det.w * drawWidth,
        height: det.h * drawHeight,
        score: det.score,
        classId: det.classId,
        label: det.label || `class ${det.classId}`,
        source: "SEI",
    }));
}

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return Number(n.toFixed(6));
}

function positiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const detectionSeiSchema = Object.freeze({
    DETECTION_SEI_TYPE,
    DETECTION_SEI_VERSION,
    DETECTION_SEI_SOURCE,
    DETECTION_SEI_UUID_BYTES,
    DETECTION_SEI_UUID_LABEL,
    normalizeDetectionSeiPayload,
    normalizeDetectionBoxes,
    isDetectionSeiPayload,
    detectionsToNormalizedBoxes,
    normalizedBoxesToDetections,
});
