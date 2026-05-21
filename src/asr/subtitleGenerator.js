export function normalizeSubtitleCue(input = {}, index = 0) {
    const startMs = Math.max(0, Math.round(Number(input.startMs) || 0));
    const rawEnd = Math.round(Number(input.endMs));
    const endMs = Number.isFinite(rawEnd) && rawEnd > startMs ? rawEnd : startMs + 1000;
    return {
        id: input.id != null ? String(input.id) : `cue-${index + 1}`,
        startMs,
        endMs,
        text: String(input.text || "").replace(/\s+/g, " ").trim(),
        confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : undefined,
    };
}

export function segmentsToSubtitleTrack(segments = [], options = {}) {
    const offsetMs = Number(options.offsetMs) || 0;
    const language = options.language || undefined;
    const cues = [];
    for (const segment of Array.isArray(segments) ? segments : []) {
        const text = String(segment?.text || "").trim();
        if (!text) continue;
        cues.push(normalizeSubtitleCue({
            ...segment,
            startMs: offsetMs + (Number(segment.startMs) || 0),
            endMs: offsetMs + (Number(segment.endMs) || 0),
        }, cues.length));
    }
    return { language, cues };
}

export function mergeSubtitleTracks(tracks = [], options = {}) {
    const language = options.language || tracks.find((track) => track?.language)?.language;
    const cues = [];
    for (const track of Array.isArray(tracks) ? tracks : []) {
        for (const cue of Array.isArray(track?.cues) ? track.cues : []) {
            if (String(cue.text || "").trim()) cues.push(normalizeSubtitleCue(cue, cues.length));
        }
    }
    cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    return {
        language,
        cues: cues.map((cue, index) => ({ ...cue, id: cue.id || `cue-${index + 1}` })),
    };
}

export function whisperOutputToSegments(output, options = {}) {
    const durationMs = Math.max(0, Number(options.durationMs) || 0);
    const chunks = Array.isArray(output?.chunks) ? output.chunks : [];
    if (chunks.length) {
        return chunks.map((chunk, index) => {
            const ts = Array.isArray(chunk.timestamp) ? chunk.timestamp : [];
            const start = Number(ts[0]);
            const end = Number(ts[1]);
            return {
                startMs: Number.isFinite(start) ? start * 1000 : 0,
                endMs: Number.isFinite(end) ? end * 1000 : durationMs,
                text: String(chunk.text || "").trim(),
                confidence: Number.isFinite(Number(chunk.confidence)) ? Number(chunk.confidence) : undefined,
            };
        });
    }
    const text = String(output?.text || "").trim();
    return text ? [{ startMs: 0, endMs: durationMs || 1000, text }] : [];
}

export const subtitleGenerator = Object.freeze({
    normalizeSubtitleCue,
    segmentsToSubtitleTrack,
    mergeSubtitleTracks,
    whisperOutputToSegments,
});
