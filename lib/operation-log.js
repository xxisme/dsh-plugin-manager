/**
 * lib/operation-log.js — 操作日志
 *
 * 每次 install / remove / enable / disable 写一行 JSONL 到 ${dataDir}/operations.log
 * UI 加载时显示最近 50 条
 */

import fs from 'node:fs';
import path from 'node:path';

const LOG_FILE = 'operations.log';
const MAX_LINES = 200;

export function appendLog(dataDir, entry) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, LOG_FILE);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry,
  }) + '\n';
  fs.appendFileSync(file, line, 'utf-8');

  // 滚动截断
  try {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      const kept = lines.slice(-MAX_LINES).join('\n') + '\n';
      fs.writeFileSync(file, kept, 'utf-8');
    }
  } catch { /* ignore */ }
}

export function readRecentLogs(dataDir, limit = 50) {
  const file = path.join(dataDir, LOG_FILE);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map((line) => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
}
