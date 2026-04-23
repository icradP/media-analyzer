import { parseFlvAudioTagBody } from '../codec/flvAudioTag.js';
import { parseFlvVideoTagBody } from '../codec/flvVideoTagBody.js';
import { parseFlvTagAt } from '../codec/flvTagParse.js';
import { parseFlvFileForAnalysis, parseFlvFileHeader } from '../codec/flvAnalysis.js';

/**
 * FLVParser.
 */
export const FLVParser = {
    /**
     * Parse FLV Header.
     */
    parseHeader(t, a) {
        return parseFlvFileHeader(t, a);
    },

    /** 单条 FLV tag。`t` 为整文件的 DataView；`a` 为 tag 起点；`r` 为当前视频 sequence header（可选）。 */
    parseTag(t, a, i, r, s = {}) {
        const ua = new Uint8Array(t.buffer, t.byteOffset, t.byteLength);
        const tag = parseFlvTagAt(ua, a, r ?? null);
        if (tag && s && Object.keys(s).length) {
            Object.assign(tag.fieldOffsets, s);
        }
        return tag;
    },

    parseVideoTag(reader, dataSize, out) {
        parseFlvVideoTagBody(reader, dataSize, out, null);
    },

    parseAudioTag(reader, dataSize, out) {
        parseFlvAudioTagBody(reader, dataSize, out);
    },

    /**
     * Main FLV parser入口：`parseFlvFileForAnalysis` 的薄封装。
     * @returns {{ header: object, tags: object[], analysis: object }}
     */
    parse(t) {
        const analysis = parseFlvFileForAnalysis(t);
        return {
            header: analysis.formatSpecific.header,
            tags: analysis.frames.map((f) => f.formatSpecific),
            analysis,
        };
    }
};

export default FLVParser;
