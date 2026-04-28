export class Canvas2DVideoRenderer {
    constructor(canvas) {
        if (!canvas) throw new Error("canvas is required.");
        this.canvas = canvas;
        this.ctx = null;
    }

    render(frame) {
        const ctx = this.ctx || this.canvas.getContext("2d");
        if (!ctx) throw new Error("2D context is unavailable.");
        this.ctx = ctx;
        const width = Number(frame?.displayWidth) || Number(frame?.codedWidth) || this.canvas.width || 1;
        const height = Number(frame?.displayHeight) || Number(frame?.codedHeight) || this.canvas.height || 1;
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        ctx.drawImage(frame, 0, 0);
    }

    clear() {
        const ctx = this.ctx || this.canvas.getContext("2d");
        if (!ctx) return;
        this.ctx = ctx;
        ctx.clearRect(0, 0, this.canvas.width || 0, this.canvas.height || 0);
    }
}

export const canvas2dRendererCodec = {
    Canvas2DVideoRenderer,
};
