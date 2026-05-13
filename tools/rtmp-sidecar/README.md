# RTMP Sidecar

Minimal local RTMP pull bridge:

```text
RTMP pull
  -> RTMP chunk/message parser
  -> FLV tag writer
  -> local WebSocket
  -> existing WS-FLV browser player
```

This tool does not use FFmpeg and does not transcode. It only repackages RTMP
audio/video/script messages into FLV tags.

## Run

Start as a local sidecar and wait for browser control:

```bash
node tools/rtmp-sidecar/server.mjs
```

Then the player page can call:

```text
http://127.0.0.1:18080/api/open
```

Directly start with an RTMP URL:

```bash
node tools/rtmp-sidecar/server.mjs --rtmp rtmp://host/live/stream
```

Default output:

```text
ws://127.0.0.1:18080/live.flv
```

Use that URL anywhere an example page accepts a WS-FLV input.

## URL Scheme Flow

The example pages support RTMP input through a custom URL scheme:

```text
media-analyzer://open?rtmp=<encoded rtmp url>&port=18080&path=/live.flv
```

Expected product flow:

```text
browser page
  -> media-analyzer://open?rtmp=...
  -> installed helper wakes the sidecar
  -> helper starts RTMP pull
  -> page polls http://127.0.0.1:18080/api/status
  -> page captures or plays ws://127.0.0.1:18080/live.flv
```

Development equivalent:

```bash
node tools/rtmp-sidecar/server.mjs 'media-analyzer://open?rtmp=rtmp%3A%2F%2Fhost%2Flive%2Fstream'
```

The URL scheme handler itself must be registered by the installed desktop
helper. The browser page can invoke the scheme, but it cannot register it or
install the helper.

### macOS development registration

Build/register the development helper:

```bash
tools/rtmp-sidecar/register-macos-url-scheme.sh
```

The script creates:

```text
~/Applications/MediaAnalyzerSidecar.app
~/Library/Application Support/MediaAnalyzerSidecar/runtime
```

The generated app declares `media-analyzer://` in its `Info.plist`. Running the
app directly also refreshes LaunchServices registration, but does not start RTMP
pull. RTMP pull only starts when the app receives an URL such as:

```bash
open 'media-analyzer://open?rtmp=rtmp%3A%2F%2Fhost%2Flive%2Fstream'
```

For a future compiled native helper, keep the same rule: put
`CFBundleURLTypes` in `Info.plist`, and call LaunchServices registration on
first run or after update.

## Options

```bash
node tools/rtmp-sidecar/server.mjs \
  --rtmp rtmp://host/live/stream \
  --host 127.0.0.1 \
  --port 18080 \
  --path /live.flv
```

For RTMP URLs where the app/play path cannot be inferred from the URL:

```bash
node tools/rtmp-sidecar/server.mjs \
  --rtmp rtmp://host/custom/path \
  --app live \
  --play-path stream
```

## Supported Scope

The bridge is intended for streams whose RTMP payload can be represented as FLV:

- H.264/AVC video in classic FLV video tags.
- AAC audio in FLV audio tags.
- G.711 A-law / mu-law audio in FLV audio tags.
- Script metadata messages.
- RTMP aggregate messages containing FLV tags.

It does not convert codecs. If the input needs H.265 -> H.264, G.711 -> AAC,
resize, frame-rate repair, or any other transcoding, use a separate transcoder
path instead.

## Code Reuse

The sidecar reuses project codec utilities instead of maintaining another FLV
implementation:

- `lib/codec/flvTagWriter.js` writes FLV headers and tag wrappers.
- `lib/codec/flvLiveDemuxer.js` incrementally reads WS-FLV and delegates tag
  parsing to the existing `parseFlvTagAt` stack.
- `lib/streaming/wsFlvMseLivePlayer.js` consumes the shared live demuxer.

The RTMP-specific code stays isolated under `tools/rtmp-sidecar`.
