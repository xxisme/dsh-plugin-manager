// lib/plugin-marks.js
// 插件魔改标记：用户手动标记某个 bundle "我魔改过"，持久化到 <dataDir>/plugin-marks.json
//
// 用法：
//  - marks.json 存 { 'profile/pkg': true }（可带版本或时间戳）
//  - readMarks() 读所有
//  - isMarkedModified(profile, pkg) 查
//  - setMark(profile, pkg, modified, opts?) 写
//  - 在 routes 里：listPlugins 返回 isModified；updates/check 自动带 marks
//
// 备注：键用 profile/pkg 而非仅 pkg，跨 profile 区分；但目前 UI 用全局标记更简单。
//      设计上保留 profile 维度以便后续区分。
'use strict';

import fs from 'node:fs';
import path from 'node:path';

const MARKS_FILE = 'plugin-marks.json';

function marksPath(dataDir) {
  return path.join(dataDir, MARKS_FILE);
}

function readMarks(dataDir) {
  const p = marksPath(dataDir);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeMarks(dataDir, marks) {
  const p = marksPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(marks, null, 2), 'utf8');
}

function keyOf(profile, pkg) {
  return `${profile}/${pkg}`;
}

// 查询：某 profile 下某插件是否被标记魔改
function isMarkedModified(dataDir, profile, pkg) {
  const marks = readMarks(dataDir);
  return !!marks[keyOf(profile, pkg)];
}

// 设置标记
// value: true=魔改；false=还原（删除标记）
// opts: { note?: string, at?: ISO } 备注/时间戳（可选，存到 entry 里）
function setMark(dataDir, profile, pkg, value, opts = {}) {
  const marks = readMarks(dataDir);
  const k = keyOf(profile, pkg);
  if (value) {
    marks[k] = { modified: true, at: opts.at || new Date().toISOString(), note: opts.note || null };
  } else {
    delete marks[k];
  }
  writeMarks(dataDir, marks);
  return marks[k] || null;
}

// 列出某 profile 下的所有 marks（用于 listPlugins 给每项加 isModified）
function listMarksForProfile(dataDir, profile) {
  const marks = readMarks(dataDir);
  const result = {};
  for (const [k, v] of Object.entries(marks)) {
    const idx = k.indexOf('/');
    if (idx < 0) continue;
    const p = k.slice(0, idx);
    const pkg = k.slice(idx + 1);
    if (p === profile && v.modified) result[pkg] = v;
  }
  return result;
}

export { readMarks, writeMarks, isMarkedModified, setMark, listMarksForProfile, marksPath };