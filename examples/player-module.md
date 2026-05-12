# Player Module

`lib/player` is the browser playback pipeline layer. It is separate from the
analysis UI and from container parsers, so render and buffering policies can
evolve without changing the frame inspector.

## Current Pipeline

```text
analysis result / selected frames
  -> AnalyzedMediaPlayer
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
- `canvas2dRenderer.js`: minimal `VideoFrame` to canvas renderer. It draws
  with a contain-fit against the canvas parent/container, so exported player
  UIs can resize the outer view without changing decode code.
- `analyzedMediaPlayer.js`: UI-independent analyzed media playback facade. It
  owns the active segment, playback state, and progress callbacks. Video decode
  and canvas rendering stay delegated to `VideoSegmentPlayer`; this facade only
  coordinates it with WebAudio segment playback.
- `videoSegmentPlayer.js`: segment playback controller for analyzed media
  results. It groups selected frames by GOP, decodes from the reference I-frame,
  schedules decoded frames by PTS, and renders only the target segment frames.
  It also exposes a `frame-step` strategy that reuses the same
  `decodeVideoFrameWithStrategies -> canvas` path as single-frame preview, with
  the tinyh264 fallback kept in the shared browser orchestrator.

## Example Page

- `examples/player-demo.html`: standalone player page built around
  `AnalyzedMediaPlayer`. It loads local/remote media, analyzes it, renders a
  monitor canvas, draws video/audio timeline tracks, and plays the selected
  In/Out range.

## Next Extension Points

- Add `WebGLVideoRenderer` for lower CPU rendering and shader-based scaling.
- Add source modules for HTTP-FLV, WebSocket-FLV, TS, and fMP4 live input.
- Add network/container buffers before demux for live latency policies.
- Add audio clock as master when synchronized audio playback is needed.
