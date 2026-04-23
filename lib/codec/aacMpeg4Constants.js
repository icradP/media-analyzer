export const AAC_SAMPLING_FREQUENCIES = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
    7350, 0, 0, 0,
];

/** ISO/IEC 14496-3 audioObjectType → 展示名 */
export const AUDIO_OBJECT_TYPE_NAMES = {
    0: "NULL",
    1: "AAC Main",
    2: "AAC LC (Low Complexity)",
    3: "AAC SSR (Scalable Sample Rate)",
    4: "AAC LTP (Long Term Prediction)",
    5: "SBR (Spectral Band Replication)",
    6: "AAC Scalable",
    7: "TwinVQ",
    8: "CELP",
    9: "HVXC",
    10: "Reserved",
    11: "Reserved",
    12: "TTSI",
    13: "Main Synthetic",
    14: "Wavetable Synthesis",
    15: "General MIDI",
    16: "Algorithmic Synthesis",
    17: "ER AAC LC",
    18: "Reserved",
    19: "ER AAC LTP",
    20: "ER AAC Scalable",
    21: "ER TwinVQ",
    22: "ER BSAC",
    23: "ER AAC LD",
    24: "ER CELP",
    25: "ER HVXC",
    26: "ER HILN",
    27: "ER Parametric",
    28: "SSC",
    29: "PS (Parametric Stereo)",
    30: "MPEG Surround",
    31: "Escape",
    32: "Layer-1",
    33: "Layer-2",
    34: "Layer-3",
    35: "DST",
    36: "ALS",
    37: "SLS",
    38: "SLS non-core",
    39: "ER AAC ELD",
    40: "SMR Simple",
    41: "SMR Main",
    42: "USAC (no SBR)",
    43: "SAOC",
    44: "LD MPEG Surround",
    45: "USAC",
};

/** MPEG-2 AAC style profile 索引 */
export const AAC_PROFILE_ID_NAMES = {
    0: "Main",
    1: "LC (Low Complexity)",
    2: "SSR (Scalable Sample Rate)",
    3: "LTP (Long Term Prediction)",
    4: "SBR (HE-AAC)",
    5: "Scalable",
};

export function getMpeg2AacProfileName(profileIndex) {
    return AAC_PROFILE_ID_NAMES[profileIndex - 1] || `Unknown (${profileIndex})`;
}

/** MPEG-2 AAC profile 展示名（与 getMpeg2AacProfileName 相同） */
export function getAacRiProfileName(profileIndex) {
    return getMpeg2AacProfileName(profileIndex);
}

export function getChannelLayoutLabel(channelConfiguration) {
    return (
        {
            0: "Defined in AOT",
            1: "Mono",
            2: "Stereo",
            3: "3.0",
            4: "4.0",
            5: "5.0",
            6: "5.1",
            7: "7.1",
        }[channelConfiguration] || `${channelConfiguration} channels`
    );
}

export function getAudioObjectTypeName(aot) {
    return AUDIO_OBJECT_TYPE_NAMES[aot] || `Unknown (${aot})`;
}
