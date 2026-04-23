import { AAC_SAMPLING_FREQUENCIES } from "./aacMpeg4Constants.js";

/** 由采样率(Hz) 反查 MPEG-4 采样率索引，找不到时返回 4 */
export function getAacSamplingFrequencyIndex(sampleRateHz) {
    const idx = AAC_SAMPLING_FREQUENCIES.indexOf(sampleRateHz);
    return idx >= 0 ? idx : 4;
}

/**
 * 构造 ADTS 固定头 7 字节（不含可变 protection_absent 后的 crc 等扩展）。
 * @param {number} aacFrameLength 含 ADTS 头在内的整帧长度
 * @param {number} profile 0–3（MPEG-4 中 object type 压缩表示）
 * @param {number} samplingFreqIndex 0–15
 * @param {number} channelConfig 声道配置
 */
export function buildAdtsFixedHeader7(aacFrameLength, profile, samplingFreqIndex, channelConfig) {
    const s = new Uint8Array(7);
    const c = aacFrameLength + 7;
    s[0] = 0xff;
    s[1] = 0xf1;
    const o = Math.max(0, (profile || 2) - 1);
    s[2] = ((o & 3) << 6) | ((samplingFreqIndex & 15) << 2) | ((channelConfig >> 2) & 1);
    s[3] = ((channelConfig & 3) << 6) | ((c >> 11) & 3);
    s[4] = (c >> 3) & 255;
    s[5] = ((c & 7) << 5) | 31;
    s[6] = 0xfc;
    return s;
}

/** ADTS 头 + 原始 AAC payload */
export function wrapAacPayloadWithAdts(aacPayload, profile, samplingFreqIndex, channelConfig) {
    const header = buildAdtsFixedHeader7(aacPayload.length, profile, samplingFreqIndex, channelConfig);
    const out = new Uint8Array(header.length + aacPayload.length);
    out.set(header, 0);
    out.set(aacPayload, header.length);
    return out;
}
