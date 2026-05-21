import { createWhisperProvider } from "./whisperProvider.js";

let provider = null;

self.onmessage = async (event) => {
    const { id, type, payload } = event.data || {};
    if (type !== "transcribe") return;
    try {
        provider ||= createWhisperProvider(payload?.providerOptions || {});
        const pcm = new Float32Array(payload.pcm);
        const result = await provider.transcribe(pcm, {
            ...payload.options,
            onProgress: (progress) => {
                self.postMessage({ id, type: "progress", payload: progress });
            },
        });
        self.postMessage({ id, type: "result", payload: result });
    } catch (err) {
        self.postMessage({
            id,
            type: "error",
            error: {
                name: err?.name || "Error",
                message: err?.message || String(err),
            },
        });
    }
};
