# 架构复核与当前缺陷

本次复核基于当前 `master` 工作区状态。当前工作区是干净的，说明本文档记录的是仓库当前实现，而不是未提交 diff。

## 架构确认

项目当前的总体设计是合理的：各解析器都尽量输出统一分析结果，再由浏览器侧模型消费。

```text
输入 Uint8Array
  -> detectContainerFormat
  -> 各格式 parser
  -> { format, streams, frames, formatSpecific }
  -> browser models / examples
```

主要分层如下：

- `lib/core/`：基础 reader、box parser、公共计算。
- `lib/codec/`：编码细节、FLV、统一入口、跨格式帧适配。
- `lib/mpegTs/` / `lib/mpegPs/`：TS/PS 容器解析和 PES/ES 组装。
- `lib/streaming/`：WebSocket 采集和 MP4/fMP4 入口适配。
- `lib/browser/`：帧列表、HexDataView、Inspector、参考帧关系、WebCodecs/WebAudio 播放。
- `examples/`：静态示例页，直接消费公开 ESM。

这个方向的优势是：UI 不必关心每种容器的原始结构，只需要处理统一的 `streams` 和 `frames`。当前最大的问题也正出在这个统一模型还不够严格：`frames[].offset/size` 在不同容器里表达的不是同一种范围。

## 高优先级缺陷

### 1. PS 视频 PES 长度为 0 时会被 Annex-B NAL start code 截断

位置：`lib/mpegPs/psParse.js`

`detectPesPacketLength()` 在 `PES_packet_length === 0` 时直接调用 `findNextPsStartCode(bytes, offset + 6)`。但 H.264/H.265 ES 负载本身大量包含 `00 00 01 xx` NAL start code，这会被误认为下一个 PS packet start code。

影响：

- PS H.264/H.265 视频 PES 会在第一个 NAL 处被截断。
- `parsePesPacket` 得到的 payload 为空或严重不完整。
- 后续 codec 探测、picture type、帧大小、播放解码都会失败。

复现用例已验证：一个 `PES_packet_length=0` 且 payload 以 `00 00 01 65` 开始的 PES，被解析成 `_byteLength=9`，只剩 PES 头，没有 ES payload。

建议修复：

- 对 PS packet start code 做合法 stream id 过滤，只接受 `0xba/0xbb/0xbc/0xb9/0xbd-0xbf/0xc0-0xef/...` 这类 PS/PES packet id。
- 对候选位置做 header 合法性校验，避免把 NAL unit type 当成 stream id。
- 对 video PES length 0 的情况保留到下一个合法 PS packet，而不是任意 `00 00 01`。

### 2. Annex-B HEVC codec 探测会把部分 HEVC slice 误判成 H.264

位置：`lib/mpegTs/tsPesParse.js`

`detectAnnexBVideoCodecFromPesPayload()` 先用单字节 H.264 NAL type 判断，再用 HEVC 两字节 header 判断。HEVC IDR/slice 的首字节也可能让 `first & 31` 落在 H.264 合法范围内，例如 HEVC IDR 首字节 `0x26` 会被判成 H.264。

影响：

- 没有 PMT 或 PMT 信息不完整的 TS/PS H.265 流可能被识别成 H.264。
- 后续 `hasVclNaluInAnnexB`、NAL 解析、picture type 和 WebCodecs codec 选择都会沿着错误路径走。

复现用例已验证：

```js
detectAnnexBVideoCodecFromPesPayload(Uint8Array.from([0,0,0,1,0x26,0x01,0x88]))
// 当前返回 "h264"，实际是 HEVC IDR 类 NAL
```

建议修复：

- 不要只看第一个 NAL 的低 5 bit。
- 扫描前几个 NAL，分别按 H.264 单字节 header 和 HEVC 双字节 header 评分。
- HEVC 判断需要检查 `nal_unit_type`、`nuh_layer_id`、`nuh_temporal_id_plus1` 是否合理，再和 H.264 候选比较。

### 3. `parseIsoBmffForAnalysis` 不能真正解析 fMP4 media fragments

位置：`lib/streaming/mp4ParserWsAdapter.js`

当前 MP4 分析只走 `trak -> mdia -> minf -> stbl` sample table，依赖 `stsz/stsc/stco/stts/ctts/stss` 生成 sample frame。fragmented MP4 的媒体样本通常在 `moof/traf/tfhd/tfdt/trun + mdat`，这里没有解析。

影响：

- WebSocket/fMP4 或 CMAF 类输入可能只能看到 box tree，不能生成有效 `frames[]`。
- `mediaOverview.totalFrames`、帧列表、逐帧播放都会缺数据。

建议修复：

- 增加 fragment path：解析 `mvex/trex` 默认值、`moof/traf/tfhd/tfdt/trun`、mdat data offset。
- 将 trun sample 映射到统一 `frames[]`，并为每个 sample 填充 offset/size/pts/dts/keyframe。
- 区分 progressive MP4 sample table 和 fragmented MP4 sample run 两条路径。

## 中优先级缺陷

### 4. `frames[].offset/size` 的语义不统一

位置：`lib/codec/flvAnalysis.js`、`lib/mpegTs/parseMpegTsForAnalysis.js`、`lib/browser/frameInspectorModel.js`

当前不同容器对 `offset/size` 的含义不一致：

- FLV frame 使用 tag 起点作为 `offset`，但 `size` 是 `dataSize`，不是整个 tag，也不是编码 payload。
- TS frame 使用首个 PES 的文件 offset，但 `size` 可能是 assembled ES/VCL 大小，而 assembled ES 在原 TS 文件里通常不是连续区间。
- 浏览器播放通过 `sliceFrameBytes()` 和 `_assembledESData` 做了容器特化兜底，但 frame list、HexDataView、第三方调用者仍容易误用 `offset/size`。

影响：

- UI 里的 size/offset 看起来像统一字段，但实际不是同一层级。
- 新增格式时容易继续扩大歧义。
- Inspector/HexDataView 对 TS assembled frame 的展示可能和实际解码 payload 不一致。

建议修复：

统一拆成明确字段：

```js
{
  fileRange: { offset, length },       // 原文件中的连续容器范围
  payloadRange: { offset, length },    // 原文件中连续编码 payload 范围；没有则 null
  payloadBytes: Uint8Array | null,     // 非连续组装后的 ES/AU bytes
  containerRange: { offset, length }   // 可选，完整 tag/PES/box 范围
}
```

短期至少要在文档和 adapter 中明确：`offset/size` 只是列表显示字段，不保证可直接切出可播放 payload。

### 5. 纯音频格式没有逐帧时间线

位置：`lib/codec/audioMinimalAnalysis.js`

WAV/FLAC/MP3/Opus 目前只做 header 级分析，`frames` 始终为空。

影响：

- `media-overview` 可展示基本信息。
- `frame-analysis` 页面会没有音频帧列表、无法做 segment audio、无法展示逐帧/包级统计。

建议修复：

- MP3 可扫描 frame header，生成每帧 offset/size/pts/duration。
- WAV 可按固定窗口或 block align 生成 pseudo frames。
- Opus/Ogg 可按 page/packet 生成时间线。
- FLAC 可解析 frame sync 后生成 frame 级条目。

### 6. 缺少自动化测试和固定样本回归

当前仓库没有 npm 测试脚本，也没有 parser fixture。已经存在多处启发式逻辑：TS access unit 合并、PS start code 扫描、HEVC/H.264 探测、FLV sequence header 处理、MP4 edit list/ctts 修正。没有固定样本时，很容易修一个容器打破另一个容器。

建议优先增加轻量测试：

- 纯 Node ESM 单元测试，不需要引入构建系统。
- synthetic bytes 覆盖：PS length 0 + Annex-B、HEVC IDR 探测、FLV AAC/G.711 payload range、MP4 ctts/edit list。
- 少量真实小样本 fixture：TS H.264/AAC、TS H.265/AAC、FLV H.264/AAC、PS H.264。

## 设计建议

1. 把统一数据契约再收紧，尤其是 frame byte range。
2. parser 层只产出数据，不把浏览器播放假设塞回 parser。
3. browser 层允许有容器特化适配，但要通过明确字段适配，而不是猜 `offset/size`。
4. 先修 PS length 0 和 HEVC 探测，这两个会直接让解析结果错误。
5. 再补 fMP4 fragment path，否则 `streaming/mp4ParserWsAdapter` 的命名和实际能力不完全匹配。

## 本次验证

- `git status --short --branch`：工作区干净，当前分支 `master...origin/master`。
- ESM 入口导入检查通过：`lib/codec/index.js`、`lib/browser/index.js`、`lib/mpegTs/index.js`、`lib/mpegPs/index.js`。
- `git diff --check` 通过。
- 用 Node synthetic bytes 验证了 PS length 0 截断和 HEVC IDR 误判两个缺陷。
