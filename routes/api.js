/**
 * routes/api.js — DSH 插件管理 HTTP 路由
 *
 * 端点：
 *   GET  /manager                   iframe shell HTML（含 inline CSS + JS）
 *   GET  /api/status                 DSH_HOME / dsh / pnpm 状态
 *   GET  /api/profiles               列出所有 profile
 *   GET  /api/plugins/:profile       列出 profile 下所有 plugin
 *   GET  /api/backups                列出备份
 *   POST /api/install/zip            安装本地 zip（解压 + 调 dsh plugin add link:）
 *   POST /api/install/cmd            执行用户给的 dsh plugin 命令（白名单验证）
 *   GET  /api/job/:id                轮询 job 状态 + 实时输出
 *   POST /api/uninstall              卸载（调 dsh plugin remove）
 *   POST /api/toggle                 启用/禁用（直接改 cordis.patch.yml）
 *   POST /api/restore                从备份恢复
 *   GET  /api/logs                   操作日志
 *   GET  /api/browse                 文件浏览器
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  listProfiles,
  listPlugins,
  profileExists,
  setBundleEnabled,
} from '../lib/dsh-profile.js';
import {
  backupProfile,
  restoreProfile,
  listBackups,
  updateBackupNote,
  deleteBackup,
  cleanupOldBackups,
} from '../lib/backup.js';
import { detectHomes, getCurrentDshHome, setCurrentDshHome, addCustomDshHome } from '../lib/homes.js';
import { scanProfile } from '../lib/plugin-scanner.js';
import { backupPlugins } from '../lib/plugin-backup.js';
import { restorePlugins, restorePluginsExec, githubCommitOf } from '../lib/plugin-restore.js';
import { scanWorkspace, backupWorkspace } from '../lib/workspace.js';
import { checkUpdates } from '../lib/updater.js';
import { readMarks, isMarkedModified, setMark } from '../lib/plugin-marks.js';
import {
  pnpmAvailable,
  install,
  addPackage,
  removePackage,
} from '../lib/pnpm-runner.js';
import { extractAndInspect } from '../lib/zip-extractor.js';
import { appendLog, readRecentLogs } from '../lib/operation-log.js';
import { runDsh, getJob, parseDshCommand, resolveDshCmd } from '../lib/cmd-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(__dirname);
const APP_DIR = path.join(ROOT_DIR, 'app');

// ─── helpers ─────────────────────────────────────
function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (env && fs.existsSync(env)) return env;
  if (process.platform === 'win32') {
    const p = path.join(process.env.USERPROFILE || '', '.dsh');
    if (fs.existsSync(p)) return p;
  } else {
    const p = path.join(process.env.HOME || '', '.dsh');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function profileDirOf(dshHome, profileName) {
  return path.join(dshHome, 'profiles', profileName);
}

// ─── iframe shell HTML（CSS + JS 全部 inline） ─────
function renderShell(c, ctx) {
  const pluginId = ctx.pluginId;
  const hanaCss = c.req.query('hana-css') || '';
  const theme = c.req.query('hana-theme') || 'warm-paper';
  const base = `/api/plugins/${pluginId}`;

  let pluginToken = '';
  try {
    const candidates = [
      process.env.HANA_HOME && path.join(process.env.HANA_HOME, 'server-info.json'),
      path.join(os.homedir(), '.hanako', 'server-info.json'),
      'C:\\Users\\Administrator\\.hanako\\server-info.json',
    ].filter(Boolean);
    for (const si of candidates) {
      if (fs.existsSync(si)) {
        const j = JSON.parse(fs.readFileSync(si, 'utf-8'));
        if (j && j.token) { pluginToken = j.token; break; }
      }
    }
  } catch { /* ignore */ }
  console.log('[dsh-plugin-manager] shell render: tokenFound=' + (pluginToken ? 'yes' : 'NO'));

  let cssInline = '';
  let jsInline = '';
  try {
    const cssPath = path.join(APP_DIR, 'manager.css');
    if (fs.existsSync(cssPath)) cssInline = fs.readFileSync(cssPath, 'utf-8');
  } catch { /* ignore */ }
  try {
    const jsPath = path.join(APP_DIR, 'manager.js');
    if (fs.existsSync(jsPath)) {
      jsInline = fs.readFileSync(jsPath, 'utf-8')
        .replace(/<\/script>/gi, '<\\/script>');
    }
  } catch { /* ignore */ }

  return c.html(`<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DSH 插件管理</title>
  ${hanaCss ? `<link rel="stylesheet" href="${hanaCss.replace(/"/g, '&quot;')}">` : ''}
  <style>${cssInline}</style>
</head>
<body data-hana-theme="${theme.replace(/"/g, '&quot;')}">
  <div id="root"></div>
  <script>window.HANA_PLUGIN_BASE=${JSON.stringify(base)};</script>
  <script>window.HANA_PLUGIN_TOKEN=${JSON.stringify(pluginToken)};</script>
  <script>${jsInline}</script>
</body>
</html>`);
}

// ─── Routes ─────────────────────────────────────
export default function (app, ctx) {
  // 当前选定的 DSH_HOME。优先读持久化选择，其次探测 env / ~/.dsh。
  // 所有路由都通过这个 helper 拿 home，不再直接调 resolveDshHome。
  function currentDshHome() {
    const sel = getCurrentDshHome(ctx.dataDir);
    return sel || resolveDshHome();
  }

  // 页面
  app.get('/manager', (c) => renderShell(c, ctx));
  app.get('/page', (c) => renderShell(c, ctx));

  // 列出候选 DSH home + 当前选择
  app.get('/api/homes', (c) => {
    const homes = detectHomes(ctx.dataDir);
    return c.json({ ok: true, ...homes });
  });

  // 切换当前 home（持久化到 plugin-data/dsh-plugin-manager/current-home.json）
  app.post('/api/current-home', async (c) => {
    const { dshHome } = await c.req.json();
    try {
      setCurrentDshHome(ctx.dataDir, dshHome);
      // 切换后清掉 status 缓存，下次 GET /api/status 会重新探测
      statusCache = { at: 0, data: null };
      return c.json({ ok: true, dshHome });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  // 添加用户自定义 home 路径
  app.post('/api/custom-home', async (c) => {
    const { dshHome } = await c.req.json();
    try {
      const p = addCustomDshHome(ctx.dataDir, dshHome);
      return c.json({ ok: true, dshHome: p });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 400);
    }
  });

  // 状态缓存：探测 DSH_HOME 路径 + dsh web 服务端口。不 spawn dsh/pnpm 进程
  // （spawn 跟 hana 进程 PATH 交接本来就脆弱，而且 install 动作现走 runDsh()）。
  // 60s 缓存避免反复拉。
  let statusCache = { at: 0, data: null };
  let statusCallCount = 0;
  async function getStatus() {
    const now = Date.now();
    statusCallCount += 1;
    const hit = !!(statusCache.data && now - statusCache.at < 60000);
    const cacheAge = statusCache.data ? Math.floor((now - statusCache.at) / 1000) : null;
    if (statusCache.data && now - statusCache.at < 60000) {
      return { ...statusCache.data, _cache: { hit: true, age: cacheAge, calls: statusCallCount } };
    }
    const dshHome = currentDshHome();
    const dshHomeExists = dshHome ? fs.existsSync(dshHome) : false;

    // 并行探测：DSH web 服务 + dsh/npm 依赖 (allSettled 一个挂了不影响其他)。
    // 每个探测都有 timeout + 错误监听，不会 hang。
    const [web, cmd, pnpm] = await Promise.allSettled([
      probeDshWeb(),
      detectDshVersion(),
      pnpmAvailable(),
    ]);

    statusCache = {
      at: now,
      data: {
        dshHome,
        dshHomeExists,
        dshWeb: web.status === 'fulfilled' ? web.value : { ok: false, error: '探测异常' },
        dshCmd: cmd.status === 'fulfilled' ? cmd.value : { ok: false, error: '探测异常' },
        pnpm: pnpm.status === 'fulfilled' ? pnpm.value : { ok: false, error: '探测异常' },
        platform: process.platform,
      },
    };
    return { ...statusCache.data, _cache: { hit: false, age: 0, calls: statusCallCount } };
  }

  // 探测 dsh web host 是否在线（默认 3080，可逐个试 3080/3081/3082）。
  // 走 dsh 官方 RPC：POST /api/host.describe（跟 dsh-hanako 的 probeHost 同构）。
  // 之前用 GET /api/health 是错的——服务活着但 404（那只是端口活着，不代表 dsh host 就绪）。
  async function probeDshWeb() {
    const ports = [3080, 3081, 3082];
    const tried = [];
    for (const port of ports) {
      try {
        const url = `http://127.0.0.1:${port}/api/host.describe`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'probe-' + Date.now(),
            method: 'host.describe',
            payload: {},
          }),
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          let version = null;
          try {
            const body = await res.json();
            // dsh host.describe RPC 返回 { type, rpcId, result: { ok, value: { version, ... } } }
            version = body?.result?.value?.version || body?.data?.version || body?.version || null;
          } catch { /* ignore */ }
          return { ok: true, port, url, version };
        }
        tried.push(`${port}:HTTP ${res.status}`);
      } catch (e) {
        tried.push(`${port}:${e.name || 'error'}`);
      }
    }
    return { ok: false, error: 'dsh web 未就绪', tried };
  }

  // 探测 dsh 命令版本。不听 'exit' 单独解决：必须 listen 'error' + timeout 兜底，
  // 否则 spawn ENOENT 时 Promise 永远 hang，60s cache 永远走不到。
  // 跟 cmd-runner.js 里 runDsh() 一样的约束。
  async function detectDshVersion() {
    const dshPath = resolveDshCmd();
    if (!dshPath) {
      return { ok: false, error: 'dsh command not found (npm prefix + PATH both empty)' };
    }
    try {
      const { spawn } = await import('node:child_process');
      return await new Promise((resolve) => {
        const proc = spawn(dshPath, ['--version'], {
          shell: process.platform === 'win32',
          windowsHide: true,
        });
        let out = '';
        let err = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.stderr.on('data', (d) => { err += d.toString(); });
        const finish = (val) => {
          clearTimeout(timer);
          resolve(val);
        };
        const timer = setTimeout(() => {
          try { proc.kill(); } catch { /* ignore */ }
          finish({ ok: false, error: 'dsh --version timeout after 5s', stderr: err.slice(-300) });
        }, 5000);
        proc.on('error', (e) => {
          finish({ ok: false, error: `[spawn error] ${e.code || ''} ${e.message || ''}`, path: dshPath });
        });
        proc.on('exit', (code) => {
          if (code === 0) finish({ ok: true, version: out.trim(), path: dshPath });
          else finish({ ok: false, error: `dsh --version exit ${code}`, stderr: err.slice(-300), path: dshPath });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 状态总览（带缓存）
  app.get('/api/status', async (c) => {
    return c.json(await getStatus());
  });

  // 列出所有 profile
  app.get('/api/profiles', (c) => {
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    return c.json({ ok: true, dshHome, profiles: listProfiles(dshHome) });
  });

  // 列出 profile 下所有 plugin
  app.get('/api/plugins/:profile', (c) => {
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    const profileName = c.req.param('profile');
    if (!profileExists(dshHome, profileName)) {
      return c.json({ ok: false, error: `profile 不存在: ${profileName}` }, 404);
    }
    try {
      const data = listPlugins(dshHome, profileName, ctx.dataDir);
      return c.json({ ok: true, profile: profileName, ...data });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 列出备份
  app.get('/api/backups', (c) => {
    return c.json({ ok: true, backups: listBackups(ctx.dataDir) });
  });

  // 手动备份当前 profile（命名规则与自动备份一致：YYYYMMDD-HHmmss-profile）
  app.post('/api/backup', async (c) => {
    const { profile } = await c.req.json();
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !profileExists(dshHome, profile)) {
      return c.json({ ok: false, error: `profile 不存在: ${profile}` }, 400);
    }
    try {
      const backupDir = backupProfile(ctx.dataDir, dshHome, profile, true); // manual = true
      // 上限 10 条，超了从最早的开始删
      const removed = cleanupOldBackups(ctx.dataDir, 10);
      appendLog(ctx.dataDir, { action: 'backup.manual', profile, backupDir, ok: true, removed });
      return c.json({ ok: true, backupDir, removed });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 更新备份备注
  app.post('/api/backup/note', async (c) => {
    const { backupDir, note } = await c.req.json();
    if (!backupDir) return c.json({ ok: false, error: 'backupDir 缺失' }, 400);
    try {
      const ok = updateBackupNote(backupDir, note);
      if (!ok) return c.json({ ok: false, error: '备份目录不存在' }, 400);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 删除备份（含磁盘目录）
  app.post('/api/backup/delete', async (c) => {
    const { backupDir } = await c.req.json();
    if (!backupDir) return c.json({ ok: false, error: 'backupDir 缺失' }, 400);
    try {
      const ok = deleteBackup(backupDir);
      if (!ok) return c.json({ ok: false, error: '备份目录不存在或删除失败' }, 400);
      appendLog(ctx.dataDir, { action: 'backup.delete', backupDir, ok: true });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // DEBUG: 探针 ctx.dataDir + backups 解析详情
  app.get('/api/debug/data-dir', (c) => {
    const fs2 = require('node:fs');
    const path2 = require('node:path');
    const dataDir = ctx.dataDir;
    const backupRoot = dataDir ? path2.join(dataDir, 'backups') : null;
    const exists = backupRoot ? fs2.existsSync(backupRoot) : null;
    let entries = null;
    if (exists) {
      try { entries = fs2.readdirSync(backupRoot); } catch (e) { entries = `ERR: ${e.message}`; }
    }
    return c.json({
      ctxKeys: Object.keys(ctx),
      dataDir,
      backupRoot,
      exists,
      entries,
      entriesCount: Array.isArray(entries) ? entries.length : null,
    });
  });

  // 解析用户命令（dry-run 预览用，不实际执行）
  app.post('/api/parse-cmd', async (c) => {
    const { command } = await c.req.json();
    const parsed = parseDshCommand(command);
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    return c.json({ ok: true, parsed });
  });

  // ─── 安装本地 zip：解压 + dsh plugin add link: ───
  app.post('/api/install/zip', async (c) => {
    const { profile, zipPath, force } = await c.req.json();
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !profileExists(dshHome, profile)) {
      return c.json({ ok: false, error: `profile 不存在: ${profile}` }, 400);
    }
    if (!zipPath || !fs.existsSync(zipPath)) {
      return c.json({ ok: false, error: `zip 文件不存在: ${zipPath}` }, 400);
    }

    let backupDir = null;
    try {
      // 1) 备份当前 profile（backupDir 声明在 try 外，避免 backupProfile 抛错时外层 catch 引用 TDZ）
      backupDir = backupProfile(ctx.dataDir, dshHome, profile);

      // 2) 解压到 profiles/<name>/external/<plugin>/
      const profDir = profileDirOf(dshHome, profile);
      const externalDir = path.join(profDir, 'external');
      if (!fs.existsSync(externalDir)) fs.mkdirSync(externalDir, { recursive: true });

      // 解压到临时目录（解压成功后再 move 到确定目录；失败时清理临时目录 + 提示恢复 backup）
      const tmpName = `${Date.now()}-${path.basename(zipPath, '.zip')}`;
      const destDir = path.join(externalDir, tmpName);
      let pluginRoot, metadata;
      try {
        ({ pluginRoot, metadata } = extractAndInspect(zipPath, destDir));
      } catch (e) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* ignore */ }
        appendLog(ctx.dataDir, {
          action: 'install.zip',
          profile, zipPath, ok: false, error: `解压失败: ${e.message}`,
          backupDir, restoreHint: backupDir ? `已备份到 ${backupDir}，可在「备份」里恢复` : null,
        });
        return c.json({
          ok: false,
          error: `解压失败: ${e.message}`,
          backupDir,
          restoreHint: backupDir ? `已自动备份到 ${backupDir}，可在「备份」里恢复` : null,
        }, 400);
      }
      const pluginName = metadata.name;
      if (!pluginName) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* ignore */ }
        return c.json({
          ok: false, error: 'plugin package.json 缺少 name 字段',
          backupDir, restoreHint: backupDir ? `已自动备份到 ${backupDir}` : null,
        }, 400);
      }
      // 防 shell 注入：pluginName 会拼进 link: 参数（Windows spawn shell:true 下 cmd 元字符有逃逸面）。
      // npm 包名本身就是 URL 安全字符集（字母数字 @ . _ / -），超出即拒绝。
      if (!/^[a-zA-Z0-9@._/-]+$/.test(pluginName) || pluginName.includes('..')) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* ignore */ }
        return c.json({
          ok: false,
          error: `插件名含不安全字符（可能被 shell 解释），拒绝安装: ${pluginName}`,
          backupDir, restoreHint: backupDir ? `已自动备份到 ${backupDir}` : null,
        }, 400);
      }

      // 移动到确定目录
      const finalDir = path.join(externalDir, pluginName);
      if (fs.existsSync(finalDir)) {
        if (!force) {
          return c.json({
            ok: false,
            error: `目标已存在: ${finalDir}，传 force=true 覆盖`,
            backupDir,
          }, 409);
        }
        fs.rmSync(finalDir, { recursive: true, force: true });
      }
      fs.cpSync(pluginRoot, finalDir, { recursive: true });
      fs.rmSync(pluginRoot, { recursive: true, force: true });
      // 清理临时解压父目录（如果与 finalDir 不同）
      if (destDir !== finalDir && fs.existsSync(destDir)) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }

      // 3) 调 dsh plugin add link:<path>（让 dsh 自己处理 package.json + cordis + pnpm install）
      const linkPath = finalDir.replace(/\\/g, '/');
      const job = await runDsh(
        ['plugin', '--profile', profile, 'add', `link:${linkPath}`],
        { cwd: profDir }
      );

      const ok = job.exitCode === 0;
      appendLog(ctx.dataDir, {
        action: 'install.zip',
        profile,
        plugin: pluginName,
        zipPath,
        ok,
        jobId: job.id,
        exitCode: job.exitCode,
        durationMs: job.durationMs,
        backupDir,
        finalDir,
        stdoutTail: job.stdout.slice(-800),
        stderrTail: job.stderr.slice(-800),
      });

      return c.json({
        ok,
        pluginName,
        finalDir,
        backupDir,
        job,
        metadata,
        restoreHint: ok ? null : (backupDir ? `已自动备份到 ${backupDir}，可在「备份」里恢复` : null),
        // 失败时把真实错误信息带回去：spawn 错误（job.error）> stderr > stdout > exitCode
        error: ok ? undefined : (
          (job.error && `[spawn error] ${job.error}`) ||
          (job.stderr && job.stderr.trim().slice(-500)) ||
          (job.stdout && job.stdout.trim().slice(-500)) ||
          `exit ${job.exitCode}`
        ),
      });
    } catch (e) {
      ctx.log?.error?.('install zip failed', e);
      // 出错时尝试清理刚解压的 finalDir，避免留下半截文件
      try { if (typeof finalDir !== 'undefined' && finalDir && fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true }); } catch { /* ignore */ }
      appendLog(ctx.dataDir, {
        action: 'install.zip', profile, zipPath, ok: false, error: e.message,
        backupDir, restoreHint: backupDir ? `已自动备份到 ${backupDir}，可在「备份」里恢复` : null,
      });
      return c.json({
        ok: false, error: e.message, backupDir,
        restoreHint: backupDir ? `已自动备份到 ${backupDir}，可在「备份」里恢复` : null,
      }, 500);
    }
  });

  // ─── 执行用户给的 dsh plugin 命令 ───
  app.post('/api/install/cmd', async (c) => {
    const { profile, command } = await c.req.json();
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);

    // 解析 + 白名单验证
    const parsed = parseDshCommand(command);
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);

    // profile 一致性校验（如果前端传了 profile，跟命令里的必须一致）
    if (profile && profile !== parsed.profile) {
      return c.json({
        ok: false,
        error: `命令中的 --profile ${parsed.profile} 与 UI 选择不一致`,
      }, 400);
    }

    // 仅允许 add / update 操作（remove/uninstall 走单独的 /api/uninstall）
    if (!['add', 'update'].includes(parsed.action)) {
      return c.json({
        ok: false,
        error: `通过命令安装只支持 add/update，${parsed.action} 请用对应 API`,
      }, 400);
    }

    if (!profileExists(dshHome, parsed.profile)) {
      return c.json({ ok: false, error: `profile 不存在: ${parsed.profile}` }, 400);
    }

    try {
      // 备份当前 profile
      const backupDir = backupProfile(ctx.dataDir, dshHome, parsed.profile);

      const profDir = profileDirOf(dshHome, parsed.profile);
      const job = await runDsh(parsed.fullArgs, { cwd: profDir });

      const ok = job.exitCode === 0;
      appendLog(ctx.dataDir, {
        action: `install.cmd.${parsed.action}`,
        profile: parsed.profile,
        plugin: parsed.package,
        command,
        ok,
        jobId: job.id,
        exitCode: job.exitCode,
        durationMs: job.durationMs,
        backupDir,
        stdoutTail: job.stdout.slice(-800),
        stderrTail: job.stderr.slice(-800),
      });

      return c.json({
        ok,
        profile: parsed.profile,
        package: parsed.package,
        action: parsed.action,
        backupDir,
        job,
        // 失败时把真实错误信息带回去：spawn 错误（job.error）> stderr > stdout > exitCode
        error: ok ? undefined : (
          (job.error && `[spawn error] ${job.error}`) ||
          (job.stderr && job.stderr.trim().slice(-500)) ||
          (job.stdout && job.stdout.trim().slice(-500)) ||
          `exit ${job.exitCode}`
        ),
      });
    } catch (e) {
      ctx.log?.error?.('install cmd failed', e);
      appendLog(ctx.dataDir, { action: 'install.cmd', profile, command, ok: false, error: e.message });
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ─── 轮询 job 状态（前端展示实时输出） ───
  app.get('/api/job/:id', (c) => {
    const job = getJob(c.req.param('id'));
    if (!job) return c.json({ ok: false, error: 'job 不存在' }, 404);
    return c.json({ ok: true, job });
  });

  // 卸载（直接调 dsh plugin remove）
  app.post('/api/uninstall', async (c) => {
    const { profile, id, removeFiles } = await c.req.json();
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !profileExists(dshHome, profile)) {
      return c.json({ ok: false, error: `profile 不存在: ${profile}` }, 400);
    }
    if (!id) return c.json({ ok: false, error: 'id 必填' }, 400);

    try {
      const backupDir = backupProfile(ctx.dataDir, dshHome, profile);
      const profDir = profileDirOf(dshHome, profile);
      const job = await runDsh(
        ['plugin', '--profile', profile, 'remove', id],
        { cwd: profDir }
      );

      // 如果要求删本地文件
      let removedDir = null;
      if (removeFiles) {
        const externalDir = path.join(profDir, 'external', id);
        if (fs.existsSync(externalDir)) {
          fs.rmSync(externalDir, { recursive: true, force: true });
          removedDir = externalDir;
        }
      }

      const ok = job.exitCode === 0;
      appendLog(ctx.dataDir, {
        action: 'uninstall',
        profile,
        plugin: id,
        removeFiles,
        ok,
        jobId: job.id,
        exitCode: job.exitCode,
        backupDir,
        removedDir,
      });

      return c.json({ ok, pluginName: id, backupDir, removedDir, job });
    } catch (e) {
      ctx.log?.error?.('uninstall failed', e);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 启用/禁用（直接改 cordis.patch.yml，不需要 pnpm install）
  app.post('/api/toggle', async (c) => {
    const { profile, id, enabled } = await c.req.json();
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !profileExists(dshHome, profile)) {
      return c.json({ ok: false, error: `profile 不存在: ${profile}` }, 400);
    }
    if (!id) return c.json({ ok: false, error: 'id 必填' }, 400);
    if (typeof enabled !== 'boolean') {
      return c.json({ ok: false, error: 'enabled 必须是 boolean' }, 400);
    }

    try {
      const backupDir = backupProfile(ctx.dataDir, dshHome, profile);
      setBundleEnabled(dshHome, profile, id, enabled);
      appendLog(ctx.dataDir, { action: enabled ? 'enable' : 'disable', profile, plugin: id, ok: true, backupDir });
      return c.json({ ok: true, id, enabled, backupDir });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 恢复备份
  app.post('/api/restore', async (c) => {
    const { backupDir, profile } = await c.req.json();
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!backupDir || !fs.existsSync(backupDir)) {
      return c.json({ ok: false, error: `备份目录不存在: ${backupDir}` }, 400);
    }
    if (!profile || !profileExists(dshHome, profile)) {
      return c.json({ ok: false, error: `profile 不存在: ${profile}` }, 400);
    }
    try {
      const restored = restoreProfile(ctx.dataDir, backupDir, dshHome, profile);
      appendLog(ctx.dataDir, { action: 'restore', profile, backupDir, ok: true, files: restored });
      return c.json({ ok: true, restored });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 备份 v2：插件源备份（scan → backup → restore） ──────
  // 扫描 profile 的插件集，输出 PluginSpec[]（含策略分类）
  app.get('/api/v2/scan', (c) => {
    const profile = c.req.query('profile');
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !profileExists(dshHome, profile)) {
      return c.json({ ok: false, error: 'profile 不存在: ' + profile }, 400);
    }
    try {
      const r = scanProfile(profileDirOf(dshHome, profile));
      if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 备份 v2：扫描 + 落盘到 <dataDir>/backups/plugin-source/<profile>/<timestamp>/
  app.post('/api/v2/backup', async (c) => {
    const { profile, marks } = await c.req.json();
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !profileExists(dshHome, profile)) {
      return c.json({ ok: false, error: 'profile 不存在: ' + profile }, 400);
    }
    try {
      const scan = scanProfile(profileDirOf(dshHome, profile), { marks: marks || {} });
      if (!scan.ok) return c.json({ ok: false, error: scan.error }, 400);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupRoot = path.join(ctx.dataDir, 'backups', 'plugin-source', profile, ts);
      const results = backupPlugins(scan.plugins, path.join(backupRoot, 'plugins'));
      appendLog(ctx.dataDir, { action: 'backup.v2', profile, backupRoot, ok: true, plugins: results.length });
      return c.json({ ok: true, backupRoot, results });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 列出插件源备份（按 profile 分组；workspace 在 backups/workspace/ 下，不再混入）
  app.get('/api/v2/backups', (c) => {
    const root = path.join(ctx.dataDir, 'backups', 'plugin-source');
    const list = {};
    if (fs.existsSync(root)) {
      for (const profile of fs.readdirSync(root)) {
        const pd = path.join(root, profile);
        if (!fs.statSync(pd).isDirectory()) continue;
        list[profile] = fs.readdirSync(pd).filter((d) => fs.statSync(path.join(pd, d)).isDirectory());
      }
    }
    return c.json({ ok: true, backups: list });
  });

  // 构造真实还原执行器（/api/v2/restore 与 /api/updates/rollback 共用）
  async function makeRestoreExec(dshHome, profile, pluginsRoot) {
    const profDir = profileDirOf(dshHome, profile);
    const externalDir = path.join(profDir, 'external');
    const { addPackage } = await import('../lib/pnpm-runner.js');
    const { addBundle } = await import('../lib/dsh-profile.js');
    const { restoreBlobOne } = await import('../lib/plugin-restore.js');
    return {
      // pnpm add（cwd=profile 目录，写入 package.json + lockfile）
      async add(specStr) {
        const j = await addPackage(specStr, profDir);
        return { ok: j.exitCode === 0, error: j.exitCode === 0 ? null : ((j.stderr || '').slice(-400) || `exit ${j.exitCode}`) };
      },
      // 注册到 dsh.profile.bundles（不写 cordis insert——bundle 层已有，避免重复加载）
      registerBundle(pkg) {
        addBundle(dshHome, profile, { id: pkg, depsSpec: null });
      },
      // blob 目标：link 插件 → external/<pkg>；其他 → node_modules/<pkg>
      targetDirFor(spec) {
        return spec.installKind === 'link'
          ? path.join(externalDir, spec.pkg.replace(/^@/, '').replace(/\//g, '__'))
          : path.join(profDir, 'node_modules', spec.pkg);
      },
      // 复制 content 到目标
      async copyBlob(spec, dst) {
        return restoreBlobOne(spec, pluginsRoot, dst);
      },
    };
  }

  // v2 恢复预览（dry-run）：从备份 index 读 spec，生成命令
  app.post('/api/v2/restore', async (c) => {
    const { profile, timestamp, apply } = await c.req.json();
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !timestamp) return c.json({ ok: false, error: 'profile/timestamp 缺失' }, 400);
    const backupRoot = path.join(ctx.dataDir, 'backups', 'plugin-source', profile, timestamp);
    const indexPath = path.join(backupRoot, 'plugins', 'index.json');
    if (!fs.existsSync(indexPath)) return c.json({ ok: false, error: '备份不存在: ' + backupRoot }, 404);
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const specs = index.plugins;
      const dryRun = apply !== true;
      if (dryRun) {
        const results = restorePlugins(specs, path.join(backupRoot, 'plugins'), { dryRun });
        return c.json({ ok: true, dryRun, results });
      }
      // 真实还原：pointer 执行 pnpm add，blob 复制 content + link 注册，全部注册到 bundles
      const pluginsRoot = path.join(backupRoot, 'plugins');
      const exec = await makeRestoreExec(dshHome, profile, pluginsRoot);
      const r = await restorePluginsExec(specs, pluginsRoot, exec);
      appendLog(ctx.dataDir, {
        action: 'restore.v2', profile, backupRoot, ok: r.ok,
        plugins: r.results.length, okCount: r.results.filter((x) => x.ok).length,
      });
      return c.json({ ok: true, dryRun: false, results: r.results, allOk: r.ok });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 工作区快照：备份 dsh-workspace/ 整个目录（魔改/自研资产库） ──
  // 扫描工作区（列出顶层条目：目录 + 文件）
  app.get('/api/v2/workspace/scan', (c) => {
    const wsDir = c.req.query('wsDir') || path.join(os.homedir(), 'Desktop', 'dsh-workspace');
    try {
      const r = scanWorkspace(wsDir);
      return c.json({ ok: r.ok, ...(r.ok ? { workspaceDir: r.workspaceDir, entries: r.entries } : { error: r.error }) });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 一键打开备份根目录到 OS 文件管理器（Windows: explorer / macOS: open / Linux: xdg-open）
  // 不接受任意 path 参数——固定打开 <dataDir>/backups，防任意路径打开的风险
  app.post('/api/open-backups-dir', async (c) => {
    const target = path.join(ctx.dataDir, 'backups');
    try {
      if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
      const cmd = process.platform === 'win32' ? 'explorer.exe'
 : process.platform === 'darwin' ? 'open'
 : 'xdg-open';
      const proc = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
      proc.on('error', () => { /* 可能环境无文件管理器，忽略 */ });
      proc.unref();
      return c.json({ ok: true, path: target });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 备份整个工作区 → <dataDir>/backups/workspace/<timestamp>/
  app.post('/api/v2/workspace/backup', async (c) => {
    const { wsDir } = await c.req.json();
    const ws = wsDir || path.join(os.homedir(), 'Desktop', 'dsh-workspace');
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupRoot = path.join(ctx.dataDir, 'backups', 'workspace', ts);
      const r = backupWorkspace(ws, path.join(backupRoot, 'plugins'));
      if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
      appendLog(ctx.dataDir, { action: 'backup.workspace', workspaceDir: ws, backupRoot, ok: true, entries: r.results.length });
      return c.json({ ok: true, backupRoot, results: r.results });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 插件魔改标记（用户手动标记：profile/pkg → modified） ──────────────
  // 读取所有 marks（含/不魔改的所有入口；返回 list 给前端渲染）
  app.get('/api/plugin-marks', (c) => {
    const profile = c.req.query('profile') || null;
    const marks = readMarks(ctx.dataDir);
    if (!profile) return c.json({ ok: true, marks });
    const filtered = {};
    for (const [k, v] of Object.entries(marks)) {
      if (k.startsWith(profile + '/')) filtered[k] = v;
    }
    return c.json({ ok: true, marks: filtered });
  });

  // 设置/取消标记
  app.post('/api/plugin-marks', async (c) => {
    const { profile, pkg, modified, note } = await c.req.json();
    if (!profile || !pkg) return c.json({ ok: false, error: 'profile/pkg 必填' }, 400);
    try {
      const entry = setMark(ctx.dataDir, profile, pkg, !!modified, note ? { note } : {});
      return c.json({ ok: true, modified: !!modified, entry });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── GitHub token 配置 ─────────────────
  // 存在 <dataDir>/github-token 明文。用户不会推 GitHub，但 PAT 能提高查询限流。
  app.get('/api/github-token/status', (c) => {
    const tokenPath = path.join(ctx.dataDir, 'github-token');
    const exists = fs.existsSync(tokenPath);
    let masked = null;
    if (exists) {
      try {
        const t = fs.readFileSync(tokenPath, 'utf8').trim();
        if (t) masked = t.length > 8 ? t.slice(0, 4) + '…' + t.slice(-4) : '•••';
      } catch { /* ignore */ }
    }
    return c.json({ ok: true, hasToken: !!process.env.GITHUB_TOKEN || exists, masked, fromEnv: !!process.env.GITHUB_TOKEN });
  });
  app.post('/api/github-token', async (c) => {
    const { token } = await c.req.json();
    if (!token || typeof token !== 'string' || token.length < 10) {
      return c.json({ ok: false, error: 'token 无效（至少 10 字符）' }, 400);
    }
    try {
      fs.writeFileSync(path.join(ctx.dataDir, 'github-token'), token.trim(), { mode: 0o600 });
      // 清除更新检查缓存，让下一次 fetch 带新 token
      updateCheckCache.clear();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });
  app.delete('/api/github-token', (c) => {
    try {
      const p = path.join(ctx.dataDir, 'github-token');
      if (fs.existsSync(p)) fs.unlinkSync(p);
      updateCheckCache.clear();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

// ── GitHub 源插件更新检查 / 执行 ──────────────
  // 扫描 profile 的 github 插件，查上游最新 commit，对比本地（有更新/已最新/失败）
  // 缓存 5 分钟（避免用户连点检查更新造成 GitHub 限流）
  const updateCheckCache = new Map(); // key: `${dshHome}|${profile}` -> { at, result }
  app.get('/api/updates/check', async (c) => {
    const profile = c.req.query('profile');
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !profileExists(dshHome, profile)) {
      return c.json({ ok: false, error: 'profile 不存在: ' + profile }, 400);
    }
    try {
      const cacheKey = `${dshHome}|${profile}`;
      const hit = updateCheckCache.get(cacheKey);
      // 5min 缓存：但如果上游全部是限流失败（check-failed 且 error 含限流），3 分钟后才重试
      if (hit && Date.now() - hit.at < (hit.likelyRateLimited ? 3 * 60 * 1000 : 5 * 60 * 1000)) {
        return c.json({ ok: true, ...hit.result, _cache: { hit: true, age: Math.floor((Date.now() - hit.at) / 1000) } });
      }
      // 魔改标记：从 plugin-marks.json 读（用户手动标记的“已魔改”插件），
      // 让 update check 能提醒但不提供更新按钮
      const allMarks = readMarks(ctx.dataDir);
      const profileMarks = {};
      for (const [k, v] of Object.entries(allMarks)) {
        if (k.startsWith(profile + '/') && v.modified) {
          profileMarks[k.slice(profile.length + 1)] = true;
        }
      }
      // 透传 dataDir 让 updater 读 github-token
      const r = await checkUpdates(profileDirOf(dshHome, profile), { marks: profileMarks, dataDir: ctx.dataDir });
      if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
      // 检查是否全部限流 → 压缩缓存时间（避免用户连点重试浪费请求）
      const likelyRateLimited = r.plugins.length > 0 && r.plugins.every(p => p.status === 'check-failed' && (p.upstreamError || '').includes('限流'));
      updateCheckCache.set(cacheKey, { at: Date.now(), result: r, likelyRateLimited });
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 执行更新：dsh plugin update（后台 job，前端轮询）
  app.post('/api/updates/apply', async (c) => {
    const { profile, pkg } = await c.req.json();
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !profileExists(dshHome, profile)) {
      return c.json({ ok: false, error: 'profile 不存在: ' + profile }, 400);
    }
    if (!pkg) return c.json({ ok: false, error: 'pkg 必填' }, 400);
    // 安全：只允许 github 源插件（用 lockfile 校验），避免误更新 npm/link 插件
    try {
      const lockPath = path.join(profileDirOf(dshHome, profile), 'pnpm-lock.yaml');
      const lockText = fs.readFileSync(lockPath, 'utf8');
      const { parseGithubDeps } = await import('../lib/updater.js');
      const gh = parseGithubDeps(lockText);
      if (!gh[pkg]) return c.json({ ok: false, error: '不是 GitHub 源插件，拒绝更新' }, 400);

      const backupDir = backupProfile(ctx.dataDir, dshHome, profile);
      const profDir = profileDirOf(dshHome, profile);
      // 先跑一次 update，看输出是否提到 allowBuilds（pnpm 10+ 默认拒绝 GitHub 源包跑 build）
      // 如果是，就自动批准 + 重试。避免 pnpm-workspace.yaml 手动维护。
      const firstJob = await runDsh(['plugin', '--profile', profile, 'update', pkg], { cwd: profDir });
      // dsh 把 pnpm 输出写到 stdout（不是 stderr），所以要同时检查 stdout + stderr。
      // 注意：pnpm 中文报错里的"allowBuilds"被包在中文双引号里（"allowBuilds" allowlist），
      // 不能用 allowBuilds allowlist 这种粘合的正则。
      const approveAndRetry = /allowBuilds|Ignored build scripts|approve-builds/i.test((firstJob.stderr || '') + (firstJob.stdout || ''));
      if (approveAndRetry) {
        ctx.log?.info?.('auto-approving pnpm builds and retrying', pkg);
        // pnpm approve-builds 需要 lockfile 已更新才看得到 pending——update 失败时它会说 "no awaiting"。
        // 所以同时手动 patch pnpm-workspace.yaml：给这个 pkg 加仓库通配 key（pnpm 11.11+ 匹配所有 commit）。
        try {
          const wsPath = path.join(profDir, 'pnpm-workspace.yaml');
          if (fs.existsSync(wsPath)) {
            let text = fs.readFileSync(wsPath, 'utf8');
            const repo = gh[pkg].repo;
            const repoPatterns = [
              `${pkg}@git+ssh://git@github.com/${repo}.git`, // git+ssh 形式
              `${pkg}@https://codeload.github.com/${repo}/tar.gz`, // codeload tarball 形式（github: 简写会被 pnpm 解析到这个 URL）
            ];
            for (const key of repoPatterns) {
              const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm');
              if (!re.test(text)) {
                const line = `  ${key}: true`;
                if (/^allowBuilds:\s*$/m.test(text)) {
                  text = text.replace(/^(allowBuilds:\s*)$/m, `$1\n${line}`);
                } else if (/^allowBuilds:\s*\n[\s\S]+?(\n[a-zA-Z@_-]|\n$)/m.test(text)) {
                  text = text.replace(/^(allowBuilds:\s*\n[\s\S]*?)(  [a-zA-Z@_-])/m, `$1${line}\n$2`);
                } else {
                  text = text.replace(/(\n[a-zA-Z])/m, `\nallowBuilds:\n${line}$1`);
                }
              }
            }
            fs.writeFileSync(wsPath, text, 'utf8');
          }
        } catch (e) {
          ctx.log?.warn?.('patch pnpm-workspace.yaml failed', e.message);
        }
        // 重试 update（pnpm-workspace.yaml 现在有通配 key 了）
        const job2 = await runDsh(['plugin', '--profile', profile, 'update', pkg], { cwd: profDir });
        const ok2 = job2.exitCode === 0;
        // 更新成功 → 清掉检查缓存，否则前端重新 check 命中旧缓存仍显示"落后 N"
        if (ok2) updateCheckCache.delete(`${dshHome}|${profile}`);
        appendLog(ctx.dataDir, {
          action: 'update', profile, plugin: pkg, ok: ok2,
          jobId: job2.id, exitCode: job2.exitCode, durationMs: job2.durationMs,
          backupDir, autoApprovedBuilds: true,
          stderrTail: job2.stderr?.slice(-2000), stdoutTail: job2.stdout?.slice(-2000),
        });
        return c.json({
          ok: ok2, pkg, backupDir, job: job2, autoApprovedBuilds: true,
          error: ok2 ? undefined : ((job2.error && '[spawn error] ' + job2.error) || job2.stderr?.trim().slice(-500) || `exit ${job2.exitCode}`),
        });
      }
      const ok = firstJob.exitCode === 0;
      // 更新成功 → 清掉检查缓存，否则前端重新 check 命中旧缓存仍显示"落后 N"
      if (ok) updateCheckCache.delete(`${dshHome}|${profile}`);
      appendLog(ctx.dataDir, {
        action: 'update', profile, plugin: pkg, ok,
        jobId: firstJob.id, exitCode: firstJob.exitCode, durationMs: firstJob.durationMs,
        backupDir, stderrTail: firstJob.stderr?.slice(-2000), stdoutTail: firstJob.stdout?.slice(-2000),
      });
      return c.json({
        ok, pkg, backupDir, job: firstJob,
        error: ok ? undefined : ((firstJob.error && '[spawn error] ' + firstJob.error) || firstJob.stderr?.trim().slice(-500) || `exit ${firstJob.exitCode}`),
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ── 回滚：把单个插件还原到某个插件源备份里的版本（更新翻车的后悔药）──
  // 列出该插件在所有插件源备份中的历史版本
  app.get('/api/updates/rollback-list', (c) => {
    const profile = c.req.query('profile');
    const pkg = c.req.query('pkg');
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !pkg) return c.json({ ok: false, error: 'profile/pkg 必填' }, 400);
    const root = path.join(ctx.dataDir, 'backups', 'plugin-source', profile);
    const versions = [];
    if (fs.existsSync(root)) {
      const timestamps = fs.readdirSync(root)
        .filter((d) => fs.statSync(path.join(root, d)).isDirectory())
        .sort()
        .reverse(); // 新的在前
      for (const ts of timestamps) {
        const indexPath = path.join(root, ts, 'plugins', 'index.json');
        if (!fs.existsSync(indexPath)) continue;
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
          const spec = (index.plugins || []).find((s) => s.pkg === pkg);
          if (spec) {
            versions.push({
              timestamp: ts,
              strategy: spec.strategy,
              installKind: spec.installKind,
              commit: githubCommitOf(spec.lockVersion),
              version: spec.localVersion || null,
              hasContent: spec.strategy !== 'pointer',
            });
          }
        } catch { /* 单个备份损坏不影响其他 */ }
      }
    }
    return c.json({ ok: true, pkg, versions });
  });

  // 执行回滚：用指定备份里该插件的 spec 重新安装（精确锁定当时的 commit）
  app.post('/api/updates/rollback', async (c) => {
    const { profile, pkg, timestamp } = await c.req.json();
    const dshHome = currentDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !pkg || !timestamp) return c.json({ ok: false, error: 'profile/pkg/timestamp 必填' }, 400);
    const backupRoot = path.join(ctx.dataDir, 'backups', 'plugin-source', profile, timestamp);
    const indexPath = path.join(backupRoot, 'plugins', 'index.json');
    if (!fs.existsSync(indexPath)) return c.json({ ok: false, error: '备份不存在: ' + backupRoot }, 404);
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const spec = (index.plugins || []).find((s) => s.pkg === pkg);
      if (!spec) return c.json({ ok: false, error: `备份 ${timestamp} 里没有插件 ${pkg}` }, 400);
      // 回滚前先备份当前 profile（安全网，可反悔）
      const backupDir = backupProfile(ctx.dataDir, dshHome, profile);
      const pluginsRoot = path.join(backupRoot, 'plugins');
      const exec = await makeRestoreExec(dshHome, profile, pluginsRoot);
      const r = await restorePluginsExec([spec], pluginsRoot, exec);
      appendLog(ctx.dataDir, {
        action: 'rollback', profile, plugin: pkg, fromTimestamp: timestamp,
        backupDir, ok: r.ok, result: r.results[0],
      });
      return c.json({ ok: true, ...r, backupDir });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 操作日志
  app.get('/api/logs', (c) => {
    const limit = parseInt(c.req.query('limit') || '50', 10);
    return c.json({ ok: true, logs: readRecentLogs(ctx.dataDir, limit) });
  });

  // 文件浏览器（用于 zip/目录选择）
  app.get('/api/browse', (c) => {
    const start = c.req.query('path') || os.homedir();
    if (!fs.existsSync(start)) return c.json({ ok: false, error: '路径不存在' }, 400);
    try {
      const stat = fs.statSync(start);
      if (!stat.isDirectory()) return c.json({ ok: false, error: '不是目录' }, 400);
      const entries = fs.readdirSync(start, { withFileTypes: true })
        .map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
          isFile: e.isFile(),
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return c.json({ ok: true, path: start, parent: path.dirname(start), entries });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });
}