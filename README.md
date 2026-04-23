# media-analyzer

`media-analyzer` 是一个媒体解析与浏览器侧分析工具集合，包含：

- `lib/`：可复用的解析与播放能力（MP4/FLV/TS/PS、多格式帧适配、浏览器解码辅助）
- `examples/`：示例页面（媒体总览、逐帧分析）

## 快速开始

本目录为纯源码与静态示例，不依赖 npm。

## 使用示例

### 1) 打开示例页面

在项目根目录启动静态服务：

```bash
python3 -m http.server 8080
```

然后在浏览器打开：

- `http://127.0.0.1:8080/examples/media-overview-demo.html`
- `http://127.0.0.1:8080/examples/frame-analysis-demo.html`

### 2) 在代码中调用统一分析入口

```js
import { analyzeByDetectedFormat } from "./lib/codec/analyzeByDetectedFormat.js";

const bytes = new Uint8Array(await file.arrayBuffer());
const result = await analyzeByDetectedFormat(bytes, {
  fileMeta: { fileName: file.name, fileSize: file.size }
});

console.log(result.format?.formatName);
console.log(result.streams);
console.log(result.frames?.length);
```

## 示例页面截图

### media-overview-demo

![media-overview-demo](./docs/screenshots/media-overview-demo.png)

### frame-analysis-demo

![frame-analysis-demo](./docs/screenshots/frame-analysis-demo.png)

