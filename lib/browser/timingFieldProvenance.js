/**
 * Links demo timing/FPS/bitrate metrics to concrete frame & bitstream fields.
 */

const ROLE_META = Object.freeze({
    interval: { badge: "Δt", title: "帧间隔图 / 实测 FPS" },
    dts: { badge: "DTS", title: "解码时间戳 (FLV tag timestamp)" },
    pts: { badge: "PTS", title: "显示时间戳 (DTS + compositionTime)" },
    "frame-time": { badge: "t", title: "getFrameTimeSec() 主时间轴" },
    "sps-fps": { badge: "FPS", title: "SPS/VUI timing_info 推导帧率" },
    duration: { badge: "T", title: "文件时长 / 平均码率分母" },
    bitrate: { badge: "br", title: "按秒聚合码率" },
    "av-sync": { badge: "A-V", title: "音视频时间差图" },
    metadata: { badge: "meta", title: "onMetaData / stream 元数据" },
});

const FIELD_TIMING_RULES = [
    { match: /^(timestampFull|timestamp|timestampExtended)$/, roles: ["interval", "dts", "frame-time", "duration", "bitrate"] },
    { match: /^compositionTime$/, roles: ["pts", "frame-time"] },
    { match: /(^|\.)timing_info_present_flag$/, roles: ["sps-fps"] },
    { match: /(num_units_in_tick|time_scale|fixed_frame_rate_flag|calculated_frame_rate)/, roles: ["sps-fps"] },
    { match: /(vui_num_units_in_tick|vui_time_scale|vps_num_units_in_tick|vps_time_scale)/, roles: ["sps-fps"] },
    { match: /^avgFrameRate$/, roles: ["sps-fps", "metadata"] },
    { match: /^(pts|dts)$/, roles: ["frame-time"] },
    { match: /^(ptsTime|dtsTime)$/, roles: ["frame-time", "interval"] },
];

function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function median(values) {
    const arr = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!arr.length) return null;
    return arr[Math.floor(arr.length / 2)];
}

export function matchFieldTimingRoles(fieldPath) {
    const path = String(fieldPath || "");
    const roles = new Set();
    for (const rule of FIELD_TIMING_RULES) {
        if (rule.match.test(path)) {
            for (const r of rule.roles) roles.add(r);
        }
    }
    return Array.from(roles);
}

export function timingRoleBadges(roles) {
    return (Array.isArray(roles) ? roles : [])
        .map((id) => ROLE_META[id])
        .filter(Boolean)
        .map((m) => `<span class="timing-role" title="${m.title}">${m.badge}</span>`)
        .join("");
}

/**
 * How demo `getFrameTimeSec` resolves time for one frame.
 */
export function resolveFrameTimeProvenance(frameLike) {
    const rf = frameLike?._rawFrame || frameLike || {};
    if (typeof rf.ptsTime === "number" && Number.isFinite(rf.ptsTime)) {
        const fs = rf.formatSpecific || {};
        const usesComp = fs.tagType === 9 || fs.tagTypeName === "Video";
        return {
            sec: rf.ptsTime,
            primary: "frame.ptsTime",
            chain: usesComp
                ? ["formatSpecific.timestampFull", "formatSpecific.compositionTime", "→ pts/1000"]
                : ["formatSpecific.timestampFull", "→ pts/1000"],
            fieldPaths: usesComp
                ? ["timestampFull", "timestamp", "compositionTime"]
                : ["timestampFull", "timestamp"],
        };
    }
    if (typeof rf.dtsTime === "number" && Number.isFinite(rf.dtsTime)) {
        return {
            sec: rf.dtsTime,
            primary: "frame.dtsTime",
            chain: ["formatSpecific.timestampFull", "→ dts/1000"],
            fieldPaths: ["timestampFull", "timestamp"],
        };
    }
    const tick = rf.pts ?? rf.dts ?? rf.timestamp;
    if (typeof tick === "number" && Number.isFinite(tick)) {
        const key = rf.pts != null ? "frame.pts" : rf.dts != null ? "frame.dts" : "frame.timestamp";
        return {
            sec: tick / 1000,
            primary: key,
            chain: [`${key}`, "÷ 1000"],
            fieldPaths: [],
        };
    }
    return { sec: null, primary: null, chain: [], fieldPaths: [] };
}

export function estimateFpsFromFrameIntervals(frames, getFrameTimeSec) {
    const intervalsMs = [];
    const arr = Array.isArray(frames) ? frames : [];
    for (let i = 1; i < arr.length; i++) {
        const t0 = getFrameTimeSec(arr[i - 1]);
        const t1 = getFrameTimeSec(arr[i]);
        if (typeof t0 !== "number" || typeof t1 !== "number") continue;
        const dt = (t1 - t0) * 1000;
        if (dt > 0) intervalsMs.push(dt);
    }
    const med = median(intervalsMs);
    const fps = med != null && med > 0 ? 1000 / med : null;
    return {
        fps,
        medianIntervalMs: med,
        sampleCount: intervalsMs.length,
        formula: "FPS ≈ 1000 / median(Δt_ms), Δt from consecutive frame ptsTime",
        sourceFields: ["ptsTime", "timestampFull", "compositionTime"],
    };
}

function pickVideoStream(result) {
    const streams = Array.isArray(result?.streams) ? result.streams : [];
    return streams.find((s) => s.codecType === "video") || null;
}

export function resolveStreamFrameRateProvenance(result) {
    const stream = pickVideoStream(result);
    if (!stream) return null;
    const fps = stream.frameRate;
    if (fps == null) return null;
    const src = stream._sources?.frameRate || "unknown";
    const hints = {
        metadata: { label: "onMetaData.framerate", fieldPaths: [] },
        sps: { label: "SPS VUI timing_info", fieldPaths: ["num_units_in_tick", "time_scale", "calculated_frame_rate"] },
        calculated: { label: "frameCount / duration", fieldPaths: ["timestampFull"] },
    };
    const hint = hints[src] || { label: String(src), fieldPaths: [] };
    return {
        fps,
        source: src,
        label: hint.label,
        fieldPaths: hint.fieldPaths,
    };
}

/**
 * @param {{ result?: object, frames?: object[], getFrameTimeSec?: (f: object) => number|null, mediaType?: string }} opts
 */
export function buildTimingAnalytics(opts = {}) {
    const result = opts.result || null;
    const frames = Array.isArray(opts.frames) ? opts.frames : [];
    const getFrameTimeSec = typeof opts.getFrameTimeSec === "function" ? opts.getFrameTimeSec : () => null;
    const mediaFilter = opts.mediaType || null;

    const videoFrames = frames.filter((f) => (f._mediaType || f.mediaType) === "video");
    const audioFrames = frames.filter((f) => (f._mediaType || f.mediaType) === "audio");
    const intervalTarget = mediaFilter === "audio" ? audioFrames : videoFrames;

    const intervalFps = estimateFpsFromFrameIntervals(intervalTarget, getFrameTimeSec);
    const streamFps = resolveStreamFrameRateProvenance(result);

    const times = frames.map(getFrameTimeSec).filter((v) => typeof v === "number");
    const durationSec = times.length >= 2 ? Math.max(0, Math.max(...times) - Math.min(...times)) : 0;

    const highlightFieldPaths = new Set([
        ...intervalFps.sourceFields,
        ...(streamFps?.fieldPaths || []),
        "timestampFull",
        "timestamp",
        "compositionTime",
        "num_units_in_tick",
        "time_scale",
        "calculated_frame_rate",
    ]);

    const formatName = String(result?.format?.formatName || "").toLowerCase();

    return {
        formatName,
        intervalFps,
        streamFps,
        durationSec,
        frameTimeProvenance: resolveFrameTimeProvenance(intervalTarget[0] || frames[0]),
        highlightFieldPaths,
        summaryLines: buildTimingSummaryLines({ intervalFps, streamFps, durationSec, formatName }),
    };
}

function buildTimingSummaryLines({ intervalFps, streamFps, durationSec, formatName }) {
    const lines = [];
    if (intervalFps.fps != null) {
        lines.push(
            `实测 FPS≈${intervalFps.fps.toFixed(2)} (${intervalFps.medianIntervalMs?.toFixed(1)}ms/帧, n=${intervalFps.sampleCount}) ← Δ(ptsTime) ← timestampFull${formatName === "flv" ? " + compositionTime" : ""}`,
        );
    }
    if (streamFps) {
        lines.push(`流 frameRate=${streamFps.fps} (来源: ${streamFps.source} / ${streamFps.label})`);
    }
    if (durationSec > 0) {
        lines.push(`时长 ${durationSec.toFixed(3)}s ← min/max(ptsTime); 码率图按 floor(ptsTime) 分桶`);
    }
    return lines;
}

export function annotateFieldRowsWithTiming(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => {
        const timingRoles = matchFieldTimingRoles(row.field);
        return timingRoles.length ? { ...row, timingRoles } : row;
    });
}

export const timingFieldProvenanceCodec = Object.freeze({
    matchFieldTimingRoles,
    timingRoleBadges,
    resolveFrameTimeProvenance,
    estimateFpsFromFrameIntervals,
    resolveStreamFrameRateProvenance,
    buildTimingAnalytics,
    annotateFieldRowsWithTiming,
});
