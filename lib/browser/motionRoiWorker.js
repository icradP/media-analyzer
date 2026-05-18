import { MotionRoiDetector } from "./motionRoiDetection.js";

let detector = new MotionRoiDetector();

self.onmessage = async (ev) => {
    const msg = ev.data || {};
    try {
        if (msg.type === "configure") {
            detector = new MotionRoiDetector(msg.options || {});
            return;
        }
        if (msg.type === "reset") {
            detector.reset();
            return;
        }
        if (msg.type !== "process") return;
        const frame = msg.frame;
        const result = await detector.processVideoFrame(frame, msg.options || {});
        try {
            frame?.close?.();
        } catch {
            // ignore close errors
        }
        self.postMessage({ type: "result", id: msg.id, ok: true, result });
    } catch (err) {
        try {
            msg.frame?.close?.();
        } catch {
            // ignore close errors
        }
        self.postMessage({
            type: "result",
            id: msg.id,
            ok: false,
            error: err?.message || String(err),
        });
    }
};
