/** HEVCDecoderConfigurationRecord（hvcC）解析。 */

import Be from "../core/Be.js";
import {
    parseHevcVpsNaluPayload,
    parseHevcSpsNaluPayload,
    parseHevcPpsNaluPayload,
    parseHevcSeiNaluPayload,
} from "./hevcNaluUnits.js";

/**
 * @param {ArrayBuffer|ArrayBufferView} source
 * @param {number} byteOffset
 * @param {number} length
 * @param {Record<string, unknown>} [fieldOffsets={}]
 */
export function parseHevcDecoderConfigurationRecord(source, byteOffset, length, fieldOffsets = {}) {
    if (length < 23) throw new Error("HEVCDecoderConfigurationRecord too short");
    const buffer = source instanceof ArrayBuffer ? source : source.buffer;
    const abs = source instanceof ArrayBuffer ? byteOffset : source.byteOffset + byteOffset;
    const end = abs + length;
    const c = new Uint8Array(buffer, abs, length);
    const o = new Be(c, 0, abs, fieldOffsets, "sequenceHeader");
    const s = {};
    s.configurationVersion = o.readBits(8, "configurationVersion");
    s.generalProfileSpace = o.readBits(2, "generalProfileSpace");
    s.generalTierFlag = o.readBits(1, "generalTierFlag");
    s.generalProfileIdc = o.readBits(5, "generalProfileIdc");
    s.generalProfileCompatibilityFlags = o.readBits(32, "generalProfileCompatibilityFlags");
    o.startField("generalConstraintIndicatorFlags");
    const f = [];
    for (let A = 0; A < 6; A++) f.push(o._readBitsRaw(8));
    o._finishField();
    s.generalConstraintIndicatorFlags = f;
    s.generalLevelIdc = o.readBits(8, "generalLevelIdc");
    o._readBitsRaw(4);
    s.minSpatialSegmentationIdc = o.readBits(12, "minSpatialSegmentationIdc");
    o._readBitsRaw(6);
    s.parallelismType = o.readBits(2, "parallelismType");
    o._readBitsRaw(6);
    s.chromaFormat = o.readBits(2, "chromaFormat");
    o._readBitsRaw(5);
    const m = o.readBits(3, "bitDepthLumaMinus8");
    const h = m + 8;
    s.bitDepthLumaMinus8 = `${m} (${h})`;
    o._readBitsRaw(5);
    const g = o.readBits(3, "bitDepthChromaMinus8");
    const v = g + 8;
    s.bitDepthChromaMinus8 = `${g} (${v})`;
    s.avgFrameRate = o.readBits(16, "avgFrameRate");
    s.constantFrameRate = o.readBits(2, "constantFrameRate");
    s.numTemporalLayers = o.readBits(3, "numTemporalLayers");
    s.temporalIdNested = o.readBits(1, "temporalIdNested");
    const p = o.readBits(2, "lengthSizeMinusOne");
    s.lengthSizeMinusOne = p;
    s.nalUnitLength = p + 1;
    const S = o.readBits(8, "numOfArrays");
    s.numOfArrays = S;
    let b = 0;
    let x = 0;
    let T = 0;
    let N = 0;
    for (let A = 0; A < S && !(abs + Math.floor(o.bitPosition / 8) + 3 > end); A++) {
        const I = o.bitPosition;
        o._readBitsRaw(1);
        o._readBitsRaw(1);
        const O = o._readBitsRaw(6);
        o.bitPosition = I;
        let F = "";
        let E = "";
        if (O === 32) {
            F = "sequenceHeader";
            E = "numVPS";
        } else if (O === 33) {
            F = "sequenceHeader";
            E = "numSPS";
        } else if (O === 34) {
            F = "sequenceHeader";
            E = "numPPS";
        } else if (O === 39 || O === 40) {
            F = "sequenceHeader";
            E = "numSEI";
        } else {
            F = `sequenceHeader.array[${A}]`;
            E = "numNalus";
        }
        o.prefix = F;
        o._readBitsRaw(1);
        o._readBitsRaw(1);
        o._readBitsRaw(6);
        const j = o.readBits(16, E);
        if (O === 32) s.numVPS = j;
        else if (O === 33) s.numSPS = j;
        else if (O === 34) s.numPPS = j;
        else if (O === 39 || O === 40) s.numSEI = j;
        const C = O;
        for (let B = 0; B < j && !(abs + Math.floor(o.bitPosition / 8) + 2 > end); B++) {
            let k = "";
            if (C === 32) k = `sequenceHeader.vps[${b}]`;
            else if (C === 33) k = `sequenceHeader.sps[${x}]`;
            else if (C === 34) k = `sequenceHeader.pps[${T}]`;
            else if (C === 39 || C === 40) k = `sequenceHeader.sei[${N}]`;
            else k = `sequenceHeader.nalu[${B}]`;
            o.prefix = k;
            const U = o.readBits(16, "naluLength");
            const M = abs + Math.floor(o.bitPosition / 8);
            if (M + U > end) break;
            const q = new Uint8Array(buffer, M, U);
            const D = M;
            if (C === 32) {
                const z = parseHevcVpsNaluPayload(q, D, fieldOffsets, b);
                s[`vps[${b}]`] = { naluLength: U, ...z };
                b++;
            } else if (C === 33) {
                const z = parseHevcSpsNaluPayload(q, D, fieldOffsets, x);
                s[`sps[${x}]`] = { naluLength: U, ...z };
                x++;
            } else if (C === 34) {
                const z = parseHevcPpsNaluPayload(q, D, fieldOffsets, T);
                s[`pps[${T}]`] = { naluLength: U, ...z };
                T++;
            } else if (C === 39 || C === 40) {
                const z = parseHevcSeiNaluPayload(q, D, fieldOffsets, N);
                s[`sei[${N}]`] = { naluLength: U, ...z };
                N++;
            }
            o.bitPosition += U * 8;
        }
        o.prefix = "sequenceHeader";
    }
    return s;
}

export const hevcCodec = Object.freeze({
    parseHevcDecoderConfigurationRecord,
});
