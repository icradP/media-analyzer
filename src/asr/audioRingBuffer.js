export class PcmRingBuffer {
    constructor(options = {}) {
        this.sampleRate = normalizeSampleRate(options.sampleRate);
        this.maxDurationMs = Math.max(1000, Number(options.maxDurationMs) || 30000);
        this.timelineStartMs = Math.max(0, Number(options.timelineStartMs) || 0);
        this.capacity = Math.max(1, Math.ceil((this.sampleRate * this.maxDurationMs) / 1000));
        this.buffer = new Float32Array(this.capacity);
        this.writeIndex = 0;
        this.length = 0;
        this.totalWritten = 0;
    }

    reset(options = {}) {
        if (Number.isFinite(Number(options.timelineStartMs))) this.timelineStartMs = Math.max(0, Number(options.timelineStartMs));
        this.buffer.fill(0);
        this.writeIndex = 0;
        this.length = 0;
        this.totalWritten = 0;
    }

    push(pcm) {
        if (!(pcm instanceof Float32Array) || pcm.length === 0) return;
        if (pcm.length >= this.capacity) {
            this.buffer.set(pcm.subarray(pcm.length - this.capacity));
            this.writeIndex = 0;
            this.length = this.capacity;
            this.totalWritten += pcm.length;
            return;
        }
        let srcOffset = 0;
        while (srcOffset < pcm.length) {
            const writable = Math.min(pcm.length - srcOffset, this.capacity - this.writeIndex);
            this.buffer.set(pcm.subarray(srcOffset, srcOffset + writable), this.writeIndex);
            this.writeIndex = (this.writeIndex + writable) % this.capacity;
            srcOffset += writable;
        }
        this.length = Math.min(this.capacity, this.length + pcm.length);
        this.totalWritten += pcm.length;
    }

    snapshotRecent(durationMs) {
        const requested = Math.max(1, Math.ceil((this.sampleRate * (Number(durationMs) || this.maxDurationMs)) / 1000));
        const count = Math.min(this.length, requested);
        const pcm = new Float32Array(count);
        const startIndex = (this.writeIndex - count + this.capacity) % this.capacity;
        if (count > 0) {
            const first = Math.min(count, this.capacity - startIndex);
            pcm.set(this.buffer.subarray(startIndex, startIndex + first), 0);
            if (first < count) pcm.set(this.buffer.subarray(0, count - first), first);
        }
        const startSample = Math.max(0, this.totalWritten - count);
        const endSample = this.totalWritten;
        return {
            pcm,
            sampleRate: this.sampleRate,
            startMs: this.timelineStartMs + (startSample / this.sampleRate) * 1000,
            endMs: this.timelineStartMs + (endSample / this.sampleRate) * 1000,
            durationMs: (count / this.sampleRate) * 1000,
        };
    }

    get durationMs() {
        return (this.length / this.sampleRate) * 1000;
    }
}

function normalizeSampleRate(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 16000;
}

export const audioRingBuffer = Object.freeze({ PcmRingBuffer });
