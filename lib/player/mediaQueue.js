export class MediaQueue {
    constructor({ maxSize = Infinity, onDrop = null } = {}) {
        this.maxSize = Number.isFinite(Number(maxSize)) && Number(maxSize) > 0 ? Number(maxSize) : Infinity;
        this.onDrop = typeof onDrop === "function" ? onDrop : null;
        this.items = [];
    }

    get size() {
        return this.items.length;
    }

    push(item) {
        this.items.push(item);
        while (this.items.length > this.maxSize) {
            const dropped = this.items.shift();
            if (this.onDrop) this.onDrop(dropped);
        }
        return item;
    }

    shift() {
        return this.items.shift() || null;
    }

    peek() {
        return this.items[0] || null;
    }

    clear(onClear = null) {
        const clearOne = typeof onClear === "function" ? onClear : this.onDrop;
        if (clearOne) {
            for (const item of this.items) clearOne(item);
        }
        this.items = [];
    }

    toArray() {
        return this.items.slice();
    }
}

export class FrameQueue extends MediaQueue {
    push(frameItem) {
        super.push(frameItem);
        this.items.sort((a, b) => {
            const at = Number(a?.ptsTime);
            const bt = Number(b?.ptsTime);
            if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
            return Number(a?.sequence || 0) - Number(b?.sequence || 0);
        });
        return frameItem;
    }

    dropBefore(mediaTimeSec, { keepLast = true } = {}) {
        const dropped = [];
        while (this.items.length > (keepLast ? 1 : 0)) {
            const head = this.items[0];
            const pts = Number(head?.ptsTime);
            if (!Number.isFinite(pts) || pts >= mediaTimeSec) break;
            dropped.push(this.items.shift());
        }
        if (this.onDrop) {
            for (const item of dropped) this.onDrop(item);
        }
        return dropped;
    }
}

export const mediaQueueCodec = {
    MediaQueue,
    FrameQueue,
};
