/** MPEG-TS 常用 PID。 */

export const TS_PAT_PID = 0;
export const TS_CAT_PID = 1;
export const TS_TSDT_PID = 2;
/** 空包 PID */
export const TS_NULL_PID = 0x1fff;

export const tsWellKnownPidsCodec = Object.freeze({
    TS_PAT_PID,
    TS_CAT_PID,
    TS_TSDT_PID,
    TS_NULL_PID,
});
