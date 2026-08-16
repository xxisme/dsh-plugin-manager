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
  async function api(method, path, body) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (TOKEN) opt.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body) opt.body = JSON.stringify(body);
    // 10s 默认超时：fetch 不加 timeout 会一直 hang，window DOM 也就永远不更新
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
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
          <button class="btn sm" id="btn-backups">🗄️ 备份</button>
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
            </div>
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
    if ($('btn-home-switch')) $('btn-home-switch').addEventListener('click', openHomeSwitcher);

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

  function renderPluginCard(p) {
    const tags = [];
    if (p.source && p.source !== 'unknown') tags.push(`<span class="tag ${esc(p.source)}">${esc(p.source)}</span>`);
    if (p.version) tags.push(`<span class="tag">${esc(p.version)}</span>`);
    tags.push(`<span class="tag bundle">bundle</span>`);
    tags.push(p.enabled
      ? '<span class="tag enabled">✓ enabled</span>'
      : '<span class="tag disabled">⊘ disabled</span>');

    return `
      <div class="plugin-card ${p.enabled ? '' : 'disabled'}">
        <div class="plugin-name">${esc(p.id)}</div>
        <div class="plugin-meta">${tags.join('')}</div>
        ${p.detail ? `<div class="plugin-detail"><code>${esc(p.detail)}</code></div>` : ''}
        <div class="plugin-actions">
          <button class="btn sm" data-action="toggle" data-id="${esc(p.id)}">
            ${p.enabled ? '⏸ 禁用' : '▶ 启用'}
          </button>
          <button class="btn sm danger" data-action="uninstall" data-id="${esc(p.id)}">
            🗑 卸载
          </button>
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
      if (!confirm(`${cur.enabled ? '禁用' : '启用'} 插件 ${id}？`)) return;
      const r = await api('POST', '/api/toggle', { profile: STATE.currentProfile, id, enabled: !cur.enabled });
      if (r.ok) {
        toast(`${cur.enabled ? '已禁用' : '已启用'} ${id}`);
        await loadPlugins(STATE.currentProfile);
        await loadLogs();
      } else toast('操作失败：' + r.error, 'error');
    } else if (action === 'uninstall') {
      if (!confirm(`卸载插件 ${id}？\n会自动备份，可在「备份」里恢复。`)) return;
      const removeFiles = confirm('同时删除本地 link 文件吗？');
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

  // ── 启动 ──────────────────────────────────────────
  function ts(s) {
    if (!s) return '';
    try { return new Date(s).toLocaleString('zh-CN', { hour12: false }); } catch { return s; }
  }

  render();
  loadAll();
  setInterval(loadLogs, 5000);
})();