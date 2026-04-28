# Player Module

`lib/player` is the browser playback pipeline layer. It is separate from the
analysis UI and from container parsers, so render and buffering policies can
evolve without changing the frame inspector.

## Current Pipeline

```text
analysis result / selected frames
  -> VideoSegmentPlayer
  -> buildVideoDecodePlan
  -> VideoDecoder
  -> FrameQueue
  -> MediaClock
  -> Canvas2DVideoRenderer
```

## Modules

- `mediaClock.js`: playback clock with pause/resume and playback-rate support.
- `mediaQueue.js`: generic media queue and PTS-ordered frame queue.
- `canvas2dRenderer.js`: minimal `VideoFrame` to canvas renderer.
- `videoSegmentPlayer.js`: segment playback controller for analyzed media
  results. It groups selected frames by GOP, decodes from the reference I-frame,
  schedules decoded frames by PTS, and renders only the target segment frames.

## Next Extension Points

- Add `WebGLVideoRenderer` for lower CPU rendering and shader-based scaling.
- Add source modules for HTTP-FLV, WebSocket-FLV, TS, and fMP4 live input.
- Add network/container buffers before demux for live latency policies.
- Add audio clock as master when synchronized audio playback is needed.
