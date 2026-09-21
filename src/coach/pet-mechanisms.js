// 精灵「机制首层」的**读取层**：产物在 `data/roco/derived/pet-mechanisms.json`，
// 由 `scripts/roco/build-pet-mechanisms.mjs` 构建、`verify-pet-mechanisms.mjs` 检查。
//
// 为什么读取层单独放在 `src/coach/`：页面、接口、脚本三处都要用同一个常量与同一条
// 「什么时候只能说不知道」的规则。**句子写两份就会各自漂移**——所以
// 「机制资料待确认」这句话在这里定义一次，构建器与接口都从这里取。
//
// 硬纪律（与产物检查器一一对应）：
//   · `MECHANISM_UNCONFIRMED` 的行一律**不返回**机制文案（返回 fallback），哪怕产物里带了一行；
//   · 产物缺失/读不动时 `available:false`，`get()` 恒返回 null —— 调用方必须显示 fallback 或省略，
//     绝不允许在这里补一个默认句子（那正是人类投诉的「模板化特点」）。

/** 解析不到机制文字时，玩家层唯一允许出现的句子。 */
export const MECHANISM_FALLBACK = '机制资料待确认';

/** 机制行长度上限（卡片首层一行放得下）。 */
export const MECHANISM_LINE_MAX = 60;

/** 产物相对仓库根的路径。 */
export const MECHANISM_ARTIFACT = 'data/roco/derived/pet-mechanisms.json';

/** 允许出现在玩家层的机制状态。 */
export const MECHANISM_STATUSES = Object.freeze(['FROZEN_DESC', 'MECHANISM_UNCONFIRMED']);

/**
 * 建一个只读索引。
 *
 * @param {object} input
 * @param {(rel: string) => string} input.readFile 读文件（返回 UTF-8 文本）；由调用方注入，
 *        这样 Node 侧可以给 `join(root, rel)`，测试可以给内存文本。
 * @returns {{available: boolean, size: number, summary: object|null, error: string|null,
 *            get: (petId: string) => object|null}}
 */
export function createMechanismIndex({readFile}) {
  let doc = null;
  let error = null;
  try {
    const text = readFile(MECHANISM_ARTIFACT);
    doc = JSON.parse(text);
  } catch (cause) {
    // fail closed：读不动就是读不动，绝不退回到「前端自己编一句」。
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const pets = doc && typeof doc.pets === 'object' && doc.pets !== null ? doc.pets : null;
  const available = Boolean(pets);
  const size = pets ? Object.keys(pets).length : 0;
  return {
    available,
    size,
    summary: doc?.summary ?? null,
    error: available ? null : (error ?? '产物结构不对：缺少 pets'),
    get(petId) {
      if (!pets || typeof petId !== 'string' || !petId) return null;
      const row = pets[petId];
      return row && typeof row === 'object' ? row : null;
    },
  };
}

/**
 * 列表层要用的**最小**机制字段（卡片首层）。
 *
 * 为什么单独列一份：名单接口的载荷会被验收脚本逐键扫「有没有漏工程字段」，
 * 所以列表层只带这四个玩家看得懂的键；`desc` 原文与 `unverified[]` 留给详情/抽屉。
 */
export function rosterMechanism(row) {
  const player = playerMechanism(row);
  return {
    line: player.mechanism_line,
    status: player.mechanism_status,
    name: player.mechanism_name,
    tags: player.mechanism_tags,
  };
}

/**
 * 把产物里的一行整理成**玩家层**能直接渲染的字段。
 *
 * 不知道就说不知道：`MECHANISM_UNCONFIRMED` / 缺行 / 行不是字符串 ⇒ `mechanism_line` 是 fallback，
 * `mechanism_desc` / `mechanism_name` 是 null。威力不进首层（产物里的 `feature.power`
 * 只给展开详情用，来源没给就是 null）。
 */
export function playerMechanism(row) {
  const status = MECHANISM_STATUSES.includes(row?.mechanism_status) ? row.mechanism_status : 'MECHANISM_UNCONFIRMED';
  const raw = typeof row?.mechanism_line === 'string' ? row.mechanism_line.trim() : '';
  const confirmed = status === 'FROZEN_DESC' && raw !== '' && raw !== MECHANISM_FALLBACK;
  return {
    mechanism_status: confirmed ? 'FROZEN_DESC' : 'MECHANISM_UNCONFIRMED',
    mechanism_line: confirmed ? raw : MECHANISM_FALLBACK,
    mechanism_name: confirmed && typeof row?.feature?.name === 'string' ? row.feature.name : null,
    mechanism_desc: confirmed && typeof row?.feature?.desc === 'string' ? row.feature.desc : null,
    mechanism_tags: Array.isArray(row?.mechanism_tags)
      ? row.mechanism_tags.filter((entry) => entry && typeof entry.tag === 'string').map((entry) => ({tag: entry.tag, skills: entry.skills ?? null}))
      : [],
    unverified: Array.isArray(row?.unverified) ? row.unverified.filter((line) => typeof line === 'string') : [],
  };
}
