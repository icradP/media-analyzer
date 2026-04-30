import Be from './Be.js';

/** MP4Parser. */
export const MP4Parser = {
    /**
     * Parse MP4 Box.
     */
    parseBox(t, a, i, r, s = {}) {
        if (a + 8 > t.byteLength) return null;

        const c = t.getUint32(a);
        const o = String.fromCharCode(t.getUint8(a + 4), t.getUint8(a + 5), t.getUint8(a + 6), t.getUint8(a + 7));
        let f = 8;
        let m = c;

        if (c === 1) {
            m = Number(t.getBigUint64(a + 8));
            f = 16;
        } else if (c === 0) {
            m = t.byteLength - a;
        }

        if (m < 8 || a + m > t.byteLength) return null;

        const h = {
            type: o,
            size: m,
            offset: a,
            headerSize: f,
            dataOffset: a + f,
            dataSize: m - f,
            fieldOffsets: s
        };

        const g = ["moov", "trak", "mdia", "minf", "stbl", "moof", "traf", "dinf", "edts"];
        if (g.includes(o)) {
            h.children = this.parseChildren(t, h.dataOffset, h.dataSize, i, r, s);
        } else if (o === "stsd") {
            h.data = this.parseSTSD(t, h.dataOffset, h.dataSize, i, r, s);
            h.children = h.data.entries;
        } else {
            this.parseBoxData(t, h);
        }

        return h;
    },

    parseChildren(t, a, i, r, s, c) {
        const o = [];
        let f = a;
        const m = a + i;
        while (f < m) {
            const h = this.parseBox(t, f, r, s, c);
            if (!h) break;
            o.push(h);
            f += h.size;
        }
        return o;
    },

    parseSTSD(t, a, i, r, s, c) {
        const o = new Uint8Array(t.buffer, a, 8);
        const f = new Be(o, 0, a, c, "");
        const m = f.readBits(8, "version");
        const h = f.readBits(24, "flags");
        const g = f.readUintBE(4, "entryCount");
        
        const v = [];
        let p = a + 8;
        for (let S = 0; S < g; S++) {
            const b = t.getUint32(p);
            const x = String.fromCharCode(t.getUint8(p + 4), t.getUint8(p + 5), t.getUint8(p + 6), t.getUint8(p + 7));
            
            const C = {
                type: x,
                size: b,
                offset: p,
                dataOffset: p + 8,
                dataSize: b - 8
            };

            if (["avc1", "avc3", "hvc1", "hev1"].includes(x)) {
                // Video Sample Entry
                C.width = t.getUint16(p + 24 + 8);
                C.height = t.getUint16(p + 26 + 8);
                C.children = this.parseChildren(t, p + 86, b - 86, r, s, c);
                
                const B = C.children.find(k => k.type === "avcC" || k.type === "hvcC");
                if (B) {
                    C.config = B.data;
                }
            } else if (x === "mp4a") {
                // Audio Sample Entry
                C.channelCount = t.getUint16(p + 24);
                C.sampleSize = t.getUint16(p + 26);
                const sampleRateFixed = t.getUint32(p + 32);
                C.sampleRate = sampleRateFixed >>> 16;
                C.children = this.parseChildren(t, p + 36, b - 36, r, s, c);
            }

            v.push(C);
            p += b;
        }

        return { version: m, flags: h, entryCount: g, entries: v };
    },

    parseBoxData(t, a) {
        const i = new Uint8Array(t.buffer, a.dataOffset, a.dataSize);
        const r = new Be(i, 0, a.dataOffset, a.fieldOffsets, "");
        try {
            switch (a.type) {
                case "avcC":
                    a.data = this.parseAVCC(i, a.dataOffset, a.dataSize);
                    break;
                case "hvcC":
                    a.data = this.parseHVCC(i, a.dataOffset, a.dataSize);
                    break;
                case "mvhd":
                case "mdhd":
                    const v = r.readBits(8, "version");
                    r.skip(24);
                    if (v === 1) {
                        r.skip(128);
                        a.data = { timescale: r.readUintBE(4, "timescale"), duration: Number(r.readUintBE(8, "duration")) };
                    } else {
                        r.skip(64);
                        a.data = { timescale: r.readUintBE(4, "timescale"), duration: r.readUintBE(4, "duration") };
                    }
                    break;
                case "tkhd":
                    const tkVer = r.readBits(8, "version");
                    r.skip(24);
                    if (tkVer === 1) {
                        r.skip(64); // creation_time
                        r.skip(64); // modification_time
                        const trackId = r.readUintBE(4, "trackId");
                        r.skip(32); // reserved
                        const duration = Number(r.readUintBE(8, "duration"));
                        a.data = { trackId, duration };
                    } else {
                        r.skip(32); // creation_time
                        r.skip(32); // modification_time
                        const trackId = r.readUintBE(4, "trackId");
                        r.skip(32); // reserved
                        const duration = r.readUintBE(4, "duration");
                        a.data = { trackId, duration };
                    }
                    break;
                case "elst":
                    const edv = new DataView(i.buffer, i.byteOffset, i.byteLength);
                    const elVersion = edv.getUint8(0);
                    const entryCount = edv.getUint32(4);
                    let off = 8;
                    const entries = [];
                    for (let e = 0; e < entryCount; e++) {
                        let segmentDuration;
                        let mediaTime;
                        if (elVersion === 1) {
                            segmentDuration = Number(edv.getBigUint64(off));
                            const mt = edv.getBigInt64(off + 8);
                            mediaTime = Number(mt);
                            off += 16;
                        } else {
                            segmentDuration = edv.getUint32(off);
                            const mt = edv.getInt32(off + 4);
                            mediaTime = mt;
                            off += 8;
                        }
                        const mediaRateInteger = edv.getInt16(off);
                        const mediaRateFraction = edv.getInt16(off + 2);
                        off += 4;
                        entries.push({
                            segmentDuration,
                            mediaTime,
                            mediaRateInteger,
                            mediaRateFraction,
                        });
                    }
                    a.data = { version: elVersion, entries };
                    break;
                case "hdlr":
                    r.skip(32);
                    r.skip(32);
                    a.data = { handlerType: r.readString(4, "handlerType") };
                    break;
                case "stsz":
                    r.skip(32);
                    const sampleSize = r.readUintBE(4, "sampleSize");
                    const sampleCount = r.readUintBE(4, "sampleCount");
                    const entrySizes = [];
                    if (sampleSize === 0) {
                        for (let S = 0; S < sampleCount; S++) entrySizes.push(r.readUintBE(4));
                    }
                    a.data = { sampleSize, sampleCount, entrySizes };
                    break;
                case "stco":
                    r.skip(32);
                    const coCount = r.readUintBE(4, "entryCount");
                    const offsets = [];
                    for (let S = 0; S < coCount; S++) offsets.push(r.readUintBE(4));
                    a.data = { offsets };
                    break;
                case "co64":
                    r.skip(32);
                    const co64Count = r.readUintBE(4, "entryCount");
                    const offsets64 = [];
                    for (let S = 0; S < co64Count; S++) {
                        offsets64.push(Number(r.readUintBE(8)));
                    }
                    a.data = { offsets: offsets64 };
                    break;
                case "stsc":
                    r.skip(32);
                    const scCount = r.readUintBE(4, "entryCount");
                    const scEntries = [];
                    for (let S = 0; S < scCount; S++) {
                        scEntries.push({
                            firstChunk: r.readUintBE(4),
                            samplesPerChunk: r.readUintBE(4),
                            sampleDescriptionIndex: r.readUintBE(4)
                        });
                    }
                    a.data = { entries: scEntries };
                    break;
                case "stts":
                    r.skip(32);
                    const sttsCount = r.readUintBE(4, "entryCount");
                    const sttsEntries = [];
                    for (let S = 0; S < sttsCount; S++) {
                        sttsEntries.push({
                            count: r.readUintBE(4),
                            delta: r.readUintBE(4)
                        });
                    }
                    a.data = { entries: sttsEntries };
                    break;
                case "ctts":
                    const cttsVersion = r.readBits(8, "version");
                    r.skip(24);
                    const cttsCount = r.readUintBE(4, "entryCount");
                    const cttsEntries = [];
                    for (let S = 0; S < cttsCount; S++) {
                        const sampleCount = r.readUintBE(4);
                        const rawOffset = r.readUintBE(4);
                        const sampleOffset = cttsVersion === 0 ? rawOffset : (rawOffset << 0);
                        cttsEntries.push({
                            sampleCount,
                            sampleOffset,
                        });
                    }
                    a.data = { version: cttsVersion, entries: cttsEntries };
                    break;
                case "stss":
                    r.skip(32);
                    const stssCount = r.readUintBE(4, "entryCount");
                    const syncSamples = [];
                    for (let S = 0; S < stssCount; S++) syncSamples.push(r.readUintBE(4));
                    a.data = { syncSamples };
                    break;
            }
        } catch (e) {}
    },

    parseAVCC(t, a, i) {
        const r = new Be(t, 0, a, {}, "");
        const s = {
            version: r.readBits(8),
            profile: r.readBits(8),
            compatibility: r.readBits(8),
            level: r.readBits(8),
            lengthSizeMinusOne: r.readBits(8) & 3,
            sps: [],
            pps: []
        };
        const c = r.readBits(8) & 31;
        for (let o = 0; o < c; o++) {
            const f = r.readUintBE(2);
            s.sps.push(t.slice(Math.floor(r.bitPosition / 8), Math.floor(r.bitPosition / 8) + f));
            r.skip(f * 8);
        }
        const m = r.readBits(8);
        for (let o = 0; o < m; o++) {
            const f = r.readUintBE(2);
            s.pps.push(t.slice(Math.floor(r.bitPosition / 8), Math.floor(r.bitPosition / 8) + f));
            r.skip(f * 8);
        }
        return s;
    },

    parseHVCC(t, a, i) {
        const r = new Be(t, 0, a, {}, "");
        const s = {
            version: r.readBits(8),
            sps: [], pps: [], vps: []
        };
        const profileTierByte = r.readBits(8);
        s.general_profile_space = (profileTierByte >> 6) & 0x03;
        s.general_tier_flag = (profileTierByte >> 5) & 0x01;
        s.profile = profileTierByte & 0x1f;
        s.general_profile_compatibility_flags = r.readUintBE(4);
        s.general_constraint_indicator_flags = [
            r.readBits(8),
            r.readBits(8),
            r.readBits(8),
            r.readBits(8),
            r.readBits(8),
            r.readBits(8),
        ];
        s.level = r.readBits(8);
        r.skip(4);
        s.min_spatial_segmentation_idc = r.readBits(12);
        r.skip(6);
        s.parallelismType = r.readBits(2);
        r.skip(6);
        s.chroma = r.readBits(2);
        r.skip(5);
        s.bitDepthLumaMinus8 = r.readBits(3);
        r.skip(5);
        s.bitDepthChromaMinus8 = r.readBits(3);
        s.avgFrameRate = r.readUintBE(2);
        r.skip(8);
        const c = r.readBits(8);
        for (let o = 0; o < c; o++) {
            const f = r.readBits(8) & 63;
            const m = r.readUintBE(2);
            for (let h = 0; h < m; h++) {
                const g = r.readUintBE(2);
                const v = t.slice(Math.floor(r.bitPosition / 8), Math.floor(r.bitPosition / 8) + g);
                if (f === 32) s.vps.push(v);
                else if (f === 33) s.sps.push(v);
                else if (f === 34) s.pps.push(v);
                r.skip(g * 8);
            }
        }
        return s;
    },

    async parse(t) {
        const a = new DataView(t.buffer, t.byteOffset, t.byteLength);
        let i = 0;
        const r = [];
        while (i < t.byteLength) {
            const s = this.parseBox(a, i, null, null);
            if (!s) break;
            r.push(s);
            i += s.size;
        }
        return {
            boxes: r
        };
    }
};

export default MP4Parser;
