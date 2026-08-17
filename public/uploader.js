'use strict';
/*
 * 大文件分片上传器
 * - 按 2MB 分片 POST 到 /api/upload/chunk（服务端落 DATA/chunks/<fileId>/<index>.part）
 * - 实时进度 / 速度（XHR upload.onprogress + 滑动窗口 EMA）
 * - 暂停 / 继续 / 取消
 * - 网络中断自动重试（断点续传：每片失败重试，已传分片不重传）
 * - 完成后合并（/api/upload/complete）并回调 onComplete({url,name,size})
 */
(function () {
  const CHUNK_SIZE = 2 * 1024 * 1024; // 须与服务端一致
  const MAX_RETRIES = 6;              // 单片网络错误最大重试次数
  const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024; // 4GB 上限，保护磁盘

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 由文件元信息生成稳定 fileId（同名/同大小/同修改时间 -> 同一 id），支持跨次选择断点续传
  async function makeFileId(file) {
    try {
      const data = new TextEncoder().encode(`${file.name}|${file.size}|${file.lastModified}`);
      const buf = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // 非安全上下文（如 http 局域网）下 crypto.subtle 不可用：退化为随机 id（会话内仍可按 id 续传）
      return 'f' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
    }
  }

  function fmtSize(bytes) {
    if (!bytes || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    const kb = bytes / 1024;
    if (kb < 1024) return kb.toFixed(1) + ' KB';
    const mb = kb / 1024;
    if (mb < 1024) return mb.toFixed(1) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
  }

  // ---------------- 单个文件上传任务 ----------------
  class UploadTask {
    constructor(file, fileId, mgr) {
      this.file = file;
      this.fileId = fileId;
      this.mgr = mgr;
      this.total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
      this.next = 0;
      this.bytesConfirmed = 0; // 已完成分片累计字节（进度/速度基准）
      this.curLoaded = 0;      // 当前分片已上传字节（XHR 进度）
      this.state = 'uploading'; // uploading | retrying | paused | completed | failed | canceled
      this.paused = false;
      this.cancelled = false;
      this.retries = 0;
      this.startTime = Date.now();
      this.finishTime = 0;
      this.xhr = null;
      this.speed = 0;
      this._samples = [];      // [{t, bytes}] 滑动窗口
      this._waiters = [];
      this.el = null;
      this.built = false;
      this._timer = null;
    }

    get loaded() { return Math.min(this.bytesConfirmed + this.curLoaded, this.file.size); }
    get percent() {
      if (this.file.size === 0) return this.state === 'completed' ? 100 : 0;
      const p = Math.floor((this.loaded / this.file.size) * 100);
      return Math.max(0, Math.min(100, p));
    }

    async start() {
      await this._resumeFromServer();
      this.render();
      this._tick();
      this._loop();
    }

    // 启动时向服务端查询已收到的分片，跳过已传部分（断点续传）
    async _resumeFromServer() {
      try {
        const r = await fetch('/api/upload/status?fileId=' + encodeURIComponent(this.fileId));
        const d = await r.json();
        if (Array.isArray(d.received) && d.received.length) {
          const sorted = [...d.received].sort((a, b) => a - b);
          let n = 0;
          for (const i of sorted) { if (i === n) n++; else break; }
          this.next = n;
          let confirmed = 0;
          for (let i = 0; i < n; i++) confirmed += Math.min(CHUNK_SIZE, this.file.size - i * CHUNK_SIZE);
          this.bytesConfirmed = confirmed;
        }
      } catch { /* 状态查询失败不影响全新上传 */ }
    }

    _loop() {
      const run = async () => {
        while (this.next < this.total && !this.cancelled) {
          if (this.paused) {
            this._setState('paused');
            await this._waitWhilePaused();
            if (this.cancelled) break;
            continue;
          }
          const index = this.next;
          const start = index * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, this.file.size);
          const blob = this.file.slice(start, end);
          this.curLoaded = 0;
          this._setState('uploading');
          try {
            await this._uploadChunk(index, blob);
            this.bytesConfirmed += (end - start);
            this.curLoaded = 0;
            this.next++;
            this.retries = 0;
            this._updateProgress();
          } catch (err) {
            if (this.cancelled) break;
            this.retries++;
            if (this.retries > MAX_RETRIES) {
              this._setState('failed', '上传失败：' + (err && err.message ? err.message : '网络错误'));
              return;
            }
            this._setState('retrying', '网络中断，正在重连…(' + this.retries + '/' + MAX_RETRIES + ')');
            await sleep(Math.min(1000 * 2 ** (this.retries - 1), 8000));
          }
        }
        if (this.cancelled) { await this._cleanup(); this.mgr.removeTask(this); return; }
        if (this.next >= this.total) { await this._complete(); }
      };
      run();
    }

    _uploadChunk(index, blob) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        this.xhr = xhr;
        xhr.open('POST', '/api/upload/chunk');
        const fd = new FormData();
        fd.append('fileId', this.fileId);
        fd.append('index', String(index));
        fd.append('total', String(this.total));
        fd.append('chunk', blob);
        const base = this.bytesConfirmed;
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            this.curLoaded = e.loaded;
            this._sample(Date.now(), base + e.loaded);
            this._updateProgress();
          }
        };
        xhr.onload = () => {
          this.xhr = null;
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error('HTTP ' + xhr.status));
        };
        xhr.onerror = () => { this.xhr = null; reject(new Error('网络错误')); };
        xhr.onabort = () => { this.xhr = null; reject(new Error('已取消')); };
        xhr.send(fd);
      });
    }

    // 速度滑动窗口 + 指数滑动平均，避免数字剧烈跳动
    _sample(t, bytes) {
      this._samples.push({ t, bytes });
      const cutoff = t - 1500;
      while (this._samples.length > 2 && this._samples[0].t < cutoff) this._samples.shift();
      const first = this._samples[0];
      const dt = (t - first.t) / 1000;
      if (dt > 0.2) {
        const inst = (bytes - first.bytes) / dt;
        this.speed = this.speed ? this.speed * 0.7 + inst * 0.3 : inst;
      }
    }

    async _complete() {
      this._setState('uploading', '合并中…');
      try {
        const res = await fetch('/api/upload/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileId: this.fileId,
            name: this.file.name,
            size: this.file.size,
            total: this.total,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '合并失败');
        this.finishTime = Date.now();
        this.curLoaded = 0;
        this.bytesConfirmed = this.file.size;
        this._setState('completed');
        this._showSummary(data);
        if (this.mgr.onComplete) this.mgr.onComplete({ url: data.url, name: data.name, size: data.size });
      } catch (e) {
        this._setState('failed', '合并失败：' + (e.message || '未知错误'));
      }
    }

    pause() {
      if (this.state === 'completed' || this.state === 'failed' || this.cancelled) return;
      this.paused = true;
      if (this.xhr) { try { this.xhr.abort(); } catch {} }
      this._setState('paused');
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      this._setState('uploading');
      this._resolveWaiters();
    }

    cancel() {
      this.cancelled = true;
      this.paused = false;
      if (this.xhr) { try { this.xhr.abort(); } catch {} }
      this._setState('canceled');
      this._resolveWaiters();
    }

    async _cleanup() {
      try {
        await fetch('/api/upload/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId: this.fileId }),
        });
      } catch {}
    }

    _waitWhilePaused() { return new Promise((resolve) => this._waiters.push(resolve)); }
    _resolveWaiters() {
      const rs = this._waiters;
      this._waiters = [];
      rs.forEach((r) => r());
    }

    // ---------------- 渲染 ----------------
    render() {
      if (this.built) return;
      this.built = true;
      const el = document.createElement('div');
      el.className = 'up-card state-uploading';
      el.innerHTML = `
        <div class="up-head">
          <span class="up-name" title=""></span>
          <span class="up-badge"></span>
        </div>
        <div class="up-bar"><div class="up-fill"></div></div>
        <div class="up-meta">
          <span class="up-pct">0%</span>
          <span class="up-info"></span>
          <span class="up-actions">
            <button type="button" class="up-btn up-pause">暂停</button>
            <button type="button" class="up-btn up-cancel">取消</button>
          </span>
        </div>
        <div class="up-summary hidden"></div>
      `;
      this.el = el;
      this.elName = el.querySelector('.up-name');
      this.elBadge = el.querySelector('.up-badge');
      this.elFill = el.querySelector('.up-fill');
      this.elPct = el.querySelector('.up-pct');
      this.elInfo = el.querySelector('.up-info');
      this.elActions = el.querySelector('.up-actions');
      this.elPause = el.querySelector('.up-pause');
      this.elCancel = el.querySelector('.up-cancel');
      this.elSummary = el.querySelector('.up-summary');

      this.elName.textContent = this.file.name;
      this.elName.title = this.file.name;

      this.elPause.addEventListener('click', () => { if (this.paused) this.resume(); else this.pause(); });
      this.elCancel.addEventListener('click', () => this.cancel());

      this.mgr.panel.appendChild(el);
      this._updateProgress();
    }

    _setState(state, note) {
      this.state = state;
      if (!this.el) return;
      this.el.className = 'up-card state-' + state;
      const map = {
        uploading: '上传中',
        retrying: '重连中',
        paused: '已暂停',
        completed: '完成',
        failed: '失败',
        canceled: '已取消',
      };
      this.elBadge.textContent = note || map[state] || state;

      if (state === 'completed' || state === 'canceled') {
        this.elActions.classList.add('hidden');
      } else if (state === 'failed') {
        this.elPause.classList.remove('hidden');
        this.elPause.textContent = '重试';
        this.elPause.onclick = () => this._retry();
      } else {
        this.elPause.classList.remove('hidden');
        this.elPause.textContent = this.paused ? '继续' : '暂停';
        this.elPause.onclick = () => { if (this.paused) this.resume(); else this.pause(); };
      }
      this._updateProgress();
    }

    _retry() {
      this.retries = 0;
      this.paused = false;
      this.elPause.textContent = '暂停';
      this.elPause.onclick = () => { if (this.paused) this.resume(); else this.pause(); };
      this._setState('uploading');
      this._loop();
    }

    _updateProgress() {
      if (!this.el) return;
      const pct = this.percent;
      this.elFill.style.width = pct + '%';
      this.elPct.textContent = pct + '%';
      const info = fmtSize(this.loaded) + ' / ' + fmtSize(this.file.size);
      if (this.state === 'uploading' || this.state === 'retrying') {
        if (this.speed > 0) info += '  ·  ' + fmtSize(this.speed) + '/s';
        const remain = this.speed > 0 ? (this.file.size - this.loaded) / this.speed : 0;
        if (remain > 1) info += '  ·  剩余 ' + this._fmtTime(remain);
      }
      if (this.state === 'paused') info += '  ·  已暂停';
      this.elInfo.textContent = info;
    }

    _fmtTime(sec) {
      sec = Math.max(0, Math.round(sec));
      if (sec < 60) return sec + 's';
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      if (m < 60) return m + 'm' + (s ? s + 's' : '');
      const h = Math.floor(m / 60);
      return h + 'h' + (m % 60) + 'm';
    }

    _showSummary(data) {
      const elapsed = Math.max(0, (this.finishTime - this.startTime) / 1000);
      const avg = elapsed > 0 ? this.file.size / elapsed : 0;
      this.elSummary.classList.remove('hidden');
      this.elSummary.innerHTML = `
        <div class="up-sum-title">✅ 上传完成</div>
        <div class="up-sum-row"><span>文件名</span><b class="up-sum-name"></b></div>
        <div class="up-sum-row"><span>大小</span><b>${fmtSize(data.size)}</b></div>
        <div class="up-sum-row"><span>耗时</span><b>${this._fmtTime(elapsed)}</b></div>
        <div class="up-sum-row"><span>平均速度</span><b>${fmtSize(avg)}/s</b></div>
      `;
      const nm = this.elSummary.querySelector('.up-sum-name');
      nm.textContent = data.name || this.file.name;
      nm.title = data.name || this.file.name;
    }

    // 周期性刷新速度/剩余时间（即使某分片内无进度事件也能更新）
    _tick() {
      this._timer = setInterval(() => {
        if (this.state === 'uploading' || this.state === 'retrying') this._updateProgress();
        else { clearInterval(this._timer); this._timer = null; }
      }, 1000);
    }
  }

  // ---------------- 上传管理器 ----------------
  class UploadManager {
    constructor() {
      this.tasks = [];
      this.panel = null;
      this.onComplete = null; // 由 app.js 注入：上传完成后发送 WS 文件消息
    }
    init(panelEl) { this.panel = panelEl; }
    async addFile(file) {
      if (!file) return;
      if (file.size > MAX_FILE_SIZE) {
        window.alert('文件过大（超过 4GB），无法上传喵~');
        return;
      }
      const id = await makeFileId(file);
      const task = new UploadTask(file, id, this);
      this.tasks.push(task);
      this.showPanel();
      task.start();
    }
    removeTask(task) {
      this.tasks = this.tasks.filter((t) => t !== task);
      if (task.el && task.el.parentNode) task.el.parentNode.removeChild(task.el);
      if (this.tasks.length === 0) this.hidePanel();
    }
    showPanel() { if (this.panel) this.panel.classList.remove('hidden'); }
    hidePanel() { if (this.panel) this.panel.classList.add('hidden'); }
  }

  window.uploadManager = new UploadManager();
})();
