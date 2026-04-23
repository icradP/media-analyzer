/**
 * MPEG-TS 传输包完整解析。
 * 使用 `lib/core/Be.js`（含 `recordCompositeField`）；**不含** `_displayMetadata` / `payloadReader` / 默认 `_rawData`。
 */

import Be from "../core/Be.js";
import { MPEG_TS_SYNC_BYTE } from "./tsPacketSize.js";

/**
 * @param {Uint8Array} fileBytes
 * @param {number} byteOffset
 * @param {number} packetSize
 * @param {number} [packetIndex=0]
 * @param {{
 *   fieldOffsets?: object|null;
 *   includeRawPacketSlice?: boolean;
 * }} [options]
 */
export function parseTsTransportPacketFull(fileBytes, byteOffset, packetSize, packetIndex = 0, options = {}) {
    const { fieldOffsets: foOpt = null, includeRawPacketSlice = false } = options;
    if (byteOffset + packetSize > fileBytes.byteLength) return null;
    const c = byteOffset;
    const o = foOpt ?? null;
    const headerBytes = new Uint8Array(fileBytes.buffer, fileBytes.byteOffset + byteOffset, 4);
    const m = new Be(headerBytes, 0, byteOffset, o, "");
    const sync = m.readBits(8, "sync_byte");
    if (sync !== MPEG_TS_SYNC_BYTE) return null;
    const transport_error_indicator = m.readBits(1, "transport_error_indicator");
    const payload_unit_start_indicator = m.readBits(1, "payload_unit_start_indicator");
    const transport_priority = m.readBits(1, "transport_priority");
    const PID = m.readBits(13, "PID");
    const transport_scrambling_control = m.readBits(2, "transport_scrambling_control");
    const adaptation_field_control = m.readBits(2, "adaptation_field_control");
    const continuity_counter = m.readBits(4, "continuity_counter");
    const N = {
        index: packetIndex,
        offset: c,
        size: packetSize,
        sync_byte: sync,
        transport_error_indicator,
        payload_unit_start_indicator,
        transport_priority,
        PID,
        transport_scrambling_control,
        adaptation_field_control,
        continuity_counter,
        fieldOffsets: o,
        payloadUnitStartIndicator: payload_unit_start_indicator,
    };
    let A = 0;
    let L = c + 4;
    const x = adaptation_field_control;
    const r = fileBytes;
    if ((x === 2 || x === 3) && byteOffset + 5 <= r.byteLength) {
        const I = new Uint8Array(r.buffer, r.byteOffset + byteOffset + 4, 1);
        A = new Be(I, 0, byteOffset + 4, o, "adaptation_field").readBits(8, "length");
        if (A > 0 && byteOffset + 5 + A <= r.byteLength) {
            const F = new Uint8Array(r.buffer, r.byteOffset + byteOffset + 5, A);
            const E = new Be(F, 0, byteOffset + 5, o, "adaptation_field");
            const j = E.readBits(1, "discontinuity_indicator");
            const C = E.readBits(1, "random_access_indicator");
            const B = E.readBits(1, "elementary_stream_priority_indicator");
            const P = E.readBits(1, "PCR_flag");
            const k = E.readBits(1, "OPCR_flag");
            const U = E.readBits(1, "splicing_point_flag");
            const M = E.readBits(1, "transport_private_data_flag");
            const q = E.readBits(1, "adaptation_field_extension_flag");
            N.adaptation_field = {
                length: A,
                discontinuity_indicator: j,
                random_access_indicator: C,
                elementary_stream_priority_indicator: B,
                PCR_flag: P,
                OPCR_flag: k,
                splicing_point_flag: U,
                transport_private_data_flag: M,
                adaptation_field_extension_flag: q,
            };
            if (P) {
                const K = E.readBits(32, "program_clock_reference_base_high");
                const V = E.readBits(1, "program_clock_reference_base_low");
                const X = K * 2 + V;
                E.recordCompositeField(
                    "program_clock_reference_base",
                    ["program_clock_reference_base_high", "program_clock_reference_base_low"],
                    ["program_clock_reference_base_high", "program_clock_reference_base_low"],
                );
                E.readBits(6, "PCR_reserved");
                const te = E.readBits(9, "program_clock_reference_extension");
                N.adaptation_field.program_clock_reference_base = X;
                N.adaptation_field.program_clock_reference_extension = te;
                N.adaptation_field.PCR = X * 300 + te;
                E.recordCompositeField(
                    "PCR",
                    [
                        "program_clock_reference_base_high",
                        "program_clock_reference_base_low",
                        "PCR_reserved",
                        "program_clock_reference_extension",
                    ],
                    [
                        "program_clock_reference_base_high",
                        "program_clock_reference_base_low",
                        "program_clock_reference_extension",
                    ],
                );
            }
            if (k) {
                const K = E.readBits(32, "original_program_clock_reference_base_high");
                const V = E.readBits(1, "original_program_clock_reference_base_low");
                const X = K * 2 + V;
                E.recordCompositeField(
                    "original_program_clock_reference_base",
                    [
                        "original_program_clock_reference_base_high",
                        "original_program_clock_reference_base_low",
                    ],
                    [
                        "original_program_clock_reference_base_high",
                        "original_program_clock_reference_base_low",
                    ],
                );
                E.readBits(6, "OPCR_reserved");
                const te = E.readBits(9, "original_program_clock_reference_extension");
                N.adaptation_field.original_program_clock_reference_base = X;
                N.adaptation_field.original_program_clock_reference_extension = te;
                N.adaptation_field.OPCR = X * 300 + te;
                E.recordCompositeField(
                    "OPCR",
                    [
                        "original_program_clock_reference_base_high",
                        "original_program_clock_reference_base_low",
                        "OPCR_reserved",
                        "original_program_clock_reference_extension",
                    ],
                    [
                        "original_program_clock_reference_base_high",
                        "original_program_clock_reference_base_low",
                        "original_program_clock_reference_extension",
                    ],
                );
            }
            if (U) {
                N.adaptation_field.splice_countdown = E.readBits(8, "splice_countdown");
            }
            if (M) {
                const K = E.readBits(8, "transport_private_data_length");
                N.adaptation_field.transport_private_data_length = K;
                const priv = new Uint8Array(K);
                for (let X = 0; X < K; X++) priv[X] = E.readBits(8, `private_data_byte[${X}]`);
                N.adaptation_field.private_data_byte = priv;
            }
            if (q) {
                const K = E.readBits(8, "adaptation_field_extension_length");
                N.adaptation_field.adaptation_field_extension_length = K;
                const V = E.readBits(1, "extension.ltw_flag");
                const X = E.readBits(1, "extension.piecewise_rate_flag");
                const te = E.readBits(1, "extension.seamless_splice_flag");
                E.readBits(5, "extension.reserved");
                N.adaptation_field.extension = {
                    ltw_flag: V,
                    piecewise_rate_flag: X,
                    seamless_splice_flag: te,
                };
                if (V) {
                    const R = E.readBits(1, "extension.ltw_valid_flag");
                    const Y = E.readBits(15, "extension.ltw_offset");
                    N.adaptation_field.extension.ltw_valid_flag = R;
                    N.adaptation_field.extension.ltw_offset = Y;
                }
                if (X) {
                    E.readBits(2, "extension.piecewise_rate_reserved");
                    N.adaptation_field.extension.piecewise_rate = E.readBits(22, "extension.piecewise_rate");
                }
                if (te) {
                    const R = E.readBits(4, "extension.splice_type");
                    const Y = E.readBits(3, "extension.DTS_next_AU_32_30");
                    E.readBits(1, "extension.marker_bit_1");
                    const Z = E.readBits(15, "extension.DTS_next_AU_29_15");
                    E.readBits(1, "extension.marker_bit_2");
                    const ne = E.readBits(15, "extension.DTS_next_AU_14_0");
                    E.readBits(1, "extension.marker_bit_3");
                    const se = Y * 2 ** 30 + Z * 2 ** 15 + ne;
                    N.adaptation_field.extension.splice_type = R;
                    N.adaptation_field.extension.DTS_next_AU = se;
                }
                const W = E.getCurrentByteOffset();
                const Q = K - W + 1;
                for (let R = 0; R < Q; R++) E.readBits(8, `extension.reserved_byte[${R}]`);
            }
            const D = E.getCurrentByteOffset();
            const z = A - D;
            if (z > 0) {
                const stuff = new Uint8Array(z);
                for (let K = 0; K < z; K++) stuff[K] = E.readBits(8, `stuffing_byte[${K}]`);
                N.adaptation_field.stuffing_bytes = stuff;
            }
        }
        L = c + 4 + 1 + A;
    }
    if (x === 1 || x === 3) {
        const I = c + packetSize - L;
        if (I > 0 && L < c + packetSize) {
            N.payload = r.subarray(L, L + I);
            N.payloadOffset = L;
            N.payloadSize = I;
            if (o) {
                o.data_byte = { offset: L, length: I };
            }
        }
    }
    if (includeRawPacketSlice) {
        N._rawData = r.subarray(c, c + packetSize);
        N._byteOffset = c;
        N._byteLength = packetSize;
    }
    if (foOpt == null) {
        delete N.fieldOffsets;
    }
    return N;
}

export const tsTransportPacketFullCodec = Object.freeze({
    parseTsTransportPacketFull,
});
