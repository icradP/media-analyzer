/**
 * HEVC SPS short_term_ref_pic_set（H.265 7.3.7）。
 * 用于在 num_short_term_ref_pic_sets > 0 时消费比特，避免后续 VUI 错位。
 */

/**
 * @param {import("../core/Be.js").default} reader
 * @param {number} stRpsIdx
 * @param {number} numShortTermRefPicSets
 * @param {number} spsMaxDecPicBufferingMinus1 当前 sublayer 的 sps_max_dec_pic_buffering_minus1
 * @param {Array<{ numDeltaPocs: number }>} prevSets 已成功解析的集合，供 inter 预测引用
 * @param {Record<string, unknown>} out
 * @param {string} prefix 字段名前缀
 * @returns {boolean} 是否完整消费（失败时返回 false，调用方应 catch）
 */
export function parseHevcStRefPicSet(reader, stRpsIdx, numShortTermRefPicSets, spsMaxDecPicBufferingMinus1, prevSets, out, prefix) {
    const pfx = `${prefix}[${stRpsIdx}]`;
    let interRefPicSetPredictionFlag = 0;
    if (stRpsIdx !== 0) {
        interRefPicSetPredictionFlag = reader.readBits(1, `${pfx}.inter_ref_pic_set_prediction_flag`);
    }

    const entry = { numDeltaPocs: 0 };

    if (interRefPicSetPredictionFlag) {
        let deltaIdxMinus1 = 0;
        if (stRpsIdx === numShortTermRefPicSets) {
            deltaIdxMinus1 = reader.readUE(`${pfx}.delta_idx_minus1`);
            if (deltaIdxMinus1 > stRpsIdx - 1) return false;
        }
        const deltaRpsSign = reader.readBits(1, `${pfx}.delta_rps_sign`);
        const absDeltaRpsMinus1 = reader.readUE(`${pfx}.abs_delta_rps_minus1`);
        if (absDeltaRpsMinus1 > 0x7fff) return false;
        const deltaRps = (1 - 2 * deltaRpsSign) * (absDeltaRpsMinus1 + 1);
        const refRpsIdx = stRpsIdx - (deltaIdxMinus1 + 1);
        if (refRpsIdx < 0 || refRpsIdx >= prevSets.length) return false;
        const numDeltaPocs = prevSets[refRpsIdx].numDeltaPocs;
        if (numDeltaPocs > 64) return false;
        const usedByCurrPicFlag = [];
        const useDeltaFlag = [];
        for (let j = 0; j <= numDeltaPocs; j++) {
            useDeltaFlag[j] = 1;
        }
        for (let j = 0; j <= numDeltaPocs; j++) {
            usedByCurrPicFlag[j] = reader.readBits(1, `${pfx}.used_by_curr_pic_flag[${j}]`);
            if (!usedByCurrPicFlag[j]) {
                useDeltaFlag[j] = reader.readBits(1, `${pfx}.use_delta_flag[${j}]`);
            }
        }
        out[`${pfx}.inter_ref_pic_set_prediction_flag`] = interRefPicSetPredictionFlag;
        out[`${pfx}.delta_idx_minus1`] = stRpsIdx === numShortTermRefPicSets ? deltaIdxMinus1 : undefined;
        out[`${pfx}.delta_rps_sign`] = deltaRpsSign;
        out[`${pfx}.abs_delta_rps_minus1`] = absDeltaRpsMinus1;
        out[`${pfx}.delta_rps`] = deltaRps;
        out[`${pfx}.ref_rps_idx`] = refRpsIdx;
        out[`${pfx}.used_by_curr_pic_flag`] = usedByCurrPicFlag;
        out[`${pfx}.use_delta_flag`] = useDeltaFlag;
        entry.numDeltaPocs = numDeltaPocs;
    } else {
        const numNegativePics = reader.readUE(`${pfx}.num_negative_pics`);
        const numPositivePics = reader.readUE(`${pfx}.num_positive_pics`);
        if (numNegativePics > spsMaxDecPicBufferingMinus1) return false;
        if (numPositivePics > spsMaxDecPicBufferingMinus1 - numNegativePics) return false;

        const deltaPocS0 = [];
        const usedByCurrPicS0 = [];
        for (let i = 0; i < numNegativePics; i++) {
            const deltaPocS0Minus1 = reader.readUE(`${pfx}.delta_poc_s0_minus1[${i}]`);
            if (deltaPocS0Minus1 > 0x7fff) return false;
            if (i === 0) {
                deltaPocS0[i] = -(deltaPocS0Minus1 + 1);
            } else {
                deltaPocS0[i] = deltaPocS0[i - 1] - (deltaPocS0Minus1 + 1);
            }
            usedByCurrPicS0[i] = reader.readBits(1, `${pfx}.used_by_curr_pic_s0_flag[${i}]`);
        }

        const deltaPocS1 = [];
        const usedByCurrPicS1 = [];
        for (let i = 0; i < numPositivePics; i++) {
            const deltaPocS1Minus1 = reader.readUE(`${pfx}.delta_poc_s1_minus1[${i}]`);
            if (deltaPocS1Minus1 > 0x7fff) return false;
            if (i === 0) {
                deltaPocS1[i] = deltaPocS1Minus1 + 1;
            } else {
                deltaPocS1[i] = deltaPocS1[i - 1] + deltaPocS1Minus1 + 1;
            }
            usedByCurrPicS1[i] = reader.readBits(1, `${pfx}.used_by_curr_pic_s1_flag[${i}]`);
        }

        out[`${pfx}.inter_ref_pic_set_prediction_flag`] = 0;
        out[`${pfx}.num_negative_pics`] = numNegativePics;
        out[`${pfx}.num_positive_pics`] = numPositivePics;
        out[`${pfx}.delta_poc_s0`] = deltaPocS0;
        out[`${pfx}.used_by_curr_pic_s0_flag`] = usedByCurrPicS0;
        out[`${pfx}.delta_poc_s1`] = deltaPocS1;
        out[`${pfx}.used_by_curr_pic_s1_flag`] = usedByCurrPicS1;
        entry.numDeltaPocs = numNegativePics + numPositivePics;
    }

    prevSets.push(entry);
    return true;
}

/**
 * @param {import("../core/Be.js").default} reader
 * @param {number} numSets readUE 结果
 * @param {number} _spsMaxSubLayersMinus1 保留与调用方一致（当前用 `s[...]` 取 max buffer）
 * @param {Record<string, unknown>} s 已写入 s[`sps_max_dec_pic_buffering_minus1[${i}]`] 的 SPS 对象
 * @param {string} c 字段前缀 sequenceHeader.sps[n]
 */
export function parseHevcSpsShortTermRefPicSets(reader, numSets, _spsMaxSubLayersMinus1, s, c) {
    const maxBuf =
        Number(s[`sps_max_dec_pic_buffering_minus1[${spsMaxSubLayersMinus1}]`]) ??
        Number(s[`sps_max_dec_pic_buffering_minus1[0]`]) ??
        16;
    const prev = [];
    const prefix = `${c}.short_term_ref_pic_set`;
    for (let stRpsIdx = 0; stRpsIdx < numSets; stRpsIdx++) {
        if (!parseHevcStRefPicSet(reader, stRpsIdx, numSets, maxBuf, prev, s, prefix)) {
            s._st_rps_parse_error = `short_term_ref_pic_set[${stRpsIdx}]`;
            return;
        }
    }
}
