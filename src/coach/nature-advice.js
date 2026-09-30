// 性格/天分的**说法层**：把数字翻成"取舍"，而不是报一串面板。
//
// 人类 2026-09-26 的两条要求就落在这里：
//   · **防止纯机器算**：只回数值不算合格 —— 每条建议必须带「换来了什么 / 牺牲了什么」；
//   · **防止过拟合**：这里**没有**任何按精灵名/按原话写死的答案，一切都从种族值 + 天分 + 性格现算。
//
// 数字来源只有一个：`talent.js`（它自己从 `data/roco/systems/natures.json` 读规则）。
// 种族值来源：归一化图鉴 `data/roco/normalized/<ruleset>/full-catalog.json` 的 `stats`
//（与图鉴问答用的是同一份快照；读不到就是 null，不许用别处的数顶）。
import {STAT_KEYS, STAT_NAMES, panelOf, natureOf, natures, natureFactor} from './talent.js';
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
  // ⚠ 2026-09-27 补：按**名字**查时，同名多形态（钻石蜗 6 种、鸭吉吉国王 6 种…）**不许挑第一只** ——
  // 那与我们在图鉴问句里的口径不一致（那边是"不替你挑一只"）。这里如实回 `ambiguous` + 候选，
  // 由调用方去说清楚（面板/性格建议都适用）。
  const byId = rows.find((row) => row.pet_id === key || row.id === key) ?? null;
  if (!byId) {
    const byName = rows.filter((row) => row.name === key);
    if (byName.length > 1) {
      return {ambiguous: true, name: key,
        matches: byName.map((row) => ({pet_id: row.pet_id, name: row.name, title: row.title ?? null}))};
    }
  }
  const hit = byId ?? rows.find((row) => row.name === key);
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
/**
 * 缺天分时**必须写进每一条结论正文**的那句话（Lead 2026-09-30 裁决口径 (a)）：
 *   「缺天分时**产品要给结论**；但"这一半按 0 计入"必须写进**每一条结论的正文**」✓
 * **两态**：天分齐 ⇒ 返回 `null`（正文里**一个字都不许出现** ✗ —— 否则就是"无条件挂免责"）；
 *           天分缺 ⇒ 返回那句话 ✓（照算 + 明说偏低，与 `panelOf` 的旧契约一致 ✓）
 */
export function zeroTalentNote(talent) {
  const has = Boolean(talent) && STAT_KEYS.some((stat) => Number(talent?.[stat]));
  return has ? null : '（天分没填：这条里天分那一半按 0 计入，面板偏低，别当实测值）';
}

export function explainNature({race, talent = null, nature, breakthrough = 0}) {
  const row = natureOf(nature);
  if (!row) return null;
  // ⚠ 2026-09-27 **改钉**：长处那一侧的系数**随突破长**（初始 +10%、每突破 +2%、满 +20%），
  // 所以这里**现算**（`natureFactor`），不再写死 +20%。缺省零突破（我们没有每只的突破段数）。
  const neutral = panelOf({race, talent, nature: null, breakthrough}).panel;
  const withNature = panelOf({race, talent, nature: row.name, breakthrough}).panel;
  const gain = {stat: row.up, from: neutral[row.up], to: withNature[row.up], delta: withNature[row.up] - neutral[row.up]};
  const cost = {stat: row.down, from: neutral[row.down], to: withNature[row.down], delta: withNature[row.down] - neutral[row.down]};
  return {
    nature: row.name, gain, cost,
    // 说法层：句子结构固定、数字现算 —— 不许出现"某某精灵就该用某某性格"这种硬编码结论。
    text: `「${row.name}」把${STAT_NAMES[row.up]}抬 `
      + `${pct(natureFactor(row.name, row.up, {breakthrough}).factor)}（${gain.from} → ${gain.to}），`
      + `代价是${STAT_NAMES[row.down]}掉 `
      + `${pct(natureFactor(row.name, row.down, {breakthrough}).factor)}（${cost.from} → ${cost.to}）。`
      // ⚠ 口径 (a)：缺天分时**结论照给**，但"按 0 计入"要落在**这条结论的正文**上 ✓（不是只进 unknown/caveats ✗）
      + (zeroTalentNote(talent) ?? ''),
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
 *
 * ⚠ 2026-09-30 修（半成品排查 #4，人类口径「**不许拿 0 当真实值**」）：
 *   旧写法（**逐字留档，改钉不删**）：
 *     `if (!one.nature) caveats.push(`${label}还没有性格数据 ⇒ 性格那一半按中性算`);`
 *     `if (!one.talent || STAT_KEYS.every((stat) => !Number(one.talent?.[stat]))) {`
 *       `caveats.push(`${label}的天分是 0（缺数值时的占位）⇒ 天分那一半比不出高低`); }`
 *     `const pa = panelOf({race, talent: a.talent, nature: a.nature}).panel;`
 *   ⇒ 问题：**缺的天分照 0 进了面板计算** ✗ —— 结论看着有依据，其实**用一个假数算出来的** ✗
 *   现在：**缺的那一半直接不参与计算**（`panelOf` 收到 null）⇒ 结论只覆盖**真有的**那一半，
 *         并且在 `caveats` 与正文里**明说这一比不含哪一半** ✓（不是"按 0 算"，也不是"中性算"）
 */
export function compareIndividuals({race, a, b}) {
  if (!race || !a || !b) return {ok: false, reason: '缺少种族值或个体 ⇒ 不比（也不许猜）'};
  const hasTalent = (one) => Boolean(one?.talent) && STAT_KEYS.some((stat) => Number(one.talent?.[stat]));
  const natureKnown = Boolean(a.nature && b.nature);
  const talentKnown = hasTalent(a) && hasTalent(b);
  const caveats = [];
  if (!natureKnown) caveats.push('性格数据缺失 ⇒ 这一比**不含性格**（不是按中性算成同一个数）');
  if (!talentKnown) caveats.push('天分数据缺失 ⇒ 这一比**不含天分**（不是按 0 算）');
  // 缺的那一半**不参与计算**：`panelOf` 收到 null ⇒ 面板里就没有它 ✓（不再拿 0 顶 ✗）
  const pa = panelOf({race, talent: talentKnown ? a.talent : null, nature: natureKnown ? a.nature : null}).panel;
  const pb = panelOf({race, talent: talentKnown ? b.talent : null, nature: natureKnown ? b.nature : null}).panel;
  const diff = {};
  for (const stat of STAT_KEYS) diff[stat] = (pa[stat] ?? null) === null || (pb[stat] ?? null) === null
    ? null : pa[stat] - pb[stat];
  const better = STAT_KEYS.filter((stat) => (diff[stat] ?? 0) > 0);
  const worse = STAT_KEYS.filter((stat) => (diff[stat] ?? 0) < 0);
  const compared = [talentKnown ? '天分' : null, natureKnown ? '性格' : null].filter(Boolean);
  const scope = compared.length === 2 ? '' : `只比了${compared.join('与') || '种族值'}这一半：`;   // 缺的那半要**在正文里说清** ✓
  const talk = better.length || worse.length
    ? `${scope}第一个个体在${better.map((stat) => STAT_NAMES[stat]).join('、') || '没有一项'}上更高，`
      + `在${worse.map((stat) => STAT_NAMES[stat]).join('、') || '没有一项'}上更低。`
    : `${scope}两只算出来的面板完全一样${compared.length === 2 ? '（在天分与性格都一样的前提下，这是正常的）' : ''}。`;
  // 同上：两体对比也是"一条结论" ⇒ 缺天分时正文里也要有那句 ✓（天分齐时**不许有** ✗）
  const zeroNote = (!talentKnown) ? (zeroTalentNote(a.talent) ?? zeroTalentNote(b.talent)) : null;
  const text = `${talk}${zeroNote ?? ''}`;
  return {ok: true, panels: {a: pa, b: pb}, diff, caveats, compared, text};
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
/**
 * 「X 的面板是多少」——**人类点名的四层里"能算出来的那一部分"**。
 *
 * 用途：让玩家问得出"这只 60 级面板多少"。数字只来自数据层：
 *   · 种族值 → L1 图鉴层（`full-catalog.json`，已按人类拍板采用抓包值）；
 *   · 天分/性格 → 上下文里带了就用（页面送来的个体），没带就**按天分 0 + 中性性格**算并**说清**；
 *   · 等级 → **60**（人类口径 + 官方上限），零突破下界（我们没有每只的突破段数）。
 */
export function panelAsk(message = '') {
  const text = String(message ?? '');
  if (!text.trim()) return false;
  if (!/面板|实战数值|数值面板|面板数值/.test(text)) return false;
  return Boolean(petMentionedIn(text));
}

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

// 出处那一行必须与**算出来的档位**一致（2026-09-27：正文写 +10% 而这里的出处还写着 +20%，
// 就等于自相矛盾）。缺省是零突破下界。
const sourceLine = '（性格加成来自游戏性格表：长处**初始 +10%**、每突破一次再 +2%、满突破 +20%，'
  + '短处固定 −10%；这里按**零突破**算，面板按种族值 + 天分现算 —— 60 级口径）';

/**
 * 本地成句。返回 `{text, evidence}`（成句成功）或 `null`（这一问我答不了，交回上层）。
 * **不编**：没有种族值就直说查不到；两个个体凑不齐就直说看到几个。
 */
/**
 * 面板问句的**本地成句**（0 次模型调用）：逐项列出来，并把"哪些是假设"讲清。
 *
 * `individual` 是页面送来的那一个个体（有 `talent` / `nature` 就用；没有就按 0 / 中性并标注）。
 */
export async function panelLocalAnswer(message, {individual = null} = {}) {
  if (!panelAsk(message)) return null;
  const mentioned = petMentionedIn(message);
  const name = mentioned?.name ?? String(message).trim();
  const layer = await raceOf(name);
  if (layer?.ambiguous) {
    const shown = layer.matches.slice(0, 6)
      .map((one) => `${one.title ?? one.name}（${one.pet_id}）`).join('、');
    return {text: `「${layer.name}」这个名字对应 ${layer.matches.length} 只不同形态，面板逐只不同，`
      + `所以不能拿一只替另一只算：${shown}${layer.matches.length > 6 ? ' 等' : ''}。`
      + '说一个 pet_id（或者说清是哪一只），我再给这一只的面板。',
    evidence: [`raceOf('${layer.name}') → ambiguous，候选 ${layer.matches.length} 只`], trace: []};
  }
  if (!layer) {
    return {text: `「${name}」的种族值我这边查不到（图鉴层里没有这只）—— 没有种族值就不算面板，也不拿别的数来凑。`
      + '换个写法（用图鉴里的全名）再问一次。',
    evidence: [`raceOf('${name}') = null（图鉴层 ${'full-catalog.json'}）`], trace: []};
  }
  const talent = individual?.talent && typeof individual.talent === 'object' ? individual.talent : null;
  const nature = typeof individual?.nature === 'string' && individual.nature ? individual.nature : null;
  const panel = panelOf({race: layer.race, talent, nature, scope: 'pvp', level: 60, breakthrough: 0}).panel;
  const order = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].filter((stat) => panel[stat] !== undefined);
  if (!order.length) {
    return {text: `「${layer.name}」的面板这一项都算不出来：图鉴层的种族值缺项。`,
      evidence: ['panelOf 一项都没算出来 ⇒ 不回数字'], trace: []};
  }
  const line = order.map((stat) => `${STAT_NAMES[stat]} ${panel[stat]}`).join(' / ');
  // ⚠ 用了这一只的天分/性格时，**必须说清这一份本身是哪来的**：数据集里那两项是 null，
  // 值由个体层**种子化掷点**生成（示例数据），不是玩家存档里的真值。不说＝把建模值当实测值用。
  const rolled = (source) => typeof source === 'string' && source.includes('rolled');
  const talentNote = talent
    ? (rolled(individual?.talent_source) ? '天分用你这一只的（**这一份是建模掷点，不是游戏里的真值**）' : '天分用你这一只的')
    : '**天分按 0 计**（没拿到这只的天分 ⇒ 面板偏低）';
  const natureNote = nature
    ? `性格「${nature}」${rolled(individual?.nature_source) ? '（同样是建模掷点）' : ''}`
    : '**性格按中性**（没拿到这只的性格）';
  const assumptions = [
    '**60 级**（默认档；等级上限就是 60）',
    '**默认 5 星**（按满突破算：资质那一项在面板里放大 6 倍）',
    talentNote,
    natureNote,
    '**零突破**（没有每只的突破段数；满突破那一档是 +20% 而不是 +10%）',
  ];
  // ⚠ 2026-09-28 人类拍板：「资质」这个词**要**出现在玩家正文里
  //   （原先正文只写"种族值 + 天分 + 性格"，四层口径见 `docs/roco/PET-LAYERS.md`）。
  //   ⚠ 排版：逗号后**不留空格**（"……+10%） 算的" 会在页面上多出一个孤零零的空格）。
  //   ⚠ 「资质」在这份正文里指的是**那六项数值本身**（0–10，五星 0–60 那一档）；
  //     外部攻略另有一个把"种族值 + 天分"合称资质的说法，两者会撞车 ⇒ 正文里点一句，别让玩家猜。
  return {
    text: `${layer.name}（${(layer.types ?? []).join('|') || '属性未登记'}）的面板：${line}。`
      + `按 ${assumptions.join('、')}算的 —— 面板 = 种族值 + 资质 + 天分 + 性格（等级公式；`
      + '这里的"资质"指六项资质数值）。换一只或补上天分性格，我再算一遍。',
    evidence: [`种族值：图鉴层 ${layer.pet_id}（抓包采用后的值）`, `面板：panelOf(level=60, scope=pvp, 零突破)`,
      `假设：${assumptions.join('；')}`],
    trace: [],
  };
}

/**
 * 这份上下文里"这一只的个体"（带天分/性格）。页面送来的名单在 `/api/coach` 上已经被
 * `attachIndividualsToContext` 补过字段 ⇒ 这里直接读；**读不到就 null**（答案层按 0/中性算并标注）。
 */
export function individualIn(context, name) {
  const rows = Array.isArray(context?.profile?.pets) ? context.profile.pets : [];
  if (!rows.length || !name) return null;
  const hit = rows.find((row) => row?.name === name
    || row?.species_name === name);
  if (!hit) return null;
  const talent = hit.talent && typeof hit.talent === 'object' && !('value' in hit.talent) ? hit.talent : null;
  const nature = typeof hit.nature === 'string' && hit.nature.trim() ? hit.nature.trim() : null;
  if (!talent && !nature) return null;
  return {talent, nature, talent_source: hit.talent_source ?? null, nature_source: hit.nature_source ?? null};
}

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
    // ⚠ 2026-09-27 真机抓到的错（同名 **≠** 同种）：名单里那两只「棋契陛下」其实是
    // **两个不同物种**（pet_000556 与 pet_000575）—— 而这一支要回答的是"**同一只**的两个个体差在哪"，
    // `compareIndividuals` 自己的注释也写着"同种才有意义"（它按一个 `race` 给两边算面板）。
    // 拿两个物种套同一份种族值比出来的表**没有意义**，所以这一档必须 **fail closed**。
    const species = new Set(same.map((one) => String(one.species_id ?? one.id ?? '')).filter(Boolean));
    if (species.size > 1) {
      const listed = same.map((one) => `${one.name}（${one.species_id ?? one.id ?? '无物种 id'}）`).join('、');
      return {text: `「${mentioned.name}」在你的名单里有两行，但它们**不是同一个物种**：${listed}。`
        + '我说的是"**同一只**的两个个体差在哪"（同种、两份天分/性格），拿两个物种套同一份种族值比出来的表没有意义 —— '
        + '所以这一问我先不比。想比的话：把同一只的两个个体都放进名单（同名**且同种**），我再逐项给你比。',
      evidence: [`同名两行的物种 id：${[...species].join(' / ')} ⇒ 不同种，拒绝按"两个个体"比`]};
    }
    const row = await raceOf(mentioned.pet_id);
    // 两个个体各自的 `talent`/`nature`（页面补过字段）—— `compareIndividuals` 本来就按传入的个体算，
    // 这里**不用改它**，只要保证传进去的是"补过字段的那两行"（原来传的就是 same[0]/same[1]，✓）。
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
    // ⚠ 2026-09-27 改钉：这里原来写死 `talent: null` —— 于是"为什么用开朗"给的面板差值是
    // **天分 0** 那一版的。现在用名单里这一只的个体（页面已经补过字段），并在正文里说明用了什么。
    const mine = individualIn(context, row.name);
    const explained = explainNature({race: row.race, talent: mine?.talent ?? null, nature: asked});
    const who = mine?.talent ? '按你这一只的天分算' : '按天分 0 计（没拿到这只的天分）';
    return {text: `${row.name}：${explained.text}（${who}）${sourceLine}`,
      evidence: [`种族值：${RACE_SOURCE}`, `explainNature(${asked})`,
        ...(mine?.talent ? [`天分：${JSON.stringify(mine.talent)}（来源：${mine.talent_source ?? '未知'}）`] : [])]};
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

