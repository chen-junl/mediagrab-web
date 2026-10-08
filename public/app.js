const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  inspection: null,
  mode: 'video',
  selectedFormat: null,
  job: null,
  eventSource: null,
};

const els = {
  form: $('#inspect-form'),
  url: $('#url-input'),
  paste: $('#paste-button'),
  inspect: $('#inspect-button'),
  feedback: $('#form-feedback'),
  mediaCard: $('#media-card'),
  thumbnail: $('#media-thumbnail'),
  extractor: $('#media-extractor'),
  title: $('#media-title'),
  uploader: $('#media-uploader'),
  duration: $('#media-duration'),
  formatGrid: $('#format-grid'),
  formatCount: $('#format-count'),
  download: $('#download-button'),
  reset: $('#reset-button'),
  progressCard: $('#progress-card'),
  progressTitle: $('#progress-title'),
  progressPercent: $('#progress-percent'),
  progressBar: $('#progress-bar'),
  progressMessage: $('#progress-message'),
  progressFormat: $('#progress-format'),
  completeActions: $('#complete-actions'),
  saveFile: $('#save-file-button'),
  newDownload: $('#new-download-button'),
  history: $('#history-list'),
  clearHistory: $('#clear-history'),
};

const HISTORY_KEY = 'mediagrab-history';

function setFeedback(message = '', type = 'error') {
  els.feedback.textContent = message;
  els.feedback.dataset.type = type;
}

function setBusy(button, busy, busyLabel = '处理中…') {
  if (!button.dataset.label) button.dataset.label = button.querySelector('span')?.textContent || '';
  button.disabled = busy;
  const label = button.querySelector('span');
  if (label) label.textContent = busy ? busyLabel : button.dataset.label;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function currentFormats() {
  return state.inspection?.formats?.[state.mode] || [];
}

function renderFormats() {
  const formats = currentFormats();
  els.formatCount.textContent = `${formats.length} 个选项`;
  if (!formats.length) {
    els.formatGrid.innerHTML = '<p class="empty-history">未找到可用的下载格式。</p>';
    state.selectedFormat = null;
    return;
  }
  if (!formats.some((format) => format.id === state.selectedFormat)) {
    state.selectedFormat = formats[0].id;
  }
  els.formatGrid.innerHTML = formats.map((format) => `
    <button type="button" class="format-option ${format.id === state.selectedFormat ? 'selected' : ''}"
      data-format-id="${escapeHtml(format.id)}" data-format-label="${escapeHtml(format.label)}">
      <strong>${escapeHtml(format.label)}</strong>
      <small>${escapeHtml(format.detail || format.ext || '自动')}</small>
    </button>
  `).join('');
  $$('.format-option').forEach((button) => button.addEventListener('click', () => {
    state.selectedFormat = button.dataset.formatId;
    $$('.format-option').forEach((item) => item.classList.toggle('selected', item === button));
  }));
}

function displayInspection(data) {
  state.inspection = data;
  state.mode = 'video';
  state.selectedFormat = data.formats?.video?.[0]?.id || null;
  els.mediaCard.classList.remove('hidden');
  els.progressCard.classList.add('hidden');
  els.completeActions.classList.add('hidden');
  els.thumbnail.src = data.thumbnail || '/placeholder.svg';
  els.thumbnail.alt = data.title || '媒体缩略图';
  els.extractor.textContent = String(data.extractor || '网页').toUpperCase();
  els.title.textContent = data.title || '未命名媒体';
  els.uploader.textContent = data.uploader || '未知创作者';
  els.duration.textContent = data.duration || '—';
  $$('.mode-button').forEach((button) => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  renderFormats();
  els.mediaCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetInspection() {
  state.inspection = null;
  state.selectedFormat = null;
  state.eventSource?.close();
  els.mediaCard.classList.add('hidden');
  els.progressCard.classList.add('hidden');
  els.url.focus();
}

async function inspectUrl(event) {
  event.preventDefault();
  const url = els.url.value.trim();
  if (!url) return;
  setFeedback('');
  setBusy(els.inspect, true, '正在解析…');
  try {
    const response = await fetch('/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '无法解析此链接。');
    displayInspection(data);
  } catch (error) {
    setFeedback(error.message || '解析失败，请检查链接后重试。');
  } finally {
    setBusy(els.inspect, false);
  }
}

async function pasteUrl() {
  try {
    els.url.value = await navigator.clipboard.readText();
    els.url.focus();
    setFeedback('已从剪贴板粘贴链接。', 'success');
  } catch {
    els.url.focus();
    setFeedback('浏览器未允许读取剪贴板，请手动粘贴链接。');
  }
}

function historyItems() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function addHistory(job) {
  const items = historyItems().filter((item) => item.id !== job.id);
  items.unshift({ id: job.id, title: job.title, formatLabel: job.formatLabel });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 5)));
  renderHistory();
}

function renderHistory() {
  const items = historyItems();
  if (!items.length) {
    els.history.innerHTML = '<p class="empty-history">最近下载的内容会显示在这里。</p>';
    return;
  }
  els.history.innerHTML = items.map((item) => `
    <div class="history-item">
      <span class="history-icon">↓</span>
      <div><strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.formatLabel || 'media')} · 已完成</small></div>
    </div>
  `).join('');
}

function updateProgress(job) {
  els.progressCard.classList.remove('hidden');
  els.progressTitle.textContent = job.status === 'complete' ? '下载已完成' : job.status === 'error' ? '下载遇到问题' : job.status === 'cancelled' ? '下载已取消' : '正在准备文件';
  const percent = Math.max(0, Math.min(100, Number(job.progress) || 0));
  els.progressPercent.textContent = `${Math.round(percent)}%`;
  els.progressBar.style.width = `${percent}%`;
  els.progressMessage.textContent = job.message || '正在处理…';
  els.progressFormat.textContent = job.formatLabel || '—';
  if (job.status === 'complete') {
    els.completeActions.classList.remove('hidden');
    els.saveFile.href = job.downloadUrl || `/api/jobs/${encodeURIComponent(job.id)}/file`;
    els.progressBar.style.background = 'var(--lime)';
    addHistory(job);
  } else if (job.status === 'error' || job.status === 'cancelled') {
    els.completeActions.classList.add('hidden');
    els.progressBar.style.background = 'var(--accent)';
  } else {
    els.completeActions.classList.add('hidden');
    els.progressBar.style.background = 'var(--accent)';
  }
}

function subscribeToJob(id) {
  state.eventSource?.close();
  const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  state.eventSource = source;
  source.addEventListener('snapshot', (event) => handleJobEvent(source, event));
  source.addEventListener('update', (event) => handleJobEvent(source, event));
  ['complete', 'error', 'cancelled'].forEach((name) => {
    source.addEventListener(name, (event) => handleJobEvent(source, event));
  });
  source.onerror = () => {
    if (['complete', 'error', 'cancelled'].includes(state.job?.status)) source.close();
  };
}

function handleJobEvent(source, event) {
  const job = JSON.parse(event.data);
  state.job = job;
  updateProgress(job);
  if (['complete', 'error', 'cancelled'].includes(job.status)) source.close();
}

async function startDownload() {
  if (!state.inspection) return;
  setBusy(els.download, true, '正在创建任务…');
  els.progressCard.classList.remove('hidden');
  els.completeActions.classList.add('hidden');
  try {
    const selected = currentFormats().find((format) => format.id === state.selectedFormat);
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: state.inspection.source,
        mode: state.mode,
        formatId: state.selectedFormat,
        formatLabel: state.mode === 'audio' ? 'MP3' : (selected?.label || '自动'),
        title: state.inspection.title,
      }),
    });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || '无法创建下载任务。');
    state.job = job;
    updateProgress(job);
    subscribeToJob(job.id);
  } catch (error) {
    els.progressTitle.textContent = '下载遇到问题';
    els.progressMessage.textContent = error.message || '无法创建下载任务。';
  } finally {
    setBusy(els.download, false);
  }
}

els.form.addEventListener('submit', inspectUrl);
els.paste.addEventListener('click', pasteUrl);
els.download.addEventListener('click', startDownload);
els.reset.addEventListener('click', resetInspection);
els.newDownload.addEventListener('click', () => {
  resetInspection();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
els.clearHistory.addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});
$$('.mode-button').forEach((button) => button.addEventListener('click', () => {
  state.mode = button.dataset.mode;
  state.selectedFormat = currentFormats()[0]?.id || null;
  $$('.mode-button').forEach((item) => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  });
  renderFormats();
}));
$$('[data-example]').forEach((button) => button.addEventListener('click', () => {
  els.url.value = button.dataset.example;
  els.url.focus();
  setFeedback('示例链接已填入，准备好后即可解析。', 'success');
}));

renderHistory();