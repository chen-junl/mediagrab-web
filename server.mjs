import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import YTDlpWrapModule from 'yt-dlp-wrap';
const YTDlpWrap = YTDlpWrapModule.default || YTDlpWrapModule;
import ffmpegPath from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DOWNLOAD_DIR = path.join(ROOT, 'downloads');
const BIN_DIR = path.join(ROOT, '.bin');
const YTDLP_PATH = process.env.YT_DLP_PATH || path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const MAX_ACTIVE_JOBS = Number(process.env.MAX_ACTIVE_JOBS || 2);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

const jobs = new Map();
let ytDlp;
let ytDlpPromise;

await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
await fs.mkdir(BIN_DIR, { recursive: true });

function createId() {
  return crypto.randomBytes(9).toString('base64url');
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    title: job.title,
    formatLabel: job.formatLabel,
    message: job.message,
    fileName: job.fileName || null,
    downloadUrl: job.status === 'complete' ? `/api/jobs/${job.id}/file` : null,
  };
}

function broadcast(job, event = 'update') {
  const payload = `event: ${event}\ndata: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const res of job.clients) res.write(payload);
}

function activeJobCount() {
  return [...jobs.values()].filter((job) => ['queued', 'downloading', 'preparing'].includes(job.status)).length;
}

async function ensureYtDlp() {
  if (ytDlp) return ytDlp;
  if (ytDlpPromise) return ytDlpPromise;

  ytDlpPromise = (async () => {
    if (!existsSync(YTDLP_PATH)) {
      console.log(`[MediaGrab] Downloading yt-dlp binary to ${YTDLP_PATH}`);
      await YTDlpWrap.downloadFromGithub(YTDLP_PATH);
    }
    ytDlp = new YTDlpWrap(YTDLP_PATH);
    return ytDlp;
  })().catch((error) => {
    ytDlpPromise = undefined;
    throw error;
  });

  return ytDlpPromise;
}

function assertUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('请提供媒体链接。');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('链接格式无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('仅支持 http:// 或 https:// 链接。');
  }
  return parsed.toString();
}

function normalizeFormats(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const byHeight = new Map();

  for (const format of formats) {
    const hasVideo = format.vcodec && format.vcodec !== 'none';
    if (!hasVideo || !format.height) continue;
    const height = Number(format.height);
    if (!Number.isFinite(height) || height < 144) continue;
    const current = byHeight.get(height);
    const score = (format.ext === 'mp4' ? 10 : 0) + (format.acodec !== 'none' ? 5 : 0) + Number(format.tbr || 0) / 1000;
    const currentScore = current ? current.score : -1;
    if (score > currentScore) byHeight.set(height, { format, score });
  }

  const video = [...byHeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 8)
    .map(([height, item]) => ({
      id: `bestvideo*[height<=${height}]+bestaudio/best[height<=${height}]/best`,
      label: `${height}p`,
      detail: [item.format.ext?.toUpperCase(), item.format.fps ? `${Math.round(item.format.fps)} FPS` : ''].filter(Boolean).join(' · '),
      height,
      ext: item.format.ext,
    }));

  const audioCandidates = formats
    .filter((format) => format.acodec && format.acodec !== 'none' && (!format.vcodec || format.vcodec === 'none'))
    .sort((a, b) => Number(b.abr || 0) - Number(a.abr || 0));
  const bestAudio = audioCandidates[0];

  return {
    video: video.length ? video : [{ id: 'bestvideo*+bestaudio/best', label: 'Best available', detail: 'Auto · MP4 when possible', height: null, ext: 'auto' }],
    audio: [{ id: 'bestaudio/best', label: 'MP3', detail: bestAudio?.abr ? `Up to ${Math.round(bestAudio.abr)} kbps` : 'Best available audio', ext: 'mp3' }],
  };
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '—';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function safeFormat(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  if (!/^[\w.+*/?\-\[\]{}|()]+$/.test(value)) return null;
  return value;
}

function findOutputFiles(jobId) {
  return fs.readdir(DOWNLOAD_DIR).then((files) => files.filter((file) => file.startsWith(`${jobId}.`)));
}

async function runDownload(job, payload) {
  try {
    job.status = 'preparing';
    job.message = '正在启动下载器…';
    broadcast(job);
    const ytdlp = await ensureYtDlp();

    const outputTemplate = path.join(DOWNLOAD_DIR, `${job.id}.%(ext)s`);
    const args = [
      '--no-playlist',
      '--newline',
      '--no-warnings',
      '--restrict-filenames',
      '--ffmpeg-location',
      ffmpegPath || '',
      '-o',
      outputTemplate,
    ];

    if (payload.mode === 'audio') {
      args.push('-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
      job.formatLabel = 'MP3 audio';
    } else {
      args.push('-f', payload.formatId || 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4');
      job.formatLabel = payload.formatLabel || 'Best available video';
    }

    args.push(payload.url);
    job.status = 'downloading';
    job.message = '正在下载媒体…';
    broadcast(job);

    const emitter = ytdlp.exec(args);
    job.process = emitter.ytDlpProcess;

    emitter.on('progress', (progress) => {
      const percent = Number(progress.percent);
      if (Number.isFinite(percent)) job.progress = Math.max(0, Math.min(100, percent));
      if (progress.currentSpeed) job.message = `${progress.currentSpeed}${progress.eta ? ` · ${progress.eta} left` : ''}`;
      broadcast(job);
    });

    emitter.on('ytDlpEvent', (type, data) => {
      if (type === 'download') {
        job.message = data.replace(/^\[download\]\s*/i, '').trim() || '正在下载媒体…';
      } else if (type === 'postprocess') {
        job.message = '正在整理文件…';
      }
      broadcast(job);
    });

    emitter.once('error', (error) => {
      job.status = 'error';
      job.message = error?.message?.split('\n')[0] || '下载失败。';
      broadcast(job, 'error');
      closeJobClients(job);
    });

    emitter.once('close', async (code) => {
      if (job.status === 'error') return;
      if (code !== 0) {
        job.status = 'error';
        job.message = '下载器未能完成下载。';
        broadcast(job, 'error');
        closeJobClients(job);
        return;
      }
      const files = await findOutputFiles(job.id);
      if (!files.length) {
        job.status = 'error';
        job.message = '下载结束，但未生成文件。';
        broadcast(job, 'error');
        closeJobClients(job);
        return;
      }
      job.progress = 100;
      job.status = 'complete';
      job.fileName = files[0];
      job.message = '文件已准备就绪';
      broadcast(job, 'complete');
      closeJobClients(job);
      setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref();
    });
  } catch (error) {
    job.status = 'error';
    job.message = error?.message?.split('\n')[0] || '无法启动下载。';
    broadcast(job, 'error');
    closeJobClients(job);
  }
}

function closeJobClients(job) {
  for (const res of job.clients) res.end();
  job.clients.clear();
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, ytdlpReady: Boolean(ytDlp || existsSync(YTDLP_PATH)), ffmpegReady: Boolean(ffmpegPath) });
});

app.post('/api/inspect', async (req, res) => {
  try {
    const url = assertUrl(req.body?.url);
    const ytdlp = await ensureYtDlp();
    const infoJson = await ytdlp.execPromise(['--no-playlist', '--no-warnings', '--dump-single-json', url]);
    const info = JSON.parse(infoJson);
    res.json({
      source: url,
      title: info.title || 'Untitled media',
      uploader: info.uploader || info.channel || 'Unknown creator',
      duration: formatDuration(info.duration),
      durationSeconds: info.duration || null,
      thumbnail: info.thumbnail || null,
      webpageUrl: info.webpage_url || url,
      extractor: info.extractor_key || info.extractor || 'Web',
      formats: normalizeFormats(info),
    });
  } catch (error) {
    res.status(400).json({ error: error?.message || '无法解析此链接。' });
  }
});

app.post('/api/download', async (req, res) => {
  try {
    if (activeJobCount() >= MAX_ACTIVE_JOBS) return res.status(429).json({ error: '服务器正忙，请稍后重试。' });
    const url = assertUrl(req.body?.url);
    const mode = req.body?.mode === 'audio' ? 'audio' : 'video';
    const formatId = mode === 'video' ? safeFormat(req.body?.formatId) : 'bestaudio/best';
    const job = {
      id: createId(),
      status: 'queued',
      progress: 0,
      title: String(req.body?.title || 'Untitled media').slice(0, 180),
      formatLabel: mode === 'audio' ? 'MP3 audio' : String(req.body?.formatLabel || 'Video').slice(0, 80),
      message: '等待下载',
      fileName: null,
      url,
      clients: new Set(),
      process: null,
    };
    jobs.set(job.id, job);
    res.status(202).json(publicJob(job));
    void runDownload(job, { url, mode, formatId: formatId || 'bestvideo*+bestaudio/best', formatLabel: job.formatLabel });
  } catch (error) {
    res.status(400).json({ error: error?.message || '无法启动下载。' });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在或已过期。' });
  res.json(publicJob(job));
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  job.clients.add(res);
  res.write(`event: snapshot\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
  req.on('close', () => job.clients.delete(res));
});

app.get('/api/jobs/:id/file', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'complete' || !job.fileName) return res.status(404).send('文件尚未准备就绪。');
  const filePath = path.join(DOWNLOAD_DIR, job.fileName);
  if (!filePath.startsWith(DOWNLOAD_DIR) || !existsSync(filePath)) return res.status(404).send('文件已不可用。');
  res.download(filePath, job.title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').trim().slice(0, 140) + path.extname(filePath));
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在。' });
  if (job.process && !job.process.killed) job.process.kill('SIGTERM');
  job.status = 'cancelled';
  job.message = '已取消';
  broadcast(job, 'cancelled');
  closeJobClients(job);
  res.json(publicJob(job));
});

app.get(/.*/, (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  MEDIAGRAB WEB  http://localhost:${PORT}\n`);
  console.log(`  downloads  ${DOWNLOAD_DIR}`);
});

