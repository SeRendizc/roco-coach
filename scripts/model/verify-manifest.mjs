#!/usr/bin/env node
// 本地模型 manifest 的校验器（Mac 部署的可复现那一半）。
//
// 它回答一个问题：**本机这一份权重，和 manifest 里登记的是不是同一个东西。**
// 没有它，「我们部署的是 Qwen3.5-4B-4bit」就只是一句话，换台机器、换次下载
// 就可能悄悄变成别的权重或另一个量化档。
//
// 用法::
//
//     node scripts/model/verify-manifest.mjs            # 校验
//     node scripts/model/verify-manifest.mjs --write    # 重算 sha256 并写回（只在确认换版时用）
//     node scripts/model/verify-manifest.mjs --json      # 机器可读输出
//
// 不联网：许可证与 revision 的来源在 manifest 里写明（抓取时间 + API 字段），
// 要更新它们必须显式改文件，不允许运行期静默漂移。

import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, statSync, existsSync, readdirSync, createReadStream} from 'node:fs';
import {dirname, join, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const MANIFEST = join(ROOT, 'models', 'registry.json');

export function loadManifest(path = MANIFEST) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * 流式计算 SHA256。
 *
 * **不能用 `readFileSync`**：4B 的 safetensors 是 3.03 GB，超过 Node 的
 * 2 GiB buffer 上限，会抛 `ERR_FS_FILE_TOO_LARGE`。这个错误只在**真的**
 * 校验大权重时才出现——小文件测试永远发现不了。
 */
export function sha256File(path) {
  const hash = createHash('sha256');
  const stream = createReadStream(path, {highWaterMark: 1 << 22});
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 校验一个模型条目；返回 `{model_id, ok, problems, checked}`。 */
export async function verifyModel(entry, {root = ROOT} = {}) {
  const problems = [];
  const dir = isAbsolute(entry.local_dir) ? entry.local_dir : join(root, entry.local_dir);
  if (!existsSync(dir)) {
    return {model_id: entry.model_id, ok: false, dir,
      problems: [`权重目录不存在：${entry.local_dir}（先跑 scripts/model/setup-mac.sh）`], checked: 0};
  }
  let checked = 0;
  for (const [name, expected] of Object.entries(entry.files || {})) {
    const path = join(dir, name);
    if (!existsSync(path)) { problems.push(`缺少文件：${name}`); continue; }
    const bytes = statSync(path).size;
    if (bytes !== expected.bytes) {
      problems.push(`${name} 大小不符：manifest ${expected.bytes}，实际 ${bytes}`);
      continue;
    }
    const digest = await sha256File(path);
    if (digest !== expected.sha256) {
      problems.push(`${name} SHA256 不符：manifest ${expected.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…`);
      continue;
    }
    checked += 1;
  }
  // 目录里多出来的权重文件也要说一声：多一个 shard 通常意味着换了更大的模型。
  const onDisk = readdirSync(dir).filter((name) => name.endsWith('.safetensors'));
  const declared = Object.keys(entry.files || {}).filter((name) => name.endsWith('.safetensors'));
  for (const name of onDisk) if (!declared.includes(name)) {
    problems.push(`目录里有 manifest 未登记的分片：${name}`);
  }
  for (const field of ['model_id', 'revision', 'license', 'source', 'quantization']) {
    if (!entry[field]) problems.push(`manifest 缺少字段 ${field}`);
  }
  return {model_id: entry.model_id, ok: problems.length === 0, dir, problems, checked,
    files: Object.keys(entry.files || {}).length};
}

/** 重算某个模型条目的 files 段（换版时用，不自动跑）。 */
export async function recomputeModel(entry, {root = ROOT} = {}) {
  const dir = isAbsolute(entry.local_dir) ? entry.local_dir : join(root, entry.local_dir);
  const files = {};
  let total = 0;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const bytes = statSync(path).size;
    files[name] = {sha256: await sha256File(path), bytes};
    total += bytes;
  }
  return {...entry, files, download_bytes: total};
}

async function main(argv) {
  const write = argv.includes('--write');
  const asJson = argv.includes('--json');
  const manifest = loadManifest();
  let entries = manifest.models || [];
  if (write) {
    entries = [];
    for (const entry of manifest.models || []) entries.push(await recomputeModel(entry));
    const next = {...manifest, models: entries,
      generated_by: 'scripts/model/verify-manifest.mjs --write（第 14 轮本地部署实测）'};
    writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`);
  }
  const results = [];
  for (const entry of entries) results.push(await verifyModel(entry));
  const ok = results.every((row) => row.ok);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ok, results, manifest: MANIFEST}, null, 1)}\n`);
  } else {
    for (const row of results) {
      process.stdout.write(`${row.ok ? '✔' : '✖'} ${row.model_id} — 校验 ${row.checked}/${row.files} 个文件`
        + (row.problems.length ? `\n   ${row.problems.join('\n   ')}` : '') + '\n');
    }
    process.stdout.write(ok ? 'manifest 校验通过\n' : 'manifest 校验失败\n');
  }
  return ok ? 0 : 1;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) main(process.argv.slice(2)).then((code) => process.exit(code));
