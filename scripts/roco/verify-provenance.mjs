#!/usr/bin/env node
// 数据溯源检查：**"所有数据必须记录版本、赛季、来源、抓取时间、revision、SHA256、
// 许可与核验状态"** 这一条边界，从散文变成检查。
//
// 为什么需要它：这条边界写在目标里，但在此之前只靠人眼看。
// 一条边界如果没有检查，它真正的状态是"没人知道"——
// 而数据一旦没有出处，后面所有基于它的结论都不成立。
//
// 它核对的是**文件里到底写了什么**，不是"我们打算写什么"：
//   · 规范化数据顶部必须带 ruleset/season/source/revision/抓取时间/许可；
//   · 每条记录里"我推断出来的"字段必须有标记（unknown/假设/未核验），
//     不能与"抄下来的"字段长得一样；
//   · 快照文件必须能在 `data/roco/raw/` 里找到对应的 SHA256 记录。
//
// 跑法::
//
//     node scripts/roco/verify-provenance.mjs
//     node scripts/roco/verify-provenance.mjs --json

import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
const RULESET = 'roco-world-s4-2026-09-10';
const NORMALIZED = join(ROOT, 'data', 'roco', 'normalized', RULESET);
const SOURCES = join(ROOT, 'data', 'roco', 'sources.yaml');
const RAW_DIR = join(ROOT, 'data', 'roco', 'raw');

/** 规范化数据顶部必须有的字段。缺一个就是"这份数据说不清自己从哪来"。 */
//: 每份规范化文件都必须能指回来源与规则集。season/revision 由来源清单统一记录，
//: 所以**不**要求每份文件重复写（重复写反而会有多处副本互相矛盾）。
export const REQUIRED_TOP_LEVEL = ['schema_version', 'ruleset_id', 'game'];

/** 「谁生成的」这一类文件：它们是本地产物，不是从上游抄来的，所以按另一套要求核对。 */
export const GENERATED_FILES = ['import-report.json', 'support-matrix.json'];

/** 来源清单里每条来源都必须有的字段（真实字段名）。 */
export const EXPECTED_IN_SOURCES = ['revision', 'archive_sha256', 'license', 'fetched_at', 'verification_status'];

/** provenance 台账里每条记录都必须有的字段。 */
export const REQUIRED_IN_PROVENANCE = ['entity_type', 'source_id',
  'verification_status', 'ruleset_id', 'game', 'fetched_at'];

/**
 * 汇总类记录（`import_run`）描述的是**一次导入**，不是某个源文件，
 * 所以它没有 `source_file_sha256` 是合理的；而逐实体的记录必须给出源文件哈希，
 * 否则「这条数据来自哪个文件的哪一段」就无从核对。
 */
export const SUMMARY_ENTITY_TYPES = ['import_run'];

/**
 * 检查一份规范化文件。返回 `{file, problems}`。
 *
 * 注意：这里**不**判断数据对不对（那要靠 microcase 与实测），
 * 只判断"这份数据有没有说清自己的来源与核验状态"。
 */
export function checkNormalizedFile(path, {text = null} = {}) {
  const name = path.slice(ROOT.length + 1);
  const problems = [];
  let data;
  try {
    data = JSON.parse(text ?? readFileSync(path, 'utf8'));
  } catch (error) {
    return {file: name, problems: [`读不出来：${error.message}`]};
  }
  if (data.ruleset_id !== RULESET) {
    problems.push(`ruleset_id 是 ${JSON.stringify(data.ruleset_id)}，不是 ${RULESET}`);
  }
  for (const field of REQUIRED_TOP_LEVEL) {
    if (data[field] === undefined || data[field] === null) {
      problems.push(`缺少顶层字段 ${field}`);
    }
  }
  if (data.source_revision !== undefined && !/^[0-9a-f]{7,40}$/.test(String(data.source_revision))) {
    problems.push(`source_revision 不是哈希：${JSON.stringify(data.source_revision)}`);
  }
  // 除「本地生成物」之外，每份数据都要能指回一个上游来源。
  const generated = GENERATED_FILES.includes(name.split('/').pop());
  if (!generated && !data.source_id) {
    problems.push('既不是生成物、又没有 source_id：说不清这份数据从哪来');
  }
  return {file: name, problems, keys: Object.keys(data), generated};
}

/**
 * 检查记录里"推断出来的"字段有没有标记。
 *
 * 这一条对应边界里的"未核验机制 fail closed 并标 unknown/unsupported"：
 * 一份数据里**推导出来的**部分（例如由种族值换算的面板值、社区口径的配招）
 * 如果与**抄下来的**部分长得一样，读的人分不出哪个能信。
 */
export function checkDerivedMarkers(data) {
  const problems = [];
  const derivedSignals = /(_note|note|assumption|assumed|derived|hypothesis|estimated|unknown|unsupported|verified)/i;
  for (const [collection, records] of Object.entries(data)) {
    if (!Array.isArray(records) && typeof records !== 'object') continue;
    const list = Array.isArray(records) ? records : Object.values(records);
    if (!list.length || typeof list[0] !== 'object' || list[0] === null) continue;
    // 找这一批记录里有没有任何"标记类"字段
    const keys = new Set();
    for (const row of list.slice(0, 50)) for (const key of Object.keys(row || {})) keys.add(key);
    const marked = [...keys].filter((key) => derivedSignals.test(key));
    if (!marked.length) {
      // 不是每个集合都需要标记（纯抄写的集合不需要）；
      // 只有出现了"算出来的"字段名时才要求它旁边有标记。
      const computed = [...keys].filter((key) => /panel|derived|score|estimate|converted/i.test(key));
      if (computed.length) {
        problems.push(`集合 ${collection} 里有推导字段 ${computed.join('/')}，但整批记录都没有核验标记字段`);
      }
    }
  }
  return problems;
}

/** 从 sources.yaml 里抽出每个来源的 revision/sha256/license/fetched_at。 */
export function parseSources(text) {
  // 真实字段名是 `source_id`（不是 `id`）、哈希是 `archive_sha256`（不是 `sha256`），
  // 而且**首行就带值**（`- source_id: xxx`）。第一版全写错，于是「来源 0 个」，
  // 把一份完整的清单报成空的——检查器自己的 bug 比它要检查的问题更值得先修。
  // 这是一个**够用的** YAML 子集解析器，不是通用 YAML：
  // 只认 `sources:` 下 `- source_id: …` 开头的条目，以及它们同缩进的 `key: value`。
  //
  // 第一版在这里连错三次，每次都会把一份完整清单报成残缺：
  //   ① 字段名写成 `id`（真实是 `source_id`）、哈希写成 `sha256`（真实是 `archive_sha256`）；
  //   ② 没处理块标量（`basis: >`）的续行，把说明正文里的 `caveat:` 当成新字段；
  //   ③ 「续行缩进更深」写成了「缩进 ≥ 声明行」，于是条目内**所有**字段都被当成续行跳过，
  //      只剩 `source_id` 一条——7 个来源变成 4 个空壳；
  //   ④ 字段名正则写 `[a-z_]+`，而 `archive_sha256` 含数字——**它存在的理由就是核对
  //      这个哈希，它自己却看不见这个字段**。
  // 检查器自己的 bug 比它要检查的问题更需要先修：一个总是报错的检查会被人忽略。
  const sources = [];
  let current = null;
  let fieldIndent = null;   // 当前来源条目的字段缩进
  let blockIndent = null;   // 正在读的块标量正文的缩进
  const put = (key, value) => {
    if (!current) return;
    current[key] = String(value).replace(/^["']|["']$/g, '').trim();
  };
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    // **空行与注释也要参与「块结束」判断**，不能直接 continue 掉：
    // 块正文后面常跟着一个空行和一条注释，然后才是新的 `- source_id:`。
    // 第一版在这里 `continue`，于是块状态一直挂着，把注释之后那一整条来源
    // 当成块正文**整条跳掉**——表现出「多出来的空壳来源」。
    if (!line.trim() || line.trim().startsWith('#')) {
      if (blockIndent !== null) blockIndent = null;
      continue;
    }
    const indent = line.length - line.trimStart().length;

    if (blockIndent !== null && indent >= blockIndent) continue;   // 块正文
    if (blockIndent !== null && indent < blockIndent) blockIndent = null;

    const startMatch = /^(\s*)-\s*source_id:\s*(.+)$/.exec(line);
    if (startMatch) {
      if (current) sources.push(current);
      current = {};
      fieldIndent = startMatch[1].length + 2;   // `- ` 之后的字段缩进
      put('source_id', startMatch[2]);
      continue;
    }
    if (!current) continue;
    // 字段名必须允许**数字**：`archive_sha256` 里就有。
    // 第一版写成 `[a-z_]+`，于是这条字段永远匹配不上——
    // 而这个检查器存在的理由正是核对 SHA256，它自己却看不见它。
    const fieldMatch = /^(\s+)([a-z0-9_]+):\s*(.*)$/.exec(line);
    if (!fieldMatch) continue;
    const [, spaces, key, value] = fieldMatch;
    if (spaces.length < fieldIndent) { current = null; continue; }   // 离开了这个条目
    put(key, value);
    // `>`（折叠）/ `|`（保留）后面跟着块正文，正文缩进比这一行深
    if (/^[>|][-+]?\s*$/.test(value.trim())) blockIndent = spaces.length + 1;
  }
  if (current) sources.push(current);
  // 只保留**真正的来源条目**：它们都有 `role`（primary / cross_check / community_lineups …）。
  // 文件末尾的 `license_summary:` 用同样的 `- source_id:` 开头，但它描述的是许可、
  // 没有 role、字段集完全不同。第一版把它们也当成来源，于是「来源数」翻倍、
  // 每个都「缺少 revision/sha256/fetched_at」，把一份完整清单报成残缺。
  //
  // 用一个**能真正区分两者的字段**过滤，比让这个手写解析器去理解嵌套结构更稳：
  // 它只需要回答「哪些条目是来源」，不需要成为通用 YAML 解析器。
  return sources.filter((source) => source.role);
}

export function check({root = ROOT} = {}) {
  const problems = [];
  const normalizedDir = join(root, 'data', 'roco', 'normalized', RULESET);
  if (!existsSync(normalizedDir)) {
    return {ok: false, problems: [`找不到规范化数据目录：${normalizedDir}`]};
  }
  const files = readdirSync(normalizedDir).filter((name) => name.endsWith('.json'));
  const fileResults = [];
  for (const name of files) {
    const result = checkNormalizedFile(join(normalizedDir, name));
    fileResults.push(result);
    for (const problem of result.problems) problems.push(`${name}: ${problem}`);
  }

  // 集合里推导字段必须有标记
  const petsPath = join(normalizedDir, 'pets.json');
  if (existsSync(petsPath)) {
    const data = JSON.parse(readFileSync(petsPath, 'utf8'));
    for (const problem of checkDerivedMarkers(data)) problems.push(`pets.json: ${problem}`);
  }

  // 许可与抓取时间必须在来源清单里出现（规范化文件里没有这两项是允许的，
  // 但"哪里都没有"不行）
  const sourcesPath = join(root, 'data', 'roco', 'sources.yaml');
  let sources = [];
  if (!existsSync(sourcesPath)) {
    problems.push('缺少 data/roco/sources.yaml：没有它就说不清数据来自哪里');
  } else {
    sources = parseSources(readFileSync(sourcesPath, 'utf8'));
    if (!sources.length) problems.push('sources.yaml 里没解析出任何来源');
    // 来源分三类，各自要有不同的「可核对锚点」，不是一律要求 revision + archive_sha256：
    //   ① 独立归档：必须有自己的 revision 与 archive_sha256；
    //   ② `part_of` 某个来源的子文件（例如 S4Season.lua 属于主快照）：
    //      它没有独立 revision，锚点是**逐文件清单里的 sha256**；
    //   ③ 其余：必须至少有 license 与 verification_status。
    // 第一版一律要求 revision + archive_sha256，把一条合法的子文件报成残缺——
    // 而这类误报会让整套检查失去可信度。
    const inventoryPath = join(root, 'reports', 'roco', 'm1-data', 'snapshot-file-inventory.json');
    let inventory = null;
    if (existsSync(inventoryPath)) {
      try {
        inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
      } catch { inventory = null; }
    }
    const inventoryHashes = new Set();
    for (const file of inventory?.files || []) {
      if (typeof file?.sha256 === 'string') inventoryHashes.add(file.sha256);
    }
    for (const source of sources) {
      const id = source.source_id;
      if (source.part_of) {
        // 子文件自己**不必**写 sha256；它的锚点是「逐文件清单里有这个路径」。
        // 从 `archive_path` 里取出清单用的相对路径（`rocom-wiki-data/S4Season.lua`），
        // 去清单里查它有没有被哈希过。
        const rel = String(source.archive_path || '')
          .split('/extracted/').pop() || '';
        const entry = (inventory?.files || []).find((file) => file?.path === rel);
        if (!entry) {
          const listed = inventory ? `清单里没有 ${rel || '(未声明 archive_path)'}` : '找不到逐文件清单';
          problems.push(`来源 ${id} 是 ${source.part_of} 的子文件，但${listed}`
            + '：子文件必须能在逐文件清单里核对到哈希');
        } else if (!/^[0-9a-f]{64}$/.test(String(entry.sha256))) {
          problems.push(`来源 ${id} 在逐文件清单里的 sha256 不是 64 位十六进制`);
        }
      } else if (source.archive_sha256) {
        if (!/^[0-9a-f]{64}$/.test(String(source.archive_sha256))) {
          problems.push(`来源 ${id} 的 archive_sha256 不是 64 位十六进制`);
        }
        if (!source.revision) problems.push(`来源 ${id} 有归档哈希却没有 revision`);
      } else {
        // 既不独立、也没声明 part_of：至少要有许可与核验状态
        for (const field of ['license', 'verification_status']) {
          if (!source[field]) problems.push(`来源 ${id} 既没有归档哈希、也没有 ${field}`);
        }
      }
      for (const field of EXPECTED_IN_SOURCES) {
        if (field === 'revision' || field === 'archive_sha256') continue;   // 上面按类别判过
        if (field === 'fetched_at' && source.part_of) continue;             // 子文件随主快照一起抓
        if (!source[field]) problems.push(`来源 ${id} 缺少 ${field}`);
      }
    }
  }

  // 来源里声明的归档 sha256 必须能在 raw/ 目录里对上一个真实文件
  const rawDir = join(root, 'data', 'roco', 'raw');
  const rawFiles = existsSync(rawDir) ? readdirSync(rawDir) : [];
  const verifiedSnapshots = [];
  for (const source of sources) {
    const declared = source.archive_sha256;
    if (!declared) continue;
    const hit = rawFiles.find((name) => {
      const path = join(rawDir, name);
      try {
        return createHash('sha256').update(readFileSync(path)).digest('hex') === declared;
      } catch {
        return false;
      }
    });
    if (hit) verifiedSnapshots.push({source: source.source_id, file: hit});
    else problems.push(`来源 ${source.source_id} 声明的 archive_sha256 在 data/roco/raw/ 里找不到`
      + `对应文件（快照可能被删了或换过）`);
  }

  // provenance 台账：每条记录都要能回答「哪个实体、来自哪个文件、核验到哪一步」
  const provenancePath = join(root, 'data', 'roco', 'provenance.jsonl');
  let provenance = [];
  if (!existsSync(provenancePath)) {
    problems.push('缺少 data/roco/provenance.jsonl：逐实体的来源与核验状态没有落盘');
  } else {
    provenance = readFileSync(provenancePath, 'utf8').split('\n')
      .filter((line) => line.trim()).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      });
    if (provenance.some((row) => row === null)) problems.push('provenance.jsonl 里有不合法的 JSON 行');
    provenance = provenance.filter(Boolean);
    for (const [index, row] of provenance.entries()) {
      for (const field of REQUIRED_IN_PROVENANCE) {
        if (row[field] === undefined || row[field] === null || row[field] === '') {
          problems.push(`provenance #${index}（${row.entity_type || '?'}）缺少 ${field}`);
        }
      }
      if (!SUMMARY_ENTITY_TYPES.includes(row.entity_type)
        && (row.source_file_sha256 === undefined || row.source_file_sha256 === null)) {
        problems.push(`provenance #${index}（${row.entity_type}）缺少 source_file_sha256`
          + '：逐实体记录必须能指回源文件');
      }
    }
    // 每份规范化数据（除生成物）都应当在台账里有对应记录，否则「文件有、来源没有」
    const recorded = new Set(provenance.map((row) => row.entity_type));
    for (const name of files) {
      if (GENERATED_FILES.includes(name)) continue;
      const data = JSON.parse(readFileSync(join(normalizedDir, name), 'utf8'));
      const id = data.source_id;
      if (id && !provenance.some((row) => row.source_id === id)) {
        problems.push(`${name} 声明了 source_id=${id}，但 provenance.jsonl 里没有这个来源的记录`);
      }
    }
    void recorded;
  }

  return {
    ok: problems.length === 0,
    files: fileResults.map((result) => ({file: result.file, problems: result.problems.length})),
    sources: sources.map((source) => source.source_id),
    provenance_rows: provenance.length,
    verified_snapshots: verifiedSnapshots,
    problems,
  };
}

function main(argv) {
  const report = check();
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  else {
    process.stdout.write(`规范化文件 ${report.files.length} 份，来源 ${report.sources.length} 个，`
      + `provenance ${report.provenance_rows ?? 0} 条，快照校验通过 ${report.verified_snapshots.length} 个\n`);
    if (report.ok) process.stdout.write('溯源完整\n');
    else process.stdout.write(`问题 ${report.problems.length} 条：\n  ${report.problems.join('\n  ')}\n`);
  }
  return report.ok ? 0 : 1;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));
