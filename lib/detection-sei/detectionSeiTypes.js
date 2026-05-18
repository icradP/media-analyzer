/**
 * @typedef {Object} DetectionBox
 * @property {number} x Normalized left coordinate, 0..1.
 * @property {number} y Normalized top coordinate, 0..1.
 * @property {number} w Normalized width, 0..1.
 * @property {number} h Normalized height, 0..1.
 * @property {number} score Confidence score, 0..1.
 * @property {number} classId Model class id.
 * @property {string} [label] Optional class label.
 */

/**
 * @typedef {Object} DetectionSeiPayloadV1
 * @property {"zxb.detection"} type
 * @property {1} version
 * @property {number} frameIndex
 * @property {number} [pts]
 * @property {number} [timeMs]
 * @property {string} source
 * @property {{ name?: string, inputSize?: number, classes?: string[] }} [model]
 * @property {{ width: number, height: number }} image
 * @property {DetectionBox[]} detections
 */

/**
 * @typedef {Object} DetectionSeiProcessOptions
 * @property {number} confidenceThreshold
 * @property {number} iouThreshold
 * @property {number} frameStride
 * @property {boolean} replaceExisting
 * @property {boolean} fallbackRunDetection
 * @property {number} maxDetectionsPerFrame
 */

export const detectionSeiTypes = Object.freeze({});
