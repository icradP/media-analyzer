/**
 * Constants and Helper functions directly extracted from original source.
 */

export const AVC_PROFILES = {
    44: "CAVLC 4:4:4 Intra",
    66: "Baseline",
    77: "Main",
    83: "Scalable Baseline",
    86: "Scalable High",
    88: "Extended",
    100: "High",
    110: "High 10",
    122: "High 4:2:2",
    244: "High 4:4:4 Predictive",
    118: "Multiview High",
    128: "Stereo High",
    134: "MFC High",
    135: "MFC Depth High",
    138: "Multiview Depth High",
    139: "Enhanced Multiview Depth High"
};

export const HEVC_PROFILES = {
    0: "No Profile",
    1: "Main",
    2: "Main 10",
    3: "Main Still Picture",
    4: "Format Range Extensions",
    5: "High Throughput",
    9: "Screen Content Coding Extensions"
};

export const SLICE_TYPES = {
    0: "P slice (Predicted)",
    1: "B slice (Bi-directional predicted)",
    2: "I slice (Intra)",
    3: "SP slice",
    4: "SI slice",
    5: "P slice (all slices in picture are P)",
    6: "B slice (all slices in picture are B)",
    7: "I slice (all slices in picture are I)",
    8: "SP slice (all slices in picture are SP)",
    9: "SI slice (all slices in picture are SI)"
};

export const SAMPLING_FREQUENCIES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0];

/** MPEG-2 AAC profile 索引（1-based）→ 名 */
export function getAudioProfileName(t) {
    return {
        0: "Main",
        1: "LC (Low Complexity)",
        2: "SSR (Scalable Sample Rate)",
        3: "LTP (Long Term Prediction)",
        4: "SBR (HE-AAC)",
        5: "Scalable"
    }[t - 1] || `Unknown (${t})`;
}

export function getChromaFormatName(t) {
    return {
        0: "Monochrome",
        1: "4:2:0",
        2: "4:2:2",
        3: "4:4:4"
    }[t] || "Unknown";
}

export function getAVCProfileName(t) {
    return AVC_PROFILES[t] || `Unknown Profile (${t})`;
}

export function getAVCLevelName(t) {
    return `Level ${(t / 10).toFixed(1)}`;
}

export function getHEVCProfileName(t) {
    return HEVC_PROFILES[t] || `Unknown Profile (${t})`;
}

export function getHEVCLevelName(t) {
    return `Level ${(t / 30).toFixed(1)}`;
}

/** general_tier_flag 文案 */
export function getHEVCTierName(t) {
    return { 0: "Main", 1: "High" }[t] || `Unknown Tier (${t})`;
}

export function getSliceTypeName(t) {
    return SLICE_TYPES[t] || `Unknown (${t})`;
}

/**
 * Remove emulation prevention bytes.
 */
export function removeEmulationPrevention(t) {
    const a = [];
    const i = [];
    let r = 0;
    while (r < t.length) {
        if (r + 2 < t.length && t[r] === 0 && t[r + 1] === 0 && t[r + 2] === 3 && r + 3 < t.length && t[r + 3] <= 3) {
            a.push(0);
            a.push(0);
            i.push(r + 2);
            r += 3;
            continue;
        }
        a.push(t[r]);
        r++;
    }
    return {
        data: new Uint8Array(a),
        removedPositions: i
    };
}
