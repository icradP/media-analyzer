/**
 * DVB/MPEG-TS 描述子体解析。
 * `fieldOffsets` 为可选；为 `null` 时不写字段偏移（数据层默认）。
 */

/** @param {Uint8Array} t */
function decodeDvbText(t) {
    if (!t || t.length === 0) return "";
    const a = t[0];
    return a >= 32
        ? String.fromCharCode(...t)
        : a === 21
          ? new TextDecoder("utf-8").decode(t.subarray(1))
          : String.fromCharCode(...t.subarray(1));
}

/**
 * @param {number} tag — descriptor_tag
 * @param {Uint8Array|number[]} data — 描述子 data 字节（不含 tag/length）
 * @param {number} baseOffset — 在整文件中的 payload 内绝对偏移（仅用于写 fieldOffsets）
 * @param {Record<string, object>|null} [fieldOffsets]
 * @param {string} [parentKey]
 * @returns {Record<string, unknown>}
 */
export function parseMpegTsDescriptorPayload(tag, data, baseOffset = 0, fieldOffsets = null, parentKey = "") {
    const r = fieldOffsets;
    const s = parentKey;
    const a = data instanceof Uint8Array ? data : Uint8Array.from(data);
    const i = baseOffset;
    const c = {};
    const setOff = (key, off, len) => {
        if (r) r[`${s}.${key}`] = { offset: off, length: len };
    };
    try {
        switch (tag) {
            case 5:
                if (a.length >= 4) {
                    const o = String.fromCharCode(a[0], a[1], a[2], a[3]);
                    c.format_identifier = o;
                    setOff("format_identifier", i, 4);
                    if (o === "GA94") {
                        c.isSubtitle = true;
                        c.isCEA608 = true;
                    }
                    if (a.length > 4) {
                        const f = a.subarray(4);
                        c.additional_identification_info = new Uint8Array(f);
                        setOff("additional_identification_info", i + 4, f.length);
                    }
                }
                break;
            case 10:
                if (a.length >= 4) {
                    c.ISO_639_language_code = String.fromCharCode(a[0], a[1], a[2]);
                    setOff("ISO_639_language_code", i, 3);
                    c.audio_type = a[3];
                    setOff("audio_type", i + 3, 1);
                }
                break;
            case 72:
                if (a.length >= 3) {
                    c.service_type = a[0];
                    setOff("service_type", i, 1);
                    const o = a[1];
                    c.service_provider_name_length = o;
                    let f = 2;
                    if (o > 0 && f + o <= a.length) {
                        const m = a.subarray(f, f + o);
                        c.service_provider_name = decodeDvbText(m);
                        setOff("service_provider_name", i + f, o);
                        f += o;
                    }
                    if (f < a.length) {
                        const m = a[f];
                        c.service_name_length = m;
                        f++;
                        if (m > 0 && f + m <= a.length) {
                            const h = a.subarray(f, f + m);
                            c.service_name = decodeDvbText(h);
                            setOff("service_name", i + f, m);
                        }
                    }
                }
                break;
            case 82:
                if (a.length >= 1) {
                    c.component_tag = a[0];
                    setOff("component_tag", i, 1);
                }
                break;
            case 86:
                c.teletext_entries = [];
                for (let o = 0; o + 4 < a.length; o += 5) {
                    c.teletext_entries.push({
                        ISO_639_language_code: String.fromCharCode(a[o], a[o + 1], a[o + 2]),
                        teletext_type: (a[o + 3] >> 3) & 31,
                        teletext_magazine_number: a[o + 3] & 7,
                        teletext_page_number: a[o + 4],
                    });
                }
                break;
            case 89:
                c.subtitling_entries = [];
                for (let o = 0; o + 7 < a.length; o += 8) {
                    c.subtitling_entries.push({
                        ISO_639_language_code: String.fromCharCode(a[o], a[o + 1], a[o + 2]),
                        subtitling_type: a[o + 3],
                        composition_page_id: (a[o + 4] << 8) | a[o + 5],
                        ancillary_page_id: (a[o + 6] << 8) | a[o + 7],
                    });
                }
                c.isSubtitle = true;
                break;
            case 124:
                if (a.length >= 3) {
                    c.profile_and_level = a[0];
                    setOff("profile_and_level", i, 1);
                    c.AAC_type_flag = (a[1] >> 7) & 1;
                    c.reserved = a[1] & 127;
                    if (c.AAC_type_flag && a.length >= 3) {
                        c.AAC_type = a[2];
                        setOff("AAC_type", i + 2, 1);
                    }
                    const o = c.AAC_type_flag ? 3 : 2;
                    if (a.length > o) {
                        const rest = a.subarray(o);
                        c.additional_info = new Uint8Array(rest);
                        c.audioSpecificConfig = new Uint8Array(rest);
                        setOff("additional_info", i + o, rest.length);
                    }
                }
                break;
            case 134:
                if (a.length >= 1) {
                    const o = a[0] & 31;
                    c.number_of_services = o;
                    c.caption_services = [];
                    let f = 1;
                    for (let m = 0; m < o && f + 5 < a.length; m++) {
                        const h = {
                            language: String.fromCharCode(a[f], a[f + 1], a[f + 2]),
                            digital_cc: (a[f + 3] >> 7) & 1,
                            caption_service_number: a[f + 3] & 63,
                        };
                        if (h.digital_cc) {
                            h.type = "CEA-708";
                        } else {
                            h.type = "EIA-608";
                            h.line21_field = (a[f + 3] >> 6) & 1;
                        }
                        c.caption_services.push(h);
                        f += 6;
                    }
                    c.isSubtitle = true;
                    c.isCEA608 = c.caption_services.some((x) => x.type === "EIA-608");
                    c.isCEA708 = c.caption_services.some((x) => x.type === "CEA-708");
                }
                break;
            case 160:
            case 161:
                break;
            default:
                break;
        }
    } catch (e) {
        console.error(`Error parsing descriptor tag 0x${tag.toString(16)}:`, e);
    }
    return c;
}

export const tsDescriptorParseCodec = Object.freeze({
    parseMpegTsDescriptorPayload,
});
