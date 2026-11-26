#!/usr/bin/env node
/**
 * AIASK 字号升级脚本
 *
 * 做两件事：
 *   1. 删除 globals.css 里从 fonts.googleapis.com 加载 Inter 的 @import
 *      （字体改由 layout.tsx 里的 next/font 自托管）
 *   2. 把过小的字号替换成 theme.css 里的设计令牌：
 *        ≤ 12px  →  var(--text-xs)   （12px，全站最小字号）
 *        13px    →  var(--text-sm)   （14px）
 *        ≥ 14px  →  不改动
 *      同时处理 font 简写（如 `font: 650 11px var(--sans)`）
 *      和 clamp() 的最小值（如 `clamp(9px, 2.4vw, 12px)` → `clamp(12px, …)`）
 *
 * 用法（在项目根目录 aiask/ 下运行）：
 *   node scripts/upgrade-typography.mjs           只预览，不改文件
 *   node scripts/upgrade-typography.mjs --write   真正写入
 *
 * 建议先用 git 提交一次当前代码，改完后用 git diff 检查。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src", "app");
const WRITE = process.argv.includes("--write");
const SKIP = new Set(["theme.css"]); // theme.css 已经使用令牌

const GOOGLE_FONTS_IMPORT = /@import\s+url\(\s*['"]?https:\/\/fonts\.googleapis\.com\/[^)]*\)\s*;?\s*/g;

function tokenFor(px) {
  if (px <= 12) return "var(--text-xs)";
  if (px < 14) return "var(--text-sm)";
  return null;
}

function listCss(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listCss(path);
    return name.endsWith(".css") && !SKIP.has(name) ? [path] : [];
  });
}

function upgrade(css) {
  const stats = { importRemoved: 0, fontSize: 0, shorthand: 0, clamp: 0, kept: 0 };

  // 1) Google Fonts @import
  let out = css.replace(GOOGLE_FONTS_IMPORT, () => { stats.importRemoved += 1; return ""; });

  // 2a) clamp() 的最小值：clamp(9px, …) → clamp(12px, …)
  out = out.replace(/clamp\(\s*([0-9.]+)px\s*,/g, (match, value) => {
    const px = Number(value);
    if (px >= 12) return match;
    stats.clamp += 1;
    return "clamp(12px,";
  });

  // 2b) font-size: 10px（保留 !important）
  out = out.replace(/font-size\s*:\s*([0-9.]+)px(\s*!important)?/g, (match, value, important = "") => {
    const token = tokenFor(Number(value));
    if (!token) { stats.kept += 1; return match; }
    stats.fontSize += 1;
    return `font-size:${token}${important}`;
  });

  // 2c) font 简写：font: [style] [weight] 11px[/1.4] family
  out = out.replace(/(font\s*:\s*(?:(?:italic|normal|oblique)\s+)?(?:\d{3}\s+)?)([0-9.]+)px/g, (match, prefix, value) => {
    const token = tokenFor(Number(value));
    if (!token) return match;
    stats.shorthand += 1;
    return `${prefix}${token}`;
  });

  return { out, stats };
}

const files = listCss(SRC);
const totals = { importRemoved: 0, fontSize: 0, shorthand: 0, clamp: 0, kept: 0 };
let changedFiles = 0;

console.log(WRITE ? "写入模式：会修改文件\n" : "预览模式：不会修改文件（加 --write 才会写入）\n");

for (const file of files) {
  const before = readFileSync(file, "utf8");
  const { out, stats } = upgrade(before);
  for (const key of Object.keys(totals)) totals[key] += stats[key];
  const changed = out !== before;
  if (changed) changedFiles += 1;
  const parts = [
    stats.importRemoved && `删除 Google Fonts @import ×${stats.importRemoved}`,
    stats.fontSize && `font-size ×${stats.fontSize}`,
    stats.shorthand && `font 简写 ×${stats.shorthand}`,
    stats.clamp && `clamp 最小值 ×${stats.clamp}`,
  ].filter(Boolean);
  console.log(`${changed ? "✎" : "·"} ${relative(ROOT, file)}${parts.length ? "  " + parts.join("，") : "  无需修改"}`);
  if (changed && WRITE) writeFileSync(file, out, "utf8");
}

console.log(`
合计：${changedFiles} 个文件需要修改
  删除 Google Fonts @import：${totals.importRemoved}
  替换 font-size：${totals.fontSize}
  替换 font 简写：${totals.shorthand}
  提高 clamp 最小值：${totals.clamp}
  ≥ 14px 保持不变：${totals.kept}
${WRITE ? "\n已写入。运行 npm run dev 检查页面，用 git diff 查看改动。" : "\n确认无误后运行：node scripts/upgrade-typography.mjs --write"}`);
