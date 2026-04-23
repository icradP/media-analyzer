/**
 * 向后兼容：占位元数据 + 实解析再导出（实现于 hevcDecoderConfig.js）。
 */

import { parseHevcDecoderConfigurationRecord, hevcCodec } from "./hevcDecoderConfig.js";

export { parseHevcDecoderConfigurationRecord, hevcCodec };

export const HEVC_DECODER_CONFIG_PORT = Object.freeze({
    parserId: "HEVCDecoderConfigurationRecord",
    bundleSymbol: "$i",
    bundleChunk: "chunk-0001.js",
    approximateLines: "2410-2526",
    nalUnitParsers: Object.freeze(["Eu", "Nu", "Au", "ju"]),
    implementedIn: "lib/codec/hevcDecoderConfig.js + hevcNaluUnits.js + hevcVui.js",
    parseHevcDecoderConfigurationRecord,
});

export const hevcCodecPort = Object.freeze({
    ...HEVC_DECODER_CONFIG_PORT,
});
