import { tokenizeTranscript, tokensToText } from "./transcriptStabilizer.js";

const DEFAULT_MERGE_OPTIONS = Object.freeze({
    overlapTimeToleranceMs: 250,
    textSimilarityThreshold: 0.68,
    maxMergeGapMs: 1200,
    preferLongerText: true,
    preferHigherConfidence: true,
    language: "auto",
    commitDelayMs: 2500,
});

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/u;
const FILLER_ZH_RE = /[嗯呃额啊哦]{1,}/gu;
const FILLER_EN = new Set(["um", "uh", "erm", "hmm"]);

export class TranscriptMerger {
    constructor(options = {}) {
        this.options = normalizeMergeOptions(options);
        this.segments = [];
        this.decisions = [];
        this.windowCount = 0;
    }

    reset() {
        this.segments = [];
        this.decisions = [];
        this.windowCount = 0;
    }

    mergeWindowResult(windowResult, options = {}) {
        const result = mergeAsrWindowResults(this.segments, windowResult, {
            ...this.options,
            ...options,
        });
        this.segments = result.segments;
        this.decisions = result.decisions;
        this.windowCount += 1;
        return result;
    }

    flush() {
        this.segments = this.segments.map((segment) => ({ ...segment, status: "final", stable: true }));
        return {
            segments: this.segments.slice(),
            stableSegments: this.segments.slice(),
            unstablePartialSegments: [],
            decisions: [],
            mergedCount: 0,
            dedupedCount: 0,
        };
    }

    advanceWindow(windowEndMs) {
        const stableBoundaryMs = Math.max(0, Number(windowEndMs) || 0) - this.options.commitDelayMs;
        this.segments = this.segments.map((segment) => {
            const stable = segment.status === "final" || segment.stable || segment.endMs <= stableBoundaryMs;
            return {
                ...segment,
                status: stable ? (segment.status === "final" ? "final" : "stable") : "partial",
                stable,
            };
        });
        return {
            segments: this.segments.slice(),
            stableSegments: this.getStableSegments(),
            unstablePartialSegments: this.getPartialSegments(),
            decisions: [],
            mergedCount: 0,
            dedupedCount: 0,
        };
    }

    getStableSegments() {
        return this.segments.filter((segment) => segment.status === "stable" || segment.status === "final");
    }

    getPartialSegments() {
        return this.segments.filter((segment) => segment.status === "partial");
    }
}

export function normalizeTranscript(text = "", language = "auto") {
    const lang = resolveLanguage(text, language);
    const raw = String(text || "").normalize("NFKC").trim();
    if (!raw) return "";
    if (lang === "zh") {
        return raw
            .replace(FILLER_ZH_RE, "")
            .replace(/[\s,.;:!?，。！？；：、"'“”‘’()[\]{}<>《》…-]+/gu, "")
            .toLowerCase();
    }
    return raw
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}\s']/gu, " ")
        .split(/\s+/u)
        .filter((token) => token && !FILLER_EN.has(token))
        .join(" ");
}

export function textSimilarity(a = "", b = "", language = "auto") {
    const lang = resolveLanguage(`${a} ${b}`, language);
    const aTokens = similarityTokens(a, lang);
    const bTokens = similarityTokens(b, lang);
    if (!aTokens.length || !bTokens.length) return 0;
    if (tokensEqual(aTokens, bTokens)) return 1;
    const lcs = lcsLength(aTokens, bTokens);
    const dice = (2 * lcs) / (aTokens.length + bTokens.length);
    const setScore = jaccardSimilarity(aTokens, bTokens);
    const overlap = findCommonTextOverlap(a, b, lang);
    return Math.max(dice, setScore, overlap.score);
}

export function mergeOverlappingText(a = "", b = "", language = "auto") {
    const lang = resolveLanguage(`${a} ${b}`, language);
    const aTokens = tokenizeTranscript(String(a || ""));
    const bTokens = tokenizeTranscript(String(b || ""));
    if (!aTokens.length) return String(b || "").trim();
    if (!bTokens.length) return String(a || "").trim();
    const normA = normalizeTranscript(a, lang);
    const normB = normalizeTranscript(b, lang);
    if (normA && normA === normB) return chooseMoreCompleteText(a, b, { preferLongerText: true });
    if (normA && normB.includes(normA)) return String(b || "").trim();
    if (normB && normA.includes(normB)) return String(a || "").trim();
    const overlap = findTokenSuffixPrefixOverlap(aTokens, bTokens);
    if (overlap.count > 0) {
        return tokensToText(aTokens.concat(bTokens.slice(overlap.count)));
    }
    const reverseOverlap = findTokenSuffixPrefixOverlap(bTokens, aTokens);
    if (reverseOverlap.count > 0) {
        return tokensToText(bTokens.concat(aTokens.slice(reverseOverlap.count)));
    }
    return chooseMoreCompleteText(a, b, { preferLongerText: true });
}

export function collapseRepeatedTranscript(text = "", language = "auto") {
    const lang = resolveLanguage(text, language);
    const tokens = tokenizeTranscript(String(text || ""));
    if (tokens.length < 4) return String(text || "").replace(/\s+/g, " ").trim();
    const maxBlock = Math.min(lang === "zh" ? 12 : 8, Math.floor(tokens.length / 2));
    const minBlock = lang === "zh" ? 2 : 1;
    const out = [];
    for (let i = 0; i < tokens.length;) {
        let best = null;
        for (let blockLen = maxBlock; blockLen >= minBlock; blockLen--) {
            if (i + blockLen * 2 > tokens.length) continue;
            const block = tokens.slice(i, i + blockLen);
            if (block.every((token) => token.kind === "punct")) continue;
            let repeats = 1;
            while (i + blockLen * (repeats + 1) <= tokens.length
                && tokenBlockEquals(block, tokens.slice(i + blockLen * repeats, i + blockLen * (repeats + 1)))) {
                repeats += 1;
            }
            if (repeats >= 2) {
                best = { blockLen, repeats };
                break;
            }
        }
        if (best) {
            out.push(...tokens.slice(i, i + best.blockLen));
            i += best.blockLen * best.repeats;
        } else {
            out.push(tokens[i]);
            i += 1;
        }
    }
    return tokensToText(out);
}

export function mergeAsrWindowResults(existing = [], incoming, options = {}) {
    const opts = normalizeMergeOptions(options);
    const incomingSegments = normalizeIncomingSegments(incoming, opts);
    const merged = (Array.isArray(existing) ? existing : [])
        .filter((segment) => String(segment?.text || "").trim())
        .map((segment) => normalizeSegment(segment, opts));
    const decisions = [];
    let mergedCount = 0;
    let dedupedCount = 0;

    for (const segment of incomingSegments) {
        const candidate = findMergeCandidate(merged, segment, opts);
        if (candidate) {
            const prev = merged[candidate.index];
            const nextText = pickMergedText(prev, segment, opts);
            const unchanged = normalizeTranscript(prev.text, opts.language) === normalizeTranscript(nextText, opts.language);
            merged[candidate.index] = {
                ...prev,
                startMs: Math.min(prev.startMs, segment.startMs),
                endMs: Math.max(prev.endMs, segment.endMs),
                text: nextText,
                confidence: chooseConfidence(prev.confidence, segment.confidence),
                sourceWindowId: segment.sourceWindowId || prev.sourceWindowId,
                lastWindowEndMs: Math.max(prev.lastWindowEndMs || 0, segment.lastWindowEndMs || 0),
            };
            mergedCount += 1;
            if (unchanged) dedupedCount += 1;
            decisions.push({
                action: unchanged ? "dedupe" : "merge",
                reason: candidate.reason,
                similarity: candidate.similarity,
                overlapMs: candidate.overlapMs,
                oldText: prev.text,
                newText: segment.text,
                mergedText: nextText,
                windowId: segment.sourceWindowId,
            });
        } else {
            merged.push(segment);
            decisions.push({
                action: "append",
                reason: "no-time-text-candidate",
                similarity: 0,
                overlapMs: 0,
                newText: segment.text,
                windowId: segment.sourceWindowId,
            });
        }
    }

    merged.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const windowEndMs = Math.max(0, Number(incoming?.windowEndMs) || Math.max(0, ...incomingSegments.map((segment) => segment.endMs)));
    const stableBoundaryMs = Number.isFinite(windowEndMs) ? windowEndMs - opts.commitDelayMs : Infinity;
    const segments = merged.map((segment) => {
        const stable = segment.status === "final" || segment.stable || segment.endMs <= stableBoundaryMs;
        return {
            ...segment,
            status: stable ? (segment.status === "final" ? "final" : "stable") : "partial",
            stable,
        };
    });

    return {
        segments,
        stableSegments: segments.filter((segment) => segment.status === "stable" || segment.status === "final"),
        unstablePartialSegments: segments.filter((segment) => segment.status === "partial"),
        decisions,
        mergedCount,
        dedupedCount,
    };
}

function normalizeMergeOptions(options = {}) {
    return {
        overlapTimeToleranceMs: clampNumber(options.overlapTimeToleranceMs, 0, 10000, DEFAULT_MERGE_OPTIONS.overlapTimeToleranceMs),
        textSimilarityThreshold: clampNumber(options.textSimilarityThreshold, 0.1, 1, DEFAULT_MERGE_OPTIONS.textSimilarityThreshold),
        maxMergeGapMs: clampNumber(options.maxMergeGapMs, 0, 10000, DEFAULT_MERGE_OPTIONS.maxMergeGapMs),
        preferLongerText: options.preferLongerText !== false,
        preferHigherConfidence: options.preferHigherConfidence !== false,
        language: ["zh", "en", "auto"].includes(options.language) ? options.language : DEFAULT_MERGE_OPTIONS.language,
        commitDelayMs: clampNumber(options.commitDelayMs, 0, 10000, DEFAULT_MERGE_OPTIONS.commitDelayMs),
    };
}

function normalizeIncomingSegments(incoming = {}, opts) {
    const windowStartMs = Math.max(0, Number(incoming.windowStartMs) || 0);
    const windowEndMs = Math.max(windowStartMs + 1, Number(incoming.windowEndMs) || windowStartMs + 1000);
    const rawSegments = Array.isArray(incoming.segments) && incoming.segments.length
        ? incoming.segments
        : [{ startMs: windowStartMs, endMs: windowEndMs, text: incoming.text, confidence: incoming.confidence }];
    return rawSegments
        .map((segment) => normalizeWindowSegment(segment, incoming, windowStartMs, windowEndMs, opts))
        .filter((segment) => String(segment.text || "").trim());
}

function normalizeWindowSegment(segment, incoming, windowStartMs, windowEndMs, opts) {
    const rawStart = Number(segment?.startMs);
    const rawEnd = Number(segment?.endMs);
    const relMax = Math.max(1000, windowEndMs - windowStartMs + 1000);
    const isRelative = windowStartMs > 0 && Number.isFinite(rawStart) && rawStart >= 0 && rawStart < relMax && rawStart < windowStartMs - 1;
    const startMs = isRelative ? windowStartMs + rawStart : (Number.isFinite(rawStart) ? rawStart : windowStartMs);
    const endMs = isRelative ? windowStartMs + rawEnd : (Number.isFinite(rawEnd) ? rawEnd : windowEndMs);
    return normalizeSegment({
        startMs,
        endMs,
        text: segment?.text || incoming.text || "",
        confidence: Number.isFinite(Number(segment?.confidence)) ? Number(segment.confidence) : incoming.confidence,
        sourceWindowId: incoming.windowId,
        lastWindowEndMs: windowEndMs,
    }, opts);
}

function normalizeSegment(segment, opts) {
    const startMs = Math.max(0, Math.round(Number(segment?.startMs) || 0));
    const rawEndMs = Math.round(Number(segment?.endMs));
    const text = collapseRepeatedTranscript(String(segment?.text || "").replace(/\s+/g, " ").trim(), opts.language);
    return {
        ...segment,
        startMs,
        endMs: Number.isFinite(rawEndMs) && rawEndMs > startMs ? rawEndMs : startMs + 1000,
        text,
        confidence: Number.isFinite(Number(segment?.confidence)) ? Number(segment.confidence) : undefined,
        normalizedText: normalizeTranscript(text, opts.language),
    };
}

function findMergeCandidate(segments, incoming, opts) {
    let best = null;
    for (let i = 0; i < segments.length; i++) {
        const existing = segments[i];
        const overlapMs = timeOverlapMs(existing, incoming);
        const gapMs = timeGapMs(existing, incoming);
        const timeCandidate = overlapMs >= opts.overlapTimeToleranceMs || gapMs <= opts.maxMergeGapMs;
        if (!timeCandidate) continue;
        const similarity = textSimilarity(existing.text, incoming.text, opts.language);
        const commonOverlap = findCommonTextOverlap(existing.text, incoming.text, opts.language);
        const contains = textContains(existing.text, incoming.text, opts.language) || textContains(incoming.text, existing.text, opts.language);
        const enoughOverlap = commonOverlap.count >= minCommonOverlapTokens(existing.text, incoming.text, opts.language);
        if (!contains && similarity < opts.textSimilarityThreshold && !enoughOverlap) continue;
        const score = similarity + Math.min(1, overlapMs / 2000) + (enoughOverlap ? 0.35 : 0) + (contains ? 0.25 : 0);
        if (!best || score > best.score) {
            best = {
                index: i,
                score,
                similarity,
                overlapMs,
                reason: contains ? "text-contained" : (enoughOverlap ? "common-overlap" : "similar-overlap"),
            };
        }
    }
    return best;
}

function pickMergedText(existing, incoming, opts) {
    const overlapped = mergeOverlappingText(existing.text, incoming.text, opts.language);
    const normalizedOverlap = normalizeTranscript(overlapped, opts.language);
    const normalizedExisting = normalizeTranscript(existing.text, opts.language);
    const normalizedIncoming = normalizeTranscript(incoming.text, opts.language);
    if (normalizedOverlap && normalizedOverlap !== normalizedExisting && normalizedOverlap !== normalizedIncoming) return overlapped;
    if (opts.preferHigherConfidence) {
        const oldConf = Number(existing.confidence);
        const newConf = Number(incoming.confidence);
        if (Number.isFinite(oldConf) && Number.isFinite(newConf) && Math.abs(newConf - oldConf) >= 0.03) {
            return newConf > oldConf ? incoming.text : existing.text;
        }
    }
    if (opts.preferLongerText) return chooseMoreCompleteText(existing.text, incoming.text, opts);
    return incoming.lastWindowEndMs >= (existing.lastWindowEndMs || 0) ? incoming.text : existing.text;
}

function chooseMoreCompleteText(a, b) {
    const at = String(a || "").trim();
    const bt = String(b || "").trim();
    return bt.length > at.length ? bt : at;
}

function chooseConfidence(a, b) {
    const av = Number(a);
    const bv = Number(b);
    if (Number.isFinite(av) && Number.isFinite(bv)) return Math.max(av, bv);
    if (Number.isFinite(bv)) return bv;
    if (Number.isFinite(av)) return av;
    return undefined;
}

function resolveLanguage(text, language = "auto") {
    if (language === "zh" || language === "en") return language;
    return CJK_RE.test(String(text || "")) ? "zh" : "en";
}

function similarityTokens(text, language) {
    const normalized = normalizeTranscript(text, language);
    if (!normalized) return [];
    return language === "zh" ? Array.from(normalized) : normalized.split(/\s+/u).filter(Boolean);
}

function findCommonTextOverlap(a, b, language = "auto") {
    const lang = resolveLanguage(`${a} ${b}`, language);
    const aTokens = tokenizeTranscript(String(a || ""));
    const bTokens = tokenizeTranscript(String(b || ""));
    const forward = findTokenSuffixPrefixOverlap(aTokens, bTokens);
    const reverse = findTokenSuffixPrefixOverlap(bTokens, aTokens);
    const best = forward.count >= reverse.count ? forward : reverse;
    const minLen = Math.max(1, Math.min(similarityTokens(a, lang).length, similarityTokens(b, lang).length));
    return {
        count: best.count,
        score: best.count / minLen,
    };
}

function findTokenSuffixPrefixOverlap(aTokens, bTokens) {
    const max = Math.min(aTokens.length, bTokens.length);
    for (let count = max; count > 0; count--) {
        let ok = true;
        for (let i = 0; i < count; i++) {
            if (aTokens[aTokens.length - count + i]?.key !== bTokens[i]?.key) {
                ok = false;
                break;
            }
        }
        if (ok) return { count };
    }
    return { count: 0 };
}

function minCommonOverlapTokens(a, b, language) {
    const lang = resolveLanguage(`${a} ${b}`, language);
    return lang === "zh" ? 2 : 2;
}

function textContains(a, b, language) {
    const aa = normalizeTranscript(a, language);
    const bb = normalizeTranscript(b, language);
    return Boolean(aa && bb && aa !== bb && aa.includes(bb));
}

function tokensEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function tokenBlockEquals(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i]?.key !== b[i]?.key) return false;
    }
    return true;
}

function lcsLength(a, b) {
    const prev = new Uint16Array(b.length + 1);
    const curr = new Uint16Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
        }
        prev.set(curr);
        curr.fill(0);
    }
    return prev[b.length];
}

function jaccardSimilarity(a, b) {
    const aa = new Set(a);
    const bb = new Set(b);
    let intersection = 0;
    for (const token of aa) if (bb.has(token)) intersection += 1;
    const union = new Set([...aa, ...bb]).size;
    return union ? intersection / union : 0;
}

function timeOverlapMs(a, b) {
    return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

function timeGapMs(a, b) {
    if (timeOverlapMs(a, b) > 0) return 0;
    return Math.max(0, Math.max(a.startMs, b.startMs) - Math.min(a.endMs, b.endMs));
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export const transcriptMerger = Object.freeze({
    TranscriptMerger,
    normalizeTranscript,
    textSimilarity,
    mergeOverlappingText,
    collapseRepeatedTranscript,
    mergeAsrWindowResults,
});
