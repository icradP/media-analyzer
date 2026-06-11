import assert from "node:assert/strict";
import { resampleFloat32, groupAudioFramesByTime, selectAudioFrames, unwrapAudioFrameForDecode } from "../src/asr/audioExtractor.js";
import { segmentsToSubtitleTrack, mergeSubtitleTracks } from "../src/asr/subtitleGenerator.js";
import { writeWebVtt } from "../src/asr/vttWriter.js";
import { writeSrt } from "../src/asr/srtWriter.js";
import { detectEnergyVad, slicePcmByVadSegment } from "../src/asr/energyVad.js";
import {
  PcmRingBuffer,
  TranscriptStabilizer,
  TranscriptMerger,
  createEnergyVadProvider,
  collapseRepeatedTranscript,
  mergeAsrWindowResults,
  mergeOverlappingText,
  normalizeTranscript,
  normalizeVadBackend,
  normalizeWhisperStreamingOptions,
  selectVadSpeechClip,
  textSimilarity,
} from "../src/asr/index.js";

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

const vadPcm = new Float32Array(16000);
for (let i = 4000; i < 8000; i++) vadPcm[i] = Math.sin(i / 8) * 0.25;
const vad = detectEnergyVad(vadPcm, {
  sampleRate: 16000,
  frameMs: 20,
  thresholdDb: -35,
  adaptiveNoiseFloor: false,
  minSpeechMs: 100,
  minSilenceMs: 80,
  paddingMs: 100,
});
assert.equal(vad.segments.length, 1);
assert.equal(vad.segments[0].backend, "energy");
assert.ok(vad.segments[0].startMs <= 260);
assert.ok(vad.segments[0].endMs >= 560);
assert.ok(slicePcmByVadSegment(vadPcm, vad.segments[0], 16000).length > 0);

assert.equal(normalizeVadBackend("energy-vad"), "energy");
assert.equal(normalizeVadBackend("unknown"), "energy");
const provider = createEnergyVadProvider({ thresholdDb: -35, adaptiveNoiseFloor: false });
const providerVad = await provider.detect(vadPcm, {
  sampleRate: 16000,
  frameMs: 20,
  minSpeechMs: 100,
  minSilenceMs: 80,
  paddingMs: 100,
});
assert.equal(providerVad.backend, "energy");
assert.equal(providerVad.segments.length, 1);

const ring = new PcmRingBuffer({ sampleRate: 10, maxDurationMs: 1000, timelineStartMs: 2000 });
ring.push(new Float32Array([1, 2, 3, 4, 5]));
ring.push(new Float32Array([6, 7, 8, 9, 10, 11]));
const recent = ring.snapshotRecent(500);
assert.deepEqual(Array.from(recent.pcm), [7, 8, 9, 10, 11]);
assert.equal(Math.round(recent.startMs), 2600);
assert.equal(Math.round(recent.endMs), 3100);

const stabilizer = new TranscriptStabilizer({ minStableRepeats: 2 });
assert.equal(stabilizer.update("hello world").committed, false);
assert.equal(stabilizer.update("hello world again").committed, false);
const stableEnglish = stabilizer.update("hello world again");
assert.equal(stableEnglish.committedText, "hello world");
assert.equal(stableEnglish.stableText, "hello world");
assert.equal(stabilizer.update("hello world again soon").partialText, "again soon");

const zh = new TranscriptStabilizer({ minStableRepeats: 2 });
zh.update("你好世界");
zh.update("你好世界今天");
const stableZh = zh.update("你好世界今天");
assert.equal(stableZh.committedText, "你好世界");

const streamingOptions = normalizeWhisperStreamingOptions({ windowMs: 15000, stepMs: 1000, overlapMs: 5000, minStableRepeats: 2 });
assert.equal(streamingOptions.windowMs, 15000);
assert.equal(streamingOptions.stepMs, 1000);
assert.equal(streamingOptions.overlapMs, 5000);
assert.equal(streamingOptions.maxLookbackMs, 30000);

assert.equal(normalizeTranscript("嗯 大家好，欢迎来到！", "zh"), "大家好欢迎来到");
assert.ok(textSimilarity("你好今天我们测试", "你好今天我们测试", "zh") > 0.99);
assert.equal(mergeOverlappingText("大家好欢迎来到", "欢迎来到今天的节目", "zh"), "大家好欢迎来到今天的节目");
assert.equal(mergeOverlappingText("hello everyone welcome to", "welcome to today's show", "en"), "hello everyone welcome to today's show");
assert.equal(collapseRepeatedTranscript("请专心驾驶请专心驾驶请专心驾驶", "zh"), "请专心驾驶");
assert.equal(collapseRepeatedTranscript("please drive safely please drive safely please drive safely", "en"), "please drive safely");

const clipSource = new Float32Array(16000 * 10);
for (let i = 16000 * 7; i < 16000 * 8; i++) clipSource[i] = 0.2;
const speechClip = selectVadSpeechClip({
  pcm: clipSource,
  sampleRate: 16000,
  startMs: 5000,
  endMs: 15000,
  durationMs: 10000,
}, {
  segments: [
    { startMs: 1000, endMs: 1800, score: 0.8 },
    { startMs: 7000, endMs: 8000, score: 0.9 },
  ],
}, { maxMergeGapMs: 300 });
assert.equal(Math.round(speechClip.startMs), 12000);
assert.equal(Math.round(speechClip.endMs), 13000);
assert.equal(Math.round(speechClip.durationMs), 1000);

const mergeOptions = {
  language: "auto",
  overlapTimeToleranceMs: 250,
  textSimilarityThreshold: 0.68,
  maxMergeGapMs: 1200,
  preferLongerText: true,
  preferHigherConfidence: true,
  commitDelayMs: 0,
};
let mergedSegments = [];
let mergeOut = mergeAsrWindowResults(mergedSegments, {
  windowId: "zh-1",
  windowStartMs: 0,
  windowEndMs: 10000,
  text: "大家好欢迎来到",
}, mergeOptions);
mergedSegments = mergeOut.segments;
mergeOut = mergeAsrWindowResults(mergedSegments, {
  windowId: "zh-2",
  windowStartMs: 5000,
  windowEndMs: 15000,
  text: "欢迎来到今天的节目",
}, mergeOptions);
assert.equal(mergeOut.segments.length, 1);
assert.equal(mergeOut.segments[0].text, "大家好欢迎来到今天的节目");

mergedSegments = [];
mergeOut = mergeAsrWindowResults(mergedSegments, {
  windowId: "dup-1",
  windowStartMs: 0,
  windowEndMs: 10000,
  text: "你好今天我们测试",
}, mergeOptions);
mergeOut = mergeAsrWindowResults(mergeOut.segments, {
  windowId: "dup-2",
  windowStartMs: 5000,
  windowEndMs: 15000,
  text: "你好今天我们测试",
}, mergeOptions);
assert.equal(mergeOut.segments.length, 1);
assert.equal(mergeOut.segments[0].text, "你好今天我们测试");
assert.equal(mergeOut.dedupedCount, 1);

mergedSegments = [];
mergeOut = mergeAsrWindowResults(mergedSegments, {
  windowId: "en-1",
  windowStartMs: 0,
  windowEndMs: 10000,
  text: "hello welcome to",
}, mergeOptions);
mergeOut = mergeAsrWindowResults(mergeOut.segments, {
  windowId: "en-2",
  windowStartMs: 5000,
  windowEndMs: 15000,
  text: "welcome to this demo",
}, mergeOptions);
assert.equal(mergeOut.segments.length, 1);
assert.equal(mergeOut.segments[0].text, "hello welcome to this demo");

const merger = new TranscriptMerger({ ...mergeOptions, commitDelayMs: 3000 });
merger.mergeWindowResult({ windowId: "a", windowStartMs: 0, windowEndMs: 10000, text: "first line" });
const delayed = merger.mergeWindowResult({ windowId: "b", windowStartMs: 12000, windowEndMs: 20000, text: "second line" });
assert.equal(delayed.segments.length, 2);
assert.equal(delayed.stableSegments.length, 1);
assert.equal(delayed.unstablePartialSegments.length, 1);

mergeOut = mergeAsrWindowResults([], {
  windowId: "keep-1",
  windowStartMs: 0,
  windowEndMs: 4000,
  text: "alpha",
}, mergeOptions);
mergeOut = mergeAsrWindowResults(mergeOut.segments, {
  windowId: "keep-2",
  windowStartMs: 8000,
  windowEndMs: 12000,
  text: "beta",
}, mergeOptions);
assert.equal(mergeOut.segments.length, 2);

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
