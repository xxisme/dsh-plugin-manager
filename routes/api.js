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
} from '../lib/backup.js';
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
  // 页面
  app.get('/manager', (c) => renderShell(c, ctx));
  app.get('/page', (c) => renderShell(c, ctx));

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
    const dshHome = resolveDshHome();
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
    const dshHome = resolveDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    return c.json({ ok: true, dshHome, profiles: listProfiles(dshHome) });
  });

  // 列出 profile 下所有 plugin
  app.get('/api/plugins/:profile', (c) => {
    const dshHome = resolveDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    const profileName = c.req.param('profile');
    if (!profileExists(dshHome, profileName)) {
      return c.json({ ok: false, error: `profile 不存在: ${profileName}` }, 404);
    }
    try {
      const data = listPlugins(dshHome, profileName);
      return c.json({ ok: true, profile: profileName, ...data });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // 列出备份
  app.get('/api/backups', (c) => {
    return c.json({ ok: true, backups: listBackups(ctx.dataDir) });
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
    const dshHome = resolveDshHome();
    if (!dshHome) return c.json({ ok: false, error: 'DSH_HOME 未配置' }, 400);
    if (!profile || !profileExists(dshHome, profile)) {
      return c.json({ ok: false, error: `profile 不存在: ${profile}` }, 400);
    }
    if (!zipPath || !fs.existsSync(zipPath)) {
      return c.json({ ok: false, error: `zip 文件不存在: ${zipPath}` }, 400);
    }

    try {
      // 1) 备份当前 profile
      const backupDir = backupProfile(ctx.dataDir, dshHome, profile);

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
    const dshHome = resolveDshHome();
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
    const dshHome = resolveDshHome();
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
    const dshHome = resolveDshHome();
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
    const dshHome = resolveDshHome();
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