export const HEX_VIEW_BYTES_PER_LINE = Object.freeze({
    LARGE: 16,
    MEDIUM: 8,
    SMALL: 4,
});

export const HEX_VIEW_BREAKPOINTS = Object.freeze({
    MEDIUM_MAX_WIDTH: 500,
    SMALL_MAX_WIDTH: 350,
});

export function computeHexBytesPerLine(containerWidth) {
    const width = Number(containerWidth || 0);
    if (width > 0 && width < HEX_VIEW_BREAKPOINTS.SMALL_MAX_WIDTH) return HEX_VIEW_BYTES_PER_LINE.SMALL;
    if (width > 0 && width < HEX_VIEW_BREAKPOINTS.MEDIUM_MAX_WIDTH) return HEX_VIEW_BYTES_PER_LINE.MEDIUM;
    return HEX_VIEW_BYTES_PER_LINE.LARGE;
}

function readFieldPath(obj, path) {
    if (!obj || !path) return null;
    if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
    const parts = String(path).split(".");
    let cur = obj;
    for (const part of parts) {
        if (!cur || typeof cur !== "object") return null;
        if (!Object.prototype.hasOwnProperty.call(cur, part)) return null;
        cur = cur[part];
    }
    return cur;
}

export function resolveSelectedFieldRange(selectedField, fieldOffsets) {
    if (!selectedField || !fieldOffsets || typeof fieldOffsets !== "object") return null;
    const hit = readFieldPath(fieldOffsets, selectedField);
    if (!hit || typeof hit !== "object") return null;
    if (typeof hit.offset === "number" && typeof hit.length === "number") {
        return { offset: hit.offset, length: hit.length };
    }
    return null;
}

export function buildHexViewRows(rawData, options = {}) {
    const bytes = rawData instanceof Uint8Array ? rawData : null;
    if (!bytes) return [];
    const bytesPerLine = options.bytesPerLine || HEX_VIEW_BYTES_PER_LINE.LARGE;
    const showAscii = options.showAscii !== false;
    const highlightOffset = options.highlightOffset ?? -1;
    const highlightLength = options.highlightLength ?? 0;
    const removed = new Set(Array.isArray(options.removedEmulationPositions) ? options.removedEmulationPositions : []);
    const rows = [];
    for (let rowStart = 0; rowStart < bytes.length; rowStart += bytesPerLine) {
        const rowBytes = [];
        let ascii = "";
        for (let i = 0; i < bytesPerLine; i++) {
            const index = rowStart + i;
            if (index >= bytes.length) break;
            const value = bytes[index];
            const highlighted =
                highlightOffset >= 0 &&
                highlightLength > 0 &&
                index >= highlightOffset &&
                index < highlightOffset + highlightLength;
            const isRemoved = removed.has(index);
            const isSeparator =
                bytesPerLine === HEX_VIEW_BYTES_PER_LINE.LARGE &&
                i === 7;
            rowBytes.push({
                index,
                value,
                hex: value.toString(16).toUpperCase().padStart(2, "0"),
                highlighted,
                isRemoved,
                isSeparator,
            });
            if (showAscii) {
                ascii += value >= 32 && value <= 126 ? String.fromCharCode(value) : ".";
            }
        }
        rows.push({
            rowStart,
            offsetHex: rowStart.toString(16).toUpperCase().padStart(8, "0"),
            bytes: rowBytes,
            ascii: showAscii ? ascii : null,
        });
    }
    return rows;
}

export const hexDataViewModelCodec = Object.freeze({
    HEX_VIEW_BYTES_PER_LINE,
    HEX_VIEW_BREAKPOINTS,
    computeHexBytesPerLine,
    resolveSelectedFieldRange,
    buildHexViewRows,
});
