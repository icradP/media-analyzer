#!/usr/bin/env node

import { RtmpPullClient } from "./rtmpClient.mjs";
import { WsFlvServer } from "./wsFlvServer.mjs";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
    printUsage();
    process.exit(0);
}

const log = (message) => {
    const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    console.log(`${now} ${message}`);
};

const server = new WsFlvServer({
    host: args.host || "127.0.0.1",
    port: Number(args.port || 18080),
    path: args.path || "/live.flv",
    hasAudio: args.videoOnly ? false : true,
    hasVideo: args.audioOnly ? false : true,
    control: {
        status: () => ({
            state: pullState,
            sourceUrl: currentRequest?.rtmp || "",
            media: mediaCount,
            mediaBytes,
        }),
        open: openPull,
        close: closePull,
        clientsChanged: handleWsClientCountChanged,
    },
    logger: log,
});

let client = null;
let stopped = false;
let pullState = "idle";
let currentRequest = buildInitialRequest(args);
let mediaCount = 0;
let mediaBytes = 0;
let reconnectTimer = null;
let idleCloseTimer = null;
let seenPlaybackClient = false;

if (currentRequest && await forwardOpenToExistingSidecar(currentRequest)) {
    process.exit(0);
}

await server.start();
log(`open with player ws://${server.host}:${server.port}${server.path}`);
if (currentRequest) await openPull(currentRequest);
else log("[sidecar] waiting for URL Scheme or /api/open request.");

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function openPull(requestLike) {
    const request = normalizeOpenRequest(requestLike);
    if (client && currentRequest?.rtmp === request.rtmp) {
        return {
            state: pullState,
            sourceUrl: currentRequest.rtmp,
            wsUrl: server.wsUrl(),
        };
    }
    closeClientOnly();
    clearReconnectTimer();
    clearIdleCloseTimer();
    server.resetStreamCache();
    currentRequest = request;
    mediaCount = 0;
    mediaBytes = 0;
    seenPlaybackClient = false;
    pullState = "connecting";
    startPull();
    scheduleIdleClose("no WS-FLV client connected", firstClientTimeoutMs());
    return {
        state: pullState,
        sourceUrl: request.rtmp,
        wsUrl: server.wsUrl(),
    };
}

async function closePull() {
    closeClientOnly();
    clearReconnectTimer();
    clearIdleCloseTimer();
    currentRequest = null;
    seenPlaybackClient = false;
    pullState = "idle";
    server.resetStreamCache();
    return { state: pullState };
}

function handleWsClientCountChanged(count) {
    if (count > 0) {
        seenPlaybackClient = true;
        clearIdleCloseTimer();
        return;
    }
    if (!currentRequest?.rtmp) return;
    scheduleIdleClose(
        seenPlaybackClient ? "last WS-FLV client disconnected" : "no WS-FLV client connected",
        seenPlaybackClient ? idleCloseMs() : firstClientTimeoutMs(),
    );
}

function startPull() {
    if (!currentRequest?.rtmp) return;
    client = new RtmpPullClient({
        url: currentRequest.rtmp,
        app: currentRequest.app || "",
        playPath: currentRequest.playPath || "",
        pageUrl: currentRequest.pageUrl || "",
        swfUrl: currentRequest.swfUrl || "",
        logger: log,
    });
    client.on("media", (message) => {
        pullState = "pulling";
        server.pushMediaMessage(message);
        mediaCount += 1;
        mediaBytes += message.payload?.byteLength || 0;
        if (mediaCount % 300 === 0) log(`[sidecar] media=${mediaCount}, payload=${formatBytes(mediaBytes)}, clients=${server.clients.size}`);
    });
    client.on("status", (info) => {
        if (info?.code) log(`[rtmp-status] ${info.code}`);
    });
    client.on("error", (err) => {
        pullState = "error";
        log(`[sidecar] RTMP error: ${err.message}`);
        scheduleReconnect();
    });
    client.on("close", () => {
        if (pullState !== "idle") pullState = "closed";
        log("[sidecar] RTMP closed.");
        scheduleReconnect();
    });
    client.start().catch((err) => {
        pullState = "error";
        log(`[sidecar] RTMP start failed: ${err.message}`);
        scheduleReconnect();
    });
}

function scheduleReconnect() {
    if (stopped || args.reconnect === false) return;
    if (reconnectTimer) return;
    closeClientOnly();
    if (!currentRequest?.rtmp) return;
    const delay = Math.max(500, Number(args.reconnectMs || 2000));
    log(`[sidecar] reconnect in ${delay}ms.`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!stopped && currentRequest?.rtmp) {
            pullState = "connecting";
            startPull();
        }
    }, delay);
}

function shutdown() {
    stopped = true;
    clearReconnectTimer();
    clearIdleCloseTimer();
    log("[sidecar] shutting down.");
    closeClientOnly();
    server.stop();
    process.exit(0);
}

function closeClientOnly() {
    if (!client) return;
    const old = client;
    client = null;
    old.removeAllListeners("close");
    old.removeAllListeners("error");
    old.stop();
}

function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
}

function scheduleIdleClose(reason, delayMs) {
    clearIdleCloseTimer();
    const delay = Math.max(0, Math.round(Number(delayMs) || 0));
    idleCloseTimer = setTimeout(() => {
        idleCloseTimer = null;
        if (!currentRequest?.rtmp || server.clients.size > 0) return;
        log(`[sidecar] ${reason}; stopping RTMP pull.`);
        closePull().catch((err) => log(`[sidecar] auto close failed: ${err?.message || String(err)}`));
    }, delay);
}

function clearIdleCloseTimer() {
    if (!idleCloseTimer) return;
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
}

function idleCloseMs() {
    return Math.max(0, Number(args.idleCloseMs ?? 1200));
}

function firstClientTimeoutMs() {
    return Math.max(idleCloseMs(), Number(args.firstClientTimeoutMs ?? 30000));
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            out.help = true;
        } else if (arg.startsWith("--no-")) {
            out[toCamel(arg.slice(5))] = false;
        } else if (arg.startsWith("--")) {
            const raw = arg.slice(2);
            const eq = raw.indexOf("=");
            if (eq >= 0) {
                out[toCamel(raw.slice(0, eq))] = raw.slice(eq + 1);
            } else {
                const key = toCamel(raw);
                const next = argv[i + 1];
                if (!next || next.startsWith("-")) out[key] = true;
                else {
                    out[key] = next;
                    i += 1;
                }
            }
        } else if (/^media-analyzer:\/\//i.test(arg)) {
            Object.assign(out, parseSchemeOpenUrl(arg));
        } else if (/^rtmps?:\/\//i.test(arg) && !out.rtmp) {
            out.rtmp = arg;
        }
    }
    return out;
}

function parseSchemeOpenUrl(urlText) {
    const url = new URL(urlText);
    if (url.protocol !== "media-analyzer:") throw new Error(`Unsupported scheme URL: ${urlText}`);
    const params = url.searchParams;
    const out = {};
    for (const key of ["rtmp", "url", "app", "playPath", "play-path", "pageUrl", "page-url", "swfUrl", "swf-url", "port", "path", "host"]) {
        const value = params.get(key);
        if (value) out[toCamel(key)] = value;
    }
    if (out.url && !out.rtmp) out.rtmp = out.url;
    return out;
}

function buildInitialRequest(input) {
    if (!input.rtmp) return null;
    return normalizeOpenRequest(input);
}

function normalizeOpenRequest(input = {}) {
    const rtmp = String(input.rtmp || input.url || "").trim();
    if (!/^rtmps?:\/\//i.test(rtmp)) throw new Error("Missing rtmp:// or rtmps:// URL.");
    return {
        rtmp,
        app: String(input.app || ""),
        playPath: String(input.playPath || input.playpath || ""),
        pageUrl: String(input.pageUrl || ""),
        swfUrl: String(input.swfUrl || ""),
    };
}

async function forwardOpenToExistingSidecar(request) {
    const base = `http://${server.host}:${server.port}`;
    try {
        const res = await fetch(`${base}/api/open`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
        });
        if (!res.ok) return false;
        const data = await res.json().catch(() => ({}));
        log(`[sidecar] forwarded URL Scheme request to existing service: ${data.wsUrl || server.wsUrl()}`);
        return true;
    } catch {
        return false;
    }
}

function toCamel(value) {
    return String(value).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function formatBytes(value) {
    const n = Number(value) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

function printUsage() {
    console.log(`RTMP -> WS-FLV sidecar

Usage:
  node tools/rtmp-sidecar/server.mjs [--rtmp rtmp://host/app/stream] [options]
  node tools/rtmp-sidecar/server.mjs 'media-analyzer://open?rtmp=rtmp%3A%2F%2Fhost%2Flive%2Fstream'

Options:
  --host 127.0.0.1        Local bind host
  --port 18080            Local HTTP/WebSocket port
  --path /live.flv        WebSocket path
  --app live              Override RTMP app name
  --play-path stream      Override RTMP play path
  --page-url URL          Optional RTMP connect pageUrl
  --swf-url URL           Optional RTMP connect swfUrl
  --audio-only            FLV header advertises audio only
  --video-only            FLV header advertises video only
  --no-reconnect          Disable reconnect loop
  --reconnect-ms 2000     Reconnect delay
  --idle-close-ms 1200    Stop RTMP after last WS-FLV client disconnects
  --first-client-timeout-ms 30000
                          Stop RTMP if no WS-FLV client connects

Output:
  ws://127.0.0.1:18080/live.flv

URL Scheme:
  media-analyzer://open?rtmp=<encoded rtmp url>&port=18080&path=/live.flv
`);
}
