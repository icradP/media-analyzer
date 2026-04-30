/**
 * Analytics - Logic directly extracted from original source.
 */
export const Analytics = {
    /**
     * Process FLV tags into frames with interval and timing.
     * Based on Jv function.
     */
    processFLVFrames(tags) {
        const frames = [];
        let lastVideoDts = null;
        let lastAudioDts = null;

        for (let i = 0; i < tags.length; i++) {
            const tag = tags[i];
            const mediaType = tag.tagType === 9 ? "video" : (tag.tagType === 8 ? "audio" : "data");
            const dts = tag.timestampFull ?? 0;
            const ptsOffset = (mediaType === "video" && typeof tag.compositionTime === "number") ? tag.compositionTime : 0;
            const pts = dts + ptsOffset;
            
            let interval = null;
            if (mediaType === "video") {
                if (lastVideoDts !== null) interval = dts - lastVideoDts;
                lastVideoDts = dts;
            } else if (mediaType === "audio") {
                if (lastAudioDts !== null) interval = dts - lastAudioDts;
                lastAudioDts = dts;
            }

            frames.push({
                index: i,
                mediaType,
                pts,
                ptsTime: pts / 1000,
                dts,
                dtsTime: dts / 1000,
                size: tag.dataSize || 0,
                offset: tag.offset || 0,
                isKeyframe: tag.frameType === 1,
                interval,
                formatSpecific: tag
            });
        }
        return frames;
    },

    /**
     * Calculate A/V Sync difference.
     * Based on P2 component memo logic.
     */
    calculateAVSync(frames) {
        const videoFrames = frames.filter(f => f.mediaType === "video");
        const audioFrames = frames.filter(f => f.mediaType === "audio")
                                  .sort((a, b) => a.ptsTime - b.ptsTime);

        if (videoFrames.length === 0 || audioFrames.length === 0) return [];

        const findNearestAudio = (targetTime) => {
            let low = 0;
            let high = audioFrames.length - 1;
            let nearest = audioFrames[0];
            let minDiff = Math.abs(audioFrames[0].ptsTime - targetTime);

            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                const midTime = audioFrames[mid].ptsTime;
                const diff = Math.abs(midTime - targetTime);
                if (diff < minDiff) {
                    minDiff = diff;
                    nearest = audioFrames[mid];
                }
                if (midTime < targetTime) low = mid + 1;
                else if (midTime > targetTime) high = mid - 1;
                else break;
            }
            return nearest;
        };

        return videoFrames.map(vf => {
            const vTime = vf.ptsTime;
            const nearestAudio = findNearestAudio(vTime);
            const syncDiff = (nearestAudio.ptsTime - vTime) * 1000;
            return {
                frameIndex: vf.index,
                ptsTime: vTime,
                syncDiff,
                vPts: vTime,
                aPts: nearestAudio.ptsTime
            };
        });
    },

    /** Calculate bitrate. */
    calculateBitrate(size, duration) {
        if (duration > 0 && size > 0) {
            return Math.round(size * 8 / duration);
        }
        return 0;
    },

    /** Calculate frame rate. */
    calculateFrameRate(frameCount, duration) {
        if (duration > 0 && frameCount > 0) {
            return parseFloat((frameCount / duration).toFixed(2));
        }
        return 0;
    }
};

export default Analytics;
