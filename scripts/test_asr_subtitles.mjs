import assert from "node:assert/strict";
import { resampleFloat32, groupAudioFramesByTime, selectAudioFrames, unwrapAudioFrameForDecode } from "../src/asr/audioExtractor.js";
import { segmentsToSubtitleTrack, mergeSubtitleTracks } from "../src/asr/subtitleGenerator.js";
import { writeWebVtt } from "../src/asr/vttWriter.js";
import { writeSrt } from "../src/asr/srtWriter.js";

const input = new Float32Array([0, 1, 0, -1]);
const resampled = resampleFloat32(input, 4, 2);
assert.equal(resampled.length, 2);
assert.deepEqual(Array.from(resampled), [0, 0]);

const frames = [
  { mediaType: "audio", ptsTime: 0 },
  { mediaType: "audio", ptsTime: 1 },
  { mediaType: "audio", ptsTime: 7 },
];
const groups = groupAudioFramesByTime(frames, 5);
assert.equal(groups.length, 2);
assert.equal(groups[0].frames.length, 2);
assert.equal(groups[1].startSec, 7);

const raw = { mediaType: "audio", ptsTime: 1.5, offset: 123, size: 9 };
const wrapper = { _mediaType: "audio", _rawFrame: raw };
const selected = selectAudioFrames([wrapper], { startSec: 1, endSec: 2 });
assert.equal(selected.length, 1);
assert.equal(unwrapAudioFrameForDecode(selected[0]), raw);

const trackA = segmentsToSubtitleTrack([
  { startMs: 0, endMs: 1200, text: " hello   world " },
], { offsetMs: 1000, language: "zh" });
const trackB = segmentsToSubtitleTrack([
  { startMs: 0, endMs: 800, text: "第二句" },
], { offsetMs: 2400, language: "zh" });
const merged = mergeSubtitleTracks([trackB, trackA], { language: "zh" });
assert.equal(merged.cues.length, 2);
assert.equal(merged.cues[0].startMs, 1000);

const vtt = writeWebVtt(merged);
assert.match(vtt, /WEBVTT/);
assert.match(vtt, /00:00:01\.000 --> 00:00:02\.200/);
assert.match(vtt, /hello world/);

const srt = writeSrt(merged);
assert.match(srt, /00:00:01,000 --> 00:00:02,200/);
assert.match(srt, /第二句/);

console.log("asr subtitle tests passed");
