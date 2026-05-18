/**
 * Low-level H.264 NAL / SEI RBSP helpers shared by SEI editor and detection-SEI.
 */

import { removeEmulationPrevention } from "../core/Constants.js";

export function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + (part?.length || 0), 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const part of parts) {
        if (!(part instanceof Uint8Array) || part.length <= 0) continue;
        out.set(part, off);
        off += part.length;
    }
    return out;
}

export function bytesEqual(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export function naluType(nalu) {
    return nalu instanceof Uint8Array && nalu.length ? nalu[0] & 0x1f : -1;
}

export function findAnnexBStartCode(bytes, from = 0) {
    for (let i = Math.max(0, from); i + 3 < bytes.length; i++) {
        if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) return { offset: i, length: 3 };
        if (i + 4 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
            return { offset: i, length: 4 };
        }
    }
    return null;
}

export function splitLengthPrefixedNalUnits(bytes, lengthSize) {
    if (!(bytes instanceof Uint8Array) || lengthSize < 1 || lengthSize > 4) return null;
    const out = [];
    let off = 0;
    while (off + lengthSize <= bytes.length) {
        let len = 0;
        for (let i = 0; i < lengthSize; i++) len = (len * 256) + bytes[off + i];
        off += lengthSize;
        if (len <= 0 || off + len > bytes.length) return null;
        out.push(bytes.subarray(off, off + len));
        off += len;
    }
    return off === bytes.length && out.length ? out : null;
}

export function joinLengthPrefixedNalUnits(nalus, lengthSize) {
    const parts = [];
    for (const nalu of nalus) {
        if (!(nalu instanceof Uint8Array) || nalu.length <= 0) continue;
        parts.push(uintBE(nalu.length, lengthSize), nalu);
    }
    return concatBytes(parts);
}

export function splitAnnexBNalUnits(bytes) {
    const out = [];
    let sc = findAnnexBStartCode(bytes, 0);
    while (sc) {
        const naluStart = sc.offset + sc.length;
        const next = findAnnexBStartCode(bytes, naluStart);
        let naluEnd = next ? next.offset : bytes.length;
        while (naluEnd > naluStart && bytes[naluEnd - 1] === 0) naluEnd--;
        if (naluEnd > naluStart) out.push(bytes.subarray(naluStart, naluEnd));
        sc = next;
    }
    return out;
}

export function splitAnnexBUnits(bytes) {
    const out = [];
    let sc = findAnnexBStartCode(bytes, 0);
    while (sc) {
        const naluStart = sc.offset + sc.length;
        const next = findAnnexBStartCode(bytes, naluStart);
        let naluEnd = next ? next.offset : bytes.length;
        while (naluEnd > naluStart && bytes[naluEnd - 1] === 0) naluEnd--;
        if (naluEnd > naluStart) {
            out.push({
                startCode: bytes.slice(sc.offset, sc.offset + sc.length),
                nalu: bytes.subarray(naluStart, naluEnd),
            });
        }
        sc = next;
    }
    return out;
}

export function detectLengthSizeAndSplitNalUnits(payload, hintLengthSize = null) {
    const tries = [];
    if (Number.isFinite(hintLengthSize) && hintLengthSize >= 1 && hintLengthSize <= 4) tries.push(hintLengthSize);
    for (const n of [4, 3, 2, 1]) if (!tries.includes(n)) tries.push(n);
    for (const lengthSize of tries) {
        const nalus = splitLengthPrefixedNalUnits(payload, lengthSize);
        if (nalus?.length) return { lengthSize, nalus };
    }
    return null;
}

export function pickSeiInsertIndex(nalus) {
    const firstVcl = nalus.findIndex((nalu) => {
        const type = naluType(nalu);
        return type >= 1 && type <= 5;
    });
    if (firstVcl >= 0) return firstVcl;
    const firstNonAud = nalus.findIndex((nalu) => naluType(nalu) !== 9);
    return firstNonAud >= 0 ? firstNonAud : nalus.length;
}

export function readSeiVarLen(bytes, offset) {
    let value = 0;
    let off = offset;
    while (off < bytes.length && bytes[off] === 0xff) {
        value += 255;
        off++;
    }
    if (off >= bytes.length) return null;
    value += bytes[off];
    return { value, next: off + 1 };
}

export function appendSeiVarLen(out, value) {
    let n = Math.max(0, Math.round(Number(value) || 0));
    while (n >= 255) {
        out.push(0xff);
        n -= 255;
    }
    out.push(n & 0xff);
}

export function insertEmulationPreventionBytes(rbsp) {
    const out = [];
    let zeroRun = 0;
    for (const b of rbsp) {
        if (zeroRun >= 2 && b <= 0x03) {
            out.push(0x03);
            zeroRun = 0;
        }
        out.push(b);
        zeroRun = b === 0 ? zeroRun + 1 : 0;
    }
    return Uint8Array.from(out);
}

export function decodeH264SeiRbspMessages(seiNalu) {
    if (!(seiNalu instanceof Uint8Array) || seiNalu.length < 2 || (seiNalu[0] & 0x1f) !== 6) return [];
    const rbsp = removeEmulationPrevention(seiNalu.slice(1)).data;
    const out = [];
    let off = 0;
    while (off < rbsp.length - 1) {
        const type = readSeiVarLen(rbsp, off);
        if (!type) break;
        off = type.next;
        const size = readSeiVarLen(rbsp, off);
        if (!size) break;
        off = size.next;
        if (off + size.value > rbsp.length) break;
        out.push({
            payloadType: type.value,
            payloadBytes: rbsp.slice(off, off + size.value),
        });
        off += size.value;
    }
    return out;
}

export function uintBE(value, length) {
    const out = new Uint8Array(length);
    let n = Math.max(0, Math.round(Number(value) || 0));
    for (let i = length - 1; i >= 0; i--) {
        out[i] = n & 0xff;
        n = Math.floor(n / 256);
    }
    return out;
}

export function u24(value) {
    const n = Math.max(0, Math.min(0xffffff, Math.round(Number(value) || 0)));
    return Uint8Array.of((n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

export function u32(value) {
    const n = Math.max(0, Math.min(0xffffffff, Math.round(Number(value) || 0)));
    return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

export function u64(value) {
    let n = BigInt(Math.max(0, Math.round(Number(value) || 0)));
    const out = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) {
        out[i] = Number(n & 0xffn);
        n >>= 8n;
    }
    return out;
}

export function readU24BE(bytes, off) {
    return (bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2];
}

export const h264BitstreamCodec = Object.freeze({
    concatBytes,
    bytesEqual,
    naluType,
    findAnnexBStartCode,
    splitLengthPrefixedNalUnits,
    joinLengthPrefixedNalUnits,
    splitAnnexBNalUnits,
    splitAnnexBUnits,
    detectLengthSizeAndSplitNalUnits,
    pickSeiInsertIndex,
    readSeiVarLen,
    appendSeiVarLen,
    insertEmulationPreventionBytes,
    decodeH264SeiRbspMessages,
    uintBE,
    u24,
    u32,
    u64,
    readU24BE,
});
