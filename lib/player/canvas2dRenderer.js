import { drawVideoFrameToCanvasContain } from "../browser/canvasFrameRender.js";

export class Canvas2DVideoRenderer {
    constructor(canvas, options = {}) {
        if (!canvas) throw new Error("canvas is required.");
        this.canvas = canvas;
        this.ctx = null;
        this.fitTo = options.fitTo || "parent";
        this.background = options.background || "#000";
        if (options.applyResponsiveStyle !== false) {
            this.canvas.style.display = this.canvas.style.display || "block";
            this.canvas.style.width = this.canvas.style.width || "100%";
            this.canvas.style.height = this.canvas.style.height || "100%";
        }
    }

    render(frame) {
        const result = drawVideoFrameToCanvasContain(frame, this.canvas, {
            fitTo: this.fitTo,
            background: this.background,
        });
        this.ctx = this.canvas.getContext("2d");
        return result;
    }

    clear() {
        const ctx = this.ctx || this.canvas.getContext("2d");
        if (!ctx) return;
        this.ctx = ctx;
        const box = this.canvas.parentElement?.getBoundingClientRect?.() || this.canvas.getBoundingClientRect?.();
        const width = Math.max(1, Math.round(Number(box?.width) || this.canvas.clientWidth || this.canvas.width || 1));
        const height = Math.max(1, Math.round(Number(box?.height) || this.canvas.clientHeight || this.canvas.height || 1));
        const dpr = Math.max(1, Math.min(3, Number(globalThis.devicePixelRatio) || 1));
        const backingWidth = Math.max(1, Math.round(width * dpr));
        const backingHeight = Math.max(1, Math.round(height * dpr));
        if (this.canvas.width !== backingWidth || this.canvas.height !== backingHeight) {
            this.canvas.width = backingWidth;
            this.canvas.height = backingHeight;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = this.background;
        ctx.fillRect(0, 0, width, height);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
}

export const canvas2dRendererCodec = {
    Canvas2DVideoRenderer,
};
