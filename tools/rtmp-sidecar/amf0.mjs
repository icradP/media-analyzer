export function encodeAmf0Values(values) {
    return Buffer.concat(values.map((value) => encodeValue(value)));
}

export function decodeAmf0Values(bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = [];
    let offset = 0;
    while (offset < buffer.length) {
        const parsed = decodeValue(buffer, offset);
        values.push(parsed.value);
        offset = parsed.offset;
    }
    return values;
}

function encodeValue(value) {
    if (typeof value === "number") return encodeNumber(value);
    if (typeof value === "boolean") return Buffer.from([0x01, value ? 1 : 0]);
    if (typeof value === "string") return encodeString(value);
    if (value === null || value === undefined) return Buffer.from([0x05]);
    if (Array.isArray(value)) {
        return Buffer.concat([
            Buffer.from([0x0a]),
            u32be(value.length),
            ...value.map((item) => encodeValue(item)),
        ]);
    }
    if (typeof value === "object") return encodeObject(value);
    throw new TypeError(`Unsupported AMF0 value type: ${typeof value}`);
}

function encodeNumber(value) {
    const out = Buffer.alloc(9);
    out[0] = 0x00;
    out.writeDoubleBE(Number(value) || 0, 1);
    return out;
}

function encodeString(value) {
    const payload = Buffer.from(String(value), "utf8");
    if (payload.length > 0xffff) {
        return Buffer.concat([Buffer.from([0x0c]), u32be(payload.length), payload]);
    }
    return Buffer.concat([Buffer.from([0x02]), u16be(payload.length), payload]);
}

function encodeObject(value) {
    const chunks = [Buffer.from([0x03])];
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        const name = Buffer.from(String(key), "utf8");
        if (name.length > 0xffff) continue;
        chunks.push(u16be(name.length), name, encodeValue(item));
    }
    chunks.push(Buffer.from([0x00, 0x00, 0x09]));
    return Buffer.concat(chunks);
}

function decodeValue(buffer, offset) {
    if (offset >= buffer.length) throw new Error("Unexpected end of AMF0 data.");
    const marker = buffer[offset++];
    if (marker === 0x00) {
        if (offset + 8 > buffer.length) throw new Error("Truncated AMF0 number.");
        return { value: buffer.readDoubleBE(offset), offset: offset + 8 };
    }
    if (marker === 0x01) {
        if (offset >= buffer.length) throw new Error("Truncated AMF0 boolean.");
        return { value: buffer[offset] !== 0, offset: offset + 1 };
    }
    if (marker === 0x02) return decodeString(buffer, offset, 2);
    if (marker === 0x03) return decodeObject(buffer, offset);
    if (marker === 0x05 || marker === 0x06) return { value: null, offset };
    if (marker === 0x08) return decodeEcmaArray(buffer, offset);
    if (marker === 0x0a) return decodeStrictArray(buffer, offset);
    if (marker === 0x0b) {
        if (offset + 10 > buffer.length) throw new Error("Truncated AMF0 date.");
        return { value: new Date(buffer.readDoubleBE(offset)), offset: offset + 10 };
    }
    if (marker === 0x0c) return decodeString(buffer, offset, 4);
    throw new Error(`Unsupported AMF0 marker 0x${marker.toString(16)}.`);
}

function decodeString(buffer, offset, lengthBytes) {
    if (offset + lengthBytes > buffer.length) throw new Error("Truncated AMF0 string length.");
    const length = lengthBytes === 2 ? buffer.readUInt16BE(offset) : buffer.readUInt32BE(offset);
    offset += lengthBytes;
    if (offset + length > buffer.length) throw new Error("Truncated AMF0 string.");
    return { value: buffer.toString("utf8", offset, offset + length), offset: offset + length };
}

function decodeObject(buffer, offset) {
    const value = {};
    while (offset + 3 <= buffer.length) {
        if (buffer[offset] === 0 && buffer[offset + 1] === 0 && buffer[offset + 2] === 0x09) {
            return { value, offset: offset + 3 };
        }
        const nameLen = buffer.readUInt16BE(offset);
        offset += 2;
        if (offset + nameLen > buffer.length) throw new Error("Truncated AMF0 object key.");
        const key = buffer.toString("utf8", offset, offset + nameLen);
        offset += nameLen;
        const parsed = decodeValue(buffer, offset);
        value[key] = parsed.value;
        offset = parsed.offset;
    }
    throw new Error("Truncated AMF0 object.");
}

function decodeEcmaArray(buffer, offset) {
    if (offset + 4 > buffer.length) throw new Error("Truncated AMF0 ECMA array length.");
    return decodeObject(buffer, offset + 4);
}

function decodeStrictArray(buffer, offset) {
    if (offset + 4 > buffer.length) throw new Error("Truncated AMF0 strict array length.");
    const count = buffer.readUInt32BE(offset);
    offset += 4;
    const value = [];
    for (let i = 0; i < count; i++) {
        const parsed = decodeValue(buffer, offset);
        value.push(parsed.value);
        offset = parsed.offset;
    }
    return { value, offset };
}

function u16be(value) {
    const out = Buffer.alloc(2);
    out.writeUInt16BE(value & 0xffff, 0);
    return out;
}

function u32be(value) {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0, 0);
    return out;
}
