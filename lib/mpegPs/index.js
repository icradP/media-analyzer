export {
    PS_STREAM_IDS,
    findNextPsStartCode,
    psStreamIdName,
    parsePsPackHeader,
    parsePsSystemHeader,
    parsePsProgramStreamMap,
    parsePsPacketAt,
    parseMpegPsPackets,
    buildMpegPsAnalysisResult,
    parseMpegPsForAnalysis,
    mpegPsParseCodec,
} from "./psParse.js";

import {
    PS_STREAM_IDS,
    findNextPsStartCode,
    psStreamIdName,
    parsePsPackHeader,
    parsePsSystemHeader,
    parsePsProgramStreamMap,
    parsePsPacketAt,
    parseMpegPsPackets,
    buildMpegPsAnalysisResult,
    parseMpegPsForAnalysis,
} from "./psParse.js";

export const mpegPsCodec = Object.freeze({
    PS_STREAM_IDS,
    findNextPsStartCode,
    psStreamIdName,
    parsePsPackHeader,
    parsePsSystemHeader,
    parsePsProgramStreamMap,
    parsePsPacketAt,
    parseMpegPsPackets,
    buildMpegPsAnalysisResult,
    parseMpegPsForAnalysis,
});
