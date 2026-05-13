import { createHash } from "node:crypto";
import http from "node:http";
import {
    FLV_TAG_TYPE_AUDIO,
    FLV_TAG_TYPE_SCRIPT,
    FLV_TAG_TYPE_VIDEO,
    buildFlvHeader,
    buildFlvTag,
} from "../../lib/codec/flvTagWriter.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WsFlvServer {
    constructor({
        host = "127.0.0.1",
        port = 18080,
        path = "/live.flv",
        hasAudio = true,
        hasVideo = true,
        control = null,
        logger = null,
    } = {}) {
        this.host = host;
        this.port = Number(port) || 18080;
        this.path = path.startsWith("/") ? path : `/${path}`;
        this.header = buildFlvHeader({ hasAudio, hasVideo });
        this.control = control;
        this.logger = typeof logger === "function" ? logger : null;
        this.server = null;
        this.clients = new Set();
        this.lastScriptTag = null;
        this.lastAudioConfigTag = null;
        this.lastVideoConfigTag = null;
        this.tagCount = 0;
        this.byteCount = 0;
    }

    async start() {
        if (this.server) return;
        this.server = http.createServer((req, res) => {
            this.#handleHttp(req, res).catch((err) => {
                this.#sendJson(res, 500, { ok: false, error: err?.message || String(err) });
            });
        });
        this.server.on("upgrade", (req, socket) => this.#handleUpgrade(req, socket));
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.port, this.host, () => {
                this.server.off("error", reject);
                resolve();
            });
        });
        this.log(`listening ws://${this.host}:${this.port}${this.path}`);
    }

    stop() {
        for (const client of this.clients) {
            try {
                client.socket.destroy();
            } catch {
                // ignore
            }
        }
        this.clients.clear();
        if (this.server) {
            try {
                this.server.close();
            } catch {
                // ignore
            }
        }
        this.server = null;
    }

    pushMediaMessage({ typeId, timestampMs = 0, payload }) {
        if (!(payload instanceof Uint8Array) || payload.length <= 0) return;
        const tagType = rtmpTypeToFlvTagType(typeId);
        if (!tagType) return;
        const tag = buildFlvTag({ tagType, timestampMs, payload });
        this.#cacheTag(tagType, payload, tag);
        this.#broadcast(tag);
        this.tagCount += 1;
        this.byteCount += tag.length;
    }

    resetStreamCache() {
        this.lastScriptTag = null;
        this.lastAudioConfigTag = null;
        this.lastVideoConfigTag = null;
        this.tagCount = 0;
        this.byteCount = 0;
    }

    wsUrl() {
        return `ws://${this.host}:${this.port}${this.path}`;
    }

    async #handleHttp(req, res) {
        const url = new URL(req.url || "/", `http://${req.headers.host || `${this.host}:${this.port}`}`);
        if (req.method === "OPTIONS") {
            this.#sendCors(res, 204);
            return;
        }
        if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/status")) {
            const extra = this.control?.status ? await this.control.status() : {};
            this.#sendJson(res, 200, {
                ok: true,
                clients: this.clients.size,
                tags: this.tagCount,
                bytes: this.byteCount,
                wsPath: this.path,
                wsUrl: this.wsUrl(),
                ...extra,
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/open" && this.control?.open) {
            const body = await readJsonBody(req);
            const result = await this.control.open(body);
            this.#sendJson(res, 200, { ok: true, wsUrl: this.wsUrl(), ...result });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/close" && this.control?.close) {
            const result = await this.control.close();
            this.#sendJson(res, 200, { ok: true, ...result });
            return;
        }
        this.#sendText(res, 404, "not found\n");
    }

    #handleUpgrade(req, socket) {
        const url = new URL(req.url || "/", `http://${req.headers.host || `${this.host}:${this.port}`}`);
        if (url.pathname !== this.path) {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
        }
        const key = req.headers["sec-websocket-key"];
        if (!key) {
            socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            socket.destroy();
            return;
        }
        const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
        socket.write([
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "\r\n",
        ].join("\r\n"));
        const client = { socket };
        this.clients.add(client);
        this.#notifyClientCount();
        socket.on("close", () => this.#removeClient(client));
        socket.on("error", () => this.#removeClient(client));
        socket.on("data", (data) => this.#handleClientFrame(client, data));
        this.#send(client, this.header);
        if (this.lastScriptTag) this.#send(client, this.lastScriptTag);
        if (this.lastAudioConfigTag) this.#send(client, this.lastAudioConfigTag);
        if (this.lastVideoConfigTag) this.#send(client, this.lastVideoConfigTag);
        this.log(`client connected (${this.clients.size})`);
    }

    #handleClientFrame(client, data) {
        if (!data || data.length < 2) return;
        const opcode = data[0] & 0x0f;
        if (opcode === 0x8) {
            this.#removeClient(client);
            try {
                client.socket.end();
            } catch {
                // ignore
            }
        } else if (opcode === 0x9) {
            this.#sendFrame(client, 0x0a, Buffer.alloc(0));
        }
    }

    #cacheTag(tagType, payload, tag) {
        if (tagType === FLV_TAG_TYPE_SCRIPT) {
            this.lastScriptTag = tag;
        } else if (tagType === FLV_TAG_TYPE_AUDIO && isAudioConfigPayload(payload)) {
            this.lastAudioConfigTag = tag;
        } else if (tagType === FLV_TAG_TYPE_VIDEO && isVideoConfigPayload(payload)) {
            this.lastVideoConfigTag = tag;
        }
    }

    #broadcast(bytes) {
        for (const client of this.clients) this.#send(client, bytes);
    }

    #removeClient(client) {
        if (!this.clients.delete(client)) return;
        this.log(`client disconnected (${this.clients.size})`);
        this.#notifyClientCount();
    }

    #notifyClientCount() {
        if (this.control?.clientsChanged) this.control.clientsChanged(this.clients.size);
    }

    #send(client, bytes) {
        this.#sendFrame(client, 0x02, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    }

    #sendFrame(client, opcode, payload) {
        if (!client.socket || client.socket.destroyed) return;
        const header = buildWsFrameHeader(opcode, payload.length);
        client.socket.write(Buffer.concat([header, payload]));
    }

    log(message) {
        if (this.logger) this.logger(`[ws-flv] ${message}`);
    }

    #sendJson(res, status, value) {
        this.#writeCorsHeaders(res, status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
    }

    #sendText(res, status, text) {
        this.#writeCorsHeaders(res, status, { "content-type": "text/plain; charset=utf-8" });
        res.end(text);
    }

    #sendCors(res, status) {
        this.#writeCorsHeaders(res, status);
        res.end();
    }

    #writeCorsHeaders(res, status, headers = {}) {
        res.writeHead(status, {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "content-type",
            "access-control-max-age": "86400",
            ...headers,
        });
    }
}

function rtmpTypeToFlvTagType(typeId) {
    if (typeId === 8) return FLV_TAG_TYPE_AUDIO;
    if (typeId === 9) return FLV_TAG_TYPE_VIDEO;
    if (typeId === 18) return FLV_TAG_TYPE_SCRIPT;
    return 0;
}

function isAudioConfigPayload(payload) {
    if (payload.length < 2) return false;
    return (payload[0] >>> 4) === 10 && payload[1] === 0;
}

function isVideoConfigPayload(payload) {
    if (payload.length < 2) return false;
    if (payload[0] & 0x80) return (payload[0] & 0x0f) === 0;
    const codecId = payload[0] & 0x0f;
    return (codecId === 7 || codecId === 12) && payload[1] === 0;
}

function buildWsFrameHeader(opcode, length) {
    if (length < 126) return Buffer.from([0x80 | opcode, length]);
    if (length <= 0xffff) {
        const out = Buffer.alloc(4);
        out[0] = 0x80 | opcode;
        out[1] = 126;
        out.writeUInt16BE(length, 2);
        return out;
    }
    const out = Buffer.alloc(10);
    out[0] = 0x80 | opcode;
    out[1] = 127;
    out.writeUInt32BE(Math.floor(length / 0x100000000), 2);
    out.writeUInt32BE(length >>> 0, 6);
    return out;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > 1024 * 1024) {
                reject(new Error("Request body too large."));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("error", reject);
        req.on("end", () => {
            if (chunks.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (err) {
                reject(new Error(`Invalid JSON body: ${err.message}`));
            }
        });
    });
}
