/**
 * FLV Audio tag 体解析。
 * 依赖 parseAudioSpecificConfig / tryParseAacRawDataBlockHeader 与 flvMediaLabels。
 */

import {
    flvSoundFormatName,
    flvSoundRateLabel,
} from "./flvMediaLabels.js";
import { parseAudioSpecificConfig, tryParseAacRawDataBlockHeader } from "./aacAudioSpecificConfig.js";

/** @param t Be 读 tag body；@param a dataSize；@param i 输出 tag 对象（含 fieldOffsets） */
export function parseFlvAudioTagBody(t, a, i) {
    if (a < 1) return;
    if (!i.fieldOffsets) i.fieldOffsets = {};

    const r = t.readBits(4, "soundFormat");
    i.soundFormat = flvSoundFormatName(r);
    i._soundFormat_value = r;

    const s = t.readBits(2, "soundRate");
    i.soundRate = `${s} (${flvSoundRateLabel(s)})`;
    i._soundRate_value = s;

    const c = t.readBits(1, "soundSize");
    i.soundSize = `${c} (${c === 0 ? "8-bit" : "16-bit"})`;
    i._soundSize_value = c;

    const o = t.readBits(1, "soundType");
    i.soundType = `${o} (${o === 0 ? "Mono" : "Stereo"})`;
    i._soundType_value = o;

    if (r === 10) {
        if (a > 1) {
            const f = t.readBits(8, "aacPacketType");
            i.aacPacketType = `${f} (${f === 0 ? "Audio Specific Config" : "AAC raw"})`;
            i._aacPacketType_value = f;

            if (f === 0 && a > 2) {
                const m = Math.floor(t.bitPosition / 8);
                const h = t.baseOffset + m;
                const g = a - 2;
                if (g >= 2) {
                    const v = t.data.slice(m, m + g);
                    const p = parseAudioSpecificConfig(
                        v,
                        0,
                        i.fieldOffsets,
                        "audioSpecificConfig",
                        h,
                    );
                    i.audioSpecificConfig = {
                        audioObjectType: `${p.audioObjectType} (${p.audioObjectTypeName})`,
                        _audioObjectType_value: p.audioObjectType,
                        samplingFrequencyIndex: `${p.samplingFrequencyIndex} (${p.samplingFrequency} Hz)`,
                        _samplingFrequencyIndex_value: p.samplingFrequencyIndex,
                        _samplingFrequency_value: p.samplingFrequency,
                        channelConfiguration: `${p.channelConfiguration} (${p.channels} channels)`,
                        _channelConfiguration_value: p.channels,
                        _profile: p.profile,
                        _channelLayout: p.channelLayout,
                        frameLengthFlag: p.frameLengthFlag,
                        dependsOnCoreCoder: p.dependsOnCoreCoder,
                        extensionFlag: p.extensionFlag,
                    };
                    if (p.extensionSamplingFrequencyIndex !== undefined) {
                        i.audioSpecificConfig.extensionSamplingFrequencyIndex = `${p.extensionSamplingFrequencyIndex} (${p.extensionSamplingFrequency} Hz)`;
                        i.audioSpecificConfig._extensionSamplingFrequencyIndex_value =
                            p.extensionSamplingFrequencyIndex;
                    }
                    if (p.extensionAudioObjectType !== undefined) {
                        i.audioSpecificConfig.extensionAudioObjectType = `${p.extensionAudioObjectType} (${p.extensionAudioObjectTypeName})`;
                        i.audioSpecificConfig._extensionAudioObjectType_value =
                            p.extensionAudioObjectType;
                    }
                    if (p.syncExtensionType !== undefined) {
                        i.audioSpecificConfig.syncExtensionType = `0x${p.syncExtensionType.toString(16).toUpperCase()}`;
                        i.audioSpecificConfig._syncExtensionType_value = p.syncExtensionType;
                    }
                    if (p.sbrPresentFlag !== undefined) {
                        i.audioSpecificConfig.sbrPresentFlag = p.sbrPresentFlag;
                    }
                    if (p.psPresentFlag !== undefined) {
                        i.audioSpecificConfig.psPresentFlag = p.psPresentFlag;
                    }
                    if (p.syncExtensionType2 !== undefined) {
                        i.audioSpecificConfig.syncExtensionType2 = `0x${p.syncExtensionType2.toString(16).toUpperCase()}`;
                        i.audioSpecificConfig._syncExtensionType2_value = p.syncExtensionType2;
                    }
                }
            } else if (f === 1 && a > 2) {
                const m = Math.floor(t.bitPosition / 8);
                const h = t.baseOffset + m;
                const g = a - 2;
                const v = t.data.slice(m, m + g);
                const p = tryParseAacRawDataBlockHeader(v, h, i.fieldOffsets);
                if (p) {
                    i.aacFrame = {
                        frameSize: g,
                        id_syn_ele: `${p.id_syn_ele} (${p.id_syn_ele_name})`,
                        element_instance_tag: p.element_instance_tag,
                        ...(p.common_window !== undefined && { common_window: p.common_window }),
                        ...(p.ics_info && {
                            ics_info: {
                                ics_reserved_bit: p.ics_info.ics_reserved_bit,
                                window_sequence: `${p.ics_info.window_sequence} (${p.ics_info.window_sequence_name})`,
                                window_shape: p.ics_info.window_shape,
                                ...(p.ics_info.max_sfb !== undefined && { max_sfb: p.ics_info.max_sfb }),
                                ...(p.ics_info.scale_factor_grouping !== undefined && {
                                    scale_factor_grouping: p.ics_info.scale_factor_grouping,
                                }),
                            },
                        }),
                    };
                    if (p.fieldOffsets) {
                        Object.assign(i.fieldOffsets, p.fieldOffsets);
                    }
                    i.data = `Uint8Array(${g})`;
                    i.fieldOffsets.data = { offset: h, length: g };
                    i.fieldOffsets.aacData = { offset: h, length: g };
                }
            }
        }
    } else if (a > 1) {
        const f = Math.floor(t.bitPosition / 8);
        const m = t.baseOffset + f;
        const h = a - 1;
        i.data = `Uint8Array(${h})`;
        i.fieldOffsets.data = { offset: m, length: h };
        i.fieldOffsets.audioData = { offset: m, length: h };
    }
}

export const flvAudioTagCodec = Object.freeze({
    parseFlvAudioTagBody,
});
