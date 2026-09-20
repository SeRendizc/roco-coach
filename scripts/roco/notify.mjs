#!/usr/bin/env node
// 阶段汇报推送（PushPlus）。
//
// 用途：把「大阶段完成」的进度推到用户微信。用户在睡觉，要求任何需要工作区外权限、
// 或阶段完成/即将停止时都要推送。
//
// 安全：token 只从环境变量或本机未入库文件读取，**不写入仓库、不写入日志**。
//   用法：PUSHPLUS_TOKEN=xxx node scripts/roco/notify.mjs --title "..." --file <md|html>
//   或    node scripts/roco/notify.mjs --title "..." --content "..."
//
// 边界：本脚本只做一次 HTTPS POST；失败不阻塞主流程（退出码仍为 0，但会打印错误）。

import { readFileSync, existsSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const TOKEN_FILE = '.dsh-pushplus-token'; // 用户可放本机文件；已在 .gitignore 中忽略
let token = process.env.PUSHPLUS_TOKEN ?? null;
if (!token && existsSync(TOKEN_FILE)) token = readFileSync(TOKEN_FILE, 'utf8').trim();

if (!token) {
  console.error('[notify] 未找到 PUSHPLUS_TOKEN，跳过推送（不视为失败）');
  process.exit(0);
}

const title = arg('title', '小芽 M0/M1 进度');
let content = arg('content', '');
const file = arg('file');
if (file && existsSync(file)) content = readFileSync(file, 'utf8');
if (!content) {
  console.error('[notify] 没有内容可推送');
  process.exit(0);
}

const payload = {
  token,
  title,
  content,
  template: arg('template', 'html'),
};

try {
  const res = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log(`[notify] pushplus http=${res.status} body=${text}`);
  // 只记录「推送发生过」，不记录 token
  appendFileSync('reports/roco/notify-log.jsonl', JSON.stringify({
    at: new Date().toISOString(), title, http: res.status, body: text,
  }) + '\n');
} catch (err) {
  console.error(`[notify] 推送失败（不阻塞主流程）: ${err.message}`);
}
