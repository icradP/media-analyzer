import assert from "node:assert/strict";
import {
  insertSeiIntoMp4Sample,
  patchMp4SampleBytes,
  splitAvcSampleNalUnits,
} from "../lib/codec/mp4AvcSei.js";
import {
  applyH264SeiPatch,
  buildH264SeiNaluFromPayload,
  extractH264SeiFromFrame,
  insertH264SeiIntoFrame,
} from "../lib/browser/seiEditorModel.js";
import { u32 } from "../lib/codec/h264Bitstream.js";

function avccSample(nalus) {
  const parts = [];
  for (const nalu of nalus) parts.push(u32(nalu.length), nalu);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function asciiBytes(text) {
  return Uint8Array.from(Array.from(text).map((ch) => ch.charCodeAt(0)));
}

function readU32(bytes, off) {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

function writeU32(bytes, off, value) {
  bytes.set(u32(value), off);
}

function makeMp4Fixture(sample) {
  const sampleOffset = 40;
  const stszDataOffset = 96;
  const stcoDataOffset = 120;
  const file = new Uint8Array(180);
  writeU32(file, 32, 8 + sample.length);
  file.set(asciiBytes("mdat"), 36);
  file.set(sample, sampleOffset);
  writeU32(file, stszDataOffset + 12, sample.length);
  writeU32(file, stcoDataOffset + 8, sampleOffset);
  writeU32(file, stcoDataOffset + 12, 160);
  const stsz = {
    type: "stsz",
    dataOffset: stszDataOffset,
    data: { sampleSize: 0, sampleCount: 1, entrySizes: [sample.length] },
  };
  const stco = {
    type: "stco",
    dataOffset: stcoDataOffset,
    data: { offsets: [sampleOffset, 160] },
  };
  const boxes = [
    { type: "mdat", offset: 32, dataOffset: sampleOffset, size: 8 + sample.length },
    {
      type: "moov",
      children: [{
        type: "trak",
        children: [{
          type: "mdia",
          children: [{
            type: "minf",
            children: [{
              type: "stbl",
              children: [stsz, stco],
            }],
          }],
        }],
      }],
    },
  ];
  const result = {
    format: { formatName: "mp4" },
    formatSpecific: { fileData: file, boxes },
    streams: [{
      index: 0,
      codecType: "video",
      codecName: "avc1",
      decoderConfig: { lengthSizeMinusOne: 3 },
    }],
  };
  const frameWrapper = {
    index: 0,
    _mediaType: "video",
    _rawFrame: {
      index: 0,
      streamIndex: 0,
      mediaType: "video",
      codecName: "avc1",
      offset: sampleOffset,
      size: sample.length,
      pts: 9000,
      dts: 9000,
      ptsTime: 0.1,
      dtsTime: 0.1,
      formatSpecific: { sampleIndex: 1, sampleOffset },
    },
  };
  return { file, result, frameWrapper, sampleOffset, stszDataOffset, stcoDataOffset };
}

const sps = Uint8Array.of(0x67, 0x42, 0x00, 0x1f);
const pps = Uint8Array.of(0x68, 0xce, 0x06);
const idr = Uint8Array.of(0x65, 0x88, 0x84, 0x21);
const sei = buildH264SeiNaluFromPayload(5, asciiBytes("hello"));
const sample = avccSample([sps, pps, idr]);

const inserted = insertSeiIntoMp4Sample(sample, sei, { lengthSize: 4 });
assert.equal(inserted.delta, sei.length + 4);
assert.deepEqual(splitAvcSampleNalUnits(inserted.patchedBytes, 4).map((n) => n.nalType), [7, 8, 6, 5]);

const fixture = makeMp4Fixture(sample);
const patchedFile = patchMp4SampleBytes(fixture.file, fixture.result, [{
  offset: fixture.sampleOffset,
  oldLength: sample.length,
  bytes: inserted.patchedBytes,
  streamIndex: 0,
  sampleIndex: 1,
}]);
assert.equal(readU32(patchedFile.patchedBytes, 32), 8 + inserted.patchedBytes.length);
assert.equal(readU32(patchedFile.patchedBytes, fixture.stszDataOffset + 12 + inserted.delta), inserted.patchedBytes.length);
assert.equal(readU32(patchedFile.patchedBytes, fixture.stcoDataOffset + 12 + inserted.delta), 160 + inserted.delta);

const insertedByEditor = insertH264SeiIntoFrame(fixture.file, fixture.frameWrapper, fixture.result, sei, fixture.result.streams[0]);
assert.equal(insertedByEditor.container, "mp4");
assert.equal(readU32(insertedByEditor.patchedBytes, 32), 8 + inserted.patchedBytes.length);

const sampleWithSei = avccSample([sps, pps, sei, idr]);
const fixtureWithSei = makeMp4Fixture(sampleWithSei);
const extracted = extractH264SeiFromFrame(fixtureWithSei.frameWrapper, fixtureWithSei.result, fixtureWithSei.result.streams[0]);
assert.equal(extracted.context.container, "mp4");
assert.equal(extracted.context.sampleIndex, 1);
assert.equal(extracted.context.naluCount, 4);
assert.equal(extracted.context.seiCount, 1);
const editedSei = buildH264SeiNaluFromPayload(5, asciiBytes("hello-mp4"));
const editedFile = applyH264SeiPatch(fixtureWithSei.file, extracted.context, editedSei);
assert.equal(editedFile.container, "mp4");
assert.equal(readU32(editedFile.patchedBytes, 32), 8 + sampleWithSei.length + editedFile.delta);

console.log("mp4 sei tests passed");
