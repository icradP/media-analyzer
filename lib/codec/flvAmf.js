/**
 * AMF0 与 Script tag 体：**仅数据处理**（`DataView` 字节区间 → 值与 `fieldOffsets`），无 UI。
 */

import Be from "../core/Be.js";

/**
 * @param {DataView} view
 * @param {number} offset
 * @param {number} end — 不包含的上界（脚本体末尾）
 * @param {string} [fieldPrefix=""]
 */
export function readAmfValue(view, offset, end, fieldPrefix = "") {
    if (offset >= end || offset >= view.byteLength) {
        return { value: null, bytesRead: 0, fieldOffsets: {} };
    }
    const type = view.getUint8(offset);
    let consumed = 1;
    let value = null;
    const fieldOffsets = {};
    try {
        switch (type) {
            case 0:
                if (offset + 9 <= view.byteLength) {
                    value = view.getFloat64(offset + 1);
                    consumed = 9;
                }
                break;
            case 1:
                if (offset + 2 <= view.byteLength) {
                    value = view.getUint8(offset + 1) !== 0;
                    consumed = 2;
                }
                break;
            case 2:
                if (offset + 3 <= view.byteLength) {
                    const strLen = view.getUint16(offset + 1);
                    if (offset + 3 + strLen <= view.byteLength) {
                        const raw = new Uint8Array(view.buffer, view.byteOffset + offset + 3, strLen);
                        value = new TextDecoder("utf-8").decode(raw);
                        consumed = 3 + strLen;
                    }
                }
                break;
            case 3: {
                const m = readAmfStrictObject(view, offset, end, fieldPrefix);
                value = m.value;
                consumed = m.bytesRead;
                Object.assign(fieldOffsets, m.fieldOffsets);
                break;
            }
            case 8: {
                const m = readAmfEcmaArray(view, offset, end, fieldPrefix);
                value = m.value;
                consumed = m.bytesRead;
                Object.assign(fieldOffsets, m.fieldOffsets);
                break;
            }
            case 10: {
                const m = readAmfStrictArray(view, offset, end);
                value = m.value;
                consumed = m.bytesRead;
                break;
            }
            case 11:
                if (offset + 11 <= view.byteLength) {
                    const ms = view.getFloat64(offset + 1);
                    const tz = view.getInt16(offset + 9);
                    const d = new Date(ms);
                    d._timezone = tz;
                    value = d;
                    consumed = 11;
                }
                break;
            case 5:
                value = null;
                consumed = 1;
                break;
            case 6:
                value = undefined;
                consumed = 1;
                break;
            default:
                console.warn(`Unknown AMF type: ${type} at offset ${offset}`);
                consumed = 1;
                break;
        }
    } catch (e) {
        console.warn("Error parsing AMF value:", e);
    }
    return { value, bytesRead: consumed, fieldOffsets };
}

export function readAmfStrictObject(view, offset, end, fieldPrefix = "") {
    const out = {};
    let pos = offset + 1;
    const fieldOffsets = {};
    for (; pos + 3 <= view.byteLength && pos < end;) {
        const keyLen = view.getUint16(pos);
        const keyStart = pos;
        pos += 2;
        if (keyLen === 0 && pos < view.byteLength && view.getUint8(pos) === 9) {
            const endKey = fieldPrefix ? `${fieldPrefix}._objectEnd` : "_objectEnd";
            fieldOffsets[endKey] = { offset: keyStart, length: 3 };
            out._objectEnd = "Object End (0x000009)";
            pos += 1;
            break;
        }
        if (pos + keyLen > view.byteLength || pos + keyLen > end) break;
        const keyRaw = new Uint8Array(view.buffer, view.byteOffset + pos, keyLen);
        const key = new TextDecoder("utf-8").decode(keyRaw);
        pos += keyLen;
        const { value: child, bytesRead: br, fieldOffsets: fo } = readAmfValue(view, pos, end);
        out[key] = child;
        pos += br;
        const label = fieldPrefix ? `${fieldPrefix}.${key}` : key;
        fieldOffsets[label] = { offset: keyStart, length: pos - keyStart };
        if (fo) Object.assign(fieldOffsets, fo);
    }
    return { value: out, bytesRead: pos - offset, fieldOffsets };
}

export function readAmfEcmaArray(view, offset, end, fieldPrefix = "") {
    if (offset + 5 > view.byteLength) {
        return { value: null, bytesRead: 1, fieldOffsets: {} };
    }
    const denseLen = view.getUint32(offset + 1);
    const fieldOffsets = {};
    let pos = offset + 5;
    let denseEnd = -1;
    const out = {};
    for (; pos + 3 <= view.byteLength && pos < end;) {
        const keyLen = view.getUint16(pos);
        const keyStart = pos;
        pos += 2;
        if (keyLen === 0 && pos < view.byteLength && view.getUint8(pos) === 9) {
            denseEnd = keyStart;
            pos += 1;
            break;
        }
        if (pos + keyLen > view.byteLength || pos + keyLen > end) break;
        const keyRaw = new Uint8Array(view.buffer, view.byteOffset + pos, keyLen);
        const key = new TextDecoder("utf-8").decode(keyRaw);
        pos += keyLen;
        const { value: child, bytesRead: br } = readAmfValue(view, pos, end);
        out[key] = child;
        pos += br;
        const label = fieldPrefix ? `${fieldPrefix}.${key}` : key;
        fieldOffsets[label] = { offset: keyStart, length: pos - keyStart };
    }
    if (denseEnd >= 0) {
        const endKey = fieldPrefix ? `${fieldPrefix}._objectEnd` : "_objectEnd";
        fieldOffsets[endKey] = { offset: denseEnd, length: 3 };
        out._objectEnd = "Object End (0x000009)";
    }
    out._amfArrayLength = denseLen;
    return { value: out, bytesRead: pos - offset, fieldOffsets };
}

export function readAmfStrictArray(view, offset, end) {
    if (offset + 5 > view.byteLength) {
        return { value: null, bytesRead: 1, fieldOffsets: {} };
    }
    const count = view.getUint32(offset + 1);
    const arr = [];
    let pos = offset + 5;
    for (let i = 0; i < count && pos < end; i++) {
        const { value, bytesRead } = readAmfValue(view, pos, end);
        arr.push(value);
        pos += bytesRead;
    }
    return { value: arr, bytesRead: pos - offset, fieldOffsets: {} };
}

/**
 * @param {Be} reader — tag body，`baseOffset` 为体在文件中的起点
 * @param {number} dataSize
 * @param {Record<string, unknown>} tag — 写入 script 相关字段
 */
export function parseFlvScriptTagBody(reader, dataSize, tag) {
    if (dataSize < 1) return;
    const base = reader.baseOffset;
    const end = base + dataSize;
    const view = new DataView(reader.data.buffer);
    let pos = base;
    if (!tag.fieldOffsets) tag.fieldOffsets = {};
    try {
        const { value: scriptName, bytesRead: nameLen, fieldOffsets: nameFo } = readAmfValue(
            view,
            pos,
            end,
            "scriptName",
        );
        pos += nameLen;
        if (scriptName === "onMetaData") {
            tag.scriptName = scriptName;
            tag.fieldOffsets.scriptName = { offset: base, length: nameLen };
            if (nameFo) Object.assign(tag.fieldOffsets, nameFo);
            if (pos < end) {
                const metaType = view.getUint8(pos);
                tag.metadataType = metaType;
                if (metaType === 8 && pos + 5 <= end) {
                    tag.metadataArraySize = view.getUint32(pos + 1, false);
                }
            }
            const metaStart = pos;
            const { value: meta, bytesRead: metaLen, fieldOffsets: metaFo } = readAmfValue(view, metaStart, end, "metadata");
            if (meta && typeof meta === "object") {
                tag.metadata = meta;
                tag.fieldOffsets.metadata = { offset: metaStart, length: metaLen };
                if (metaFo) Object.assign(tag.fieldOffsets, metaFo);
            }
        } else {
            tag.scriptName = scriptName || "Unknown";
            tag.scriptDataError = "Script Data (AMF)";
        }
    } catch (e) {
        console.warn("Failed to parse AMF data:", e);
        tag.scriptDataError = "Script Data (AMF - Parse Error)";
    }
}

export const flvAmfCodec = Object.freeze({
    readAmfValue,
    readAmfStrictObject,
    readAmfEcmaArray,
    readAmfStrictArray,
    parseFlvScriptTagBody,
});
