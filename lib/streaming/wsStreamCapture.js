/**
 * WebSocket 流采集 + 粗类型判断。
 * 完整 MP4/TS 解析由调用方注入；可选用 `parseIsoBmffBoxesMinimal`（仅顶层 box）。
 *
 * 运行环境需具备全局 `WebSocket`（浏览器；Node 需自行 polyfill）。
 */

import {
    MP4_LIKE_TOP_LEVEL_BOX_IDS,
    coarseLooksLikeMp4OrFmp4,
    hasMpegTsMultiSyncPattern,
    isAacAdtsSignature,
    isFlacSignature,
    isFlvSignaturePrefix,
    isMp3Signature,
    isOggSignature,
    isPsPackHeader,
    isWavSignature,
    readFourCC,
    readUint32BE,
} from "../core/mediaSignatures.js";

/** 默认拉流时长（秒） */
export const WS_STREAM_DEFAULT_FETCH_SECONDS = 10;

/** WebSocket 仍处于 CONNECTING 时的超时（毫秒） */
export const WS_STREAM_CONNECT_TIMEOUT_MS = 15000;

/** ISO BMFF / 常用根级 box 四字符 */
export const ISO_MP4_LIKE_TOP_LEVEL_BOX_IDS = MP4_LIKE_TOP_LEVEL_BOX_IDS;

export {
    coarseLooksLikeMp4OrFmp4,
    hasMpegTsMultiSyncPattern,
    isFlvSignaturePrefix,
    readFourCC,
    readUint32BE,
};

const CAPTURE_DOWNLOAD_EXTENSIONS = Object.freeze(
    new Set([
        "flv", "ts", "m2ts", "mp4", "m4s", "fmp4", "mov", "ps", "mpeg", "mpg",
        "aac", "mp3", "wav", "flac", "ogg", "opus", "bin",
    ]),
);

function pad2(n) {
    return String(n).padStart(2, "0");
}

function compactLocalTimestamp(date = new Date()) {
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function fileNameFromUrl(sourceUrl) {
    if (!sourceUrl) return "";
    try {
        const u = new URL(sourceUrl);
        return u.pathname.split("/").filter(Boolean).pop() || "";
    } catch {
        return "";
    }
}

function extensionFromFileName(fileName) {
    const clean = String(fileName || "").split(/[?#]/, 1)[0];
    const match = clean.match(/\.([A-Za-z0-9]{1,8})$/);
    if (!match) return "";
    const ext = match[1].toLowerCase();
    return CAPTURE_DOWNLOAD_EXTENSIONS.has(ext) ? ext : "";
}

function stripKnownExtension(fileName) {
    const ext = extensionFromFileName(fileName);
    if (!ext) return fileName;
    return fileName.slice(0, -(ext.length + 1));
}

export function sanitizeDownloadFileName(fileName, fallback = "media-capture.bin") {
    const raw = String(fileName || "").trim();
    const safe = raw
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/[\x00-\x1f\x7f]+/g, "")
        .replace(/\s+/g, " ")
        .replace(/^\.+/, "")
        .trim();
    return safe || fallback;
}

export function mediaFileExtensionFromBytes(bytes, fallback = "bin") {
    if (!(bytes instanceof Uint8Array)) return fallback;
    if (isFlvSignaturePrefix(bytes)) return "flv";
    if (hasMpegTsMultiSyncPattern(bytes)) return "ts";
    if (coarseLooksLikeMp4OrFmp4(bytes)) return "mp4";
    if (isWavSignature(bytes)) return "wav";
    if (isFlacSignature(bytes)) return "flac";
    if (isOggSignature(bytes)) return "ogg";
    if (isAacAdtsSignature(bytes)) return "aac";
    if (isMp3Signature(bytes)) return "mp3";
    if (isPsPackHeader(bytes)) return "ps";
    return fallback;
}

export function buildCapturedMediaFileName(options = {}) {
    const {
        bytes,
        sourceUrl = "",
        fileName = "",
        prefix = "media-capture",
        now = new Date(),
    } = options;
    const rawFileName = String(fileName || "");
    const sourceName = sanitizeDownloadFileName(
        (/^wss?:\/\//i.test(rawFileName) || /^https?:\/\//i.test(rawFileName) ? fileNameFromUrl(rawFileName) : rawFileName)
            || fileNameFromUrl(sourceUrl),
        "",
    );
    const extFromName = extensionFromFileName(sourceName);
    if (sourceName && extFromName) return sourceName;

    const inferredExt = mediaFileExtensionFromBytes(bytes, "bin");
    const base = sanitizeDownloadFileName(stripKnownExtension(sourceName) || prefix, prefix);
    return `${base}-${compactLocalTimestamp(now)}.${inferredExt}`;
}

export function downloadBytesAsFile(bytes, fileName, mimeType = "application/octet-stream") {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength <= 0) {
        throw new Error("No captured bytes available to save");
    }
    if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
        throw new Error("Browser download APIs are not available in this environment");
    }
    const safeName = sanitizeDownloadFileName(fileName, buildCapturedMediaFileName({ bytes }));
    const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = safeName;
    a.style.display = "none";
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    return { fileName: safeName, size: bytes.byteLength };
}

/**
 * @param {() => number} pendingCountFn 待完成的异步任务数（如 Blob 转 ArrayBuffer）
 * @param {number} [maxWaitMs=2000]
 */
export function waitUntilZeroOrTimeout(pendingCountFn, maxWaitMs = 2000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
            if (pendingCountFn() <= 0 || Date.now() - start >= maxWaitMs) {
                resolve();
                return;
            }
            setTimeout(tick, 20);
        };
        tick();
    });
}

/**
 * @typedef {object} CollectWsBinaryOptions
 * @property {(message?: string) => void} [onProgress]
 * @property {number} [fetchDurationSec=WS_STREAM_DEFAULT_FETCH_SECONDS]
 * @property {number} [connectTimeoutMs=WS_STREAM_CONNECT_TIMEOUT_MS]
 */

/**
 * 连接 WebSocket，在限时内收集二进制帧并拼接为单一 Uint8Array（fMP4 与 TS 共用）。
 * @param {string} streamUrl
 * @param {CollectWsBinaryOptions} [options]
 * @returns {Promise<{ bytes: Uint8Array; actualFetchTimeSec: number; streamUrl: string }>}
 */
export function collectWebSocketBinary(streamUrl, options = {}) {
    const {
        onProgress,
        fetchDurationSec = WS_STREAM_DEFAULT_FETCH_SECONDS,
        connectTimeoutMs = WS_STREAM_CONNECT_TIMEOUT_MS,
    } = options;
    const maxDurationMs = fetchDurationSec * 1000;

    return new Promise((resolve, reject) => {
        if (typeof WebSocket === "undefined") {
            reject(new Error("WebSocket is not available in this environment"));
            return;
        }
        try {
            const ws = new WebSocket(streamUrl);
            ws.binaryType = "arraybuffer";
            const chunks = [];
            let totalLength = 0;
            const startedAt = Date.now();
            let finished = false;
            let blobInflight = 0;
            let fetchTimer = null;
            let connectTimer = null;

            const cleanupTimers = () => {
                if (fetchTimer) {
                    clearTimeout(fetchTimer);
                    fetchTimer = null;
                }
                if (connectTimer) {
                    clearTimeout(connectTimer);
                    connectTimer = null;
                }
            };

            const closeSocket = () => {
                try {
                    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                        ws.close();
                    }
                } catch {
                    /* ignore */
                }
            };

            const finalizeConcat = async () => {
                if (finished) return;
                finished = true;
                cleanupTimers();
                closeSocket();
                await waitUntilZeroOrTimeout(() => blobInflight);
                if (chunks.length === 0 || totalLength === 0) {
                    reject(new Error("No data received from WebSocket stream"));
                    return;
                }
                const out = new Uint8Array(totalLength);
                let pos = 0;
                for (const part of chunks) {
                    out.set(part, pos);
                    pos += part.length;
                }
                resolve({
                    bytes: out,
                    actualFetchTimeSec: (Date.now() - startedAt) / 1000,
                    streamUrl,
                });
            };

            fetchTimer = setTimeout(() => {
                onProgress?.("Reached time limit, stopping fetch...");
                finalizeConcat();
            }, maxDurationMs);

            ws.onopen = () => {
                if (connectTimer) {
                    clearTimeout(connectTimer);
                    connectTimer = null;
                }
                onProgress?.(`Fetching ${fetchDurationSec}s of stream data...`);
            };

            ws.onmessage = (ev) => {
                const data = ev.data;
                if (data instanceof ArrayBuffer) {
                    const u8 = new Uint8Array(data);
                    chunks.push(u8);
                    totalLength += u8.length;
                    if (totalLength % 102400 < data.byteLength) {
                        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
                        const mb = (totalLength / 1024 / 1024).toFixed(2);
                        onProgress?.(`Fetching... ${mb}MB (${elapsedSec}s/${fetchDurationSec}s)`);
                    }
                } else if (typeof Blob !== "undefined" && data instanceof Blob) {
                    blobInflight += 1;
                    data
                        .arrayBuffer()
                        .then((ab) => {
                            if (finished) return;
                            const u8 = new Uint8Array(ab);
                            chunks.push(u8);
                            totalLength += u8.length;
                        })
                        .catch(() => {
                            /* ignore */
                        })
                        .finally(() => {
                            blobInflight -= 1;
                        });
                }
            };

            ws.onerror = () => {
                if (finished) return;
                finished = true;
                cleanupTimers();
                reject(new Error("WebSocket connection error"));
            };

            ws.onclose = (ev) => {
                if (finished) return;
                if (chunks.length > 0 || blobInflight > 0) {
                    onProgress?.("WebSocket closed, processing received data...");
                    finalizeConcat();
                } else {
                    finished = true;
                    cleanupTimers();
                    reject(
                        new Error(`WebSocket closed before receiving data (code: ${ev.code})`),
                    );
                }
            };

            connectTimer = setTimeout(() => {
                if (ws.readyState === WebSocket.CONNECTING && !finished) {
                    finished = true;
                    cleanupTimers();
                    try {
                        ws.close();
                    } catch {
                        /* ignore */
                    }
                    reject(new Error("WebSocket connection timeout"));
                }
            }, connectTimeoutMs);
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * @param {object} analysis — 解析器返回对象，需含 `format` 字段
 * @param {string} streamUrl
 * @param {number} fetchDurationSec
 * @param {number} dataSize
 * @param {number} actualFetchTimeSec
 */
export function attachWsFmp4FormatInfo(analysis, streamUrl, fetchDurationSec, dataSize, actualFetchTimeSec) {
    if (!analysis.format) analysis.format = {};
    analysis.format.formatName = "ws-fmp4";
    analysis.format.formatLongName = "WebSocket-fMP4 (WebSocket Fragmented MP4 Stream)";
    analysis.format.wsFmp4Info = {
        streamUrl,
        fetchDuration: fetchDurationSec,
        actualFetchTime: actualFetchTimeSec,
        dataSize,
    };
    return analysis;
}

/**
 * @param {object} analysis
 * @param {string} streamUrl
 * @param {number} fetchDurationSec
 * @param {number} dataSize
 * @param {number} actualFetchTimeSec
 */
export function attachWsTsFormatInfo(analysis, streamUrl, fetchDurationSec, dataSize, actualFetchTimeSec) {
    if (!analysis.format) analysis.format = {};
    analysis.format.formatName = "ws-ts";
    analysis.format.formatLongName = "WebSocket-TS (WebSocket MPEG-TS Stream)";
    analysis.format.wsTsInfo = {
        streamUrl,
        fetchDuration: fetchDurationSec,
        actualFetchTime: actualFetchTimeSec,
        dataSize,
    };
    return analysis;
}

/**
 * WebSocket-fMP4：采集 → `coarseLooksLikeMp4OrFmp4` → 调用注入的 MP4 解析器。
 *
 * @param {string} streamUrl
 * @param {(bytes: Uint8Array) => Promise<object>} parseMp4Like — 完整解析
 * @param {CollectWsBinaryOptions} [options]
 */
export async function fetchWebSocketFmp4AndParse(streamUrl, parseMp4Like, options = {}) {
    const fetchDurationSec = options.fetchDurationSec ?? WS_STREAM_DEFAULT_FETCH_SECONDS;
    options.onProgress?.("Connecting to WebSocket-fMP4 stream...");
    const { bytes, actualFetchTimeSec } = await collectWebSocketBinary(streamUrl, {
        ...options,
        fetchDurationSec,
    });
    if (!coarseLooksLikeMp4OrFmp4(bytes)) {
        throw new Error("Stream content is not MP4/fMP4 (detected by payload bytes)");
    }
    options.onProgress?.(`Received ${(bytes.length / 1024 / 1024).toFixed(2)}MB, parsing fMP4 data...`);
    options.onProgress?.("Parsing fMP4 structure...");
    const analysis = await parseMp4Like(bytes);
    return attachWsFmp4FormatInfo(analysis, streamUrl, fetchDurationSec, bytes.length, actualFetchTimeSec);
}

/**
 * WebSocket-MPEG-TS：采集 → 同步字节校验 → 调用注入的 TS 解析器。
 *
 * @param {string} streamUrl
 * @param {(bytes: Uint8Array) => Promise<object>} parseTs — 完整解析；轻量可用 `parseMpegTsScanSummary(b)` 或 `parseMpegTsScanSummary(b, { includePsi: true })`（`../mpegTs/index.js`）
 * @param {CollectWsBinaryOptions} [options]
 */
export async function fetchWebSocketTsAndParse(streamUrl, parseTs, options = {}) {
    const fetchDurationSec = options.fetchDurationSec ?? WS_STREAM_DEFAULT_FETCH_SECONDS;
    options.onProgress?.("Connecting to WebSocket-TS stream...");
    const { bytes, actualFetchTimeSec } = await collectWebSocketBinary(streamUrl, {
        ...options,
        fetchDurationSec,
    });
    if (bytes.length < 188) {
        throw new Error("Data too small to be a valid TS stream");
    }
    if (bytes[0] !== 0x47) {
        throw new Error("Invalid TS sync byte, not a valid WebSocket-TS stream");
    }
    options.onProgress?.(`Received ${(bytes.length / 1024 / 1024).toFixed(2)}MB, parsing TS data...`);
    options.onProgress?.("Parsing TS structure...");
    const analysis = await parseTs(bytes);
    return attachWsTsFormatInfo(analysis, streamUrl, fetchDurationSec, bytes.length, actualFetchTimeSec);
}

export const wsStreamCaptureCodec = Object.freeze({
    WS_STREAM_DEFAULT_FETCH_SECONDS,
    WS_STREAM_CONNECT_TIMEOUT_MS,
    ISO_MP4_LIKE_TOP_LEVEL_BOX_IDS,
    readUint32BE,
    readFourCC,
    isFlvSignaturePrefix,
    hasMpegTsMultiSyncPattern,
    coarseLooksLikeMp4OrFmp4,
    sanitizeDownloadFileName,
    mediaFileExtensionFromBytes,
    buildCapturedMediaFileName,
    downloadBytesAsFile,
    waitUntilZeroOrTimeout,
    collectWebSocketBinary,
    attachWsFmp4FormatInfo,
    attachWsTsFormatInfo,
    fetchWebSocketFmp4AndParse,
    fetchWebSocketTsAndParse,
});
