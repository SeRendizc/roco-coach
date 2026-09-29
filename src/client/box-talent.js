// 小芽 · 精灵盒子：**「天分 / 资质 / 刷新天分记录」这三件事的唯一读法与唯一说法**。
//
// 为什么单独一个模块（2026-09-29，人类报的 U01：截图 1/12 几乎每张卡都写「天分认不出」）：
//   ① 这三件事原来是**同一个字符串出口** —— `box-drawer.js` 的 `individualRowChips` 用一处三元
//      决定印「四档名」还是「天分认不出」还是「天分待导出」，详情页那几栏又各写一套；
//      于是「天分」（掷出来的档位）、「资质」（六项具体数值）、「刷新天分记录（还剩 N 次）」
//      （玩家自己的动作账）被压成一句话，玩家分不出屏幕上说的是哪一件。
//   ② 「资质」是一张六维表，而 `Number(null) === 0` ⇒ 缺的那一项会被印成 `0` —— **等于编了一个数**。
//   ③ 旧记录（本仓旧口径掷点：随机三项 7–10、其余 0–6 ⇒ 激活 4–6 项）套不上人类给的四档
//      ⇒ 整页卡片机械同一句「认不出」，既不给**具体值**，也不给**可执行的补救**。
//
// ── 哪一份是真值（Lead 2026-09-29 口径，照做）────────────────────────────────
//   **本机记录**（`coach/individuals.js` 的 `cultivationOf`，键 `roco.box.individuals.v1`）优先；
//   抓包回执 / 名单里的导入字段（`traits` 的「资质」「天分档位」、列表卡的 `individual_label`）
//   只用于**补充说明**与**玩家主动采纳时的来源**。两者不一致时：屏幕上以本机记录为准，
//   并**如实标注**两边各是什么 —— 不静默二选一（`conflict` 字段就是那一条的落点）。
//
// ── 三件事怎么分（同一个个体上，三样并排说，不合并成一个串）────────────────────
//   · 天分（档位）：由「资质 + 性格」按 `coach/talent.js` 的四档读出来的**名字**；
//   · 资质：六项**具体数值**（缺哪项就写哪项缺，不补 0）；
//   · 刷新天分记录：玩家自己的动作账（还剩几次、上一次刷到哪一项）—— **不是**天分本身。
//
// 这个模块是纯函数（不碰 DOM、不碰 localStorage），Node 判据可以直接钉它。
import {cultivationOf} from '../coach/individuals.js';
import {talentTierOf, STAT_KEYS, STAT_NAMES} from '../coach/talent.js';

/** 六项资质的中文名（顺序与 `coach/talent.js` 的 `STAT_KEYS` 同一套，不许在这里重排）。 */
export const QUALIFICATION_LABELS = Object.freeze(
  Object.fromEntries(STAT_KEYS.map((key) => [key, STAT_NAMES[key]])));

/** 缺项那一句里不用工程词的口径（「游戏数据里没有这一项」是页面层原来那句，这里更具体）。 */
const NO_VALUE = '没有这一项';

/**
 * 一个值算不算**真的数值**。
 *
 * ⚠ 这里**不能**用 `Number(value)` + `Number.isFinite`：`Number(null) === 0`、`Number('') === 0`
 * ⇒ 缺的那一项会被当成 0 印出来（U01 的「不能凭空生成」就是被这一条破的）。
 * 只认数字本身与**非空数字串**（服务端给的是 `{"hp": 0, "spa": 7}` 这种纯数字表）。
 */
export function numberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 「资质」= 六项具体数值。返回**逐项**的读数（哪项有、哪项缺），不印成一句就完事。
 *
 * @returns {{entries:Array<{key:string,label:string,value:?number}>, values:Object,
 *   present:Array<string>, missing:Array<string>, missingLabels:Array<string>,
 *   text:string, hasAny:boolean, activatedLabels:Array<string>, activatedCount:number}}
 */
export function qualificationOf(individual) {
  const raw = individual?.talent && typeof individual.talent === 'object' && !Array.isArray(individual.talent)
    ? individual.talent : null;
  const entries = STAT_KEYS.map((key) => ({key, label: QUALIFICATION_LABELS[key],
    value: raw ? numberOrNull(raw[key]) : null}));
  const present = entries.filter((one) => one.value !== null).map((one) => one.key);
  const missing = entries.filter((one) => one.value === null).map((one) => one.key);
  const activated = entries.filter((one) => one.value !== null && one.value > 0);
  return {
    entries,
    values: Object.fromEntries(entries.map((one) => [one.key, one.value])),
    present,
    missing,
    missingLabels: missing.map((key) => QUALIFICATION_LABELS[key]),
    // 只印有值的项：缺的**不印 0**（那是编数据），由 missingLabels 单独说清缺什么。
    text: entries.filter((one) => one.value !== null)
      .map((one) => `${one.label} ${one.value}`).join(' / '),
    hasAny: present.length > 0,
    activatedLabels: activated.map((one) => one.label),
    activatedCount: activated.length,
  };
}

/** 「资质」缺项那一句（具体缺哪几项；不缺就说 null）。 */
function missingText(qualification) {
  if (!qualification.missingLabels.length) return null;
  return `缺 ${qualification.missingLabels.join('、')} 这 ${qualification.missingLabels.length} 项`;
}

/** 把导入 / 名单那一份（`{hp:…}` 或 `{label, values}`）归一成同一种读数。 */
export function importedReadingOf(imported) {
  if (!imported || typeof imported !== 'object') return null;
  const values = imported.values && typeof imported.values === 'object' ? imported.values : imported;
  const qualification = qualificationOf({talent: values});
  const label = typeof imported.label === 'string' && imported.label.trim() ? imported.label.trim() : null;
  if (!label && !qualification.hasAny) return null;
  return {label, qualification,
    text: qualification.text,
    source: typeof imported.source === 'string' && imported.source.trim()
      ? imported.source.trim() : '抓包名单（导入字段）'};
}

/**
 * 读一个个体：**一处真值 + 三件事分开**。
 *
 * @param {object} individual 本机记录（`coach/individuals.js` 的形状）
 * @param {object} [options]
 * @param {?object} options.imported 抓包回执/名单里那一份（`{label, values, source}`）—— 只用于说明与补救
 * @returns {object} 读数（见下面每一条注释）
 */
export function talentReadingOf(individual, {imported = null} = {}) {
  const grown = cultivationOf(individual);
  const qualification = qualificationOf(individual);
  const tier = grown?.tier ?? null;
  const importedOne = importedReadingOf(imported);
  const missing = missingText(qualification);
  let status = 'empty';
  let reason = '';
  let remedy = null;

  if (tier?.label) {
    status = 'tier';
    // 档位那一句由 `talentTierOf` 给（它带着"被激活的是哪几项"）；这里只补"以谁为准"。
    reason = tier.reason ?? `${tier.label}（被激活的是：${qualification.activatedLabels.join('、')}）`;
  } else if (qualification.missing.length) {
    status = 'missing';
    reason = `${missing}资质 ⇒ 四档判不出来（缺的那几项不知道有没有被激活）`;
    remedy = qualification.present.length
      ? `把缺的 ${qualification.missingLabels.join('、')} 补上就能判档`
      : '这一只的六项资质都还没有数';
  } else if (qualification.hasAny) {
    status = 'unresolved';
    reason = `六项资质都有数，但被激活的有 ${qualification.activatedCount} 项`
      + `（${qualification.activatedLabels.join('、')}）—— 四档名只覆盖 1 / 2 / 3 项`;
    remedy = '按四档口径重掷一份（本机记录里现在这一份是旧口径掷出来的）';
  } else {
    status = 'empty';
    reason = '这一只的六项资质一项都没有数（本机记录里是空的）';
  }

  // 导入 / 名单那一份与屏幕上这一份**不一致**时，如实把两句话都摆出来（不静默二选一）。
  let conflict = null;
  if (importedOne) {
    const sameLabel = Boolean(importedOne.label && tier?.label && importedOne.label === tier.label);
    const sameValues = importedOne.qualification.present.length === qualification.present.length
      && importedOne.qualification.present.every(
        (key) => importedOne.qualification.values[key] === qualification.values[key]);
    if (!(sameLabel && sameValues)) {
      conflict = {
        label: importedOne.label,
        valuesText: importedOne.text || null,
        source: importedOne.source,
        // 屏幕上这一份认不出档位、而名单那一份有档名时，这个补救**真的能修好**它。
        adoptable: status !== 'tier' && importedOne.qualification.activatedCount >= 1
          && importedOne.qualification.activatedCount <= 3,
      };
    }
  }

  const title = [
    `天分：${tier?.label ?? '无档名'}（${reason}）`,
    `资质：${qualification.text || NO_VALUE}`,
    missing ? `缺项：${missing}` : null,
    conflict ? `名单那一份：${conflict.label ?? '（没有档名）'}${conflict.valuesText ? `（${conflict.valuesText}）` : ''}` : null,
    remedy ? `补救：${remedy}` : null,
  ].filter(Boolean).join('｜');

  return {
    status,                       // 'tier' | 'unresolved' | 'missing' | 'empty'
    tierLabel: tier?.label ?? null,
    tierKey: tier?.key ?? null,
    tierReason: tier?.reason ?? null,
    qualification,
    qualificationText: qualification.text,
    missingLabels: qualification.missingLabels,
    activatedLabels: qualification.activatedLabels,
    activatedCount: qualification.activatedCount,
    reason, remedy, conflict, title,
    // 屏幕上的这一份是"从哪儿来的"（判据与开发者抽屉读它；玩家看不见这些键）。
    source: 'local-record',
    fingerprint: grown?.fingerprint ?? '',
    revision: grown?.revision ?? '',
  };
}

/**
 * 列表行那一个小胶囊：**具体值 / 具体缺什么 / 具体为什么**，不再是机械的「认不出」。
 *
 * ⚠ 人类 2026-09-28 的口径一个字没变：档位认得出时**只说档名**（「一般般的天分」），
 * 前面不加「天分档位」、不写具体数值（详细进二级页看）。
 * 认不出时才多说一句**为什么**（激活几项 / 缺哪几项）—— 那是为了不再出现整页同一句话。
 */
export function talentChipOf(reading) {
  if (!reading) return {label: '天分 待导出', state: 'absent', title: '这一只还没有天分记录'};
  if (reading.status === 'tier') {
    return {label: reading.tierLabel, state: 'known',
      title: `天分（${reading.tierLabel}）：${reading.reason}`};
  }
  if (reading.status === 'missing') {
    const short = reading.qualification.present.length
      ? `缺 ${reading.missingLabels.length} 项资质`
      : '资质待导出';
    return {label: short, state: 'absent',
      title: `天分：${reading.reason}。资质：${reading.qualificationText || NO_VALUE}`
        + `。点开这一只看补救办法`};
  }
  if (reading.status === 'unresolved') {
    return {label: `天分未定档（激活 ${reading.activatedCount} 项）`, state: 'known',
      title: `天分：${reading.reason}。资质：${reading.qualificationText}。点开这一只看补救办法`};
  }
  return {label: '资质待导出', state: 'absent',
    title: `天分：${reading.reason}。点开这一只看补救办法`};
}

/**
 * 「刷新天分记录」= 玩家自己的**动作账**（还剩几次、上一次刷到哪一项）—— 与天分本身分开说。
 *
 * `note` 由调用方从 `coach/individuals.js` 的 `lastRefreshNote` 取（那句话只有一处事实源），
 * 这里只把"还剩几次"这一类**记录**读出来。
 */
export function refreshLedgerOf(individual, {note = null} = {}) {
  const refreshes = individual?.refreshes && typeof individual.refreshes === 'object' ? individual.refreshes : {};
  const left = (kind) => (Number.isFinite(Number(refreshes[kind])) ? Number(refreshes[kind]) : null);
  const natureLeft = left('nature');
  const talentLeft = left('talent');
  return {
    natureLeft, talentLeft,
    text: `刷新天分记录：还剩 ${talentLeft ?? '—'} 次（性格还剩 ${natureLeft ?? '—'} 次）`,
    note: note || null,
    // 还剩 0 次时把话说全：这不是"没有天分"，是"这一只不能再刷新了"。
    remedy: talentLeft === 0 ? '这一只的天分刷新次数用完了（回滚也不会退还）' : null,
  };
}
