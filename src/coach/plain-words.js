// 「说人话」的最后一道：把**模型自己说出来的内部术语**翻成玩家的话（2026-09-27，审计 ②）。
//
// 为什么要在**发出去之前**再过一道（而不是只改提示词）：
// 真机探针（`scripts/roco/probe-answer-speak.mjs`，对着正在跑的服务逐句问）抓到两条**模型正文**
// 里带着内部叫法 —— 「所以下面是推断，不是实测**回执**」「具体倍数和图鉴**口径**我这次没查到」。
// 提示词里那些词（回执 / 口径 / 台账 / 判据…）模型会照着抄进给玩家的回答里；
// 光改提示词是"希望它不抄"，而这是**玩家看得见**的那一层，得有确定性的兜底。
//
// 三条纪律：
//   ① **只换词，不动别的**：映射表里全是"内部叫法 → 玩家说法"，一个数字、一个标点都不碰；
//      判据会逐条验"替换前后数字序列完全相同"（`tests/roco-plain-speak.test.js` ⑪）。
//   ② **幂等**：玩家话里如果本来就出现这些词（例如"规则"里含"规则"），再跑一次结果不变。
//   ③ **留痕**：换了哪几个词要能报出来（调用方写进回执的 `speakPlain`），不悄悄改。
//
// ⚠ 覆盖范围要如实说：这一层只管**词**。句子结构、语气、有没有空转，仍由提示词与守卫负责。

/**
 * 内部叫法 → 玩家说法。**只收"确定是内部叫法"的词**（宁可少收，不要误伤正常中文）：
 * 每个键都在 `docs/roco/PLAIN-SPEAK.md` 第一节的规则 1/2 名单里（口径/回执/台账/判据/…）。
 */
export const JARGON_WORDS = Object.freeze({
  // 规范规则 1（内部术语）
  回执: '查到的记录',
  口径: '说法',   // 不用「规则」：正文里常有「规则口径」，换成「规则规则」会读起来别扭
  台账: '记录',
  判据: '标准',
  证据包: '依据',
  白名单: '允许清单',
  归一化: '统一换算',
  兜底: '保底',
  结构分: '结构评分',
  声明假设: '假设',
  相对表现: '相对强弱',
  // 规范规则 2（对着仓库/代码说话）
  本仓库: '我这边',
  本仓: '我这边',
});

/**
 * 把一段回答里的内部叫法换成玩家说法。
 * 返回 `{text, replaced}`：`replaced` 是**真的换过的**词（没换就是空数组，调用方据此留痕）。
 */
export function speakPlainly(value) {
  let text = String(value ?? '');
  const replaced = [];
  for (const [jargon, plain] of Object.entries(JARGON_WORDS)) {
    if (!text.includes(jargon)) continue;
    // `本仓库` 与 `本仓` 是前缀关系：先长后短，免得「本仓库」被「本仓」切成「我这边库」。
    text = text.split(jargon).join(plain);
    replaced.push(`${jargon}→${plain}`);
  }
  return {text, replaced};
}

/** 只报"这句话里有没有内部叫法"（判据与探针共用一份表）。 */
export function jargonIn(value) {
  const text = String(value ?? '');
  return Object.keys(JARGON_WORDS).filter((word) => text.includes(word));
}

/**
 * **硬禁词**（判据 ①/⑧/⑩ 与真机探针、移动端总扫共用这一份表 —— 词表写两份必然漂）。
 * 出处：`docs/roco/PLAIN-SPEAK.md` 第一节的规则 1–5，加上 2026-09-27 审计 ② 实测到的两类：
 *   · `本仓`（原来只禁 `本仓库`，裸的那个漏了 —— `teacher.js:76`、`runtime.js` 正文多处）；
 *   · `.js`（数据/代码文件名：`learnsets.json`/`types.json`/`weather_policy`/`rule.js` 都进过正文）。
 */
export const BANNED_WORDS = Object.freeze([
  '本仓',
  '[object Object]', '口径', '结构分', '声明假设', '相对表现',
  'ENGINE_HYPOTHESIS', '证据包', 'src/game/', 'src/coach/',
  '.js',
]);

/** **工程语气**（第二档，棘轮）：出现不等于错，但玩家读着费劲，计数只许减不许增。 */
export const ENGINEER_TONE_WORDS = Object.freeze([
  '回执', '判据', '台账', '兜底', '降级', '守卫', '归一化', '白名单',
]);

/**
 * 一段文字命中了哪几个词（硬禁词与工程语气分开报）。
 * 判据、真机探针、移动端总扫都用它 —— 一处改，三处跟着变。
 */
export function speakHits(value) {
  const text = String(value ?? '');
  return {
    hard: BANNED_WORDS.filter((word) => text.includes(word)),
    soft: ENGINEER_TONE_WORDS.filter((word) => text.includes(word)),
  };
}
