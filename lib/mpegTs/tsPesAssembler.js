/**
 * TS → PES 拼包状态机。
 * 仅处理数据装配；不含 `yb` 帧提取。
 */

/**
 * @typedef {object} TsPesAssemblerStateItem
 * @property {object|null} currentPES
 * @property {Uint8Array[]} pesBufferArray
 * @property {object|null} lastPacket
 */

/** @returns {TsPesAssemblerStateItem} */
export function createTsPesAssemblerStateItem() {
    return {
        currentPES: null,
        pesBufferArray: [],
        lastPacket: null,
    };
}

/**
 * @param {TsPesAssemblerStateItem} state
 * @param {object[]} outPesPackets
 */
export function flushTsPesState(state, outPesPackets) {
    if (!state.currentPES || state.pesBufferArray.length === 0) return;
    const total = state.pesBufferArray.reduce((sum, part) => sum + part.length, 0);
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const part of state.pesBufferArray) {
        buffer.set(part, offset);
        offset += part.length;
    }
    state.currentPES.buffer = buffer;
    state.currentPES.size = total;
    state.currentPES.endPacketIndex = state.lastPacket ? state.lastPacket.index : state.currentPES.startPacketIndex;
    state.currentPES.byteLength = state.lastPacket
        ? state.lastPacket.offset + state.lastPacket.size - state.currentPES.offset
        : total;
    outPesPackets.push(state.currentPES);
}

/**
 * 给定已知 PID 流映射，只收集音视频等已识别 PID 的 PES。
 *
 * @param {object} packet — TS packet
 * @param {Map<number, object>} streamMap
 * @param {Map<number, TsPesAssemblerStateItem>} assemblerMap
 * @param {object[]} outPesPackets
 * @param {Map<number, number>|null} [maxPtsByPid]
 */
export function pushTsPacketToPesAssembler(packet, streamMap, assemblerMap, outPesPackets, maxPtsByPid = null) {
    if (!streamMap.get(packet.PID) || !packet.payload || packet.payload.length === 0) return;
    if (!assemblerMap.has(packet.PID)) {
        assemblerMap.set(packet.PID, createTsPesAssemblerStateItem());
    }
    const state = assemblerMap.get(packet.PID);
    if (!state) return;

    if (packet.payload_unit_start_indicator === 1) {
        if (state.currentPES && state.pesBufferArray.length > 0) {
            flushTsPesState(state, outPesPackets);
        }
        const f = packet.payload;
        if (f.length >= 6 && f[0] === 0 && f[1] === 0 && f[2] === 1) {
            const stream_id = f[3];
            const PES_packet_length = (f[4] << 8) | f[5];
            const pes = {
                fieldOffsets: {},
                _rawData: new Uint8Array(0),
                _byteOffset: packet.payloadOffset || 0,
                _byteLength: 0,
                buffer: null,
                offset: packet.payloadOffset || 0,
                size: 0,
                byteLength: 0,
                pid: packet.PID,
                stream_id,
                PES_packet_length,
                startPacketIndex: packet.index,
                endPacketIndex: packet.index,
                pts: undefined,
                dts: undefined,
                isKeyframe: false,
            };
            state.currentPES = pes;
            if (packet.adaptation_field?.random_access_indicator) {
                pes.isKeyframe = true;
            }
            if (f.length >= 9) {
                const flags = (f[7] >> 6) & 3;
                if (flags >= 2 && f.length >= 14) {
                    const p = (f[9] >> 1) & 7;
                    const hi = ((f[10] << 7) | (f[11] >> 1)) & 32767;
                    const lo = ((f[12] << 7) | (f[13] >> 1)) & 32767;
                    pes.pts = p * 2 ** 30 + hi * 2 ** 15 + lo;
                    if (maxPtsByPid && pes.pts !== undefined) {
                        const prev = maxPtsByPid.get(packet.PID) ?? 0;
                        if (pes.pts > prev) maxPtsByPid.set(packet.PID, pes.pts);
                    }
                    if (flags === 3 && f.length >= 19) {
                        const dp = (f[14] >> 1) & 7;
                        const dhi = ((f[15] << 7) | (f[16] >> 1)) & 32767;
                        const dlo = ((f[17] << 7) | (f[18] >> 1)) & 32767;
                        pes.dts = dp * 2 ** 30 + dhi * 2 ** 15 + dlo;
                    }
                }
            }
            state.pesBufferArray = [f];
        } else {
            state.pesBufferArray = [];
            state.currentPES = null;
        }
    } else if (state.currentPES) {
        state.pesBufferArray.push(packet.payload);
        if (packet.adaptation_field?.random_access_indicator) {
            state.currentPES.isKeyframe = true;
        }
    }
    state.lastPacket = packet;
}

/**
 * flush 所有 PID 状态。
 * @param {Map<number, TsPesAssemblerStateItem>} assemblerMap
 * @param {object[]} outPesPackets
 */
export function flushAllTsPesAssemblerStates(assemblerMap, outPesPackets) {
    for (const [, state] of assemblerMap.entries()) {
        flushTsPesState(state, outPesPackets);
    }
}

export const tsPesAssemblerCodec = Object.freeze({
    createTsPesAssemblerStateItem,
    flushTsPesState,
    pushTsPacketToPesAssembler,
    flushAllTsPesAssemblerStates,
});
