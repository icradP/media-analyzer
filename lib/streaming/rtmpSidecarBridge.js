export const DEFAULT_RTMP_SIDECAR_HTTP_BASE = "http://127.0.0.1:18080";
export const DEFAULT_RTMP_SIDECAR_WS_PATH = "/live.flv";

export function buildRtmpSidecarSchemeUrl(rtmpUrl, {
    port = 18080,
    path = DEFAULT_RTMP_SIDECAR_WS_PATH,
} = {}) {
    const params = new URLSearchParams({
        rtmp: String(rtmpUrl || ""),
        port: String(port),
        path,
    });
    return `media-analyzer://open?${params.toString()}`;
}

export function wakeRtmpSidecar(rtmpUrl, options = {}) {
    const {
        port = 18080,
        path = DEFAULT_RTMP_SIDECAR_WS_PATH,
        onLog = null,
        onStatus = null,
    } = options;
    const schemeUrl = buildRtmpSidecarSchemeUrl(rtmpUrl, { port, path });
    if (typeof onLog === "function") onLog(`[rtmp sidecar] wake ${schemeUrl}`);
    if (typeof onStatus === "function") onStatus("Waiting for Media Analyzer sidecar...");
    if (typeof window !== "undefined") window.location.href = schemeUrl;
    return schemeUrl;
}

export async function openRtmpThroughSidecar(rtmpUrl, options = {}) {
    const {
        httpBase = DEFAULT_RTMP_SIDECAR_HTTP_BASE,
        wsPath = DEFAULT_RTMP_SIDECAR_WS_PATH,
        wake = true,
        waitTimeoutMs = 10000,
        openTimeoutMs = 5000,
        onLog = null,
        onStatus = null,
    } = options;

    if (wake) {
        const url = new URL(httpBase);
        wakeRtmpSidecar(rtmpUrl, {
            port: url.port || "18080",
            path: wsPath,
            onLog,
            onStatus,
        });
    }

    try {
        await fetchRtmpSidecarJson("/api/status", { httpBase, timeoutMs: 600 });
    } catch {
        await waitForRtmpSidecarReady({ httpBase, timeoutMs: waitTimeoutMs });
    }

    const result = await fetchRtmpSidecarJson("/api/open", {
        httpBase,
        method: "POST",
        body: { rtmp: rtmpUrl },
        timeoutMs: openTimeoutMs,
    });
    const wsUrl = result.wsUrl || `${httpBase.replace(/^http/i, "ws")}${wsPath}`;
    if (typeof onLog === "function") onLog(`[rtmp sidecar] ${rtmpUrl} -> ${wsUrl}`);
    if (typeof onStatus === "function") onStatus(`RTMP sidecar ready: ${wsUrl}`);
    return { ...result, wsUrl };
}

export async function waitForRtmpSidecarReady({
    httpBase = DEFAULT_RTMP_SIDECAR_HTTP_BASE,
    timeoutMs = 10000,
    pollMs = 250,
} = {}) {
    const started = nowMs();
    let lastError = null;
    while (nowMs() - started < timeoutMs) {
        try {
            return await fetchRtmpSidecarJson("/api/status", { httpBase, timeoutMs: 800 });
        } catch (err) {
            lastError = err;
            await sleep(pollMs);
        }
    }
    throw new Error(`RTMP sidecar did not become ready. ${lastError?.message || ""}`.trim());
}

export async function fetchRtmpSidecarJson(path, {
    httpBase = DEFAULT_RTMP_SIDECAR_HTTP_BASE,
    method = "GET",
    body = null,
    timeoutMs = 2500,
} = {}) {
    const Controller = typeof AbortController !== "undefined" ? AbortController : null;
    const controller = Controller ? new Controller() : null;
    const timer = controller && typeof setTimeout === "function"
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
    try {
        const res = await fetch(`${httpBase}${path}`, {
            method,
            cache: "no-store",
            headers: body ? { "content-type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller?.signal,
        });
        if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
        const data = await res.json();
        if (data?.ok === false) throw new Error(data.error || "sidecar request failed");
        return data;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
}

export const rtmpSidecarBridge = Object.freeze({
    DEFAULT_RTMP_SIDECAR_HTTP_BASE,
    DEFAULT_RTMP_SIDECAR_WS_PATH,
    buildRtmpSidecarSchemeUrl,
    wakeRtmpSidecar,
    openRtmpThroughSidecar,
    waitForRtmpSidecarReady,
    fetchRtmpSidecarJson,
});
