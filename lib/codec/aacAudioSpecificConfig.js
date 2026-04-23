import Be from "../core/Be.js";
import {
    AAC_SAMPLING_FREQUENCIES,
    getAudioObjectTypeName,
    getChannelLayoutLabel,
} from "./aacMpeg4Constants.js";

const RAW_ELEMENT_NAMES = {
    0: "SCE (Single Channel Element)",
    1: "CPE (Channel Pair Element)",
    2: "CCE (Coupling Channel Element)",
    3: "LFE (LFE Channel Element)",
    4: "DSE (Data Stream Element)",
    5: "PCE (Program Config Element)",
    6: "FIL (Fill Element)",
    7: "END (Terminator)",
};

const WINDOW_SEQUENCE_NAMES = {
    0: "ONLY_LONG_SEQUENCE",
    1: "LONG_START_SEQUENCE",
    2: "EIGHT_SHORT_SEQUENCE",
    3: "LONG_STOP_SEQUENCE",
};

/**
 * @param {Uint8Array} data
 * @param {number} [byteOffset=0]
 * @param {Record<string, unknown>|null} [fieldOffsets=null]
 * @param {string} [prefix=""]
 * @param {number} [baseOffset=0] Be 内 baseOffset
 */
export function parseAudioSpecificConfig(
    data,
    byteOffset = 0,
    fieldOffsets = null,
    prefix = "",
    baseOffset = 0,
) {
    if (!data || data.length < 2) return {};
    const c = {};
    const o = new Be(data, byteOffset, baseOffset, fieldOffsets, prefix);
    c.audioObjectType = o.readBits(5, "audioObjectType");
    c.originalAudioObjectType = c.audioObjectType;
    c.audioObjectTypeName = getAudioObjectTypeName(c.audioObjectType);
    c.profile = c.audioObjectType;
    c.samplingFrequencyIndex = o.readBits(4, "samplingFrequencyIndex");
    if (c.samplingFrequencyIndex === 15) {
        c.samplingFrequency = o.readBits(24, "samplingFrequency");
        c._samplingFrequency_value = c.samplingFrequency;
    } else {
        c.samplingFrequency = AAC_SAMPLING_FREQUENCIES[c.samplingFrequencyIndex] || 0;
        c._samplingFrequency_value = c.samplingFrequency;
    }
    c.channelConfiguration = o.readBits(4, "channelConfiguration");
    c.channels = c.channelConfiguration;
    c._channelConfiguration_value = c.channelConfiguration;
    c.channelLayout = getChannelLayoutLabel(c.channelConfiguration);
    c.frameLengthFlag = o.readBits(1, "frameLengthFlag");
    c.dependsOnCoreCoder = o.readBits(1, "dependsOnCoreCoder");
    c.extensionFlag = o.readBits(1, "extensionFlag");
    if (c.audioObjectType === 5 || c.audioObjectType === 29) {
        if (data.length >= byteOffset + 3) {
            c.extensionSamplingFrequencyIndex = o.readBits(4, "extensionSamplingFrequencyIndex");
            if (c.extensionSamplingFrequencyIndex === 15) {
                c.extensionSamplingFrequency = o.readBits(24, "extensionSamplingFrequency");
            } else {
                c.extensionSamplingFrequency =
                    AAC_SAMPLING_FREQUENCIES[c.extensionSamplingFrequencyIndex] || 0;
            }
            c.extensionAudioObjectType = o.readBits(5, "extensionAudioObjectType");
            c.extensionAudioObjectTypeName = getAudioObjectTypeName(c.extensionAudioObjectType);
        }
    } else if (data.length >= byteOffset + 4) {
        const f = o.bitPosition;
        const m = o.readBits(11, "syncExtensionType");
        if (m === 695) {
            c.syncExtensionType = m;
            c.extensionAudioObjectType = o.readBits(5, "extensionAudioObjectType");
            c.extensionAudioObjectTypeName = getAudioObjectTypeName(c.extensionAudioObjectType);
            if (c.extensionAudioObjectType === 5) {
                c.sbrPresentFlag = o.readBits(1, "sbrPresentFlag");
                if (c.sbrPresentFlag === 1) {
                    c.extensionSamplingFrequencyIndex = o.readBits(
                        4,
                        "extensionSamplingFrequencyIndex",
                    );
                    if (c.extensionSamplingFrequencyIndex === 15) {
                        c.extensionSamplingFrequency = o.readBits(
                            24,
                            "extensionSamplingFrequency",
                        );
                    } else {
                        c.extensionSamplingFrequency =
                            AAC_SAMPLING_FREQUENCIES[c.extensionSamplingFrequencyIndex] || 0;
                    }
                    const h = o.bitPosition;
                    const g = o.readBits(11, "syncExtensionType2");
                    if (g === 1352) {
                        c.syncExtensionType2 = g;
                        c.psPresentFlag = o.readBits(1, "psPresentFlag");
                    } else {
                        o.bitPosition = h;
                    }
                }
            } else if (c.extensionAudioObjectType === 22) {
                c.psPresentFlag = o.readBits(1, "psPresentFlag");
            }
        } else {
            o.bitPosition = f;
        }
    }
    return c;
}

/**
 * 尝试解析 AAC raw 块中的 raw_data_block 起始结构（id_syn_ele 等）。
 * @param {Uint8Array} data
 * @param {number} [baseOffset=0] fieldOffsets 用
 * @param {Record<string, unknown>|null} [fieldOffsets=null]
 */
export function tryParseAacRawDataBlockHeader(data, baseOffset = 0, fieldOffsets = null) {
    if (!data || data.length < 2) return null;
    const r = {};
    const s = new Be(data, 0, baseOffset, fieldOffsets, "");
    try {
        const c = s.readBits(3, "aacFrame.id_syn_ele");
        const o = RAW_ELEMENT_NAMES[c] || `Unknown (${c})`;
        const f = {
            id_syn_ele: c,
            id_syn_ele_name: o,
            element_instance_tag: 0,
            fieldOffsets: r,
        };
        if (c === 7) return f;
        f.element_instance_tag = s.readBits(4, "aacFrame.element_instance_tag");
        if (c <= 3) {
            if (c === 1) {
                f.common_window = s.readBits(1, "aacFrame.common_window");
            }
            if (c !== 1 || f.common_window === 1) {
                f.ics_info = {
                    ics_reserved_bit: s.readBits(1, "aacFrame.ics_info.ics_reserved_bit"),
                    window_sequence: s.readBits(2, "aacFrame.ics_info.window_sequence"),
                    window_sequence_name: "",
                    window_shape: s.readBits(1, "aacFrame.ics_info.window_shape"),
                };
                f.ics_info.window_sequence_name =
                    WINDOW_SEQUENCE_NAMES[f.ics_info.window_sequence] || "Unknown";
                if (f.ics_info.window_sequence === 2) {
                    f.ics_info.max_sfb = s.readBits(4, "aacFrame.ics_info.max_sfb");
                    f.ics_info.scale_factor_grouping = s.readBits(
                        7,
                        "aacFrame.ics_info.scale_factor_grouping",
                    );
                } else {
                    f.ics_info.max_sfb = s.readBits(6, "aacFrame.ics_info.max_sfb");
                }
            }
        }
        return f;
    } catch {
        return null;
    }
}

/** 聚合导出（便于逐步替换调用方） */
export const aacCodec = Object.freeze({
    parseAudioSpecificConfig,
    tryParseAacRawDataBlockHeader,
    RAW_ELEMENT_NAMES,
    WINDOW_SEQUENCE_NAMES,
});
