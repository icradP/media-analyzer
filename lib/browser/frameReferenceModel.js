function isObject(v) {
    return v !== null && typeof v === "object";
}

function codecFamilyFromFrame(frame) {
    const codec = String(frame?._codecFormat || frame?.data?.codecName || "").toLowerCase();
    if (codec.includes("264") || codec.includes("avc")) return "h264";
    if (codec.includes("265") || codec.includes("hevc")) return "h265";
    return null;
}

function collectFrameNalus(frameData) {
    const out = [];
    const pushArr = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const x of arr) if (isObject(x)) out.push(x);
    };
    if (isObject(frameData)) {
        Object.keys(frameData)
            .filter((k) => /^nalu\[\d+\]$/.test(k))
            .sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0))
            .forEach((k) => {
                const n = frameData[k];
                if (isObject(n)) out.push(n);
            });
    }
    pushArr(frameData?.nalus);
    pushArr(frameData?.es?.nalus);
    pushArr(frameData?.pes?.nalus);
    pushArr(frameData?.formatSpecific?.nalus);
    return out;
}

function pickPrimaryVclSlice(codecFamily, nalus) {
    if (codecFamily === "h264") {
        return nalus.find((n) => n._nal_unit_type_value === 1 || n._nal_unit_type_value === 5) || null;
    }
    if (codecFamily === "h265") {
        return (
            nalus.find(
                (n) =>
                    typeof n._nal_unit_type_value === "number" &&
                    n._nal_unit_type_value < 32,
            ) || null
        );
    }
    return null;
}

function frameSortValue(frame) {
    if (typeof frame._pts === "number") return frame._pts;
    if (typeof frame._timestamp === "number") return frame._timestamp;
    return frame.index;
}

function frameDisplayValue(frame) {
    const ptsTime = frame.data?.ptsTime;
    if (typeof ptsTime === "number") return ptsTime * 1000;
    const tsSec = frame.data?.timestampInSeconds;
    if (typeof tsSec === "number") return tsSec * 1000;
    if (typeof frame._pts === "number") return frame._pts;
    if (typeof frame._timestamp === "number") return frame._timestamp;
    return frame.index;
}

function streamIndexFromFrame(frame) {
    return typeof frame.data?.streamIndex === "number" ? frame.data.streamIndex : null;
}

function findDecoderConfigForFrame(frame, mediaInfo) {
    const streamIndex = streamIndexFromFrame(frame);
    const tracksCandidates = [mediaInfo?.mp4?.formatSpecific?.tracks, mediaInfo?.mkv?.formatSpecific?.tracks];
    if (streamIndex !== null) {
        for (const tracks of tracksCandidates) {
            if (!Array.isArray(tracks)) continue;
            const track = tracks.find((t) => t?.index === streamIndex);
            if (!track) continue;
            const codec = String(frame._codecFormat || "").toLowerCase();
            if (codec.includes("264") || codec.includes("avc")) return track.avcC || null;
            if (codec.includes("265") || codec.includes("hevc")) return track.hvcC || null;
        }
    }
    const flvFrames = mediaInfo?.flv?.frames;
    if (Array.isArray(flvFrames)) {
        const seq = flvFrames.find((f) => isObject(f?.formatSpecific?.sequenceHeader));
        if (seq?.formatSpecific?.sequenceHeader) return seq.formatSpecific.sequenceHeader;
    }
    return null;
}

function defaultRefCounts(frame, mediaInfo) {
    const cfg = findDecoderConfigForFrame(frame, mediaInfo);
    if (!cfg) return { l0Count: 1, l1Count: 1 };
    const pps0 = cfg["pps[0]"] || cfg;
    const l0 =
        typeof pps0?.num_ref_idx_l0_default_active_minus1 === "number"
            ? pps0.num_ref_idx_l0_default_active_minus1 + 1
            : 1;
    const l1 =
        typeof pps0?.num_ref_idx_l1_default_active_minus1 === "number"
            ? pps0.num_ref_idx_l1_default_active_minus1 + 1
            : 1;
    return { l0Count: l0, l1Count: l1 };
}

function dedupeRelations(relations) {
    const seen = new Set();
    return relations.filter((r) => {
        const k = `${r.frame.index}:${r.direction}:${r.label}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function nearestByPoc(candidates, centerMeta, direction, targetPoc) {
    const f = candidates.filter((c) =>
        c.frame === centerMeta.frame || c.poc === null || c.decodeIndex >= centerMeta.decodeIndex
            ? false
            : direction === "past"
                ? c.poc < targetPoc + 0.5
                : c.poc > targetPoc - 0.5,
    );
    if (!f.length) return null;
    return f.sort((a, b) => {
        const d = Math.abs(a.poc - targetPoc) - Math.abs(b.poc - targetPoc);
        if (d !== 0) return d;
        return (
            Math.abs(a.sortValue - centerMeta.sortValue) -
            Math.abs(b.sortValue - centerMeta.sortValue)
        );
    })[0];
}

export function buildFrameMetaForReference(frame, decodeIndex) {
    const family = codecFamilyFromFrame(frame);
    const nalus = collectFrameNalus(frame.data);
    const slice = pickPrimaryVclSlice(family, nalus);
    const pictureType = typeof frame._pictureType === "string" ? frame._pictureType : null;
    const frameNum = typeof slice?.frame_num === "number" ? slice.frame_num : null;
    let poc = null;
    if (family === "h264") {
        if (typeof slice?.pic_order_cnt_lsb === "number") poc = slice.pic_order_cnt_lsb;
        else if (frameNum !== null) poc = frameNum;
    } else if (family === "h265") {
        if (typeof slice?.slice_pic_order_cnt_lsb === "number") poc = slice.slice_pic_order_cnt_lsb;
        else if (slice?._nal_unit_type_value === 19 || slice?._nal_unit_type_value === 20) poc = 0;
    }
    let isRef = !!slice && pictureType !== "B";
    if (family === "h264" && typeof slice?.nal_ref_idc === "number") isRef = slice.nal_ref_idc > 0;
    if (slice?._nal_unit_type_value === 5 || slice?._nal_unit_type_value === 19 || slice?._nal_unit_type_value === 20) {
        isRef = true;
    }
    return {
        frame,
        codecFamily: family,
        sliceNalu: slice,
        pictureType,
        poc,
        frameNum,
        sortValue: frameSortValue(frame),
        displayValue: frameDisplayValue(frame),
        decodeIndex,
        isReferenceCandidate: isRef,
    };
}

function fallbackReferenceRelations(frame, pageFrames) {
    if (frame._mediaType !== "video") return [];
    const idx = pageFrames.findIndex((x) => x === frame);
    if (idx === -1) return [];
    const nearestPastNonB = [...pageFrames.slice(0, idx)]
        .reverse()
        .find((f) => f._mediaType === "video" && f._pictureType !== "B");
    if (frame._pictureType === "P") {
        return nearestPastNonB ? [{ frame: nearestPastNonB, direction: "past", label: "L0" }] : [];
    }
    if (frame._pictureType === "B") {
        const cands = [...pageFrames.slice(0, idx)]
            .reverse()
            .filter((f) => f._mediaType === "video" && f._pictureType !== "B");
        const past = cands.find((f) =>
            typeof f._pts !== "number" || typeof frame._pts !== "number" ? true : f._pts <= frame._pts,
        );
        const future = cands.find((f) =>
            typeof f._pts !== "number" || typeof frame._pts !== "number" ? false : f._pts > frame._pts,
        );
        return dedupeRelations([
            ...(past ? [{ frame: past, direction: "past", label: "L0" }] : []),
            ...(future ? [{ frame: future, direction: "future", label: "L1" }] : []),
        ]);
    }
    return [];
}

function genericReferenceSearch(center, metas, l0Count, l1Count) {
    const refs = metas.filter(
        (m) =>
            !(
                m.frame === center.frame ||
                !m.isReferenceCandidate ||
                m.codecFamily !== center.codecFamily ||
                m.decodeIndex >= center.decodeIndex
            ),
    );
    const hasPoc = center.poc !== null && refs.some((m) => m.poc !== null);
    const past = refs
        .filter((m) => !hasPoc || m.poc === null || m.poc < center.poc)
        .sort((a, b) =>
            hasPoc && a.poc !== null && b.poc !== null ? b.poc - a.poc : b.decodeIndex - a.decodeIndex,
        );
    const future = refs
        .filter((m) => !hasPoc || m.poc === null || m.poc > center.poc)
        .sort((a, b) =>
            hasPoc && a.poc !== null && b.poc !== null ? a.poc - b.poc : b.decodeIndex - a.decodeIndex,
        );
    return dedupeRelations([
        ...past.slice(0, l0Count).map((m, i) => ({
            frame: m.frame,
            direction: "past",
            label: l0Count > 1 ? `L0-${i}` : "L0",
        })),
        ...future.slice(0, l1Count).map((m, i) => ({
            frame: m.frame,
            direction: "future",
            label: l1Count > 1 ? `L1-${i}` : "L1",
        })),
    ]);
}

function h264Relations(center, metas, mediaInfo) {
    const sliceType = Number(center.sliceNalu?._slice_type_value ?? 2) % 5;
    if (sliceType === 2 || sliceType === 4) return [];
    const defaults = defaultRefCounts(center.frame, mediaInfo);
    const l0Count =
        typeof center.sliceNalu?.num_ref_idx_l0_active_minus1 === "number"
            ? center.sliceNalu.num_ref_idx_l0_active_minus1 + 1
            : defaults.l0Count;
    const l1Count =
        sliceType === 1
            ? typeof center.sliceNalu?.num_ref_idx_l1_active_minus1 === "number"
                ? center.sliceNalu.num_ref_idx_l1_active_minus1 + 1
                : defaults.l1Count
            : 0;
    const refs = metas.filter(
        (m) =>
            m.frame !== center.frame &&
            m.codecFamily === center.codecFamily &&
            m.isReferenceCandidate &&
            m.decodeIndex < center.decodeIndex,
    );
    if (sliceType === 0 || sliceType === 3) {
        return refs
            .sort((a, b) => b.decodeIndex - a.decodeIndex)
            .slice(0, l0Count)
            .map((m, i) => ({
                frame: m.frame,
                direction: "past",
                label: l0Count > 1 ? `L0-${i}` : "L0",
            }));
    }
    if (sliceType === 1) {
        const past = refs
            .filter((m) => m.displayValue <= center.displayValue)
            .sort((a, b) => b.displayValue - a.displayValue);
        const future = refs
            .filter((m) => m.displayValue > center.displayValue)
            .sort((a, b) => a.displayValue - b.displayValue);
        return dedupeRelations([
            ...past.slice(0, l0Count).map((m, i) => ({
                frame: m.frame,
                direction: "past",
                label: l0Count > 1 ? `L0-${i}` : "L0",
            })),
            ...future.slice(0, l1Count).map((m, i) => ({
                frame: m.frame,
                direction: "future",
                label: l1Count > 1 ? `L1-${i}` : "L1",
            })),
        ]);
    }
    return genericReferenceSearch(center, metas, l0Count, l1Count);
}

function h265Relations(center, metas) {
    const poc = center.poc;
    if (poc === null) return genericReferenceSearch(center, metas, 1, center.pictureType === "B" ? 1 : 0);
    const refs = [];
    const neg = Number(center.sliceNalu?.num_negative_pics ?? 0);
    const pos = Number(center.sliceNalu?.num_positive_pics ?? 0);
    let accNeg = 0;
    for (let i = 0; i < neg; i++) {
        const d = center.sliceNalu?.[`delta_poc_s0_minus1[${i}]`];
        const used = center.sliceNalu?.[`used_by_curr_pic_s0_flag[${i}]`];
        if (typeof d !== "number") continue;
        accNeg += d + 1;
        if (used === 0) continue;
        const hit = nearestByPoc(metas, center, "past", poc - accNeg);
        if (hit) refs.push({ frame: hit.frame, direction: "past", label: neg > 1 ? `L0-${i}` : "L0" });
    }
    let accPos = 0;
    for (let i = 0; i < pos; i++) {
        const d = center.sliceNalu?.[`delta_poc_s1_minus1[${i}]`];
        const used = center.sliceNalu?.[`used_by_curr_pic_s1_flag[${i}]`];
        if (typeof d !== "number") continue;
        accPos += d + 1;
        if (used === 0) continue;
        const hit = nearestByPoc(metas, center, "future", poc + accPos);
        if (hit) refs.push({ frame: hit.frame, direction: "future", label: pos > 1 ? `L1-${i}` : "L1" });
    }
    return refs.length ? dedupeRelations(refs) : genericReferenceSearch(center, metas, 1, center.pictureType === "B" ? 1 : 0);
}

export function buildFrameReferenceRelations(targetFrame, pageFrames, mediaInfo = {}) {
    if (!targetFrame || targetFrame._mediaType !== "video") return { status: "none", relations: [] };
    if (targetFrame._pictureType === "I") return { status: "none", relations: [] };
    const idx = pageFrames.findIndex((f) => f === targetFrame);
    if (idx === -1) return { status: "unavailable", relations: [] };
    const center = buildFrameMetaForReference(targetFrame, idx);
    const metas = pageFrames
        .map((f, i) => ({ frame: f, index: i }))
        .filter((x) => x.frame._mediaType === "video")
        .map((x) => buildFrameMetaForReference(x.frame, x.index));
    let relations = [];
    if (center.codecFamily === "h264" && center.sliceNalu) {
        relations = h264Relations(center, metas, mediaInfo);
    } else if (center.codecFamily === "h265" && center.sliceNalu) {
        relations = h265Relations(center, metas);
    }
    if (!relations.length) relations = fallbackReferenceRelations(targetFrame, pageFrames);
    return relations.length ? { status: "resolved", relations } : { status: "unavailable", relations: [] };
}

export const frameReferenceModelCodec = Object.freeze({
    buildFrameMetaForReference,
    buildFrameReferenceRelations,
});
