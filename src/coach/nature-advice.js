// 性格/天分的**说法层**：把数字翻成"取舍"，而不是报一串面板。
//
// 人类 2026-09-26 的两条要求就落在这里：
//   · **防止纯机器算**：只回数值不算合格 —— 每条建议必须带「换来了什么 / 牺牲了什么」；
//   · **防止过拟合**：这里**没有**任何按精灵名/按原话写死的答案，一切都从种族值 + 天分 + 性格现算。
//
// 数字来源只有一个：`talent.js`（它自己从 `data/roco/systems/natures.json` 读规则）。
// 种族值来源：归一化图鉴 `data/roco/normalized/<ruleset>/full-catalog.json` 的 `stats`
//（与图鉴问答用的是同一份快照；读不到就是 null，不许用别处的数顶）。
import {STAT_KEYS, STAT_NAMES, panelOf, natureOf, natures} from './talent.js';
import {PET_NAME_ROWS} from './pet-names-data.js';
import {processEnv} from './env.js';

// ⚠ 环境变量只许走 `processEnv()`（浏览器里没有 `process`；这条由结构判据逐文件钉住）。
const RULESET = processEnv().ROCO_RULESET_ID || 'roco-world-s4-2026-09-10';
export const RACE_SOURCE = `data/roco/normalized/${RULESET}/full-catalog.json 的 stats（归一化图鉴快照）`;

// 种族值只在**服务端**读（浏览器图不许出现 node:* 的静态 import）⇒ 用**动态** import，
// 浏览器里这段根本不会执行；判据允许动态 import（见 structure-contract 的注释）。
let catalogPromise = null;
function catalog() {
  if (!catalogPromise) {
    catalogPromise = import('node:fs').then(({readFileSync}) => {
      const url = new URL(`../../data/roco/normalized/${RULESET}/full-catalog.json`, import.meta.url);
      const raw = JSON.parse(readFileSync(url, 'utf8'));
      return Array.isArray(raw) ? raw : (raw.pets ?? []);
    });
  }
  return catalogPromise;
}

/** 按编号或名字取一只的种族值（找不到就 null —— 调用方必须如实说"查不到"，不许猜）。 */
export async function raceOf(idOrName) {
  const key = String(idOrName ?? '').trim();
  if (!key) return null;
  const rows = await catalog();
  const hit = rows.find((row) => row.pet_id === key || row.id === key)
    ?? rows.find((row) => row.name === key);
  if (!hit || !hit.stats) return null;
  const race = {};
  for (const stat of STAT_KEYS) {
    const value = Number(hit.stats[stat]);
    if (Number.isFinite(value)) race[stat] = value;
  }
  return Object.keys(race).length ? {pet_id: hit.pet_id ?? hit.id, name: hit.name, types: hit.types ?? [], race}
    : null;
}

const pct = (factor) => `${factor > 1 ? '+' : ''}${Math.round((factor - 1) * 100)}%`;

/**
 * 一条性格对这只精灵做了什么：**换来什么 + 牺牲什么**，两边都给面板差值。
 * 这是"说法层"的最小单位，`adviceFor` 与答案层都用它。
 */
export function explainNature({race, talent = null, nature}) {
  const row = natureOf(nature);
  if (!row) return null;
  const neutral = panelOf({race, talent, nature: null}).panel;
  const withNature = panelOf({race, talent, nature: row.name}).panel;
  const gain = {stat: row.up, from: neutral[row.up], to: withNature[row.up], delta: withNature[row.up] - neutral[row.up]};
  const cost = {stat: row.down, from: neutral[row.down], to: withNature[row.down], delta: withNature[row.down] - neutral[row.down]};
  return {
    nature: row.name, gain, cost,
    // 说法层：句子结构固定、数字现算 —— 不许出现"某某精灵就该用某某性格"这种硬编码结论。
    text: `「${row.name}」把${STAT_NAMES[row.up]}抬 ${pct(1.2)}（${gain.from} → ${gain.to}），`
      + `代价是${STAT_NAMES[row.down]}掉 ${pct(0.9)}（${cost.from} → ${cost.to}）。`,
  };
}

/**
 * 这只精灵的性格候选：按 `priority`（你在意的项，按先后）算，每条都带代价。
 * 返回的是**材料**，不下"就该用它"的结论 —— 结论要结合队伍与对手（答案层去讲）。
 */
export function adviceFor({race, talent = null, priority = ['spe'], limit = 5} = {}) {
  if (!race) return {ok: false, reason: '没有种族值 ⇒ 性格建议算不出来（不猜）'};
  const rows = [];
  for (const row of natures()) {
    const explained = explainNature({race, talent, nature: row.name});
    const gain = explained.gain.delta;
    const cost = explained.cost.delta;
    const wanted = priority.includes(row.up);
    rows.push({...explained, wanted, score: gain - Math.abs(cost) * 0.5});
  }
  // 先按"在不在你要的项上"分档，再按净收益排（**排序规则写在明面上**，不是黑箱打分）
  rows.sort((a, b) => Number(b.wanted) - Number(a.wanted) || b.score - a.score
    || a.nature.localeCompare(b.nature, 'zh'));
  return {ok: true, priority, rows: rows.slice(0, limit)};
}

/**
 * 两个个体差在哪（同种才有意义）：逐项面板差 + 一句取舍。
 * **缺输入的地方必须留白**：天分按 0 计、性格未知，都要在 `caveats` 里说出来，不许假装比过。
 */
export function compareIndividuals({race, a, b}) {
  if (!race || !a || !b) return {ok: false, reason: '缺少种族值或个体 ⇒ 不比（也不许猜）'};
  const caveats = [];
  for (const [label, one] of [['第一个个体', a], ['第二个个体', b]]) {
    if (!one.nature) caveats.push(`${label}还没有性格数据 ⇒ 性格那一半按中性算`);
    if (!one.talent || STAT_KEYS.every((stat) => !Number(one.talent?.[stat]))) {
      caveats.push(`${label}的天分是 0（缺数值时的占位）⇒ 天分那一半比不出高低`);
    }
  }
  const pa = panelOf({race, talent: a.talent, nature: a.nature}).panel;
  const pb = panelOf({race, talent: b.talent, nature: b.nature}).panel;
  const diff = {};
  for (const stat of STAT_KEYS) diff[stat] = (pa[stat] ?? null) === null || (pb[stat] ?? null) === null
    ? null : pa[stat] - pb[stat];
  const better = STAT_KEYS.filter((stat) => (diff[stat] ?? 0) > 0);
  const worse = STAT_KEYS.filter((stat) => (diff[stat] ?? 0) < 0);
  const talk = better.length || worse.length
    ? `第一个个体在${better.map((stat) => STAT_NAMES[stat]).join('、') || '没有一项'}上更高，`
      + `在${worse.map((stat) => STAT_NAMES[stat]).join('、') || '没有一项'}上更低。`
    : '两只算出来的面板完全一样（在天分与性格都一样的前提下，这是正常的）。';
  return {ok: true, panels: {a: pa, b: pb}, diff, caveats, text: talk};
}

// ── 问句识别 + 本地成句（0 次模型调用）─────────────────────────────────────
//
// 判据要求（见 tests/roco-nature-advice.test.js ⑨⑩）：
//   · 认得出「<名字>用什么性格」「为什么用<性格>」「两个个体差在哪」；
//   · 别的问句**不许**被这条吃掉（相性/技能/图鉴/阵容各有各的路）；
//   · 答案里必须有取舍句，且数字全部现算。

/** 消息里提到的是图鉴里的哪一只（取**最长匹配**，避免短名把长名吃掉）。 */
export function petMentionedIn(text) {
  const source = String(text ?? '');
  if (!source.trim()) return null;
  let best = null;
  for (const [name, petId] of PET_NAME_ROWS) {
    if (name.length < 2 || !source.includes(name)) continue;
    if (!best || name.length > best.name.length) best = {name, pet_id: petId};
  }
  return best;
}

const WANT_SPEED = /先手|速度|快|抢先|一速/;
const WANT_ATTACK = /输出|打人|伤害|攻击|物攻|魔攻|火力/;
const WANT_BULK = /扛|肉|耐|血|站场|顶|不死|防御|双防/;

/** 玩家在问哪一项（没问就给 null —— 那种情况按"它最高的那一项"讲，并说明为什么）。 */
export function wantedStats(text) {
  const source = String(text ?? '');
  const want = [];
  if (WANT_SPEED.test(source)) want.push('spe');
  if (WANT_BULK.test(source)) want.push('hp', 'def', 'spd');
  if (WANT_ATTACK.test(source)) want.push('atk', 'spa');
  return want;
}

/**
 * 这类问句归不归本地事实（`localFactAsk` 用）。**只认这三种形状**，其余一律放行给别的路。
 */
export function natureTalentAsk(message = '') {
  const text = String(message ?? '');
  if (!text.trim()) return false;
  if (/个体|两只|这两个|两个.*(差|比)|同一只.*(哪只|哪个)/.test(text) && /差|比|哪个|哪只|选哪/.test(text)
    && petMentionedIn(text)) return true;
  // 「为什么用开朗？」这类句子里没有"性格"两个字，但确实是在问性格 —— 认它。
  if (!/性格/.test(text)) {
    return Boolean(natureIn(text)) && Boolean(petMentionedIn(text)) && /为什么|凭什么|为啥|怎么|该|用|选/.test(text);
  }
  if (!/(用|选|配|要|该|适合|推荐).{0,6}性格|性格.{0,6}(用|选|配|要|该|适合|推荐|怎么)/.test(text)) return false;
  // 有名字 ⇒ 讲这一只；没名字但问"为什么该用<性格>" ⇒ 也答（用性格表本身讲）
  return Boolean(petMentionedIn(text)) || Boolean(natureOf(natureIn(text)));
}

/** 消息里点名的性格（认不出就 null）。 */
export function natureIn(text) {
  const source = String(text ?? '');
  for (const row of natures()) if (source.includes(row.name)) return row.name;
  return null;
}

const sourceLine = '（性格加成来自游戏性格表：长处 +20%、短处 −10%；面板按种族值 + 天分现算）';

/**
 * 本地成句。返回 `{text, evidence}`（成句成功）或 `null`（这一问我答不了，交回上层）。
 * **不编**：没有种族值就直说查不到；两个个体凑不齐就直说看到几个。
 */
export async function natureLocalAnswer({message = '', context = null} = {}) {
  const text = String(message);
  if (!natureTalentAsk(text)) return null;
  const mentioned = petMentionedIn(text) ?? petMentionedIn(text.replace(/性格.*$/, ''));
  const asked = natureIn(text);

  // ① 两个个体比大小
  if (/个体|哪只|哪个|差|比/.test(text) && !/为什么|怎么选性格/.test(text)) {
    const pets = Array.isArray(context?.profile?.pets) ? context.profile.pets : [];
    const same = mentioned ? pets.filter((row) => row?.name === mentioned.name) : [];
    if (same.length < 2) {
      return {
        text: mentioned
          ? `你说的「${mentioned.name}」，我这边看到 ${same.length} 个个体 —— 至少要有两个才能比。`
            + '（把这一只的另一个个体也放进名单，或者说清是哪两只，我逐个面板给你比。）'
          : '要比两个个体的话，点一下名字（例如「皇家狮鹫这两个个体差在哪」），我按面板逐项给你比。',
        evidence: [`context.profile.pets 里同名个体 ${same.length} 个；比较需要 ≥2`],
      };
    }
    const row = await raceOf(mentioned.pet_id);
    const result = compareIndividuals({race: row?.race, a: same[0], b: same[1]});
    if (!result.ok) return {text: `${result.reason}`, evidence: ['compareIndividuals 拒绝：缺输入']};
    const lines = [result.text];
    if (result.caveats.length) lines.push(`⚠ ${result.caveats.join('；')}。`);
    lines.push(sourceLine);
    return {text: lines.join(''), evidence: [
      `种族值：${RACE_SOURCE}`, `面板：${JSON.stringify(result.panels)}`]};
  }

  // ② 「为什么该用<性格>」：讲这一条性格对这只做了什么
  if (asked && /为什么|凭什么|为啥/.test(text)) {
    const row = mentioned ? await raceOf(mentioned.pet_id) : null;
    if (!row) {
      return {text: `要说清「为什么用${asked}」，得先知道是哪一只 —— 你说个名字（例如「皇家狮鹫为什么用开朗」），我按它的种族值算给你。`,
        evidence: ['没有点名精灵 ⇒ 不猜是哪一只']};
    }
    const explained = explainNature({race: row.race, talent: null, nature: asked});
    return {text: `${row.name}：${explained.text}${sourceLine}`,
      evidence: [`种族值：${RACE_SOURCE}`, `explainNature(${asked})`]};
  }

  // ③ 「<名字>用什么性格」：按玩家在意的方向给一组，每条都带代价
  if (!mentioned) return null;
  const row = await raceOf(mentioned.pet_id);
  if (!row) return {text: `「${mentioned.name}」的种族值我这边查不到，所以性格我不猜。`, evidence: ['raceOf=null']};
  const want = wantedStats(text);
  let priority = want;
  let why = want.length ? `你要的方向（${[...new Set(want.map((stat) => STAT_NAMES[stat]))].join('、')}）` : '';
  if (!priority.length) {
    // 没说要什么 ⇒ 按**它自己最高的那一项**讲（这是数据，不是我们的偏好），并说清为什么
    const top = STAT_KEYS.map((stat) => [stat, row.race[stat] ?? -1]).sort((a, b) => b[1] - a[1])[0];
    priority = [top[0]];
    why = `它种族值最高的是${STAT_NAMES[top[0]]} ${top[1]}`;
  }
  const advice = adviceFor({race: row.race, priority, limit: 5});
  if (!advice.ok) return {text: advice.reason, evidence: ['adviceFor 拒绝']};
  const profile = STAT_KEYS.map((stat) => `${STAT_NAMES[stat]} ${row.race[stat] ?? '—'}`).join('、');
  const ranked = STAT_KEYS.map((stat) => [stat, row.race[stat] ?? -1]).sort((a, b) => b[1] - a[1]);
  const second = want.length ? null : ranked[1];
  const head = `${row.name}（${(row.types ?? []).join('|')}）六项是：${profile}。`
    + `按「${why}」抬这一项的性格有这几个 —— `;
  const alt = second ? `另外它的${STAT_NAMES[second[0]]}也有 ${second[1]}，要按那一项算再说一声。` : '';
  const body = advice.rows.map((item, index) => `${index + 1}. ${item.text}`).join(' ');
  const tail = `想换方向（抢速度 / 更能扛 / 打得更疼）说一声，我按那个方向重算。${alt}${sourceLine}`;
  return {text: head + body + tail, evidence: [
    `种族值：${RACE_SOURCE}`, `priority=${priority.join(',')}`, `natures=${advice.rows.map((r) => r.nature).join(',')}`]};
}

