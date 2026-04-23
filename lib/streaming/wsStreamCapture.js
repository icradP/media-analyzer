/**
 * WebSocket 流采集 + 粗类型判断。
 * 完整 MP4/TS 解析由调用方注入；可选用 `parseIsoBmffBoxesMinimal`（仅顶层 box）。
 *
 * 运行环境需具备全局 `WebSocket`（浏览器；Node 需自行 polyfill）。
 */

/** 默认拉流时长（秒） */
export const WS_STREAM_DEFAULT_FETCH_SECONDS = 10;

/** WebSocket 仍处于 CONNECTING 时的超时（毫秒） */
export const WS_STREAM_CONNECT_TIMEOUT_MS = 15000;

/** ISO BMFF / 常用根级 box 四字符 */
export const ISO_MP4_LIKE_TOP_LEVEL_BOX_IDS = Object.freeze(
    new Set(["ftyp", "styp", "moov", "moof", "mdat", "free", "skip", "mvhd", "trak", "uuid"]),
);

/** @param {Uint8Array} buffer @param {number} offset */
export function readUint32BE(buffer, offset) {
    return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0;
}

/** @param {Uint8Array} buffer @param {number} offset */
export function readFourCC(buffer, offset) {
    return String.fromCharCode(buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]);
}

/** FLV 文件头三字节 `FLV` */
export function isFlvSignaturePrefix(bytes) {
    return bytes.length >= 3 && bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56;
}

/**
 * 是否在若干 188B 边界上出现 MPEG-TS 同步字节 `0x47`。
 * 用于在粗判 MP4 时排除明显的 TS 负载。
 */
export function hasMpegTsMultiSyncPattern(bytes) {
    if (bytes.length < 188 || bytes[0] !== 0x47) return false;
    return (bytes.length >= 376 && bytes[188] === 0x47) || (bytes.length >= 564 && bytes[376] === 0x47);
}

/**
 * 粗判缓冲是否像 MP4 / fMP4：扫 box size + type，或首盒 type 命中白名单。
 * @param {Uint8Array} bytes
 */
export function coarseLooksLikeMp4OrFmp4(bytes) {
    if (bytes.length < 8 || isFlvSignaturePrefix(bytes) || hasMpegTsMultiSyncPattern(bytes)) {
        return false;
    }
    const firstType = readFourCC(bytes, 4);
    if (ISO_MP4_LIKE_TOP_LEVEL_BOX_IDS.has(firstType)) return true;
    const limit = Math.min(bytes.length, 1024 * 1024);
    let offset = 0;
    while (offset + 8 <= limit) {
        const size = readUint32BE(bytes, offset);
        const type = readFourCC(bytes, offset + 4);
        if (ISO_MP4_LIKE_TOP_LEVEL_BOX_IDS.has(type)) return true;
        if (size < 8 || offset + size > limit) break;
        offset += size;
    }
    return false;
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
    waitUntilZeroOrTimeout,
    collectWebSocketBinary,
    attachWsFmp4FormatInfo,
    attachWsTsFormatInfo,
    fetchWebSocketFmp4AndParse,
    fetchWebSocketTsAndParse,
});
