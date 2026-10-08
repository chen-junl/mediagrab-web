# MediaGrab Web

MediaGrab Web 是一款中文网页媒体下载工具：粘贴公开媒体链接，解析可用格式，选择视频清晰度或 MP3，然后将文件保存到本地。下载由本机 Node.js 服务和 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 完成。

## 项目来源

本项目的产品思路参考了[原始项目](https://github.com/pablostanley/yoinks)。本项目在此基础上提供浏览器界面和本地 Node.js 服务。

## 本地运行

需要安装 Node.js（建议使用当前受支持的 LTS 版本）。

```bash
npm install
npm start
```

然后打开 <http://localhost:3000>。

首次解析或下载时，程序会将 yt-dlp 下载到 `.bin/`；`ffmpeg-static` 提供合并音视频流及提取 MP3 所需的 FFmpeg。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 服务端口 |
| `YT_DLP_PATH` | `.bin/yt-dlp`（Windows 为 `.bin/yt-dlp.exe`） | 指定已有 yt-dlp 可执行文件 |
| `MAX_ACTIVE_JOBS` | `2` | 同时运行的下载任务上限 |

## 安全与部署

默认面向本机或受信任的私有环境。若部署到公网，请先增加身份验证、限流、下载文件定期清理和任务队列，并限制可访问的目标地址以降低 SSRF 风险。不要将 `.env`、`.bin/`、`node_modules/` 或下载文件提交到仓库；这些路径已由 `.gitignore` 排除。

## 许可证

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。第三方依赖遵循其各自许可证。