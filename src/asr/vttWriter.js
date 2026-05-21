export function formatVttTime(ms) {
    const totalMs = Math.max(0, Math.round(Number(ms) || 0));
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    const milli = totalMs % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

export function writeWebVtt(track = {}, options = {}) {
    const cues = Array.isArray(track?.cues) ? track.cues : [];
    const lines = ["WEBVTT"];
    if (track.language) lines.push(`Language: ${track.language}`);
    if (options.note) lines.push(`NOTE ${String(options.note)}`);
    lines.push("");
    cues.forEach((cue, index) => {
        if (cue.id) lines.push(String(cue.id));
        lines.push(`${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}`);
        lines.push(String(cue.text || "").trim());
        lines.push("");
    });
    return lines.join("\n");
}

export const vttWriter = Object.freeze({ formatVttTime, writeWebVtt });
