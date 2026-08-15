/**
 * lib/zip-native.js — 纯 Node 内置 zip 解压器
 *
 * 为什么不用 adm-zip：
 *   - 零依赖是好插件的标志
 *   - hana dev install 反复重置 node_modules，每次都丢依赖
 *   - 我们只需要最朴素的 zip 解压功能
 *
 * 支持：
 *   - STORED (method 0，无压缩)
 *   - DEFLATE (method 8，zlib inflate)
 *   - 普通 zip 文件（不支持加密/分卷/spanned）
 *
 * zip 文件结构：
 *   [Local file header + file data] × N
 *   [Central directory header] × N
 *   [End of central directory record] (EOCD)
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b01;

/**
 * 解压 zip 到目标目录
 * @param {string} zipPath
 * @param {string} destDir
 */
export function extractZip(zipPath, destDir) {
  if (!fs.existsSync(zipPath)) throw new Error(`zip 不存在: ${zipPath}`);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const buf = fs.readFileSync(zipPath);
  const entries = parseZip(buf);

  for (const entry of entries) {
    // 防 zip slip：拒绝 .. 跳出 destDir
    const outPath = joinPath(destDir, entry.name);
    const normalized = outPath.replace(/\\/g, '/');
    const destNormalized = destDir.replace(/\\/g, '/').replace(/\/$/, '');
    if (!normalized.startsWith(destNormalized + '/') && normalized !== destNormalized) {
      throw new Error(`拒绝越界路径: ${entry.name}`);
    }
    if (entry.isDir) {
      fs.mkdirSync(outPath, { recursive: true });
      continue;
    }
    // 确保父目录存在
    fs.mkdirSync(pathDir(outPath), { recursive: true });
    if (entry.method === 0) {
      fs.writeFileSync(outPath, entry.data);
    } else if (entry.method === 8) {
      const inflated = zlib.inflateRawSync(entry.data);
      fs.writeFileSync(outPath, inflated);
    } else {
      throw new Error(`不支持的压缩方法: ${entry.method} (${entry.name})`);
    }
  }
}

function parseZip(buf) {
  const entries = [];
  let cursor = 0;
  while (cursor < buf.length) {
    const sig = buf.readUInt32LE(cursor);
    if (sig !== LOCAL_HEADER_SIG) break; // 进入 central directory
    const method = buf.readUInt16LE(cursor + 8);
    const compressedSize = buf.readUInt32LE(cursor + 18);
    const uncompressedSize = buf.readUInt32LE(cursor + 22);
    const nameLen = buf.readUInt16LE(cursor + 26);
    const extraLen = buf.readUInt16LE(cursor + 28);
    const name = buf.slice(cursor + 30, cursor + 30 + nameLen).toString('utf-8');
    const dataStart = cursor + 30 + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + compressedSize);
    const isDir = name.endsWith('/');
    entries.push({ name, method, compressedSize, uncompressedSize, data, isDir });
    cursor = dataStart + compressedSize;
  }
  return entries;
}

function joinPath(dir, name) {
  // Windows-safe join
  const sep = dir.includes('\\') ? '\\' : '/';
  if (dir.endsWith('\\') || dir.endsWith('/')) return dir + name;
  return dir + sep + name;
}

function pathDir(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (idx < 0) return '.';
  return p.slice(0, idx) || '/';
}
