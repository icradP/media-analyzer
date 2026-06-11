const TRAILING_PUNCT_RE = /^[,.;:!?，。！？；：、…]+$/u;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/u;

export class TranscriptStabilizer {
    constructor(options = {}) {
        this.minStableRepeats = Math.max(1, Math.min(10, Math.round(Number(options.minStableRepeats) || 2)));
        this.reset();
    }

    reset() {
        this.previousTokens = [];
        this.currentTokens = [];
        this.committedTokens = [];
        this.candidateText = "";
        this.candidateTokens = [];
        this.candidateRepeats = 0;
    }

    update(text, timing = {}) {
        const tokens = tokenizeTranscript(text);
        this.currentTokens = tokens;
        const prefixTokens = trimTrailingPunctuation(commonPrefixTokens(this.previousTokens, tokens));
        const pendingTokens = removeCommittedPrefixTokens(prefixTokens, this.committedTokens);
        const pendingText = tokensToText(pendingTokens);
        let committedText = "";

        if (pendingText && this.candidateTokens.length && startsWithTokens(pendingTokens, this.candidateTokens)) {
            this.candidateRepeats += 1;
        } else {
            this.candidateText = pendingText;
            this.candidateTokens = pendingTokens;
            this.candidateRepeats = pendingText ? 1 : 0;
        }

        if (this.candidateText && this.candidateRepeats >= this.minStableRepeats) {
            committedText = this.candidateText;
            this.committedTokens = this.committedTokens.concat(this.candidateTokens);
            this.candidateText = "";
            this.candidateTokens = [];
            this.candidateRepeats = 0;
        }

        this.previousTokens = tokens;
        return {
            stableText: tokensToText(this.committedTokens),
            partialText: tokensToText(removeCommittedPrefixTokens(tokens, this.committedTokens)),
            committedText,
            committed: Boolean(committedText),
            startMs: Math.max(0, Number(timing.startMs) || 0),
            endMs: Math.max(0, Number(timing.endMs) || 0),
        };
    }

    flush(timing = {}) {
        const pending = removeCommittedPrefixTokens(this.currentTokens, this.committedTokens);
        const finalText = tokensToText(pending);
        if (finalText) this.committedTokens = this.committedTokens.concat(pending);
        this.previousTokens = [];
        this.currentTokens = [];
        this.candidateText = "";
        this.candidateTokens = [];
        this.candidateRepeats = 0;
        return {
            stableText: tokensToText(this.committedTokens),
            partialText: "",
            committedText: finalText,
            committed: Boolean(finalText),
            startMs: Math.max(0, Number(timing.startMs) || 0),
            endMs: Math.max(0, Number(timing.endMs) || 0),
        };
    }
}

export function tokenizeTranscript(text = "") {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) return [];
    const tokens = [];
    let word = "";
    const flushWord = () => {
        if (!word) return;
        tokens.push({ text: word, key: word.toLowerCase(), kind: "word" });
        word = "";
    };
    for (const ch of normalized) {
        if (/\s/u.test(ch)) {
            flushWord();
        } else if (CJK_RE.test(ch)) {
            flushWord();
            tokens.push({ text: ch, key: ch, kind: "cjk" });
        } else if (TRAILING_PUNCT_RE.test(ch)) {
            flushWord();
            tokens.push({ text: ch, key: ch, kind: "punct" });
        } else {
            word += ch;
        }
    }
    flushWord();
    return tokens;
}

export function commonPrefixTokens(a = [], b = []) {
    const limit = Math.min(a.length, b.length);
    let count = 0;
    while (count < limit && a[count]?.key === b[count]?.key) count += 1;
    return b.slice(0, count);
}

export function tokensToText(tokens = []) {
    let out = "";
    let prevKind = "";
    for (const token of tokens) {
        const text = String(token?.text || "");
        if (!text) continue;
        const kind = token?.kind || "word";
        if (kind === "punct") {
            out = out.replace(/\s+$/u, "") + text;
        } else if (kind === "cjk") {
            out += text;
        } else {
            if (out && prevKind !== "cjk") out += " ";
            out += text;
        }
        prevKind = kind;
    }
    return out.trim();
}

function trimTrailingPunctuation(tokens = []) {
    let end = tokens.length;
    while (end > 0 && tokens[end - 1]?.kind === "punct") end -= 1;
    return tokens.slice(0, end);
}

function removeCommittedPrefixTokens(tokens = [], committed = []) {
    if (!tokens.length) return [];
    if (startsWithTokens(tokens, committed)) return tokens.slice(committed.length);
    const text = tokensToText(tokens);
    const committedText = tokensToText(committed);
    if (committedText && normalizeText(committedText).endsWith(normalizeText(text))) return [];
    return tokens;
}

function startsWithTokens(tokens, prefix) {
    if (!prefix.length) return true;
    if (tokens.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
        if (tokens[i]?.key !== prefix[i]?.key) return false;
    }
    return true;
}

function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export const transcriptStabilizer = Object.freeze({
    TranscriptStabilizer,
    tokenizeTranscript,
    commonPrefixTokens,
    tokensToText,
});
