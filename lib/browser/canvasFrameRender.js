export function drawVideoFrameToCanvasContain(frame, canvas, options = {}) {
    if (!frame) return null;
    if (!canvas) throw new Error("canvas is required.");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context is unavailable.");

    const visibleRect = frame.visibleRect || {};
    const sourceX = finiteNumber(visibleRect.x, 0);
    const sourceY = finiteNumber(visibleRect.y, 0);
    const sourceWidth = finiteNumber(
        visibleRect.width,
        finiteNumber(
            frame.displayWidth,
            finiteNumber(frame.codedWidth, finiteNumber(frame.width, canvas.width || 1)),
        ),
    );
    const sourceHeight = finiteNumber(
        visibleRect.height,
        finiteNumber(
            frame.displayHeight,
            finiteNumber(frame.codedHeight, finiteNumber(frame.height, canvas.height || 1)),
        ),
    );
    const displayWidth = finiteNumber(frame.displayWidth, sourceWidth);
    const displayHeight = finiteNumber(frame.displayHeight, sourceHeight);
    const box = resolveCanvasDrawBox(canvas, displayWidth, displayHeight, options);
    const cssWidth = box.width;
    const cssHeight = box.height;
    const dpr = Math.max(1, Math.min(3, finiteNumber(options.devicePixelRatio, globalThis.devicePixelRatio || 1)));
    const backingWidth = Math.max(1, Math.round(cssWidth * dpr));
    const backingHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
        canvas.width = backingWidth;
        canvas.height = backingHeight;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (options.clear !== false) {
        ctx.fillStyle = options.background || "#000";
        ctx.fillRect(0, 0, cssWidth, cssHeight);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const scale = Math.min(cssWidth / displayWidth, cssHeight / displayHeight);
    const drawWidth = Math.max(1, displayWidth * scale);
    const drawHeight = Math.max(1, displayHeight * scale);
    const dx = (cssWidth - drawWidth) / 2;
    const dy = (cssHeight - drawHeight) / 2;

    try {
        ctx.drawImage(frame, dx, dy, drawWidth, drawHeight);
    } catch {
        ctx.drawImage(frame, sourceX, sourceY, sourceWidth, sourceHeight, dx, dy, drawWidth, drawHeight);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return {
        sourceWidth,
        sourceHeight,
        displayWidth,
        displayHeight,
        canvasWidth: backingWidth,
        canvasHeight: backingHeight,
        drawWidth,
        drawHeight,
        dx,
        dy,
    };
}

function finiteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveCanvasDrawBox(canvas, fallbackWidth, fallbackHeight, options) {
    const preferParent = options.fitTo === "parent" || options.fitTo === "container";
    const parentBounds = preferParent ? canvas.parentElement?.getBoundingClientRect?.() : null;
    const ownBounds = canvas.getBoundingClientRect?.();
    const bounds = hasUsableBounds(parentBounds) ? parentBounds : ownBounds;
    return {
        width: Math.max(1, Math.round(finiteNumber(bounds?.width, canvas.clientWidth || fallbackWidth))),
        height: Math.max(1, Math.round(finiteNumber(bounds?.height, canvas.clientHeight || fallbackHeight))),
    };
}

function hasUsableBounds(bounds) {
    return Number.isFinite(bounds?.width) && bounds.width > 1 && Number.isFinite(bounds?.height) && bounds.height > 1;
}

export const canvasFrameRenderCodec = {
    drawVideoFrameToCanvasContain,
};
