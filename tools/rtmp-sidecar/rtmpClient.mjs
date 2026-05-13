import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";
import { decodeAmf0Values, encodeAmf0Values } from "./amf0.mjs";

export class RtmpPullClient extends EventEmitter {
    constructor({
        url,
        app = "",
        playPath = "",
        pageUrl = "",
        swfUrl = "",
        flashVer = "LNX 9,0,124,2",
        chunkSize = 4096,
        logger = null,
    } = {}) {
        super();
        this.source = parseRtmpUrl(url, { app, playPath });
        this.pageUrl = pageUrl;
        this.swfUrl = swfUrl;
        this.flashVer = flashVer;
        this.outChunkSize = Math.max(128, Math.trunc(Number(chunkSize) || 4096));
        this.inChunkSize = 128;
        this.windowAckSize = 0;
        this.bytesRead = 0;
        this.lastAckBytes = 0;
        this.socket = null;
        this.reader = new RtmpChunkReader();
        this.transactionId = 1;
        this.createStreamTransactionId = 0;
        this.mediaStreamId = 0;
        this.connected = false;
        this.playing = false;
        this.logger = typeof logger === "function" ? logger : null;
    }

    async start() {
        if (this.socket) return;
        const { protocol, host, port } = this.source;
        const socket = protocol === "rtmps:" ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
        this.socket = socket;
        socket.setNoDelay(true);
        socket.on("error", (err) => this.emit("error", err));
        socket.on("close", () => this.emit("close"));
        await onceSocketReady(socket);
        this.log(`connected ${protocol}//${host}:${port}`);
        await this.#handshake();
        socket.on("data", (chunk) => this.#handleSocketData(chunk));
        this.#sendSetChunkSize(this.outChunkSize);
        this.#sendConnect();
    }

    stop() {
        if (!this.socket) return;
        try {
            this.socket.destroy();
        } catch {
            // ignore
        }
        this.socket = null;
    }

    #handleSocketData(chunk) {
        this.bytesRead += chunk.length;
        if (this.windowAckSize > 0 && this.bytesRead - this.lastAckBytes >= this.windowAckSize / 2) {
            this.#sendAcknowledgement(this.bytesRead);
            this.lastAckBytes = this.bytesRead;
        }
        let messages;
        try {
            messages = this.reader.push(chunk);
        } catch (err) {
            this.emit("error", err);
            return;
        }
        for (const message of messages) this.#handleMessage(message);
    }

    async #handshake() {
        const c0c1 = Buffer.alloc(1537);
        c0c1[0] = 3;
        c0c1.writeUInt32BE(Math.floor(Date.now() / 1000), 1);
        c0c1.writeUInt32BE(0, 5);
        randomBytes(1528).copy(c0c1, 9);
        this.socket.write(c0c1);
        const s0s1s2 = await readExactly(this.socket, 3073);
        if (s0s1s2[0] !== 3) throw new Error(`Unsupported RTMP version ${s0s1s2[0]}.`);
        this.socket.write(s0s1s2.subarray(1, 1537));
        this.log("handshake done");
    }

    #handleMessage(message) {
        if (message.typeId === 1 && message.payload.length >= 4) {
            this.inChunkSize = Math.max(1, message.payload.readUInt32BE(0));
            this.reader.chunkSize = this.inChunkSize;
            this.log(`server chunk size ${this.inChunkSize}`);
            return;
        }
        if (message.typeId === 4) {
            this.#handleUserControl(message.payload);
            return;
        }
        if (message.typeId === 5 && message.payload.length >= 4) {
            this.windowAckSize = message.payload.readUInt32BE(0);
            this.log(`window ack size ${this.windowAckSize}`);
            return;
        }
        if (message.typeId === 8 || message.typeId === 9 || message.typeId === 18) {
            this.emit("media", {
                typeId: message.typeId,
                timestampMs: message.timestamp,
                payload: new Uint8Array(message.payload.buffer, message.payload.byteOffset, message.payload.byteLength),
            });
            return;
        }
        if (message.typeId === 22) {
            for (const tag of parseAggregateMessage(message.payload, message.timestamp)) this.emit("media", tag);
            return;
        }
        if (message.typeId === 20 || message.typeId === 17) {
            this.#handleCommand(message);
        }
    }

    #handleCommand(message) {
        const payload = message.typeId === 17 ? message.payload.subarray(1) : message.payload;
        let values;
        try {
            values = decodeAmf0Values(payload);
        } catch (err) {
            this.log(`failed to decode command: ${err.message}`);
            return;
        }
        const command = values[0];
        const transactionId = Number(values[1]) || 0;
        if (command === "_result" && transactionId === 1) {
            this.connected = true;
            this.log("connect accepted");
            this.#sendCreateStream();
            return;
        }
        if (command === "_result" && transactionId === this.createStreamTransactionId) {
            this.mediaStreamId = Math.max(1, Math.trunc(Number(values[3]) || 1));
            this.log(`created stream ${this.mediaStreamId}`);
            this.#sendPlay();
            return;
        }
        if (command === "onStatus") {
            const info = values.find((value) => value && typeof value === "object" && !Array.isArray(value));
            this.log(`status ${info?.code || ""} ${info?.description || ""}`.trim());
            this.emit("status", info || {});
        }
    }

    #handleUserControl(payload) {
        if (payload.length < 2) return;
        const eventType = payload.readUInt16BE(0);
        if (eventType === 6 && payload.length >= 6) {
            const timestamp = payload.readUInt32BE(2);
            const response = Buffer.alloc(6);
            response.writeUInt16BE(7, 0);
            response.writeUInt32BE(timestamp, 2);
            this.#sendMessage({ csid: 2, typeId: 4, streamId: 0, timestamp: 0, payload: response });
        }
    }

    #sendConnect() {
        const { app, tcUrl } = this.source;
        const transactionId = this.transactionId++;
        const payload = encodeAmf0Values([
            "connect",
            transactionId,
            {
                app,
                type: "nonprivate",
                flashVer: this.flashVer,
                tcUrl,
                swfUrl: this.swfUrl || undefined,
                pageUrl: this.pageUrl || undefined,
                fpad: false,
                capabilities: 15,
                audioCodecs: 4071,
                videoCodecs: 252,
                videoFunction: 1,
                objectEncoding: 0,
            },
        ]);
        this.#sendMessage({ csid: 3, typeId: 20, streamId: 0, timestamp: 0, payload });
    }

    #sendCreateStream() {
        this.createStreamTransactionId = this.transactionId++;
        const payload = encodeAmf0Values(["createStream", this.createStreamTransactionId, null]);
        this.#sendMessage({ csid: 3, typeId: 20, streamId: 0, timestamp: 0, payload });
    }

    #sendPlay() {
        const { playPath } = this.source;
        const setBuffer = Buffer.alloc(10);
        setBuffer.writeUInt16BE(3, 0);
        setBuffer.writeUInt32BE(this.mediaStreamId, 2);
        setBuffer.writeUInt32BE(3000, 6);
        this.#sendMessage({ csid: 2, typeId: 4, streamId: 0, timestamp: 0, payload: setBuffer });
        const payload = encodeAmf0Values(["play", 0, null, playPath, -2, -1, true]);
        this.#sendMessage({ csid: 8, typeId: 20, streamId: this.mediaStreamId, timestamp: 0, payload });
        this.playing = true;
        this.log(`play ${playPath}`);
    }

    #sendSetChunkSize(size) {
        const payload = Buffer.alloc(4);
        payload.writeUInt32BE(size >>> 0, 0);
        this.#sendMessage({ csid: 2, typeId: 1, streamId: 0, timestamp: 0, payload });
    }

    #sendAcknowledgement(bytesRead) {
        const payload = Buffer.alloc(4);
        payload.writeUInt32BE(bytesRead >>> 0, 0);
        this.#sendMessage({ csid: 2, typeId: 3, streamId: 0, timestamp: 0, payload });
    }

    #sendMessage({ csid, typeId, streamId, timestamp, payload }) {
        if (!this.socket) return;
        const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        const chunks = [];
        const firstHeader = buildChunkHeader({ fmt: 0, csid, timestamp, messageLength: body.length, typeId, streamId });
        const firstLen = Math.min(this.outChunkSize, body.length);
        chunks.push(firstHeader, body.subarray(0, firstLen));
        let offset = firstLen;
        while (offset < body.length) {
            const nextLen = Math.min(this.outChunkSize, body.length - offset);
            chunks.push(buildBasicHeader(3, csid));
            if (timestamp >= 0xffffff) chunks.push(u32be(timestamp));
            chunks.push(body.subarray(offset, offset + nextLen));
            offset += nextLen;
        }
        this.socket.write(Buffer.concat(chunks));
    }

    log(message) {
        if (this.logger) this.logger(`[rtmp] ${message}`);
    }
}

export class RtmpChunkReader {
    constructor({ chunkSize = 128 } = {}) {
        this.chunkSize = chunkSize;
        this.buffer = Buffer.alloc(0);
        this.headers = new Map();
    }

    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
        const out = [];
        for (;;) {
            const parsed = this.#tryReadChunk();
            if (!parsed) break;
            this.buffer = this.buffer.subarray(parsed.consumed);
            if (parsed.message) out.push(parsed.message);
        }
        return out;
    }

    #tryReadChunk() {
        const basic = readBasicHeader(this.buffer, 0);
        if (!basic) return null;
        const { fmt, csid, size: basicSize } = basic;
        const previous = this.headers.get(csid);
        let offset = basicSize;
        let header;

        if (fmt === 0) {
            if (this.buffer.length < offset + 11) return null;
            const timestampField = readU24(this.buffer, offset);
            const messageLength = readU24(this.buffer, offset + 3);
            const typeId = this.buffer[offset + 6];
            const streamId = this.buffer.readUInt32LE(offset + 7);
            offset += 11;
            const ext = timestampField === 0xffffff;
            if (ext) {
                if (this.buffer.length < offset + 4) return null;
                header = makeHeader(csid, this.buffer.readUInt32BE(offset), 0, messageLength, typeId, streamId, true);
                offset += 4;
            } else {
                header = makeHeader(csid, timestampField, 0, messageLength, typeId, streamId, false);
            }
            this.headers.set(csid, header);
        } else if (fmt === 1) {
            if (!previous) throw new Error(`RTMP fmt=1 chunk without previous header for csid ${csid}.`);
            if (this.buffer.length < offset + 7) return null;
            const deltaField = readU24(this.buffer, offset);
            const messageLength = readU24(this.buffer, offset + 3);
            const typeId = this.buffer[offset + 6];
            offset += 7;
            const ext = deltaField === 0xffffff;
            let delta = deltaField;
            if (ext) {
                if (this.buffer.length < offset + 4) return null;
                delta = this.buffer.readUInt32BE(offset);
                offset += 4;
            }
            header = makeHeader(csid, previous.timestamp + delta, delta, messageLength, typeId, previous.streamId, ext);
            this.headers.set(csid, header);
        } else if (fmt === 2) {
            if (!previous) throw new Error(`RTMP fmt=2 chunk without previous header for csid ${csid}.`);
            if (this.buffer.length < offset + 3) return null;
            const deltaField = readU24(this.buffer, offset);
            offset += 3;
            const ext = deltaField === 0xffffff;
            let delta = deltaField;
            if (ext) {
                if (this.buffer.length < offset + 4) return null;
                delta = this.buffer.readUInt32BE(offset);
                offset += 4;
            }
            header = makeHeader(csid, previous.timestamp + delta, delta, previous.messageLength, previous.typeId, previous.streamId, ext);
            this.headers.set(csid, header);
        } else {
            if (!previous) throw new Error(`RTMP fmt=3 chunk without previous header for csid ${csid}.`);
            const continuing = previous.received > 0 && previous.received < previous.messageLength;
            header = continuing
                ? previous
                : makeHeader(
                    csid,
                    previous.timestamp + (previous.timestampDelta || 0),
                    previous.timestampDelta || 0,
                    previous.messageLength,
                    previous.typeId,
                    previous.streamId,
                    previous.extendedTimestamp,
                );
            if (header.extendedTimestamp) {
                if (this.buffer.length < offset + 4) return null;
                offset += 4;
            }
            this.headers.set(csid, header);
        }

        const remaining = header.messageLength - header.received;
        const payloadSize = Math.min(this.chunkSize, remaining);
        if (this.buffer.length < offset + payloadSize) return null;
        this.buffer.copy(header.payload, header.received, offset, offset + payloadSize);
        header.received += payloadSize;
        offset += payloadSize;

        if (header.received === header.messageLength) {
            const message = {
                timestamp: header.timestamp,
                typeId: header.typeId,
                streamId: header.streamId,
                payload: header.payload,
            };
            header.received = header.messageLength;
            return { consumed: offset, message };
        }
        return { consumed: offset, message: null };
    }
}

export function parseRtmpUrl(input, { app = "", playPath = "" } = {}) {
    const url = new URL(input);
    if (url.protocol !== "rtmp:" && url.protocol !== "rtmps:") throw new Error("RTMP URL must start with rtmp:// or rtmps://.");
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    const resolvedApp = app || parts[0] || "";
    const resolvedPlayPath = playPath || parts.slice(1).join("/");
    if (!resolvedApp || !resolvedPlayPath) {
        throw new Error("RTMP URL must include app and stream path, for example rtmp://host/live/stream.");
    }
    const finalPlayPath = `${resolvedPlayPath}${url.search || ""}`;
    const port = Number(url.port) || (url.protocol === "rtmps:" ? 443 : 1935);
    const tcUrl = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}/${resolvedApp}`;
    return {
        protocol: url.protocol,
        host: url.hostname,
        port,
        app: resolvedApp,
        playPath: finalPlayPath,
        tcUrl,
    };
}

function makeHeader(csid, timestamp, timestampDelta, messageLength, typeId, streamId, extendedTimestamp) {
    return {
        csid,
        timestamp,
        timestampDelta,
        messageLength,
        typeId,
        streamId,
        extendedTimestamp,
        payload: Buffer.alloc(messageLength),
        received: 0,
    };
}

function parseAggregateMessage(payload, fallbackTimestamp) {
    const tags = [];
    let offset = 0;
    while (offset + 11 <= payload.length) {
        const typeId = payload[offset];
        const dataSize = readU24(payload, offset + 1);
        const timestampMs = readU24(payload, offset + 4) + payload[offset + 7] * 0x1000000;
        const bodyStart = offset + 11;
        const bodyEnd = bodyStart + dataSize;
        if (bodyEnd + 4 > payload.length) break;
        if (typeId === 8 || typeId === 9 || typeId === 18) {
            tags.push({
                typeId,
                timestampMs: timestampMs || fallbackTimestamp,
                payload: new Uint8Array(payload.buffer, payload.byteOffset + bodyStart, dataSize),
            });
        }
        offset = bodyEnd + 4;
    }
    return tags;
}

function buildChunkHeader({ fmt, csid, timestamp, messageLength, typeId, streamId }) {
    const timestampField = timestamp >= 0xffffff ? 0xffffff : timestamp;
    const header = Buffer.alloc(11);
    writeU24(header, 0, timestampField);
    writeU24(header, 3, messageLength);
    header[6] = typeId;
    header.writeUInt32LE(streamId >>> 0, 7);
    return Buffer.concat(timestamp >= 0xffffff
        ? [buildBasicHeader(fmt, csid), header, u32be(timestamp)]
        : [buildBasicHeader(fmt, csid), header]);
}

function buildBasicHeader(fmt, csid) {
    if (csid >= 2 && csid <= 63) return Buffer.from([(fmt << 6) | csid]);
    if (csid >= 64 && csid <= 319) return Buffer.from([(fmt << 6), csid - 64]);
    const ext = csid - 64;
    return Buffer.from([(fmt << 6) | 1, ext & 0xff, (ext >>> 8) & 0xff]);
}

function readBasicHeader(buffer, offset) {
    if (buffer.length <= offset) return null;
    const first = buffer[offset];
    const fmt = first >>> 6;
    let csid = first & 0x3f;
    if (csid === 0) {
        if (buffer.length < offset + 2) return null;
        csid = 64 + buffer[offset + 1];
        return { fmt, csid, size: 2 };
    }
    if (csid === 1) {
        if (buffer.length < offset + 3) return null;
        csid = 64 + buffer[offset + 1] + buffer[offset + 2] * 256;
        return { fmt, csid, size: 3 };
    }
    return { fmt, csid, size: 1 };
}

async function readExactly(socket, length) {
    let chunks = [];
    let total = 0;
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            socket.off("data", onData);
            socket.off("error", onError);
            socket.off("close", onClose);
        };
        const onData = (chunk) => {
            chunks.push(chunk);
            total += chunk.length;
            if (total < length) return;
            cleanup();
            const merged = Buffer.concat(chunks, total);
            const wanted = merged.subarray(0, length);
            const rest = merged.subarray(length);
            if (rest.length > 0) socket.unshift(rest);
            resolve(wanted);
        };
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        const onClose = () => {
            cleanup();
            reject(new Error("Socket closed during RTMP handshake."));
        };
        socket.on("data", onData);
        socket.on("error", onError);
        socket.on("close", onClose);
    });
}

function onceSocketReady(socket) {
    if (socket.readyState === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("secureConnect", onConnect);
            socket.off("error", onError);
        };
        const onConnect = () => {
            cleanup();
            resolve();
        };
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        socket.once(socket.encrypted ? "secureConnect" : "connect", onConnect);
        socket.once("error", onError);
    });
}

function readU24(buffer, off) {
    return (buffer[off] << 16) | (buffer[off + 1] << 8) | buffer[off + 2];
}

function writeU24(buffer, off, value) {
    buffer[off] = (value >>> 16) & 0xff;
    buffer[off + 1] = (value >>> 8) & 0xff;
    buffer[off + 2] = value & 0xff;
}

function u32be(value) {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0, 0);
    return out;
}
