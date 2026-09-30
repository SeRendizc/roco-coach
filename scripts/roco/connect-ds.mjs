#!/usr/bin/env node
// 一条命令：连上当前 8765 + 把密钥写进本地文件（以后重启自动带上）。
//
//   node scripts/roco/connect-ds.mjs
//
// 它做三件事，**全程不回显、不写日志、不提交任何地方**：
//   ① 提示你粘贴 DeepSeek 密钥（**不回显** —— 粘的时候屏幕上什么都不出，这是正常的）
//   ② 用页面同一条加密通道把密钥交给**当前正在跑的** 8765（RSA-OAEP/SHA-256 + nonce）
//   ③ 把密钥写进 ~/.roco-ds-key（权限 600，仓库外）⇒ 以后用 serve-with-ds-key.sh 起就自动带上
import {createInterface} from 'node:readline';
import {publicEncrypt, createPublicKey, constants} from 'node:crypto';
import {writeFileSync, chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const BASE = process.env.ROCO_BASE || 'http://127.0.0.1:8765';
const KEY_FILE = process.env.ROCO_DS_KEY_FILE || join(homedir(), '.roco-ds-key');
const MODEL = process.env.ROCO_DS_MODEL || 'deepseek-flash';

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({input: process.stdin, output: process.stdout, terminal: true});
    // 标准技巧：把回显吞掉（**密钥不进屏幕、不进滚动缓冲**）
    rl._writeToOutput = function (s) { if (s.includes(prompt)) process.stdout.write(prompt); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(String(answer || '').trim()); });
  });
}

const key = await askHidden('粘贴 DeepSeek 密钥（不回显），回车：');
if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) {
  console.error(`✗ 格式不对：应以 sk- 开头、后面至少 16 位 [A-Za-z0-9_-]（你这次长度 ${key.length}，前缀 "${key.slice(0, 3)}"）`);
  process.exit(2);
}

// ② 交给当前服务（与 /connect.html 同一条通道）
let ok = false, why = '';
try {
  const bRes = await fetch(`${BASE}/api/bootstrap`);
  const boot = await bRes.json();
  const cookie = bRes.headers.get('set-cookie') || '';
  if (!boot?.publicKey || !boot?.nonce) throw new Error('这一版服务没给 publicKey/nonce（是不是旧进程？）');
  // ⚠ 服务端给的是**裸 base64 的 DER/SPKI**（`index.js:502`：`export({type:'spki',format:'der'}).toString('base64')`）
  //   ⇒ **没有 PEM 头** ⇒ 直接喂给 `publicEncrypt` 会报 `DECODER routines::unsupported` ✗（我第一版就踩了）
  //   ⇒ 要么补 PEM 头、要么走 `createPublicKey({format:'der',type:'spki'})`（后者更干净 ✓）
  const keyObj = createPublicKey({key: Buffer.from(boot.publicKey, 'base64'), format: 'der', type: 'spki'});
  const encrypted = publicEncrypt(
    {key: keyObj, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256'},
    Buffer.from(JSON.stringify({key, nonce: boot.nonce}), 'utf8'));
  const r = await fetch(`${BASE}/api/connect`, {
    method: 'POST',
    headers: {Origin: BASE, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf},
    body: JSON.stringify({encryptedKey: encrypted.toString('base64'), model: MODEL}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  ok = true;
} catch (e) { why = String(e?.message || e).slice(0, 120); }

// ③ 写文件（**只在第一步格式通过之后**；权限 600）
let wrote = false;
try { writeFileSync(KEY_FILE, key, {mode: 0o600}); chmodSync(KEY_FILE, 0o600); wrote = true; } catch (e) { why += ' | 写文件失败：' + String(e?.message || e).slice(0, 60); }

console.log(ok ? `✓ 已连上当前服务（${BASE}，模型 ${MODEL}）` : `✗ 交给当前服务失败：${why}`);
console.log(wrote ? `✓ 已写入 ${KEY_FILE}（600）⇒ 以后用 scripts/roco/serve-with-ds-key.sh 启动会自动带上` : `✗ 写文件失败`);
console.log('（密钥没有回显、没有写日志、没有提交到任何地方）');
process.exit(ok && wrote ? 0 : 1);
