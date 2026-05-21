function formatSrtTime(ms) {
    const totalMs = Math.max(0, Math.round(Number(ms) || 0));
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    const milli = totalMs % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
}

export function writeSrt(track = {}) {
    const cues = Array.isArray(track?.cues) ? track.cues : [];
    const blocks = cues.map((cue, index) => [
        String(index + 1),
        `${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}`,
        String(cue.text || "").trim(),
    ].join("\n"));
    return `${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
}

export const srtWriter = Object.freeze({ writeSrt });
