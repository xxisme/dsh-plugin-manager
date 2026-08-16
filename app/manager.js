/**
 * dsh-plugin-manager / app/manager.js
 *
 * 前端（vanilla JS，零依赖）：
 *  - 状态条 + 操作按钮（刷新/备份）
 *  - 左列：profile 切换
 *  - 右列上半：两个安装入口（zip 文件 / dsh 命令）
 *  - 右列下半：已安装插件列表
 *  - 底部：实时任务输出（job 输出流）+ 操作日志
 */

(function () {
  'use strict';

  const API = window.HANA_PLUGIN_BASE || '/api/plugins/dsh-plugin-manager';
  const TOKEN = window.HANA_PLUGIN_TOKEN || '';

  const STATE = {
    dshHome: null,
    profiles: [],
    currentProfile: null,
    plugins: [],
    extras: [],
    status: null,
    homes: { current: null, candidates: [] },  // 候选 home + 当前选择
    activeTab: 'zip',   // 当前激活的安装方式 tab
    currentJob: null,   // { id, lines, done, exitCode }
    pollTimer: null,
    updateCache: {},   // { pkgName: { status, commitsBehind, likelyModified, ... } } 自动检查更新后的缓存（用于卡片显示魔改/落后状态）
  };

  // ── helpers ────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, type) {
    type = type || 'success';
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast ' + type + ' show';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'toast'; }, type === 'error' ? 6000 : 3500);
  }
  async function api(method, path, body, opts = {}) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (TOKEN) opt.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body) opt.body = JSON.stringify(body);
    // 默认 10s 超时。install/update 这类长操作必须传 timeoutMs 跳过默认。
    const timeoutMs = opts.timeoutMs || 10000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    opt.signal = ctrl.signal;
    try {
      const r = await fetch(API + path, opt);
      const text = await r.text();
      try { return JSON.parse(text); } catch { return { ok: false, error: text || `HTTP ${r.status}` }; }
    } finally {
      clearTimeout(timer);
    }
  }
  function fmtDuration(ms) {
    if (!ms) return '';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.floor(ms / 60000) + 'm' + Math.floor((ms % 60000) / 1000) + 's';
  }

  // ── 渲染 ──────────────────────────────────────────
  function renderProfileListInner() {
    if (!STATE.profiles || STATE.profiles.length === 0) {
      return '<div class="empty" style="padding:20px 10px">加载中…</div>';
    }
    return STATE.profiles.map((p) => `
      <div class="profile-item ${p === STATE.currentProfile ? 'active' : ''}" data-profile="${esc(p)}">
        <span>${esc(p)}</span>
      </div>
    `).join('');
  }

  function bindProfileList() {
    document.querySelectorAll('.profile-item').forEach((el) => {
      el.onclick = () => {
        STATE.currentProfile = el.dataset.profile;
        render();
        loadAll();
      };
    });
  }

  function render() {
    // 状态条文本从 STATE.status 读（任何时候 render 都反映当前状态）
    const s = STATE.status;
    const currentHome = STATE.homes.current;
    const dshHomeText = currentHome
      ? currentHome
      : (s?.dshHome || '初次加载中…');
    const dshWebHud = s?.dshWeb?.ok
      ? `<span class="pulse"></span> dsh web :${esc(String(s.dshWeb.port))}${s.dshWeb.version ? ' ' + esc(s.dshWeb.version) : ''}`
      : `<span class="pulse off"></span> dsh web ${s?.dshWeb ? '离线' : '检测中…'}`;
    const pnpmHud = s?.pnpm?.ok
      ? `<span class="pulse"></span> pnpm ${esc(s.pnpm.version)}`
      : `<span class="pulse off"></span> pnpm ${s?.pnpm ? '不可用' : '检测中…'}`;

    // Home 切换器：顶栏多出一个下拉
    const candidates = STATE.homes.candidates || [];
    const homeLabel = currentHome
      ? (STATE.homes.candidates.find(c => c.path === currentHome)?.label || currentHome)
      : '选择 home…';
    const homeSwitcher = `
      <button class="btn sm" id="btn-home-switch" title="${esc(currentHome || '')}">
        🏠 ${esc(homeLabel)} ▼
      </button>
    `;

    $('root').innerHTML = `
      <div class="hdr">
        <h1>📦 DSH 插件管理</h1>
        <div class="rt">
          <span id="status-dsh">${dshWebHud}</span>
          <span id="status-pnpm">${pnpmHud}</span>
        </div>
      </div>

      <div class="path-bar glass">
        <div class="path-info">
          <span class="path-label">DSH_HOME</span>
          <span class="path-value" id="dsh-home">${esc(dshHomeText)}</span>
        </div>
        <div class="actions">
          ${homeSwitcher}
          <button class="btn sm" id="btn-refresh">🔄 刷新</button>
          <button class="btn sm" id="btn-backups">🗄️ 备份配置文件</button>
          <button class="btn sm" id="btn-v2">📦 备份插件源</button>
        </div>
      </div>

      <div class="main-grid">
        <div class="glass">
          <div class="section-title">Profiles</div>
          <div class="profile-list" id="profile-list">
            ${renderProfileListInner()}
          </div>
        </div>

        <div class="glass">
          <!-- 安装入口 -->
          <div class="install-section">
            <div class="section-title">安装插件</div>
            <div class="install-tabs">
              <button class="install-tab ${STATE.activeTab === 'zip' ? 'active' : ''}" data-install-tab="zip">
                📁 本地 zip
              </button>
              <button class="install-tab ${STATE.activeTab === 'cmd' ? 'active' : ''}" data-install-tab="cmd">
                ⌨️ dsh 命令
              </button>
            </div>

            <div class="install-body" id="install-body"></div>

            <!-- 实时输出 -->
            <div class="output-section" id="output-section" style="display:none">
              <div class="output-hdr">
                <span class="output-title">📺 执行输出</span>
                <span class="output-status" id="output-status"></span>
              </div>
              <div class="output-progress" id="output-progress"></div>
              <pre class="output-log" id="output-log"></pre>
            </div>
          </div>

          <!-- 已装插件列表 -->
          <div class="plugins-section">
            <div class="plugins-hdr">
              <h2 id="plugins-title">已装插件</h2>
              <div class="plugins-stats" id="plugins-stats"></div>
              <button class="btn sm" id="btn-check-updates" style="margin-left:auto">🔍 检查更新</button>
            </div>
            <div id="update-panel" style="display:none;margin-bottom:10px"></div>
            <div id="plugins-content">
              <div class="empty">选择左侧 profile</div>
            </div>
          </div>
        </div>
      </div>

      <details class="log-panel glass" open>
        <summary>📜 操作日志 <span style="font-size:11px;color:var(--text-faint);font-weight:normal">（每 5 秒刷新）</span></summary>
        <div id="log-list" class="log-list">
          <div class="empty" style="padding:20px">暂无日志</div>
        </div>
      </details>

      <div id="toast" class="toast"></div>
      <div id="modal" class="modal-bg"></div>
    `;

    $('btn-refresh').addEventListener('click', loadAll);
    $('btn-backups').addEventListener('click', openBackupsModal);
    $('btn-v2').addEventListener('click', openV2Modal);
    if ($('btn-home-switch')) $('btn-home-switch').addEventListener('click', openHomeSwitcher);
    if ($('btn-check-updates')) $('btn-check-updates').addEventListener('click', checkUpdatesUI);

    // profile list clicks
    bindProfileList();

    // install tabs
    document.querySelectorAll('[data-install-tab]').forEach((b) => {
      b.addEventListener('click', () => {
        STATE.activeTab = b.dataset.installTab;
        document.querySelectorAll('[data-install-tab]').forEach((x) =>
          x.classList.toggle('active', x === b));
        renderInstallPanel();
      });
    });

    renderInstallPanel();
  }

  function renderInstallPanel() {
    const body = $('install-body');
    if (STATE.activeTab === 'zip') {
      body.innerHTML = renderZipPanel();
      bindZipPanel();
    } else {
      body.innerHTML = renderCmdPanel();
      bindCmdPanel();
    }
  }

  function renderZipPanel() {
    if (!STATE.currentProfile) {
      return `<div class="empty" style="padding:24px">请先选择 profile</div>`;
    }
    return `
      <div class="hint-row">粘贴 zip 绝对路径（例：<code>C:\\Users\\me\\Downloads\\plugin.zip</code>），或点「📂 浏览…」由宿主选择本地文件。</div>
      <div class="install-row">
        <input id="zip-path" placeholder="C:\\Users\\me\\Downloads\\my-plugin.zip" />
        <button class="btn" id="zip-browse-btn">📂 浏览…</button>
        <button class="btn accent" id="zip-install-btn">📦 安装</button>
      </div>
      <label class="check-row">
        <input type="checkbox" id="zip-force"> 目标已存在时强制覆盖
      </label>
      <div id="zip-info" class="install-info" style="display:none"></div>
    `;
  }

  function renderCmdPanel() {
    return `
      <div class="hint-row">从 GitHub 复制 dsh 安装命令，粘贴到下面即可执行。注意：只允许 <code>dsh plugin --profile X add/update &lt;pkg&gt;</code> 格式。</div>
      <div class="install-row">
        <input id="cmd-input" placeholder="dsh plugin --profile web add @nanmicoder/dsh-agent-teams" spellcheck="false" />
      </div>
      <div id="cmd-preview" class="cmd-preview" style="display:none"></div>
      <div class="install-row" style="margin-top:6px">
        <button class="btn" id="cmd-parse-btn">🔍 解析预览</button>
        <button class="btn accent" id="cmd-execute-btn" disabled>▶ 执行</button>
        <span style="margin-left:auto;font-size:11px;color:var(--text-faint)">
          当前 profile: <b id="cmd-current-profile">${esc(STATE.currentProfile || '(未选)')}</b>
        </span>
      </div>
    `;
  }

  function bindZipPanel() {
    if (!STATE.currentProfile) return;
    const btn = $('zip-browse-btn');
    if (btn) btn.onclick = pickZipFile;
    const installBtn = $('zip-install-btn');
    if (installBtn) installBtn.onclick = submitZipInstall;
    const zipIn = $('zip-path');
    if (zipIn) {
      zipIn.oninput = updateZipInfo;
      zipIn.onchange = updateZipInfo;
    }
  }

  function bindCmdPanel() {
    const input = $('cmd-input');
    const parseBtn = $('cmd-parse-btn');
    const executeBtn = $('cmd-execute-btn');
    if (STATE.currentProfile) {
      $('cmd-current-profile').textContent = STATE.currentProfile;
    }

    parseBtn.addEventListener('click', async () => {
      const command = input.value.trim();
      if (!command) { toast('请粘贴 dsh plugin 命令', 'warn'); return; }
      const r = await api('POST', '/api/parse-cmd', { command });
      const preview = $('cmd-preview');
      preview.style.display = 'block';
      if (!r.ok) {
        preview.innerHTML = `<div class="result-msg err">❌ ${esc(r.error)}</div>`;
        executeBtn.disabled = true;
        return;
      }
      const p = r.parsed;
      preview.innerHTML = `
        <div class="cmd-preview-row"><span class="cmd-key">profile</span><span class="cmd-val">${esc(p.profile)}</span></div>
        <div class="cmd-preview-row"><span class="cmd-key">action</span><span class="cmd-val">${esc(p.action)}</span></div>
        <div class="cmd-preview-row"><span class="cmd-key">package</span><span class="cmd-val"><code>${esc(p.package)}</code></span></div>
      `;
      executeBtn.disabled = false;
      executeBtn.dataset.parsed = JSON.stringify(p);
    });

    executeBtn.addEventListener('click', submitCmdInstall);
  }

  async function updateZipInfo() {
    const p = $('zip-path').value.trim();
    const info = $('zip-info');
    if (!p) { info.style.display = 'none'; return; }
    if (!p.toLowerCase().endsWith('.zip')) {
      info.style.display = 'block';
      info.innerHTML = `<div class="result-msg err">不是 .zip 文件</div>`;
      return;
    }
    info.style.display = 'none';
  }

  /**
 * 从 File 对象解析绝对路径（Electron 不同版本途径不同）：
 *  1. file.path（旧版 Electron < 25 直接给）
 *  2. window.platform?.getFilePath?.(file)（hana desktop renderer 注入）
 *  3. window.hanaWeb?.getPathForFile?.(file)（可能注入的 webUtils 封装）
 * 拿不到绝对路径说明宿主没暴露，必须拒绝（否则装错位置）。
 */
  function resolveFilePath(file) {
    if (!file) return { error: '未获取到文件' };
    let p = '';
    try { if (file.path) p = file.path; } catch (e) { /* ignore */ }
    if (!p) {
      try { if (window.platform && typeof window.platform.getFilePath === 'function') p = window.platform.getFilePath(file); } catch (e) { /* ignore */ }
    }
    if (!p) {
      try { if (window.hanaWeb && typeof window.hanaWeb.getPathForFile === 'function') p = window.hanaWeb.getPathForFile(file); } catch (e) { /* ignore */ }
    }
    if (!p) return { error: '宿主未提供文件绝对路径，请手填路径' };
    return { path: String(p).replace(/\//g, '\\') };
  }

  /**
   * 走 hana 资源拾取协议（与 hana-backup 同款）
   * 官方协议 packages/plugin-protocol/src/index.ts：
   *  - type: 'resource.pick'
   *  - payload: { mode: 'file' | 'directory', multiple?: boolean }
   *  - 响应: { resources: [{ kind, path/fileId/mountId, ... }] }
   * 必须在 manifest.ui.hostCapabilities 里声明 'resource.pick'，否则宿主会拒绝。
   */
  function pickViaHost(opts) {
    opts = opts || {};
    var mode = opts.mode || 'file';
    var multiple = !!opts.multiple;
    if (!window.parent || window.parent === window) return Promise.resolve(null);
    var id = 'pick_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 30000);
      function handler(e) {
        try {
          var msg = e.data;
          if (!(msg && msg.protocol === 'hana.plugin.ui' && msg.id === id && msg.kind === 'response')) return;
          clearTimeout(timer);
          window.removeEventListener('message', handler);
          if (msg.kind === 'error') {
            toast('选择失败：' + ((msg.error && msg.error.message) || '未知错误'), 'error');
            resolve(null);
            return;
          }
          var resources = (msg.payload && msg.payload.resources) || [];
          if (!resources.length) { resolve(null); return; }
          var r = resources[0];
          var p = r.path || r.filePath || r.realPath || '';
          if (p) {
            resolve({ path: String(p).replace(/\//g, '\\') });
          } else if (r.fileId) {
            toast('宿主返回的是 session-file fileId 而非本地路径，请选本地文件', 'warn');
            resolve(null);
          } else {
            resolve(null);
          }
        } catch (err) { /* ignore */ }
      }
      window.addEventListener('message', handler);
      window.parent.postMessage({
        protocol: 'hana.plugin.ui',
        version: 1,
        id: id,
        kind: 'request',
        type: 'resource.pick',
        payload: { mode: mode, multiple: multiple }
      }, '*');
    });
  }

  /** 浏览：优先走 hana 宿主原生对话框；宿主无能力时退回 input type=file。 */
  async function pickZipFile() {
    var r = await pickViaHost({ mode: 'file' });
    if (r && r.path) {
      $('zip-path').value = r.path;
      updateZipInfo();
      toast('已选择文件', 'success');
      return;
    }
    pickZipViaInput();
  }

  /** 兜底：浏览器原生 <input type="file"> */
  function pickZipViaInput() {
    var inp = document.querySelector('#zip-file-picker');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.id = 'zip-file-picker';
      inp.accept = '.zip';
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        inp.value = '';
        if (!f) { toast('未选择文件', 'warn'); return; }
        if (!f.name.toLowerCase().endsWith('.zip')) {
          toast('请选择 .zip 文件', 'warn');
          return;
        }
        var r = resolveFilePath(f);
        if (r.error) {
          toast(r.error, 'error');
          return;
        }
        $('zip-path').value = r.path;
        updateZipInfo();
        toast('已选择文件', 'success');
      });
    }
    inp.click();
  }

  async function renderBrowser(container, startPath, onPick) {
    const path = startPath || '';
    const r = await api('GET', '/api/browse?path=' + encodeURIComponent(path));
    if (!r.ok) {
      container.innerHTML = `<div style="padding:10px;color:var(--red)">${esc(r.error)}</div>`;
      return;
    }
    const rows = [];
    if (r.parent && r.parent !== r.path) {
      rows.push(`<div class="browser-row" data-path="${esc(r.parent)}" data-action="cd">
        <span class="icon">⬆️</span><span class="name">.. (上级)</span>
      </div>`);
    }
    for (const e of r.entries) {
      const isZip = e.isFile && /\.zip$/i.test(e.name);
      const action = isZip ? 'pick' : 'cd';
      rows.push(`<div class="browser-row" data-path="${esc(r.path)}\\${esc(e.name)}" data-action="${action}">
        <span class="icon ${e.isDir ? 'dir' : 'file'}"></span>
        <span class="name">${esc(e.name)}${isZip ? ' ✨' : ''}</span>
      </div>`);
    }
    container.innerHTML = `
      <div class="browser-hdr">📂 ${esc(r.path)} <span style="color:var(--text-faint)">${r.entries.length} 项</span></div>
      ${rows.join('') || '<div class="empty" style="padding:20px">空目录</div>'}
    `;
    container.querySelectorAll('.browser-row').forEach((row) => {
      row.addEventListener('click', () => {
        if (row.dataset.action === 'cd') {
          renderBrowser(container, row.dataset.path, onPick);
        } else if (row.dataset.action === 'pick') {
          onPick(row.dataset.path);
        }
      });
    });
  }

  // ── 安装执行 ──────────────────────────────────────
  function showOutput(job) {
    STATE.currentJob = job;
    $('output-section').style.display = 'block';
    updateOutput();
  }

  function updateOutput() {
    const job = STATE.currentJob;
    if (!job) return;
    const statusEl = $('output-status');
    const progressEl = $('output-progress');
    const logEl = $('output-log');
    const isDone = job.status === 'done' || job.status === 'error';
    const isOk = job.exitCode === 0;

    statusEl.textContent = isDone
      ? (isOk ? '✅ 完成' : '❌ 失败')
      : '⏳ 执行中…';
    statusEl.style.color = isDone
      ? (isOk ? 'var(--green)' : 'var(--red)')
      : 'var(--text-dim)';

    progressEl.innerHTML = isDone
      ? `<div class="progress-bar done" style="width:100%"></div>`
      : `<div class="progress-bar"><div class="progress-fill"></div></div>`;

    logEl.textContent = (job.stdout || '') + (job.stderr ? '\n--- stderr ---\n' + job.stderr : '');
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function pollJob(jobId) {
    const r = await api('GET', '/api/job/' + jobId);
    if (!r.ok) return;
    STATE.currentJob = r.job;
    updateOutput();
    if (STATE.currentJob.status === 'running') {
      STATE.pollTimer = setTimeout(() => pollJob(jobId), 500);
    } else {
      STATE.pollTimer = null;
    }
  }

  async function submitZipInstall() {
    const zipPath = $('zip-path').value.trim();
    const force = $('zip-force').checked;
    if (!zipPath) { toast('请选择 zip 文件', 'warn'); return; }
    if (!zipPath.toLowerCase().endsWith('.zip')) {
      toast('不是 .zip 文件', 'warn'); return;
    }

    const btn = $('zip-install-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 安装中…';

    try {
      // 先开 job 占位（让 UI 立刻有进度条）
      showOutput({
        id: 'pending', status: 'running',
        stdout: `⏳ 准备安装 ${zipPath}\n   profile: ${STATE.currentProfile}\n\n`, stderr: '',
      });

      const r = await api('POST', '/api/install/zip', {
        profile: STATE.currentProfile,
        zipPath,
        force,
      });

      if (r.job && r.job.id) {
        // 切到真实 job
        showOutput(r.job);
        if (r.job.status === 'running') {
          STATE.pollTimer = setTimeout(() => pollJob(r.job.id), 300);
        }
      } else {
        // 没有 job（罕见）
        $('output-log').textContent += '\n' + (r.stdout || JSON.stringify(r));
      }

      if (r.ok) {
        toast(`✅ 安装成功: ${r.pluginName}`);
        await loadPlugins(STATE.currentProfile);
        await loadLogs();
      } else {
        toast('安装失败：' + r.error, 'error');
      }
    } catch (e) {
      toast('请求失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '📦 安装';
    }
  }

  async function submitCmdInstall() {
    const command = $('cmd-input').value.trim();
    if (!command) { toast('请粘贴 dsh plugin 命令', 'warn'); return; }

    const btn = $('cmd-execute-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 执行中…';

    try {
      showOutput({
        id: 'pending', status: 'running',
        stdout: `⏳ 执行命令:\n   ${command}\n\n`, stderr: '',
      });

      const r = await api('POST', '/api/install/cmd', {
        profile: STATE.currentProfile,
        command,
      });

      if (r.job && r.job.id) {
        showOutput(r.job);
        if (r.job.status === 'running') {
          STATE.pollTimer = setTimeout(() => pollJob(r.job.id), 300);
        }
      }

      if (r.ok) {
        toast(`✅ ${r.action} ${r.package} 完成`);
        await loadPlugins(STATE.currentProfile);
        await loadLogs();
      } else {
        toast('执行失败：' + r.error, 'error');
      }
    } catch (e) {
      toast('请求失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '▶ 执行';
    }
  }

  // ── 状态/Profile/插件 ────────────────────────────
  async function loadAll() {
    try {
      // 先 render（DOM 就绪），再调 loadStatus / loadProfiles。
      // 之前 Promise.all([loadStatus, loadProfiles]) 在 render() 之前，
      // loadStatus 里 $('dsh-home').textContent = ... 会拿到 null 静默抛错。
      render();
      // 先读候选 home（决定 status / profiles 的查询目标），再并行加载 status / profiles
      await loadHomes();
      // 并行加载 status / profiles（status 被设了 60s 后端缓存）
      await Promise.all([loadStatus(), loadProfiles()]);
      // profile 可能刚被选中、install panel 还显示“未选”——需要重渲染
      render();
      if (STATE.currentProfile) {
        await loadPlugins(STATE.currentProfile);
      } else {
        $('plugins-content').innerHTML = '<div class="empty">选择左侧 profile 查看已装插件</div>';
      }
      await loadLogs();
    } catch (e) {
      console.error('loadAll failed:', e);
      toast('加载失败: ' + e.message, 'error');
    }
  }

  // 探测候选 DSH home + 当前选择
  async function loadHomes() {
    try {
      const r = await api('GET', '/api/homes');
      if (r.ok) {
        STATE.homes = { current: r.current, candidates: r.candidates || [] };
      }
    } catch (e) {
      console.warn('loadHomes failed:', e);
    }
  }

  // 切换 home：请求后端 → 重读候选 → 重载所有数据 → 重渲染
  async function switchHome(newPath) {
    const r = await api('POST', '/api/current-home', { dshHome: newPath });
    if (!r.ok) return toast('切换失败：' + r.error, 'error');
    toast('已切换 home：' + newPath);
    // 重读候选（current 变了），重载状态 / profile / 插件
    await loadHomes();
    STATE.currentProfile = null;  // 清空当前 profile 选择（home 换了，profile 不一定存在）
    STATE.profiles = [];
    STATE.plugins = [];
    STATE.status = null;
    await loadAll();
  }

  // 顶栏 home 切换器：下拉选择 / 添加自定义
  async function openHomeSwitcher() {
    const homes = STATE.homes;
    const candidates = homes.candidates || [];
    const cur = homes.current;
    const m = $('modal');
    m.innerHTML = `
      <div class="modal" onclick="event.stopPropagation()">
        <h3>🏠 切换 DSH_HOME</h3>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:12px">
          DSH 在不同位置可能有多个独立 home（默认 ~/.dsh、dsh-hanako 插件隔离 home 等）。
          在此选择本次管理的 home，切换后插件列表会重新加载。
        </div>
        <div id="home-list">
          ${candidates.map(c => `
            <label class="home-item" style="display:flex;align-items:flex-start;gap:10px;padding:8px;border-radius:6px;cursor:pointer;${c.path === cur ? 'background:var(--bg-info, rgba(0,0,0,.06));' : ''}">
              <input type="radio" name="home" value="${esc(c.path)}" ${c.path === cur ? 'checked' : ''} ${c.exists ? '' : 'disabled'} />
              <div style="flex:1;min-width:0">
                <div style="font-weight:500">${esc(c.label)}${c.exists ? '' : ' <span style="color:var(--text-faint);font-size:11px">(无效/不存在)</span>'}</div>
                <div style="font-size:11px;color:var(--text-dim);word-break:break-all">${esc(c.path)}</div>
                <div style="font-size:10px;color:var(--text-faint)">来源: ${esc(c.source)}</div>
              </div>
            </label>
          `).join('')}
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">添加自定义 home 路径</div>
          <div style="display:flex;gap:6px">
            <input type="text" id="custom-home-path" placeholder="C:\\path\\to\\dsh-home" style="flex:1;padding:5px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input, transparent);color:var(--text)" />
            <button class="btn sm" id="btn-add-custom-home">添加</button>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" onclick="document.getElementById('modal').classList.remove('show')">取消</button>
          <button class="btn primary" id="btn-apply-home">应用所选</button>
        </div>
      </div>
    `;
    m.classList.add('show');
    m.addEventListener('click', closeModal);

    $('btn-add-custom-home').addEventListener('click', async () => {
      const p = $('custom-home-path').value.trim();
      if (!p) return toast('路径不能为空', 'error');
      const r = await api('POST', '/api/custom-home', { dshHome: p });
      if (!r.ok) return toast('添加失败：' + r.error, 'error');
      toast('已添加：' + r.dshHome);
      await loadHomes();
      closeModal();
      openHomeSwitcher();
    });

    $('btn-apply-home').addEventListener('click', async () => {
      const sel = m.querySelector('input[name=home]:checked');
      if (!sel) return toast('请选择一个 home', 'error');
      const newPath = sel.value;
      if (newPath === cur) {
        closeModal();
        return;
      }
      closeModal();
      await switchHome(newPath);
    });
  }

  async function loadStatus() {
    try {
      console.log('[dsh-plugin-manager] loadStatus START');
      const r = await api('GET', '/api/status?_t=' + Date.now());
      console.log('[dsh-plugin-manager] /api/status response:', r);
      STATE.status = r;
      STATE.dshHome = r.dshHome || null;
      // 不直接设 DOM（render() 重建会覆盖）。只更新 STATE。render() 会从 STATE 读。
      // 主动 render 一次以保证状态条立刻反映新状态。
      render();
    } catch (e) {
      console.error('[dsh-plugin-manager] loadStatus failed:', e);
    }
  }

  async function loadProfiles() {
    const r = await api('GET', '/api/profiles');
    if (!r.ok) {
      STATE.profiles = [];
      return;
    }
    STATE.profiles = r.profiles;
    if (!STATE.currentProfile || !STATE.profiles.includes(STATE.currentProfile)) {
      STATE.currentProfile = STATE.profiles[0] || null;
    }
  }

  async function loadPlugins(profileName) {
    const r = await api('GET', '/api/plugins/' + encodeURIComponent(profileName));
    $('plugins-title').textContent = `Profile: ${profileName}`;
    if (!r.ok) {
      $('plugins-content').innerHTML = `<div class="empty" style="color:var(--red)">${esc(r.error)}</div>`;
      return;
    }
    STATE.plugins = r.bundles || [];
    STATE.extras = r.extras || [];

    const enabledCount = STATE.plugins.filter((p) => p.enabled).length;
    $('plugins-stats').innerHTML = `
      <span class="tag bundle">${STATE.plugins.length}</span>
      <span class="tag enabled">${enabledCount} ✓</span>
      <span class="tag disabled">${STATE.plugins.length - enabledCount} ⊘</span>
    `;

    if (STATE.plugins.length === 0) {
      $('plugins-content').innerHTML = '<div class="empty">该 profile 还没有 bundle 插件</div>';
      return;
    }

    $('plugins-content').innerHTML = `
      <div class="plugin-grid">
        ${STATE.plugins.map(renderPluginCard).join('')}
      </div>
      ${STATE.extras.length ? `
        <details style="margin-top:14px">
          <summary style="cursor:pointer;font-size:12px;color:var(--text-dim)">
            其他依赖 (${STATE.extras.length}，非 bundle)
          </summary>
          <div class="plugin-grid" style="margin-top:8px">
            ${STATE.extras.map(renderExtraCard).join('')}
          </div>
        </details>
      ` : ''}
    `;

    $('plugins-content').querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => handleAction(btn.dataset.action, btn.dataset.id));
    });
  }

  // 来源标签映射：不同 installKind 显示不同 emoji + 中文
  // 保持与 backup 策略分类一致（pointer 优先于 file/git/tarball 的语义）
  function sourceTag(p) {
    const map = {
      'link':    { icon: '🔗', label: 'link',    cls: 'link',    title: '本地目录链接（你改这里会影响原目录）' },
      'github':  { icon: '🟦', label: 'github',  cls: 'github',  title: 'GitHub 源' },
      'git':     { icon: '🟦', label: 'github',  cls: 'github',  title: 'Git 源' },
      'url':     { icon: '🔗', label: 'url',     cls: 'github',  title: 'URL 源' },
      'npm':     { icon: '📦', label: 'npm',     cls: 'npm',     title: 'npm registry 源' },
      'file':    { icon: '📁', label: 'file',    cls: 'local',   title: '本地文件' },
      'folder':  { icon: '📂', label: 'folder',  cls: 'local',   title: '本地目录' },
      'unknown': { icon: '❓', label: 'unknown', cls: 'unknown', title: '未知来源' },
      'core':    { icon: '📦', label: 'core',    cls: 'core',    title: 'DSH 内置 bundle（跟随 dsh-hanako 主包版本，不需独立管理）' },
    };
    const m = map[p.source] || map['unknown'];
    return `<span class="tag ${m.cls}" title="${esc(m.title)}">${m.icon} ${m.label}</span>`;
  }

  // 根据 GitHub 上游检查结果给插件加可识别的魔改/落后提示标签
  // 检查缓存来自 checkUpdatesUI() 自动填入的 STATE.updateCache
  // 优先级：forked（本地不在上游 history，几乎肯定魔改） > 落后 N 个 commit（可能是魔改也可能是你 fork 后未拉 upstream）
  function modifiedHint(p) {
    // 手动标了 FORK（p.isModified）→ 只显示 🏷 FORK，不再叠加自动检测的 魔改/落后 提示（FORK 是更明确的语义，避免冲突）
    if (p.isModified) return null;
    const cached = STATE.updateCache && STATE.updateCache[p.id];
    if (!cached) return null;
    if (cached.status === 'forked') {
      return { cls: 'modified', tag: '🛠️ 魔改', tooltip: `本地 commit 不在上游 history 中（可能是 fork 或魔改）\n本地: ${cached.localCommitShort}\n上游: ${(cached.upstream && cached.upstream.commitShort) || '?'}` };
    }
    if (cached.status === 'has-update' && typeof cached.commitsBehind === 'number') {
      if (cached.commitsBehind >= 10) {
        return { cls: 'modified', tag: '🛠️ 魔改？', tooltip: `本地落后上游 ${cached.commitsBehind} 个 commit。可能是 fork 后未拉 upstream，也可能是魔改了源码。` };
      }
      if (cached.commitsBehind >= 1) {
        return { cls: 'behind', tag: `落后 ${cached.commitsBehind}`, tooltip: `上游有 ${cached.commitsBehind} 个新 commit。可能需要更新，或你魔改了源码未提交到 upstream。` };
      }
    }
    return null;
  }

  function renderPluginCard(p) {
    const tags = [];
    // 来源标签
    tags.push(sourceTag(p));
    // 版本号
    if (p.version) tags.push(`<span class="tag">${esc(p.version)}</span>`);
    // bundle 类型
    tags.push(`<span class="tag bundle">bundle</span>`);
    // 自动魔改/落后提示（不靠手动标记——靠 check 更新结果推断）
    const hint = modifiedHint(p);
    if (hint) tags.push(`<span class="tag ${hint.cls}" title="${esc(hint.tooltip)}">${esc(hint.tag)}</span>`);
    // 手动标记的 FORK（稳定，跨重启/跨检查：来自 plugin-marks.json）
    if (p.isModified) tags.push(`<span class="tag fork" title="你手动标记的 fork——后续上游更新会被拦截，且备份按 blob-modified 保存">🏷 FORK</span>`);
    // 启用/禁用
    tags.push(p.enabled
      ? '<span class="tag enabled">✓ enabled</span>'
      : '<span class="tag disabled">⊘ disabled</span>');

    const cardCls = [p.enabled ? '' : 'disabled', hint && hint.cls === 'modified' ? 'modified' : '', p.isModified ? 'fork' : ''].filter(Boolean).join(' ');

    return `
      <div class="plugin-card ${cardCls}">
        <div class="plugin-name">${esc(p.id)}</div>
        <div class="plugin-meta">${tags.join('')}</div>
        ${p.detail ? `<div class="plugin-detail"><code>${esc(p.detail)}</code></div>` : ''}
        ${p.isCore ? '<div class="plugin-note" style="font-size:10px;color:var(--text-dim);margin:4px 0">⚙ 跟随 dsh-hanako 主包，不可独立管理</div>' : ''}
        <div class="plugin-actions">
          ${p.isCore ? '<span style="font-size:11px;color:var(--text-dim)">DSH 内置</span>' : `
          <button class="btn sm" data-action="toggle" data-id="${esc(p.id)}">
            ${p.enabled ? '⏸ 禁用' : '▶ 启用'}
          </button>
          <button class="btn sm danger" data-action="uninstall" data-id="${esc(p.id)}">
            🗑 卸载
          </button>
          `}
        </div>
      </div>
    `;
  }

  function renderExtraCard(p) {
    return `
      <div class="plugin-card">
        <div class="plugin-name" style="font-weight:500">${esc(p.id)}</div>
        <div class="plugin-meta">
          <span class="tag ${esc(p.source)}">${esc(p.source)}</span>
          ${p.version ? `<span class="tag">${esc(p.version)}</span>` : ''}
        </div>
        ${p.detail ? `<div class="plugin-detail"><code>${esc(p.detail)}</code></div>` : ''}
      </div>
    `;
  }

  async function handleAction(action, id) {
    if (action === 'toggle') {
      const cur = STATE.plugins.find((p) => p.id === id);
      if (!cur) return;
      // 注意：iframe sandbox 禁用 window.confirm（返回 undefined），必须用自绘 uiConfirm
      if (!(await uiConfirm(`${cur.enabled ? '禁用' : '启用'} 插件 ${id}？`))) return;
      const r = await api('POST', '/api/toggle', { profile: STATE.currentProfile, id, enabled: !cur.enabled });
      if (r.ok) {
        toast(`${cur.enabled ? '已禁用' : '已启用'} ${id}`);
        await loadPlugins(STATE.currentProfile);
        await loadLogs();
      } else toast('操作失败：' + r.error, 'error');
    } else if (action === 'uninstall') {
      if (!(await uiConfirm(`卸载插件 ${id}？\n会自动备份，可在「备份」里恢复。`))) return;
      const removeFiles = await uiConfirm('同时删除本地 link 文件吗？');
      showOutput({
        id: 'pending', status: 'running',
        stdout: `⏳ 卸载 ${id}\n   profile: ${STATE.currentProfile}\n\n`, stderr: '',
      });
      const r = await api('POST', '/api/uninstall', {
        profile: STATE.currentProfile, id, removeFiles,
      });
      if (r.job) {
        showOutput(r.job);
        if (r.job.status === 'running') {
          STATE.pollTimer = setTimeout(() => pollJob(r.job.id), 300);
        }
      }
      if (r.ok) {
        toast(`已卸载 ${id}`);
        await loadPlugins(STATE.currentProfile);
        await loadLogs();
      } else toast('卸载失败：' + r.error, 'error');
    }
  }

  // ── 操作日志 ──────────────────────────────────────
  async function loadLogs() {
    const r = await api('GET', '/api/logs?limit=50');
    if (!r.ok || !r.logs?.length) {
      $('log-list').innerHTML = '<div class="empty" style="padding:20px">暂无日志</div>';
      return;
    }
    $('log-list').innerHTML = r.logs.map((row) => {
      const detail = [
        row.profile && `[${row.profile}]`,
        row.plugin || row.spec || row.zipPath || row.sourceDir || row.command || '',
        row.durationMs ? `(${fmtDuration(row.durationMs)})` : '',
        row.error ? `❌ ${row.error}` : '',
      ].filter(Boolean).join(' ');
      return `
        <div class="log-row">
          <span class="ts">${esc(ts(row.ts))}</span>
          <span class="action ${esc(row.action)}">${esc(row.action)}</span>
          <span class="detail">${esc(detail)}</span>
        </div>
      `;
    }).join('');
  }

  // ── 自制确认框 ────────────────────────────────────
  // iframe 沙箱里 window.confirm 被禁用（返回 undefined），必须用自绘确认层。
  function uiConfirm(msg) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;' +
        'display:flex;align-items:center;justify-content:center';
      overlay.innerHTML = `
        <div style="background:var(--bg-card,#fff);border:1px solid var(--border,#ddd);border-radius:12px;
          padding:20px 24px;max-width:360px;box-shadow:0 8px 30px rgba(0,0,0,.25)">
          <div style="font-size:14px;line-height:1.6;color:var(--text,#222);margin-bottom:16px">${esc(msg)}</div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button class="btn ghost" data-c="cancel">取消</button>
            <button class="btn danger" data-c="ok">确认</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const done = (v) => { overlay.remove(); resolve(v); };
      overlay.querySelector('[data-c="cancel"]').addEventListener('click', () => done(false));
      overlay.querySelector('[data-c="ok"]').addEventListener('click', () => done(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    });
  }

  // ── 自制输入框（代替 window.prompt）────────────────
  // iframe 沙箱里 window.prompt 也被禁用。opts: { placeholder, defaultValue, multiline=false, confirmText='确认' }
  // 返回 string（输入内容）或 null（取消）
  function uiPrompt(msg, opts = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      const multiline = opts.multiline === true;
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;' +
        'display:flex;align-items:center;justify-content:center';
      const inputStyle = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border,#ccc);' +
        'border-radius:6px;font-family:monospace;font-size:13px;background:var(--bg,#fafafa);color:var(--text,#222)';
      overlay.innerHTML = `
        <div style="background:var(--bg-card,#fff);border:1px solid var(--border,#ddd);border-radius:12px;
          padding:20px 24px;max-width:560px;min-width:340px;box-shadow:0 8px 30px rgba(0,0,0,.25)">
          <div style="font-size:13px;line-height:1.65;color:var(--text,#222);margin-bottom:12px;white-space:pre-wrap">${esc(msg)}</div>
          ${multiline
            ? `<textarea data-i rows="6" style="${inputStyle};resize:vertical">${esc(opts.defaultValue || '')}</textarea>`
            : `<input data-i type="text" placeholder="${esc(opts.placeholder || '')}" value="${esc(opts.defaultValue || '')}" style="${inputStyle}">`}
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
            <button class="btn ghost" data-c="cancel">取消</button>
            <button class="btn primary" data-c="ok">${esc(opts.confirmText || '确认')}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('[data-i]');
      setTimeout(() => { input.focus(); if (!multiline && input.select) input.select(); }, 50);
      const done = (v) => { overlay.remove(); resolve(v); };
      overlay.querySelector('[data-c="cancel"]').addEventListener('click', () => done(null));
      overlay.querySelector('[data-c="ok"]').addEventListener('click', () => done(input.value));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !multiline) { e.preventDefault(); done(input.value); }
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
      });
    });
  }

  // ── 备份 modal ────────────────────────────────────
  async function openBackupsModal() {
    const r = await api('GET', '/api/backups');
    const m = $('modal');
    m.innerHTML = `
      <div class="modal" onclick="event.stopPropagation()">
        <h3 style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span>🗄️ 备份列表</span>
          <button class="btn sm" id="btn-manual-backup">＋ 手动备份</button>
        </h3>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;line-height:1.6">
          每次 install/uninstall/toggle 前自动备份。最多保留 10 条，超出的最早备份自动删除。
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:12px;padding:8px 10px;border-radius:6px;background:var(--bg-info, rgba(0,0,0,.04));line-height:1.55">
          📦 <b>备份范围：仅 profile 配置文件</b>（package.json / cordis.yml / cordis.patch.yml / pnpm-workspace.yaml / pnpm-lock.yaml）。<br>
          <span style="color:var(--text-faint,#888)">插件本体代码不备份——恢复后由 pnpm 按 package.json 重新拉取。</span>
        </div>
        <div id="backups-list" style="max-height:400px;overflow-y:auto">
          ${r.backups.length === 0 ? '<div class="empty">暂无备份</div>' : r.backups.map(b => `
            <div class="glass" style="margin-bottom:8px;padding:10px 14px">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
                <div style="flex:1;min-width:0">
                  <div style="font-weight:500;font-size:13px">${esc(b.name)}</div>
                  ${b.meta ? `<div style="font-size:11px;color:var(--text-dim);margin-top:2px">
                    ${esc(b.meta.profile || '')} · ${esc(ts(b.meta.timestamp))}${b.meta.manual ? ' · 手动' : ' · 自动'}
                  </div>` : ''}
                  <input type="text" class="backup-note" data-note-input="${esc(b.dir)}" placeholder="点击填写备注…"
                    value="${esc((b.meta && b.meta.note) || '')}"
                    style="width:100%;box-sizing:border-box;margin-top:6px;padding:5px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input, transparent);color:var(--text)" />
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
                  <button class="btn sm" data-backup-action="restore" data-backup="${esc(b.dir)}" data-backup-meta='${esc(JSON.stringify(b.meta || {}))}'>
                    恢复
                  </button>
                  <button class="btn sm danger" data-backup-action="delete" data-backup="${esc(b.dir)}">删除</button>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="modal-actions">
          <button class="btn ghost" onclick="document.getElementById('modal').classList.remove('show')">关闭</button>
        </div>
      </div>
    `;
    m.classList.add('show');
    // 用命名函数 + removeEventListener 避免多次打开时监听器累积
    m.removeEventListener('click', closeModal);
    m.addEventListener('click', closeModal);

    // 手动备份当前 profile
    $('btn-manual-backup').addEventListener('click', async () => {
      const profName = STATE.currentProfile;
      if (!profName) return toast('请先选择 profile', 'error');
      const r = await api('POST', '/api/backup', { profile: profName });
      if (r.ok) {
        toast(r.removed > 0 ? `已备份，并自动清理了 ${r.removed} 条旧备份` : '已备份');
        await openBackupsModal();
        await loadLogs();
      } else toast('备份失败：' + r.error, 'error');
    });

    // 备注输入：防抖保存（停止输入 600ms 后写）
    m.querySelectorAll('[data-note-input]').forEach((input) => {
      let t = null;
      input.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const r = await api('POST', '/api/backup/note', { backupDir: input.dataset.noteInput, note: input.value });
          if (!r.ok) toast('备注保存失败：' + r.error, 'error');
        }, 600);
      });
    });

    // 恢复 / 删除
    m.querySelectorAll('[data-backup-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.backupAction;
        const backupDir = btn.dataset.backup;
        if (action === 'delete') {
          if (!(await uiConfirm('删除该备份（含磁盘文件）？此操作不可恢复。'))) return;
          const r = await api('POST', '/api/backup/delete', { backupDir });
          if (r.ok) {
            toast('已删除备份');
            await openBackupsModal();
            await loadLogs();
          } else toast('删除失败：' + r.error, 'error');
          return;
        }
        // restore
        const meta = JSON.parse(btn.dataset.backupMeta || '{}');
        const profName = meta.profile || STATE.currentProfile;
        if (!(await uiConfirm(`从备份恢复到 profile「${profName}」？`))) return;
        const r = await api('POST', '/api/restore', { backupDir, profile: profName });
        if (r.ok) {
          toast('已恢复：' + r.restored.join(', '));
          closeModal();
          await loadPlugins(STATE.currentProfile);
          await loadLogs();
        } else toast('恢复失败：' + r.error, 'error');
      });
    });
  }

  function closeModal() { $('modal').classList.remove('show'); $('modal').innerHTML = ''; }

  // ── 插件源备份 modal ─────────────────────
  // 三策略：pointer（只存指针）/ blob-raw（原物）/ blob-modified（魔改源码）
  // 流程：扫描预览 → 确认备份 → 列历史 → dry-run 恢复预览 → apply
  async function openV2Modal() {
    const m = $('modal');
    const profName = STATE.currentProfile;
    m.innerHTML = `
      <div class="modal" onclick="event.stopPropagation()">
        <h3 style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span>📦 插件源备份</span>
          <button class="btn sm ghost" onclick="document.getElementById('modal').classList.remove('show')">✕</button>
        </h3>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;line-height:1.6">
          插件本体代码备份：能重拉的（npm / GitHub 源）只存指针；本地 zip / link 目录 / 魔改源码存完整内容。<br>
          <span style="color:var(--text-faint,#888)">${profName ? '当前 profile：' + esc(profName) : '未选择 profile——先选一个再备份'}</span>
        </div>
        ${profName ? `
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <button class="btn sm" id="btn-v2-scan">🔍 扫描预览</button>
          <button class="btn sm primary" id="btn-v2-backup">💾 立即备份</button>
        </div>
        <div id="v2-scan-result" style="font-size:12px;max-height:220px;overflow-y:auto;margin-bottom:10px"></div>
        <div style="border-top:1px solid var(--border);padding-top:10px">
          <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">历史备份：</div>
          <div id="v2-history" style="font-size:12px;max-height:180px;overflow-y:auto">加载中…</div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
            <div style="font-size:11px;color:var(--text-dim)">🛠️ 工作区快照（Desktop/dsh-workspace/）</div>
            <button class="btn sm" id="btn-v2-ws-backup">💾 备份工作区</button>
          </div>
          <div id="v2-ws-result" style="font-size:12px;max-height:180px;overflow-y:auto"></div>
        </div>` : '<div class="empty">请先在左侧选择 profile</div>'}
      </div>
    `;
    m.classList.add('show');
    m.addEventListener('click', closeModal);

    if (profName) {
      $('btn-v2-scan').addEventListener('click', () => v2Scan());
      $('btn-v2-backup').addEventListener('click', () => v2Backup());
      const wsBtn = $('btn-v2-ws-backup');
      if (wsBtn) wsBtn.addEventListener('click', () => v2WorkspaceBackup());
      loadV2History();
    }
  }

  // 扫描预览：列出每个插件的策略 + 指纹 + 大小
  async function v2Scan() {
    const el = $('v2-scan-result');
    el.innerHTML = '<div class="empty">扫描中…</div>';
    const r = await api('GET', '/api/v2/scan?profile=' + encodeURIComponent(STATE.currentProfile));
    if (!r.ok) { el.innerHTML = '<div class="empty" style="color:var(--danger,#c0392b)">' + esc(r.error) + '</div>'; return; }
    el.innerHTML = `
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">共 ${r.plugins.length} 个插件（lock 直接依赖）</div>
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <tr style="color:var(--text-faint,#888)">
          <td style="padding:3px 6px">插件</td><td>策略</td><td>来源</td><td>版本</td><td>文件</td><td>指纹</td>
        </tr>
        ${r.plugins.map(p => `
          <tr style="border-top:1px solid var(--border,#ddd)">
            <td style="padding:4px 6px">${esc(p.pkg)}${p.isSymlink ? ' 🔗' : ''}</td>
            <td><span style="padding:1px 6px;border-radius:4px;font-size:10px;background:${p.strategy === 'pointer' ? 'rgba(46,204,113,.15)' : 'rgba(241,196,15,.2)'};color:${p.strategy === 'pointer' ? '#27ae60' : '#b9770e'}">${p.strategy}</span></td>
            <td style="color:var(--text-dim)">${p.installKind}</td>
            <td>${esc(p.localVersion || '?')}</td>
            <td>${p.fileCount}</td>
            <td style="font-family:monospace;font-size:10px;color:var(--text-faint)">${p.fingerprintShort}</td>
          </tr>
        `).join('')}
      </table>
    `;
  }

  // 执行备份
  async function v2Backup() {
    const el = $('v2-scan-result');
    el.innerHTML = '<div class="empty">备份中…（大目录可能需要一点时间）</div>';
    // backup 可能拷贝几十 MB 魔改源码，给 10min 超时
    const r = await api('POST', '/api/v2/backup', { profile: STATE.currentProfile }, { timeoutMs: 10 * 60 * 1000 });
    if (!r.ok) { el.innerHTML = '<div class="empty" style="color:var(--danger,#c0392b)">备份失败：' + esc(r.error) + '</div>'; return; }
    const okCount = r.results.filter(x => x.ok).length;
    const failCount = r.results.filter(x => !x.ok).length;
    el.innerHTML = `
      <div style="font-size:12px;margin-bottom:6px">✅ 备份完成：${okCount} 成功${failCount ? '，' + failCount + ' 失败' : ''}</div>
      <div style="font-size:11px;color:var(--text-dim);word-break:break-all">${esc(r.backupRoot)}</div>
      <div style="font-size:11px;margin-top:6px">
        ${r.results.map(x => `<div>${x.ok ? '✓' : '✗'} ${esc(x.pkg)}：${x.mode === 'pointer' ? '只存指针' : (x.bytes / 1024 / 1024).toFixed(2) + 'MB / ' + x.files + ' 文件'}</div>`).join('')}
      </div>
    `;
    loadV2History();
  }

  // 历史备份 + 恢复入口
  async function loadV2History() {
    const el = $('v2-history');
    if (!el) return;
    const r = await api('GET', '/api/v2/backups');
    if (!r.ok) { el.innerHTML = '<div class="empty">' + esc(r.error) + '</div>'; return; }
    const list = (r.backups && r.backups[STATE.currentProfile]) || [];
    if (list.length === 0) { el.innerHTML = '<div class="empty">暂无备份</div>'; return; }
    el.innerHTML = list.map(ts => `
      <div class="glass" style="padding:8px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span style="font-family:monospace;font-size:11px">${esc(ts)}</span>
        <span>
          <button class="btn sm ghost" data-v2-preview="${esc(ts)}">预览恢复</button>
          <button class="btn sm" data-v2-apply="${esc(ts)}">应用恢复</button>
        </span>
      </div>
    `).join('');
    el.querySelectorAll('[data-v2-preview]').forEach(b => b.addEventListener('click', () => v2Restore(b.dataset.v2Preview, false)));
    el.querySelectorAll('[data-v2-apply]').forEach(b => b.addEventListener('click', () => v2Restore(b.dataset.v2Apply, true)));
  }

  // 恢复：dryRun=true 预览命令；dryRun=false 实际恢复
  async function v2Restore(timestamp, apply) {
    const el = $('v2-scan-result');
    const r = await api('POST', '/api/v2/restore', { profile: STATE.currentProfile, timestamp, apply });
    if (!r.ok) { el.innerHTML = '<div class="empty" style="color:var(--danger,#c0392b)">' + esc(r.error) + '</div>'; return; }
    if (r.dryRun) {
      el.innerHTML = `
        <div style="font-size:12px;font-weight:500;margin-bottom:6px">🔍 恢复预览（dry-run，未写入）</div>
        <div style="font-size:11px;font-family:monospace;line-height:1.7">${r.results.map(x =>
          `${x.pkg}：${x.commands.map(c => esc(c)).join('；')}`).join('<br>')}</div>
        <div style="font-size:11px;color:var(--text-faint,#888);margin-top:6px">blob 插件会覆盖目标目录；pointer 插件需在 profile 里跑 pnpm add。</div>
      `;
    } else {
      const ok = r.results.filter(x => x.ok !== false).length;
      el.innerHTML = `<div style="font-size:12px">✅ 已恢复 ${ok}/${r.results.length} 个插件。pointer 插件的 pnpm 命令仍需手动执行或后续安装。</div>`;
      loadV2History();
      if (STATE.currentProfile) loadPlugins(STATE.currentProfile);
    }
  }

  // 工作区快照：备份 dsh-workspace/（魔改/自研/zip 资产库）
  async function v2WorkspaceBackup() {
    const el = $('v2-ws-result');
    if (!el) return;
    el.innerHTML = '<div class="empty">扫描中…</div>';
    // 先扫描预览
    const scan = await api('GET', '/api/v2/workspace/scan');
    if (!scan.ok) { el.innerHTML = '<div class="empty" style="color:var(--danger,#c0392b)">' + esc(scan.error) + '</div>'; return; }
    const totalMB = (scan.entries.reduce((a, e) => a + (e.fileCount || 0), 0));
    el.innerHTML = `
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">
        📁 ${esc(scan.workspaceDir)} · ${scan.entries.length} 个条目
      </div>
      <div style="font-size:11px;line-height:1.8">${scan.entries.map(e =>
        `· ${esc(e.pkg)} <span style="color:var(--text-faint)">(${e.kind})</span>`).join('<br>')}</div>
      <button class="btn sm primary" id="btn-v2-ws-confirm" style="margin-top:8px">💾 确认备份整个工作区</button>
    `;
    $('btn-v2-ws-confirm').addEventListener('click', async () => {
      el.innerHTML = '<div class="empty">备份中…（约 30MB，需几秒）</div>';
      // workspace 备份几十 MB，给 10min 超时
      const r = await api('POST', '/api/v2/workspace/backup', {}, { timeoutMs: 10 * 60 * 1000 });
      if (!r.ok) { el.innerHTML = '<div class="empty" style="color:var(--danger,#c0392b)">备份失败：' + esc(r.error) + '</div>'; return; }
      const ok = r.results.filter(x => x.ok).length;
      const total = (r.results.reduce((a, x) => a + (x.bytes || 0), 0) / 1024 / 1024).toFixed(1);
      el.innerHTML = `
        <div style="font-size:12px">✅ 工作区已备份：${ok}/${r.results.length} 条目，共 ${total}MB</div>
        <div style="font-size:11px;color:var(--text-dim);word-break:break-all;margin-top:4px">${esc(r.backupRoot)}</div>
      `;
      loadV2History();
    });
  }

  // ── GitHub 源插件更新检查 / 执行 ──────────────
  // 扫描 profile 的 github 插件 → 查上游最新 commit → 展示：有更新（可更新/魔改提醒）/ 已最新 / 失败
  async function checkUpdatesUI() {
    const profName = STATE.currentProfile;
    if (!profName) { toast('先选择 profile', 'error'); return; }
    const panel = $('update-panel');
    panel.style.display = 'block';
    panel.innerHTML = '<div class="empty">🔍 检查中…（访问 GitHub API，稍候）</div>';
    const r = await api('GET', '/api/updates/check?profile=' + encodeURIComponent(profName));
    if (!r.ok) { panel.innerHTML = '<div class="empty" style="color:var(--danger,#c0392b)">检查失败：' + esc(r.error) + '</div>'; return; }

    // 填充 updateCache，让插件卡片显示魔改/落后标签（不需要手动标记）
    STATE.updateCache = {};
    for (const p of r.plugins) {
      STATE.updateCache[p.pkg] = {
        status: p.status,
        commitsBehind: p.commitsBehind,
        likelyModified: p.likelyModified,
        localCommitShort: p.localCommitShort,
        upstream: p.upstream,
      };
    }

    // 后端查完后，如果用户设了 GitHub Token 且有些插件 check-failed（限流），前端补查一次。
    // 补查不依赖后端转发——前端 fetch 直连 GitHub（GitHub API 默认允许 * CORS）。
    // 这样就算后端不重启、前端热更新也能解限流问题。
    const localToken = (typeof localStorage !== 'undefined') ? localStorage.getItem('github_token') : null;
    if (localToken) {
      const needRefetch = r.plugins.filter(p => p.status === 'check-failed' && (p.upstreamError || '').includes('限流'));
      for (const p of needRefetch) {
        const repo = (p.pkg && p.specifier) ? (extractRepo(p.specifier) || p.repo) : p.repo;
        if (!repo) continue;
        const fixed = await fetchUpstreamFromFrontend(repo, localToken);
        if (fixed.ok) {
          // 重算 status / commitsBehind / likelyModified
          const upstream = fixed.latest;
          const history = fixed.history;
          const localInHist = history.findIndex(c => c.sha === p.localCommit);
          let status;
          if (upstream.commit === p.localCommit) status = 'up-to-date';
          else if (localInHist < 0) status = 'forked';
          else status = 'has-update';
          const commitsBehind = (status === 'has-update' && localInHist >= 0) ? localInHist : null;
          // 更新原 plugin 对象 + cache
          p.status = status;
          p.canUpdate = status === 'has-update' && !p.isModified;
          p.upstream = upstream;
          p.upstreamError = null;
          p.historyError = null;
          p.commitsBehind = commitsBehind;
          p.likelyModified = status === 'forked';
          p.localCommitInHistory = localInHist >= 0 ? { index: localInHist, historySize: history.length, date: history[localInHist].date, message: history[localInHist].message } : null;
          STATE.updateCache[p.pkg] = {
            status, commitsBehind, likelyModified: p.likelyModified,
            localCommitShort: p.localCommitShort, upstream: p.upstream,
          };
        }
      }
    }

    // 重渲染插件卡片，让魔改/落后标签生效
    if (STATE.currentProfile) await loadPlugins(STATE.currentProfile);

    const updatable = r.plugins.filter(p => p.canUpdate);
    const forked = r.plugins.filter(p => p.status === 'forked');
    const behind = r.plugins.filter(p => p.status === 'has-update' && typeof p.commitsBehind === 'number' && p.commitsBehind > 0 && !p.canUpdate);
    const upToDate = r.plugins.filter(p => p.status === 'up-to-date');
    const failed = r.plugins.filter(p => p.status === 'check-failed');

    // 给所有 github 插件都渲染一行，包含 FORK 切换按钮
    const renderRow = (p, opts = {}) => `
      <div class="upd-row" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--border,#ddd)">
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;font-size:12px">${esc(p.pkg)}
            ${opts.statusTag || ''}
            ${p.isModified ? '<span class="tag fork" style="font-size:10px">🏷 FORK</span>' : ''}
          </div>
          <div style="font-size:10px;color:var(--text-faint);font-family:monospace;margin-top:2px">${p.localCommitShort || '?'} → ${p.upstream?.commitShort || '?'}</div>
          ${opts.subline || ''}
        </div>
        <div style="display:flex;gap:4px;align-items:center">
          ${p.canUpdate ? `<button class="btn sm primary" data-update-pkg="${esc(p.pkg)}">⬆ 更新</button>` : ''}
          <button class="btn sm" data-mark-pkg="${esc(p.pkg)}" data-mark-current="${p.isModified ? '1' : '0'}">
            ${p.isModified ? '🏷 取消 FORK' : '🏷 标 FORK'}
          </button>
        </div>
      </div>
    `;

    // GitHub token 状态：直接读 localStorage（后端转发可能没生效）
    const hasLocalToken = (typeof localStorage !== 'undefined') && !!localStorage.getItem('github_token');
    const tokenHint = hasLocalToken
      ? `<span style="color:#27ae60">✓ 已设置（存在浏览器 localStorage）</span> · <a href="#" data-action="clear-token" style="color:#c0392b">清除</a>`
      : `<span style="color:#b8860b">⚠ 未设置（限流 60/h，加 token 后 5000/h）</span> · <a href="#" data-action="set-token" style="color:#2c3e50">设置</a>`;

    panel.innerHTML = `
      <div class="glass" style="padding:10px 14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:6px">
          <b style="font-size:13px">📡 GitHub 源更新检查</b>
          <span style="font-size:11px">🔑 Token: ${tokenHint}</span>
        </div>
        <div style="margin-bottom:8px">
          <span style="font-size:11px;color:var(--text-dim)">可更新 ${updatable.length}${forked.length ? ' · 本地不在 history ' + forked.length : ''}${behind.length ? ' · 落后 ' + behind.length : ''} · 已最新 ${upToDate.length}${failed.length ? ' · 失败 ' + failed.length : ''}</span>
        </div>
        ${updatable.length === 0 && forked.length === 0 && behind.length === 0 && failed.length === 0
          ? '<div class="empty" style="padding:8px">所有 GitHub 插件都已是最新 🎉</div>'
          : ''}
        ${updatable.map(p => renderRow(p, {
          statusTag: '<span class="tag" style="font-size:10px;background:rgba(46,204,113,.15);color:#27ae60">可更新</span>' + (typeof p.commitsBehind === 'number' ? `<span class="tag behind" style="font-size:10px">落后 ${p.commitsBehind}</span>` : ''),
          subline: `<div style="font-size:10px;color:var(--text-dim);margin-top:2px">${esc(p.upstream?.message || '')} <span style="color:var(--text-faint)">${esc(p.upstream?.date || '')}</span></div>`,
        })).join('')}
        ${forked.map(p => renderRow(p, {
          statusTag: '<span class="tag modified" style="font-size:10px">🛠️ 本地不在上游 history</span>',
          subline: '<div style="font-size:10px;color:var(--text-dim);margin-top:2px">⚠️ 本地 commit 在上游 history 中找不到。几乎肯定是 fork 或魔改了源码（更新会覆盖，请先备份）。</div>',
        })).join('')}
        ${behind.map(p => renderRow(p, {
          statusTag: `<span class="tag behind" style="font-size:10px">落后 ${p.commitsBehind}</span>`,
        })).join('')}
        ${upToDate.map(p => renderRow(p, {
          statusTag: '<span class="tag" style="font-size:10px;background:rgba(46,204,113,.1);color:#27ae60">✓ 已最新</span>',
        })).join('')}
        ${failed.map(p => `
          <div style="padding:6px 0;border-top:1px solid var(--border,#ddd);font-size:11px;color:var(--text-dim)">
            ⚠️ ${esc(p.pkg)}：${esc(p.upstreamError || '检查失败')}
          </div>
        `).join('')}
      </div>
    `;
    panel.querySelectorAll('[data-update-pkg]').forEach(btn => {
      btn.addEventListener('click', () => applyUpdate(btn.dataset.updatePkg, btn));
    });
    panel.querySelectorAll('[data-mark-pkg]').forEach(btn => {
      btn.addEventListener('click', () => toggleMarkFromPanel(btn));
    });
    panel.querySelectorAll('[data-action="set-token"]').forEach(a => {
      a.addEventListener('click', (e) => { e.preventDefault(); promptSetToken(); });
    });
    panel.querySelectorAll('[data-action="clear-token"]').forEach(a => {
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!await uiConfirm('清除 GitHub Token？\n清除后恢复未认证限流 60 req/hour。')) return;
        try {
          localStorage.removeItem('github_token');
          toast('✅ Token 已清除');
          checkUpdatesUI();
        } catch (err) { toast('清除失败：' + err.message, 'error'); }
      });
    });
  }

  // 在检查更新面板里输入 GitHub Token（设置后限流 5000/h）
  // 使用 prompt 让用户输入 token。token 存 localStorage（仅前端），不依赖后端转发。
  // 后端仅用于"是否已设"状态检查（可选）。点 “设置”后前端会拿 token 直连 GitHub API 重查。
  async function promptSetToken() {
    const cur = (typeof localStorage !== 'undefined') ? localStorage.getItem('github_token') : null;
    const curTip = cur ? '（当前已设置）\n\n' : '';
    // 用 uiPrompt 代替 window.prompt（iframe sandbox 里 prompt 被禁用）
    const token = await uiPrompt(
      `输入 GitHub Personal Access Token (PAT)\n\n${curTip}要求：\n· 公共仓库读取权限（public_repo 勾选）\n· 最低粒度：不需 repo/admin 任何权限\n\n获取：github.com → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → 只勾 public_repo`,
      { placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', confirmText: '保存' }
    );
    if (!token) return;
    try {
      localStorage.setItem('github_token', token.trim());
      toast('✅ Token 已存到浏览器 localStorage，下次检查更新生效');
      checkUpdatesUI();
    } catch (e) {
      toast('保存失败：' + e.message, 'error');
    }
  }

  // 提取 github:owner/repo 或 codeload URL 里的 owner/repo
  function extractRepo(specifier) {
    if (!specifier) return null;
    let m = specifier.match(/github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?(?:#|$)/);
    if (m) return m[1].replace(/\.git$/, '');
    m = specifier.match(/codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\//);
    if (m) return m[1];
    m = specifier.match(/^github:([^/]+\/[^/#]+)/);
    if (m) return m[1];
    return null;
  }

  // 前端直连 GitHub API（带 token）重查单个仓库。同时拉最新 commit + history。
  // 返回 { ok, latest:{commit,date,message}, history:[{sha,date,message}] } 或 { ok:false, error }
  async function fetchUpstreamFromFrontend(repo, token) {
    try {
      const h = { 'user-agent': 'dsh-plugin-manager', accept: 'application/vnd.github+json' };
      if (token) h.authorization = `Bearer ${token}`;
      // latest commit
      const r1 = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, { headers: h });
      if (!r1.ok) {
        const reset = parseInt(r1.headers.get('x-ratelimit-reset') || '0', 10);
        const waitMin = reset > 0 ? Math.ceil((reset * 1000 - Date.now()) / 60000) : '?';
        return { ok: false, error: r1.status === 403 ? `GitHub 限流 — ${waitMin} 分钟后恢复` : `HTTP ${r1.status}` };
      }
      const j1 = await r1.json();
      const latest = {
        commit: j1[0]?.sha,
        date: j1[0]?.commit?.committer?.date,
        message: j1[0]?.commit?.message?.split('\n')[0] || '',
      };
      // history
      const r2 = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=100`, { headers: h });
      const j2 = r2.ok ? await r2.json() : [];
      const history = Array.isArray(j2) ? j2.slice(0, 100).map(c => ({
        sha: c.sha,
        date: c.commit?.committer?.date,
        message: c.commit?.message?.split('\n')[0] || '',
      })) : [];
      if (!latest.commit) return { ok: false, error: '响应缺少 commit' };
      return { ok: true, latest, history };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 检查更新面板里的 FORK 标记切换（POST /api/plugin-marks + 重渲染）
  async function toggleMarkFromPanel(btn) {
    const pkg = btn.dataset.markPkg;
    const cur = btn.dataset.markCurrent === '1';
    const willMark = !cur;
    if (willMark) {
      const ok = await uiConfirm(`把 ${pkg} 标记为 🏷 FORK？\n\n后果：\n· 卡片永久显示 🏷 FORK 标签（紫色）\n· 上游 GitHub 更新被拦截（只显示不更新）\n· 备份按 blob-modified（魔改源码完整保存）`);
      if (!ok) return;
    }
    btn.disabled = true;
    const r = await api('POST', '/api/plugin-marks', { profile: STATE.currentProfile, pkg, modified: willMark });
    btn.disabled = false;
    if (r.ok) {
      toast(willMark ? `🏷 ${pkg} 已标记 FORK` : `✅ ${pkg} FORK 已取消`);
      await checkUpdatesUI();
    } else {
      toast('标记失败：' + (r.error || '未知错误'), 'error');
    }
  }

  // 执行单个插件更新（后台 job）
  async function applyUpdate(pkg, btn) {
    if (!(await uiConfirm(`更新 ${pkg}？\n\n会先自动备份当前 profile，然后执行 dsh plugin update ${pkg}。\n更新可能改变插件行为——建议先确认上游改动。`))) return;
    const profName = STATE.currentProfile;
    if (!profName) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '⏳ 更新中…';
    try {
      // update 是后台 job（pnpm install + pnpm reload），耗时长。用 30min 超时避免 10s 默认超时误报"更新异常"。
      const r = await api('POST', '/api/updates/apply', { profile: profName, pkg }, { timeoutMs: 30 * 60 * 1000 });
      if (!r.ok) { toast('更新失败：' + (r.error || '未知错误'), 'error'); showUpdateErrorDetail(pkg, r.error || '未知错误', null, null); return; }
      if (r.ok && r.job && r.job.exitCode === 0) {
        toast(`✅ ${pkg} 已更新`);
        await loadPlugins(profName);
        await loadLogs();
        checkUpdatesUI();
      } else {
        const errMsg = r.error || ('exit ' + (r.job && r.job.exitCode));
        toast(`更新失败：${errMsg}`, 'error');
        showUpdateErrorDetail(pkg, errMsg, r.stderrTail, r.stdoutTail);
        btn.innerHTML = original;
        btn.disabled = false;
      }
    } catch (e) {
      toast('更新异常：' + e.message, 'error');
      showUpdateErrorDetail(pkg, e.message, null, null);
      btn.innerHTML = original;
      btn.disabled = false;
    }
  }

  // 在检查更新面板里追加一个错误详情块（scrollable，可折叠，可复制）
  // stderr/stdout 来自 /api/updates/apply 返回的 stderrTail/stdoutTail
  function showUpdateErrorDetail(pkg, errMsg, stderrTail, stdoutTail) {
    const panel = $('update-panel');
    if (!panel) return;
    panel.style.display = 'block';
    // 移除该 pkg 之前的错误块（避免多次重复）
    panel.querySelectorAll(`[data-update-err-pkg="${cssEscape(pkg)}"]`).forEach(el => el.remove());
    const block = document.createElement('div');
    block.dataset.updateErrPkg = pkg;
    block.style.cssText = 'margin-top:10px;padding:10px 12px;background:rgba(231,76,60,.08);border:1px solid rgba(231,76,60,.4);border-radius:6px;font-size:11px';
    const preStyle = 'background:#1e1e1e;color:#d4d4d4;padding:8px 10px;border-radius:4px;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:Consolas,monospace;font-size:11px;margin:6px 0 0';
    block.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b style="color:#c0392b">❌ ${esc(pkg)} 更新失败</b>
        <button class="btn sm" data-close-err>✕ 关闭</button>
      </div>
      <div style="margin-top:4px;color:#7b241c"><b>摘要：</b>${esc(errMsg)}</div>
      ${stderrTail ? `<details open><summary style="cursor:pointer;color:#c0392b;margin-top:6px">📋 stderr（点我折叠）</summary><pre style="${preStyle}">${esc(stderrTail)}</pre></details>` : ''}
      ${stdoutTail ? `<details><summary style="cursor:pointer;color:#2c3e50;margin-top:6px">📤 stdout</summary><pre style="${preStyle}">${esc(stdoutTail)}</pre></details>` : ''}
    `;
    panel.appendChild(block);
    block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    block.querySelector('[data-close-err]').addEventListener('click', () => block.remove());
  }

  // CSS.escape 兼容（部分老浏览器没有 CSS.escape）
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // ── 启动 ──────────────────────────────────────────
  function ts(s) {
    if (!s) return '';
    try { return new Date(s).toLocaleString('zh-CN', { hour12: false }); } catch { return s; }
  }

  render();
  loadAll();
  setInterval(loadLogs, 5000);
})();