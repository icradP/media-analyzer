import { buildVideoDecodePlan, decodeVideoFramesToCanvas } from "./framePlayback.js";

const tinyState = {
    worker: null,
    readyPromise: null,
    ready: false,
    failed: false,
    hasDecodedPicture: false,
    renderStateId: `tiny-default-${Math.floor(Math.random() * 1e9)}`,
};

function toHex2(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.max(0, Math.min(255, n)).toString(16).toUpperCase().padStart(2, "0");
}

function asU8(v) {
    if (!v) return null;
    if (v instanceof Uint8Array) return v;
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (Array.isArray(v)) return Uint8Array.from(v);
    return null;
}

function avcCodecFromSps(vStream) {
    const sps0 = asU8(vStream?.decoderConfig?.sps?.[0]);
    if (!(sps0 instanceof Uint8Array) || sps0.length < 4) return null;
    const profileIdc = toHex2(sps0[1]);
    const profileCompat = toHex2(sps0[2]);
    const levelIdc = toHex2(sps0[3]);
    if (!profileIdc || !profileCompat || !levelIdc) return null;
    return `avc1.${profileIdc}${profileCompat}${levelIdc}`;
}

export function codecCandidatesForStream(vStream) {
    const name = String(vStream?.codecName || "").toLowerCase();
    const cands = [];
    const push = (x) => {
        if (x && !cands.includes(x)) cands.push(x);
    };
    const profileHex = toHex2(vStream?.profile);
    const levelHex = toHex2(vStream?.level);
    if (name.includes("264") || name.includes("avc") || name === "avc1" || name === "avc3") {
        push(avcCodecFromSps(vStream));
        if (profileHex && levelHex) {
            push(`avc1.${profileHex}00${levelHex}`);
            push(`avc1.${profileHex}${levelHex}`);
        }
        push("avc1.64001F");
        push("avc1.4D401F");
        push("avc1.42001E");
    }
    if (name.includes("265") || name.includes("hevc") || name === "hvc1" || name === "hev1") {
        push("hvc1.1.6.L93.B0");
        push("hev1.1.6.L93.B0");
        push("hvc1.1.6.L120.B0");
        push("hev1.1.6.L120.B0");
    }
    return cands;
}

export async function resolveVideoDecoderCodecForStream(vStream) {
    const cands = codecCandidatesForStream(vStream);
    if (!cands.length) return null;
    if (typeof VideoDecoder === "undefined" || typeof VideoDecoder.isConfigSupported !== "function") {
        return cands[0];
    }
    for (const codec of cands) {
        try {
            const check = await VideoDecoder.isConfigSupported({ codec });
            if (check?.supported) return codec;
        } catch {
            // try next candidate
        }
    }
    return cands[0];
}

function codecRetryCandidates(codecString, plan = null) {
    const out = [];
    const push = (v) => {
        if (v && !out.includes(v)) out.push(v);
    };
    const s = String(codecString || "");
    if (plan?.codecFamily === "h264") {
        push(s);
        return out;
    }
    push(s);
    if (s.startsWith("avc1.")) push(`avc3.${s.slice(5)}`);
    if (s.startsWith("avc3.")) push(`avc1.${s.slice(5)}`);
    if (s === "avc1" || s === "avc3") {
        push("avc1.42C029");
        push("avc3.42C029");
    }
    return out;
}

function detectAvccLengthSize(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 5) return 4;
    for (const n of [4, 2, 1, 3]) {
        let off = 0;
        let ok = false;
        while (off + n <= bytes.length) {
            let len = 0;
            for (let i = 0; i < n; i++) len = (len << 8) | bytes[off + i];
            off += n;
            if (len <= 0 || off + len > bytes.length) {
                ok = false;
                break;
            }
            off += len;
            ok = true;
            if (off === bytes.length) return n;
        }
        if (ok && off === bytes.length) return n;
    }
    return 4;
}

function splitAvccNalus(bytes, lengthSize = 4) {
    const out = [];
    if (!(bytes instanceof Uint8Array) || bytes.length <= lengthSize) return out;
    let off = 0;
    while (off + lengthSize <= bytes.length) {
        let len = 0;
        for (let i = 0; i < lengthSize; i++) len = (len << 8) | bytes[off + i];
        off += lengthSize;
        if (len <= 0 || off + len > bytes.length) return [];
        out.push(bytes.subarray(off, off + len));
        off += len;
    }
    if (off !== bytes.length) return [];
    return out;
}

function joinAvccNalus(nalus, lengthSize = 4) {
    const arr = Array.isArray(nalus) ? nalus.filter((n) => n instanceof Uint8Array && n.length > 0) : [];
    const total = arr.reduce((s, n) => s + lengthSize + n.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const nalu of arr) {
        let len = nalu.length;
        for (let i = lengthSize - 1; i >= 0; i--) {
            out[off + i] = len & 0xff;
            len >>>= 8;
        }
        off += lengthSize;
        out.set(nalu, off);
        off += nalu.length;
    }
    return out;
}

function h264NalType(nalu) {
    if (!(nalu instanceof Uint8Array) || nalu.length < 1) return -1;
    return nalu[0] & 0x1f;
}

function cloneEncodedFrames(frames) {
    return (Array.isArray(frames) ? frames : []).map((f) => ({
        type: f?.type === "key" ? "key" : "delta",
        data: f?.data instanceof Uint8Array ? f.data.slice(0) : new Uint8Array(0),
    }));
}

function describeBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) {
        return {
            length: 0,
            bytes: [],
            hex: [],
        };
    }
    return {
        length: bytes.length,
        bytes: Array.from(bytes),
        hex: Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")),
    };
}

export function buildVideoDecodeAttempts(plan, codecFamily = plan?.codecFamily || null) {
    const base = cloneEncodedFrames(plan?.encodedFrames);
    const meta = Array.isArray(plan?.encodedFrameMeta) ? plan.encodedFrameMeta : null;
    const isAvcBitstream = codecFamily === "h264" && plan?.bitstreamFormat === "avc";
    const attempts = [];
    const addAttempt = (name, frames, description, frameMeta = meta) => {
        attempts.push({
            name,
            encodedFrames: cloneEncodedFrames(frames),
            frameMeta,
            description,
        });
    };
    if (codecFamily === "h264" && plan?.bitstreamFormat === "annexb") {
        addAttempt("reference-chain-annexb", base, null);
    } else {
        addAttempt("reference-chain", base, plan?.description || null);
    }
    if (codecFamily !== "h264" || !base.length) return attempts;
    if (!isAvcBitstream) return attempts;
    const targetIsFirstFrame =
        Number(plan?.targetFrameIndex) === Number(plan?.encodedFrameMeta?.[0]?.frameIndex);
    const first = base[0]?.data;
    const lengthSize = detectAvccLengthSize(first);
    const withoutAud = cloneEncodedFrames(base).map((f) => {
        const nalus = splitAvccNalus(f.data, lengthSize);
        if (!nalus.length) return f;
        const kept = nalus.filter((n) => h264NalType(n) !== 9);
        if (!kept.length) return f;
        return { ...f, data: joinAvccNalus(kept, lengthSize) };
    });
    addAttempt("reference-chain-drop-aud", withoutAud, plan?.description || null);
    const firstNalus = splitAvccNalus(first, lengthSize);
    if (firstNalus.length && targetIsFirstFrame) {
        const sps = firstNalus.find((n) => h264NalType(n) === 7) || null;
        const pps = firstNalus.find((n) => h264NalType(n) === 8) || null;
        const idr = firstNalus.find((n) => h264NalType(n) === 5) || null;
        const idrOnly = idr ? joinAvccNalus([idr], lengthSize) : null;
        const inband = sps && pps && idr ? joinAvccNalus([sps, pps, idr], lengthSize) : null;
        if (idrOnly && isAvcBitstream) addAttempt("idr-only", [{ type: "key", data: idrOnly }], plan?.description || null, meta?.slice(0, 1) || null);
        if (inband) {
            addAttempt("inband-sps-pps-idr", [{ type: "key", data: inband }], plan?.description || null, meta?.slice(0, 1) || null);
        }
    }
    return attempts;
}

export async function decodeVideoFrameWithStrategies({
    mediaInfo,
    targetFrameIndex,
    stream,
    canvas,
}) {
    const plan = buildVideoDecodePlan({ mediaInfo, targetFrameIndex });
    const codecString = await resolveVideoDecoderCodecForStream(stream);
    if (!codecString) throw new Error(`Unsupported codecName for WebCodecs: ${stream?.codecName || "unknown"}`);
    const attempts = buildVideoDecodeAttempts(plan, plan?.codecFamily || null);
    const codecTries = codecRetryCandidates(codecString, plan);
    const attemptResults = [];
    let lastErr = null;
    for (const codecTry of codecTries) {
        for (const at of attempts) {
            try {
                await decodeVideoFramesToCanvas({
                    encodedFrames: at.encodedFrames,
                    frameMeta: at.frameMeta || plan.encodedFrameMeta || null,
                    codecString: codecTry,
                    description: at.description,
                    canvas,
                    targetFrameIndex: plan.targetFrameIndex ?? targetFrameIndex,
                });
                return {
                    ok: true,
                    strategy: at.name,
                    codec: codecTry,
                    plan,
                    attempts: attemptResults,
                    codecRetryCandidates: codecTries,
                };
            } catch (err) {
                lastErr = err;
                attemptResults.push({
                    strategy: at.name,
                    codec: codecTry,
                    ok: false,
                    message: err?.message || String(err),
                    diagnostics: err?.diagnostics || null,
                });
            }
        }
    }
    if (lastErr) {
        const diagnostics = lastErr?.diagnostics || {};
        const chunk = diagnostics?.chunk || null;
        lastErr.diagnostics = {
            ...diagnostics,
            decodePlan: {
                codecString,
                codecRetryCandidates: codecTries,
                descriptionLength: plan.description ? plan.description.length : 0,
                decodeWindowStartFrameIndex: plan.decodeWindowStartFrameIndex,
                decodeWindowEndFrameIndex: plan.decodeWindowEndFrameIndex,
                targetFrameIndex: plan.targetFrameIndex ?? targetFrameIndex,
                hasAnnexBInput: plan.hasAnnexBInput ?? null,
                hasAnnexBOutput: plan.hasAnnexBOutput ?? null,
                bitstreamFormat: plan.bitstreamFormat ?? null,
                hasParameterSetsInSamples: plan.hasParameterSetsInSamples ?? null,
                description: describeBytes(plan.description),
                encodedFrames: plan.encodedFrames.length,
                firstChunkType: plan.encodedFrames[0]?.type || null,
                firstChunkSize: plan.encodedFrames[0]?.data?.length || 0,
                errorChunk: chunk,
            },
            attempts: attemptResults,
        };
        throw lastErr;
    }
    throw new Error("Video decode failed without explicit error.");
}

function onceEvent(target, eventName, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting ${eventName}`));
        }, timeoutMs);
        const onDone = () => {
            cleanup();
            resolve();
        };
        const onErr = () => {
            cleanup();
            reject(new Error(`Error waiting ${eventName}`));
        };
        const cleanup = () => {
            clearTimeout(timer);
            target.removeEventListener(eventName, onDone);
            target.removeEventListener("error", onErr);
        };
        target.addEventListener(eventName, onDone, { once: true });
        target.addEventListener("error", onErr, { once: true });
    });
}

function hasBoxType(bytes, type4) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 12 || typeof type4 !== "string" || type4.length !== 4) return false;
    const a = type4.charCodeAt(0) & 0xff;
    const b = type4.charCodeAt(1) & 0xff;
    const c = type4.charCodeAt(2) & 0xff;
    const d = type4.charCodeAt(3) & 0xff;
    for (let i = 4; i + 3 < bytes.length; i++) {
        if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) return true;
    }
    return false;
}

function avccToAnnexB(avccBytes) {
    if (!(avccBytes instanceof Uint8Array) || avccBytes.length < 4) return avccBytes;
    let off = 0;
    const nalus = [];
    while (off + 4 <= avccBytes.length) {
        const len =
            ((avccBytes[off] << 24) >>> 0) |
            (avccBytes[off + 1] << 16) |
            (avccBytes[off + 2] << 8) |
            avccBytes[off + 3];
        off += 4;
        if (len <= 0 || off + len > avccBytes.length) break;
        nalus.push(avccBytes.subarray(off, off + len));
        off += len;
    }
    if (!nalus.length) return avccBytes;
    const total = nalus.reduce((s, n) => s + 4 + n.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const n of nalus) {
        out[p++] = 0;
        out[p++] = 0;
        out[p++] = 0;
        out[p++] = 1;
        out.set(n, p);
        p += n.length;
    }
    return out;
}

function drawYuv420ToCanvas(yuv, width, height, canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable.");
    canvas.width = width;
    canvas.height = height;
    const image = ctx.createImageData(width, height);
    const ySize = width * height;
    const uvWidth = width >> 1;
    const uvHeight = height >> 1;
    const uOffset = ySize;
    const vOffset = ySize + uvWidth * uvHeight;
    for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
            const y = yuv[j * width + i];
            const u = yuv[uOffset + ((j >> 1) * uvWidth + (i >> 1))];
            const v = yuv[vOffset + ((j >> 1) * uvWidth + (i >> 1))];
            const c = y - 16;
            const d = u - 128;
            const e = v - 128;
            let r = (298 * c + 409 * e + 128) >> 8;
            let g = (298 * c - 100 * d - 208 * e + 128) >> 8;
            let b = (298 * c + 516 * d + 128) >> 8;
            if (r < 0) r = 0;
            else if (r > 255) r = 255;
            if (g < 0) g = 0;
            else if (g > 255) g = 255;
            if (b < 0) b = 0;
            else if (b > 255) b = 255;
            const p = (j * width + i) * 4;
            image.data[p] = r;
            image.data[p + 1] = g;
            image.data[p + 2] = b;
            image.data[p + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
}

async function decodeGopByTinyH264Fallback({
    targetFrame,
    allFrames,
    mediaInfo,
    canvas,
    onStatus,
}) {
    const t0 = performance.now();
    console.info("[tinyh264] fallback start", {
        targetFrameIndex: targetFrame?.index ?? null,
        mediaKeys: Object.keys(mediaInfo || {}),
    });
    const plan = buildVideoDecodePlan({
        mediaInfo,
        targetFrameIndex: targetFrame.index,
    });
    const encoded = Array.isArray(plan?.encodedFrames) ? plan.encodedFrames : [];
    if (!encoded.length) throw new Error("No encoded GOP frames for tinyh264.");
    console.info("[tinyh264] decode plan", {
        decodeWindowStartFrameIndex: plan?.decodeWindowStartFrameIndex ?? null,
        decodeWindowEndFrameIndex: plan?.decodeWindowEndFrameIndex ?? null,
        targetFrameIndex: plan?.targetFrameIndex ?? targetFrame?.index ?? null,
        encodedFrames: encoded.length,
    });
    const worker = await ensureTinyH264WorkerReady();
    const renderStateId = `${tinyState.renderStateId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    tinyState.hasDecodedPicture = false;
    console.info("[tinyh264] worker ready", { renderStateId });
    let lastPicture = null;
    let workerDecodeError = null;
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const onPicture = (e) => {
        const m = e?.data || {};
        if (m.type !== "pictureReady" || m.renderStateId !== renderStateId) return;
        tinyState.hasDecodedPicture = true;
        lastPicture = {
            width: m.width,
            height: m.height,
            data: new Uint8Array(m.data),
        };
        console.debug("[tinyh264] pictureReady", {
            width: m.width,
            height: m.height,
            bytes: m?.data?.byteLength || 0,
        });
    };
    const onWorkerError = (ev) => {
        workerDecodeError = new Error(
            `tinyh264 worker decode error: ${ev?.message || "unknown"} @ ${ev?.filename || "unknown"}:${ev?.lineno || 0}:${ev?.colno || 0}`
        );
    };
    worker.addEventListener("message", onPicture);
    worker.addEventListener("error", onWorkerError);
    try {
        for (let i = 0; i < encoded.length; i++) {
            const item = encoded[i];
            const au = avccToAnnexB(item?.data);
            console.debug("[tinyh264] decode AU", {
                index: i,
                chunkType: item?.type || "delta",
                avccSize: item?.data?.length || 0,
                annexbSize: au?.length || 0,
            });
            const postData = au.slice(0);
            worker.postMessage(
                {
                    type: "decode",
                    renderStateId,
                    data: postData.buffer,
                    offset: postData.byteOffset,
                    length: postData.byteLength,
                },
                [postData.buffer]
            );
            if (workerDecodeError) throw workerDecodeError;
            // Yield to worker so early pictures can surface while we keep feeding.
            await pause(i === 0 ? 12 : 2);
        }
        const isSingleFrame = encoded.length <= 1;
        const waitBudgetMs = tinyState.hasDecodedPicture
            ? Math.min(4000, Math.max(isSingleFrame ? 300 : 600, encoded.length * 24))
            : Math.min(8000, Math.max(isSingleFrame ? 220 : 1200, encoded.length * 40));
        let deadline = performance.now() + waitBudgetMs;
        while (!lastPicture && performance.now() < deadline) {
            if (workerDecodeError) throw workerDecodeError;
            await pause(10);
        }
        if (!lastPicture) {
            // Cold-start + single-keyframe inputs may emit late; do one in-place retry before failing.
            console.warn("[tinyh264] no picture after first pass, replaying GOP once", {
                encodedFrames: encoded.length,
                waitBudgetMs,
            });
            for (let i = 0; i < encoded.length; i++) {
                const item = encoded[i];
                const au = avccToAnnexB(item?.data);
                const postData = au.slice(0);
                worker.postMessage(
                    {
                        type: "decode",
                        renderStateId,
                        data: postData.buffer,
                        offset: postData.byteOffset,
                        length: postData.byteLength,
                    },
                    [postData.buffer]
                );
                if (workerDecodeError) throw workerDecodeError;
                await pause(isSingleFrame ? 1 : 4);
            }
            deadline = performance.now() + (isSingleFrame ? 900 : 2500);
            while (!lastPicture && performance.now() < deadline) {
                if (workerDecodeError) throw workerDecodeError;
                await pause(10);
            }
        }
    } finally {
        worker.removeEventListener("message", onPicture);
        worker.removeEventListener("error", onWorkerError);
        try {
            worker.postMessage({ type: "release", renderStateId });
        } catch {
            // ignore release post errors
        }
    }
    if (!lastPicture) throw new Error("tinyh264 produced no picture.");
    drawYuv420ToCanvas(lastPicture.data, lastPicture.width, lastPicture.height, canvas);
    const elapsedMs = Math.round(performance.now() - t0);
    console.info("[tinyh264] fallback done", {
        targetFrameIndex: targetFrame?.index ?? null,
        width: lastPicture.width,
        height: lastPicture.height,
        elapsedMs,
    });
    if (typeof onStatus === "function") onStatus(`tinyh264 fallback done @ frame ${targetFrame.index} (${elapsedMs}ms).`);
    return { mode: "tinyh264", width: lastPicture.width, height: lastPicture.height };
}

export async function ensureTinyH264WorkerReady() {
    if (tinyState.ready && tinyState.worker) return tinyState.worker;
    if (tinyState.failed) throw new Error("tinyh264 worker is in failed state.");
    if (!tinyState.readyPromise) {
        tinyState.readyPromise = new Promise((resolve, reject) => {
            const worker = new Worker(new URL("./tinyh264WorkerEntry.js", import.meta.url), { type: "module" });
            const timer = setTimeout(() => {
                tinyState.failed = true;
                reject(new Error("tinyh264 worker ready timeout"));
            }, 8000);
            const onMsg = (e) => {
                if (e?.data?.type === "decoderReady") {
                    clearTimeout(timer);
                    worker.removeEventListener("message", onMsg);
                    tinyState.worker = worker;
                    tinyState.ready = true;
                    tinyState.failed = false;
                    resolve(worker);
                    return;
                }
                if (e?.data?.type === "tinyh264WorkerInitError") {
                    clearTimeout(timer);
                    worker.removeEventListener("message", onMsg);
                    tinyState.failed = true;
                    const initErr = new Error(`tinyh264 init error: ${e?.data?.message || "unknown"}`);
                    initErr.cause = e?.data || null;
                    reject(initErr);
                }
            };
            worker.addEventListener("message", onMsg);
            worker.addEventListener(
                "error",
                (ev) => {
                    clearTimeout(timer);
                    tinyState.failed = true;
                    const err = new Error(
                        `tinyh264 worker error: ${ev?.message || "unknown"} @ ${ev?.filename || "unknown"}:${ev?.lineno || 0}:${ev?.colno || 0}`
                    );
                    err.cause = {
                        message: ev?.message || null,
                        filename: ev?.filename || null,
                        lineno: ev?.lineno || null,
                        colno: ev?.colno || null,
                        error: ev?.error || null,
                    };
                    reject(err);
                },
                { once: true }
            );
        });
    }
    try {
        return await tinyState.readyPromise;
    } catch (err) {
        tinyState.readyPromise = null;
        throw err;
    }
}

export function releaseTinyH264Worker() {
    if (tinyState.worker) {
        try {
            tinyState.worker.postMessage({ type: "release", renderStateId: tinyState.renderStateId });
        } catch {
            // ignore release post errors
        }
        try {
            tinyState.worker.terminate();
        } catch {
            // ignore terminate errors
        }
    }
    tinyState.worker = null;
    tinyState.readyPromise = null;
    tinyState.ready = false;
    tinyState.failed = false;
    tinyState.hasDecodedPicture = false;
}

function buildMseMp4Mime(result, videoCodec) {
    if (!videoCodec) return null;
    const streams = Array.isArray(result?.streams) ? result.streams : [];
    const audio = streams.find((s) => s.codecType === "audio");
    const aName = String(audio?.codecName || "").toLowerCase();
    const codecs = [videoCodec];
    if (aName.includes("aac") || aName.includes("mp4a")) {
        const ot = Number.isFinite(audio?.profile) ? Math.max(1, Number(audio.profile)) : 2;
        codecs.push(`mp4a.40.${ot}`);
    }
    return `video/mp4; codecs="${codecs.join(",")}"`;
}

function framePtsSec(f) {
    const rf = f?._rawFrame || {};
    if (typeof rf.ptsTime === "number" && Number.isFinite(rf.ptsTime)) return rf.ptsTime;
    if (typeof rf.dtsTime === "number" && Number.isFinite(rf.dtsTime)) return rf.dtsTime;
    const tick = rf.pts ?? rf.dts ?? rf.timestamp;
    if (typeof tick === "number" && Number.isFinite(tick)) return tick / 1000;
    return null;
}

function findGopRangeByFrame(targetFrame, allFrames) {
    const vids = (allFrames || [])
        .filter((f) => f._mediaType === "video")
        .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
    const pos = vids.findIndex((f) => f.index === targetFrame.index);
    if (pos < 0) return null;
    let start = pos;
    while (start > 0 && !vids[start]._isKeyFrame) start -= 1;
    let end = pos;
    let p = pos + 1;
    while (p < vids.length && !vids[p]._isKeyFrame) p += 1;
    end = p < vids.length ? p - 1 : vids.length - 1;
    return { startFrame: vids[start], endFrame: vids[end], targetFrame };
}

async function playRangeToCanvas({
    video,
    canvas,
    startSec,
    endSec,
    targetSec,
    gop,
    onStatus,
    modeLabel,
}) {
    video.currentTime = Math.max(0, startSec);
    await onceEvent(video, "seeked", 10000);
    if (!video.videoWidth) await onceEvent(video, "loadeddata", 10000);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable.");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    await video.play();
    if (typeof onStatus === "function") {
        onStatus(`${modeLabel}: GOP ${gop.startFrame.index}-${gop.endFrame.index} @ ${startSec.toFixed(3)}-${endSec.toFixed(3)}s`);
    }
    await new Promise((resolve) => {
        const tick = () => {
            try {
                ctx.drawImage(video, 0, 0);
            } catch {
                // ignore draw failure
            }
            if (video.currentTime >= endSec) {
                video.pause();
                video.currentTime = Math.max(0, targetSec);
                video.addEventListener(
                    "seeked",
                    () => {
                        try {
                            ctx.drawImage(video, 0, 0);
                        } catch {
                            // ignore final draw
                        }
                        resolve();
                    },
                    { once: true }
                );
                return;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
}

export async function decodeGopByMseFallback({
    targetFrame,
    allFrames,
    result,
    fileBytes,
    canvas,
    mseVideoElement,
    onStatus,
}) {
    if (!targetFrame || targetFrame._mediaType !== "video") throw new Error("tinyh264 fallback requires selected video frame.");
    try {
        return await decodeGopByTinyH264Fallback({
            targetFrame,
            allFrames,
            mediaInfo: { [result?.format?.formatName || "mp4"]: result },
            canvas,
            onStatus,
        });
    } catch (tinyErr) {
        console.error("[tinyh264] fallback failed", tinyErr);
        if (typeof onStatus === "function") onStatus(`tinyh264 fallback failed: ${tinyErr?.message || String(tinyErr)}`);
        throw tinyErr;
    }
}

export const videoDecodeOrchestratorCodec = Object.freeze({
    codecCandidatesForStream,
    resolveVideoDecoderCodecForStream,
    buildVideoDecodeAttempts,
    decodeVideoFrameWithStrategies,
    decodeGopByMseFallback,
    ensureTinyH264WorkerReady,
    releaseTinyH264Worker,
});
