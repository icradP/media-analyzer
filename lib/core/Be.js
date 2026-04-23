/**
 * Be (BitReader) - Directly extracted from original source.
 */
class Be {
    constructor(t, a = 0, i = 0, r = null, s = "", c = []) {
        this.data = t;
        this.byteOffset = a;
        this.bitPosition = a * 8;
        this.baseOffset = i;
        this.fieldOffsets = r;
        this.prefix = s;
        this.removedEmulationBytes = c;
        this.pendingFieldName = null;
        this.pendingFieldStartBitPos = 0;
    }

    startField(t) {
        this.pendingFieldName = t;
        this.pendingFieldStartBitPos = this.bitPosition;
    }

    _finishField() {
        if (this.pendingFieldName && this.fieldOffsets) {
            const t = this.pendingFieldStartBitPos;
            const a = Math.floor(t / 8);
            const i = Math.ceil(this.bitPosition / 8) - a;
            const r = this.prefix ? `${this.prefix}.${this.pendingFieldName}` : this.pendingFieldName;
            const s = t % 8;
            const c = this.bitPosition - t;
            this.fieldOffsets[r] = {
                offset: this.baseOffset + a,
                length: i > 0 ? i : 1,
                bitOffset: s,
                bitLength: c,
                startBitPos: t,
                removedEmulationBytes: this.removedEmulationBytes,
                bitReaderBaseOffset: this.baseOffset
            };
            this.pendingFieldName = null;
            this.pendingFieldStartBitPos = 0;
        }
    }

    /**
     * 将若干已记录的子字段合并为一条复合 `fieldOffsets`。
     * @param {string} compositeName
     * @param {string[]} childFieldNames — 不含 prefix 的短名，与 `readBits` 时传入的名称一致
     * @param {string[]|null} [highlightChildNames] — 可选，用于 `highlightRanges`
     */
    recordCompositeField(compositeName, childFieldNames, highlightChildNames = null) {
        if (!this.fieldOffsets || !compositeName || !childFieldNames || childFieldNames.length === 0) {
            return;
        }
        const prefixedComposite = this.prefix ? `${this.prefix}.${compositeName}` : compositeName;
        const prefixedChildren = childFieldNames.map((A) => (this.prefix ? `${this.prefix}.${A}` : A));
        const resolved = prefixedChildren.map((A) => this.fieldOffsets[A]).filter((A) => A !== undefined);
        if (resolved.length === 0) return;
        const first = resolved[0];
        const last = resolved[resolved.length - 1];
        const h = first.offset - this.baseOffset;
        const v = last.offset - this.baseOffset + last.length - h;
        const p = first.startBitPos;
        const b = last.startBitPos + last.bitLength - p;
        const T = p % 8;
        let highlightRanges = null;
        if (highlightChildNames && highlightChildNames.length > 0) {
            highlightRanges = highlightChildNames
                .map((L) => (this.prefix ? `${this.prefix}.${L}` : L))
                .map((L) => this.fieldOffsets[L])
                .filter((L) => L !== undefined)
                .map((L) => ({ startBitPos: L.startBitPos, bitLength: L.bitLength }));
        }
        /** 二进制展示的最大字节数（5） */
        const MAX_BYTES_FOR_BINARY = 5;
        this.fieldOffsets[prefixedComposite] = {
            offset: this.baseOffset + h,
            length: v > 0 ? v : 1,
            bitOffset: T,
            bitLength: b,
            startBitPos: p,
            removedEmulationBytes: this.removedEmulationBytes,
            bitReaderBaseOffset: this.baseOffset,
            noBinary: v > MAX_BYTES_FOR_BINARY,
            isComposite: true,
            subFields: prefixedChildren,
            highlightRanges: highlightRanges ?? undefined,
        };
    }

    _readBitsRaw(t) {
        let a = 0;
        for (let i = 0; i < t; i++) {
            const r = Math.floor(this.bitPosition / 8);
            const s = 7 - this.bitPosition % 8;
            if (r >= this.data.length) {
                throw new Error("BitReader: End of data");
            }
            const c = this.data[r] >> s & 1;
            a = a << 1 | c;
            this.bitPosition++;
        }
        return a;
    }

    readBits(t, a = null) {
        if (a) {
            this.startField(a);
        }
        const i = this._readBitsRaw(t);
        this._finishField();
        return i;
    }

    readUE(t = null) {
        if (t) {
            this.startField(t);
        }
        let a = 0;
        while (this._readBitsRaw(1) === 0) {
            a++;
            if (a > 32) {
                throw new Error("BitReader: Invalid UE code");
            }
        }
        let i;
        if (a === 0) {
            i = 0;
        } else {
            const r = this._readBitsRaw(a);
            i = (1 << a) - 1 + r;
        }
        this._finishField();
        return i;
    }

    readSE(t = null) {
        if (t) {
            this.startField(t);
        }
        let a = 0;
        while (this._readBitsRaw(1) === 0) {
            a++;
            if (a > 32) {
                throw new Error("BitReader: Invalid SE code");
            }
        }
        let i;
        if (a === 0) {
            i = 0;
        } else {
            const s = this._readBitsRaw(a);
            i = (1 << a) - 1 + s;
        }
        const r = Math.ceil(i / 2) * (i % 2 === 0 ? -1 : 1);
        this._finishField();
        return r;
    }

    byteAlign() {
        const t = this.bitPosition % 8;
        if (t !== 0) {
            this.bitPosition += 8 - t;
        }
    }

    skip(t) {
        this.bitPosition += t;
    }

    readString(t, a = null) {
        if (a) {
            this.startField(a);
        }
        let i = "";
        for (let r = 0; r < t; r++) {
            i += String.fromCharCode(this._readBitsRaw(8));
        }
        this._finishField();
        return i;
    }

    readVINT(t = null) {
        if (t) {
            this.startField(t);
        }
        this.byteAlign();
        const a = Math.floor(this.bitPosition / 8);
        if (a >= this.data.length) {
            throw new Error("BitReader: End of data while reading VINT");
        }
        const i = this.data[a];
        let r = 1;
        let s = 128;
        while ((i & s) === 0 && r < 8) {
            r++;
            s >>= 1;
        }
        if (a + r > this.data.length) {
            throw new Error("BitReader: Unexpected end of data while reading VINT");
        }
        const c = s - 1;
        let o = (i & c) === c;
        if (o) {
            for (let f = 1; f < r; f++) {
                if (this.data[a + f] !== 255) {
                    o = false;
                    break;
                }
            }
        }
        let m = i & c;
        for (let f = 1; f < r; f++) {
            m = m * 256 + this.data[a + f];
        }
        this.bitPosition += r * 8;
        this._finishField();
        return {
            value: m,
            bytesRead: r,
            isUnknownSize: o
        };
    }

    readUintBE(t, a = null) {
        if (a) {
            this.startField(a);
        }
        this.byteAlign();
        let i = 0;
        for (let r = 0; r < t; r++) {
            i = i * 256 + this._readBitsRaw(8);
        }
        this._finishField();
        return i;
    }

    readIntBE(t, a = null) {
        if (a) {
            this.startField(a);
        }
        this.byteAlign();
        if (t === 0) {
            this._finishField();
            return 0;
        }
        const i = this._readBitsRaw(8);
        const r = (i & 128) !== 0;
        let s = i & 127;
        for (let c = 1; c < t; c++) {
            s = s * 256 + this._readBitsRaw(8);
        }
        if (r) {
            s = s - Math.pow(2, t * 8 - 1);
        }
        this._finishField();
        return s;
    }

    readFloatBE(t, a = null) {
        if (a) {
            this.startField(a);
        }
        this.byteAlign();
        if (t !== 4 && t !== 8) {
            this._finishField();
            return 0;
        }
        if (Math.floor(this.bitPosition / 8) + t > this.data.length) {
            this._finishField();
            return 0;
        }
        const i = new ArrayBuffer(t);
        const r = new DataView(i);
        const s = new Uint8Array(i);
        for (let c = 0; c < t; c++) {
            s[c] = this._readBitsRaw(8);
        }
        this._finishField();
        if (t === 4) {
            return r.getFloat32(0, false);
        } else {
            return r.getFloat64(0, false);
        }
    }

    readUTF8(t, a = null) {
        if (a) {
            this.startField(a);
        }
        this.byteAlign();
        const i = Math.floor(this.bitPosition / 8);
        if (i + t > this.data.length) {
            t = this.data.length - i;
        }
        const r = this.data.slice(i, i + t);
        this.bitPosition += t * 8;
        let s = r.length;
        while (s > 0 && r[s - 1] === 0) {
            s--;
        }
        this._finishField();
        return new TextDecoder("utf-8").decode(r.slice(0, s));
    }

    readBytes(t, a = null) {
        if (a) {
            this.startField(a);
        }
        this.byteAlign();
        const i = Math.floor(this.bitPosition / 8);
        if (i + t > this.data.length) {
            t = this.data.length - i;
        }
        const r = this.data.slice(i, i + t);
        this.bitPosition += t * 8;
        this._finishField();
        return r;
    }

    hasMoreData() {
        return Math.floor(this.bitPosition / 8) < this.data.length;
    }

    /** 当前读指针所在字节下标（相对 `this.data`）。 */
    getCurrentByteOffset() {
        return Math.floor(this.bitPosition / 8);
    }

    getRemainingBytes() {
        return this.data.length - Math.floor(this.bitPosition / 8);
    }
}

export default Be;
