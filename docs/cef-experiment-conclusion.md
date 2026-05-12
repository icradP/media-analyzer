# CEF Desktop Experiment Conclusion

Date: 2026-05-12

## Background

The experiment evaluated whether CEF could become the desktop runtime for Media Analyzer while keeping the existing browser-first frontend and extending native capabilities such as RTMP pull, local FFmpeg processing, and low-level network access.

The expected direction was:

- Keep the current JavaScript UI and player code.
- Use CEF as an embedded browser shell.
- Expose native media capabilities through a JS bridge.
- Pull RTMP locally, transmux/transcode when needed, and feed playback data back to the frontend.

## What Was Verified

CEF can host the current frontend and expose a native bridge. Basic application bootstrapping, frontend loading, and native-to-JS messaging are feasible.

RTMP pulling through a local FFmpeg process is also feasible from the native side. FFmpeg can receive RTMP streams and produce browser-consumable containers such as fragmented MP4 in principle.

However, the key playback path was blocked by CEF runtime codec support. In the tested CEF build, MSE rejected common H.264/AAC fragmented MP4 MIME types such as:

```text
video/mp4; codecs="avc1.420020,mp4a.40.2"
```

Trying compatible `avc1` codec-string variants did not solve the issue. This indicates that the failure was not caused by RTMP itself, FLV packaging, or fMP4 segment delivery, but by the embedded CEF runtime's media capability set.

## Key Finding

RTMP and FLV are not the real dividing line here. For the current project, the important question is whether the runtime can reliably decode and play the resulting elementary streams through the selected browser playback path.

In normal Chrome, FLV.js-style playback can work because Chrome commonly has the required H.264/AAC media support. In the tested CEF runtime, the same H.264/AAC fMP4 path was not reliably available through MSE.

The existing project also relies heavily on browser media APIs such as WebCodecs and canvas rendering. CEF introduces another compatibility matrix for:

- MSE container and codec support.
- Proprietary codec availability.
- WebCodecs support and behavior.
- Platform-specific media pipeline differences.
- Custom CEF build requirements if H.264/AAC support is needed.

This makes CEF a risky foundation for the current player direction.

## Conclusion

CEF should not be used as the primary desktop runtime for Media Analyzer at this stage.

The experiment showed that CEF can provide native integration, but its media/runtime limitations are too significant for a project whose core value depends on precise browser media behavior, WebCodecs workflows, and H.264/AAC/RTMP-related playback.

Using CEF would likely require maintaining a custom CEF build with proprietary codec support and repeatedly validating media behavior across platforms. That cost is not aligned with the current project goals.

## Recommended Direction

Keep the browser/WebCodecs frontend as the primary player and analysis surface.

For capabilities that browsers cannot provide directly, such as RTMP, raw TCP, device access, or heavyweight transcoding, prefer a separate native sidecar or local service:

- Native sidecar handles RTMP pull, FFmpeg, TCP, files, and platform-specific work.
- Browser frontend keeps UI, analysis views, WebCodecs playback, canvas rendering, and developer velocity.
- Communication happens through WebSocket, HTTP, or another explicit local IPC protocol.
- Media data should be passed in browser-friendly formats that match the existing player modules.

This keeps the strongest part of the current architecture intact while adding native power only where it is actually required.

## Status

CEF implementation code and demo code have been removed from the project.

This document remains as the experiment record and decision note.
