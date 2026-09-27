// RC-205 RAG 多库划分：库注册表的唯一真源是 `data/roco/rag/libs.json`，这个文件只读它。
//
// 为什么要有这一层（人类口径：「我觉得是不是可以有多个 RAG 库，这样 debug 也能 debug」）
// ------------------------------------------------------------------------------
// 单库的三个具体坏处，每一条都能被证伪：
//   ① 没法单独 debug：1698 篇文档混在一起，一条查询错了分不清是图鉴语料的问题、
//      台账的问题、还是冲突库的问题；
//   ② 没法单独重建：改一条台账要重建整个索引（含 1446 篇 pack 实体）；
//   ③ 更坏的是**统计量互相污染**：BM25 的 idf / 平均长度是全库算的。删掉 owned 库，
//      图鉴库的分数会跟着变 —— 于是「删一个库」这件事本身会改变其它库的答案。
//      所以「每库一个索引实例」不是优化，是**判据能成立的前提**。
//
// 三条 fail-closed（判据就是这个）：
//   ① 未知 lib_id ⇒ 抛；② 声明的输入路径不存在 ⇒ 抛；
//   ③ status='ready' 却一篇文档都没有（或声明的 record_kind 一篇都没有）⇒ 抛。
// 绝不允许把「库没接上」静默降级成「检索没结果」——那会让空的库看起来像正常的库。
//
// 与 rag-index.js 一样，这个模块**只在 Node 侧**使用（静态 import node:fs/path）。
// 浏览器模块图里的 toolbox.js 不许静态 import 它，只能按需 dynamic import。

import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve as resolvePath} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根：本文件在 src/coach/ 下。 */
export const REPO_ROOT = resolvePath(HERE, '..', '..');

/** 库注册表的相对路径（相对仓库根）。 */
export const LIBS_PATH = 'data/roco/rag/libs.json';

export const LIBS_SCHEMA = 'roco-rag-libs/v1';

/** 每条库必须写全的字段。少一个就抛，不许「缺省当成空」。 */
export const REQUIRED_LIB_FIELDS = Object.freeze([
  'lib_id', 'label', 'scope', 'source_of_truth', 'inputs', 'record_kinds', 'status', 'update_mode',
]);

/** 已知状态：ready = 有真源、必须非空；pending = 规划中、**尚无 inputs**。 */
export const LIB_STATUSES = Object.freeze(['ready', 'pending']);

/** 已知 scope：rule = 规则语料；player = 玩家个体数据（规则检索默认排除）。 */
export const LIB_SCOPES = Object.freeze(['rule', 'player']);

const fail = (message) => {
  throw new Error(`rag-libs: ${message}`);
};

/**
 * 读注册表并做**结构**校验（不碰磁盘上的 inputs —— 那是 assertLib 的事）。
 * @returns {{schema: string, note: string, path: string, libs: object[], by_id: Record<string, object>}}
 */
export function loadLibs({root = REPO_ROOT} = {}) {
  const path = join(root, LIBS_PATH);
  if (!existsSync(path)) fail(`库注册表不存在：${LIBS_PATH}（缺了它就无法判断有哪些库）`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${LIBS_PATH} 不是合法 JSON：${String(error.message || error).slice(0, 120)}`);
  }
  const libs = raw.libs;
  if (!Array.isArray(libs) || libs.length === 0) fail(`${LIBS_PATH} 的 libs 必须是非空数组`);
  const byId = {};
  for (const lib of libs) {
    if (!lib || typeof lib !== 'object' || Array.isArray(lib)) fail(`${LIBS_PATH} 的 libs 里每一项都必须是对象`);
    for (const field of REQUIRED_LIB_FIELDS) {
      if (lib[field] === undefined || lib[field] === null) fail(`库 ${lib.lib_id ?? '(无 lib_id)'} 缺字段 ${field}`);
    }
    if (typeof lib.lib_id !== 'string' || !lib.lib_id.trim()) fail('lib_id 必须是非空字符串');
    if (byId[lib.lib_id]) fail(`lib_id 重复：${lib.lib_id}`);
    if (!LIB_STATUSES.includes(lib.status)) fail(`库 ${lib.lib_id} 的 status=${lib.status} 不在 ${JSON.stringify(LIB_STATUSES)} 里`);
    if (!LIB_SCOPES.includes(lib.scope)) fail(`库 ${lib.lib_id} 的 scope=${lib.scope} 不在 ${JSON.stringify(LIB_SCOPES)} 里`);
    for (const field of ['source_of_truth', 'inputs', 'record_kinds']) {
      if (!Array.isArray(lib[field])) fail(`库 ${lib.lib_id} 的 ${field} 必须是数组`);
    }
    if (lib.record_kinds.length === 0) fail(`库 ${lib.lib_id} 的 record_kinds 是空的：这个库不可能装下任何文档`);
    if (lib.status === 'pending' && !String(lib.planned_source ?? '').trim()) {
      fail(`库 ${lib.lib_id} 是 pending，必须写 planned_source（说清下一轮的真源在哪）`);
    }
    if (lib.status === 'ready' && lib.inputs.length === 0) {
      fail(`库 ${lib.lib_id} 标成 ready 却没有任何 inputs：ready 的含义就是「有真源、必须有文档」`);
    }
    byId[lib.lib_id] = lib;
  }
  return {schema: raw.schema ?? null, note: raw.note ?? '', path: LIBS_PATH, libs, by_id: byId};
}

/**
 * 记录种类 → lib_id。**同一个 record_kind 不许属于两个库**：那会让「这篇文档算哪个库的」
 * 变成看遍历顺序，于是同一个输入两次运行可能给出不同的库归属。
 * pending 库声明的 record_kind 也登记进来（计划写清楚），今天没有文档用它。
 */
export function buildLibKindMap(libs) {
  const map = {};
  for (const lib of libs) {
    for (const kind of lib.record_kinds) {
      if (map[kind] && map[kind] !== lib.lib_id) {
        fail(`记录种类 ${kind} 同时属于 ${map[kind]} 与 ${lib.lib_id}：一篇文档只能属于一个库`);
      }
      map[kind] = lib.lib_id;
    }
  }
  return Object.freeze(map);
}

/** 默认注册表（仓库里那一份）的 记录种类 → lib_id。 */
export const LIB_BY_RECORD_KIND = buildLibKindMap(loadLibs().libs);

/** 默认注册表（仓库里那一份）的 lib_id → scope。 */
export const LIB_SCOPE = Object.freeze(Object.fromEntries(loadLibs().libs.map((lib) => [lib.lib_id, lib.scope])));

/** 按 lib_id 取库规格；找不到返回 null（要不要抛由调用方决定）。 */
export function findLib(libs, libId) {
  return libs.find((lib) => lib.lib_id === libId) ?? null;
}

/**
 * 校验一个库能不能用。`lib` 可以是 lib_id（走注册表解析）或库对象本身。
 *
 * 三条必须抛（T1 的判据就是「不许静默降级成空库」）：
 *   ① 未知 lib_id；
 *   ② 任何一个声明的 input 路径不存在；
 *   ③ status==='ready' 但传入的文档集为空（或声明的某个 record_kind 一篇都没有）。
 *
 * @param {string|object} lib
 * @param {object} [options]
 * @param {string} [options.root]       仓库根
 * @param {object[]|null} [options.documents] 该库实际建出来的文档（传了才判「空库」）
 * @param {object[]|null} [options.libs]      注册表（覆盖默认，反证与测试用）
 */
export function assertLib(lib, {root = REPO_ROOT, documents = null, libs = null} = {}) {
  const registry = libs ?? loadLibs({root}).libs;
  const spec = typeof lib === 'string' ? findLib(registry, lib) : lib;
  if (!spec) fail(`未知 lib_id：${String(lib)}（不在 ${LIBS_PATH} 里）`);
  for (const field of REQUIRED_LIB_FIELDS) {
    if (spec[field] === undefined || spec[field] === null) fail(`库 ${spec.lib_id} 缺字段 ${field}`);
  }
  if (!LIB_STATUSES.includes(spec.status)) fail(`库 ${spec.lib_id} 的 status=${spec.status} 不在 ${JSON.stringify(LIB_STATUSES)} 里`);
  for (const relative of spec.inputs) {
    if (!existsSync(join(root, relative))) fail(`库 ${spec.lib_id} 的输入路径不存在：${relative}`);
  }
  if (spec.status === 'ready' && spec.inputs.length === 0) {
    fail(`库 ${spec.lib_id} 标成 ready 却没有任何 inputs`);
  }
  if (documents !== null) {
    if (!Array.isArray(documents)) fail(`assertLib 的 documents 必须是数组或 null`);
    if (spec.status === 'ready' && documents.length === 0) {
      fail(`库 ${spec.lib_id} 标成 ready，但一篇文档都没建出来（不许把空库当成正常库）`);
    }
    if (spec.status === 'ready') {
      for (const kind of spec.record_kinds) {
        if (!documents.some((doc) => doc.record_kind === kind)) {
          fail(`库 ${spec.lib_id} 声明了 record_kind=${kind}，但一篇这种文档都没有（真源与声明已经漂了）`);
        }
      }
    }
  }
  return spec;
}

/** 只要 ready 的库（pending 库没有 inputs，建不出索引，也不该假装有）。 */
export function readyLibs(libs) {
  return libs.filter((lib) => lib.status === 'ready');
}

/** lib_id 列表 → 库对象列表；任一未知就抛（不静默丢）。 */
export function selectLibs(libs, libIds) {
  return libIds.map((id) => assertLib(id, {libs}));
}
