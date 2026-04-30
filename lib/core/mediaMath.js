/**
 * 由字节量与时长估算码率、由帧数与时长估算帧率。
 * `durationSeconds` 量纲为秒（浮点）。
 */

/** @param {number} byteLength @param {number} durationSeconds */
export function bitrateBpsFromBytesAndDuration(byteLength, durationSeconds) {
    if (durationSeconds > 0 && byteLength > 0) return Math.round((byteLength * 8) / durationSeconds);
}

/** @param {number} frameCount @param {number} durationSeconds */
export function frameRateFromFrameCountAndDuration(frameCount, durationSeconds) {
    if (durationSeconds > 0 && frameCount > 0) return Math.round((frameCount / durationSeconds) * 100) / 100;
}

export function channelLayoutFromChannelCount(channels) {
    if (channels == null) return undefined;
    return (
        {
            1: "Mono",
            2: "Stereo",
            3: "2.1",
            4: "Quad",
            5: "5.0",
            6: "5.1",
            7: "6.1",
            8: "7.1",
        }[channels] || `${channels} channels`
    );
}

export const bundleMediaMath = Object.freeze({
    bitrateBpsFromBytesAndDuration,
    frameRateFromFrameCountAndDuration,
    channelLayoutFromChannelCount,
});
