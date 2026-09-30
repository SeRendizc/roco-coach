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
// ── 哪一份说话（**2026-09-29 晚更正**，T1 独立审核 + Lead 独立核实）────────────
//   **本机记录**（`coach/individuals.js` 的 `cultivationOf`，键 `roco.box.individuals.v1`）优先；
//   抓包回执 / 名单里的导入字段只用于**补充说明**与**玩家主动采纳时的来源**。两者不一致时：
//   屏幕上以本机记录为准，并**如实标注**两边各是什么 —— 不静默二选一（`conflict` 就是那条的落点）。
//
//   ⚠⚠ **更正一条我先前写错的口径**：这里原来写着「导入字段是**真值**」。**它不是。**
//   独立核实（`data/roco/owned/owned-pets.json` 全量 542 条）：
//     `talent.value` 有值的 = **0/542**（`nature.value` 同样 0/542），形状是
//     `{value:null, value_source:null, effect:'UNKNOWN', …}` —— 键在、值为 null。
//   经服务端投影后 542/542 都有值，但 `talent_source` **全部**以 `rolled` 开头。
//   ⇒ 这个仓里**没有**"抓包来的资质真值"；所谓"导入那一份"与"本机那一份"**用的是同一个
//     `rollNatureAndTalent(instance_id)`、同一个种子**。所以措辞里**不许再出现"真值"**：
//     把导入份盖上去，等于**用一份掷点换掉另一份掷点**；玩家刷新过之后还会**盖掉他刚刷的数**。
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

/**
 * **激活档**：建模里"被激活的那几项"的取值范围是 **7–10**。
 *
 * 为什么这一个常数能修 R04（2026-09-29，用户截图：几乎每张卡都写「天分未定档（激活 6 项）」）：
 *   本仓**两代掷点**都把 7–10 给"被激活"的那几项 ——
 *     · 旧口径（B1）：**随机三项 7–10、其余三项 0–6**；
 *     · 现口径（B2）：先掷激活 1–3 条，激活的那几条 7–10、其余**恰好 0**。
 *   ⇒ 旧记录里"哪三项是真正的激活"其实**还在数据里**，就是 ≥7 的那三项；
 *     只是拿 `>0` 当激活会把 0–6 的剩余项也算进去（于是 6 项 ⇒ 套不上四档 ⇒ 只能写"未定档"）。
 *   ⇒ 按激活档（≥7）读，**不改任何一个数**就能把档名恢复出来 —— 这就是 R04 要的
 *     「XXX的天分」，而且**不是**把"认不出"换个词（红线）。
 * 玩家的刷新加成（`talent_boosts`）仍然由 `coach/individuals.js` 的 `cultivationOf`
 * 先扣掉再进来（档位只认"抓到时是什么天分"），这一层不重复扣。
 */
export const ACTIVATION_FLOOR = 7;

/**
 * 把六项按**激活档**分成两组（≥7 = 激活项；1–6 = 旧口径的剩余项；0/null = 没值/未激活）。
 * 只做读数，**不碰**原值 —— 屏幕上的资质那一行照旧印全部六项。
 */
export function activationBandOf(qualification) {
  const entries = Array.isArray(qualification?.entries) ? qualification.entries : [];
  const on = entries.filter((one) => one.value !== null && one.value >= ACTIVATION_FLOOR);
  const below = entries.filter((one) => one.value !== null && one.value > 0 && one.value < ACTIVATION_FLOOR);
  return {
    keys: on.map((one) => one.key),
    labels: on.map((one) => one.label),
    count: on.length,
    belowLabels: below.map((one) => one.label),
    belowCount: below.length,
  };
}

/** 按激活档重读一次档位（返回与 `talentTierOf` 同形状；六项不全或一项都没到档就回 null）。 */
export function bandTierOf(qualification, nature) {
  const band = activationBandOf(qualification);
  // ⚠ **缺项时不许走这一条**：把 null 当成 0 会把"缺 5 项"读成"1 项激活 ⇒ 一般般的天分"，
  // 那是拿缺数据编结论（U01 的红线）。缺项一律留给上面那条 `missing` 分支如实说。
  if (!band.count || qualification.missing.length) return null;
  const talent = Object.fromEntries(qualification.entries.map((one) => [one.key,
    one.value !== null && one.value >= ACTIVATION_FLOOR ? one.value : 0]));
  return talentTierOf({talent, nature: nature ?? null});
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
  // ⭐ R04：coach 那一份读法（`>0` 即激活）之外，再按**激活档（≥7）**读一次 ——
  // 两代掷点的"被激活项"都在 7–10 区间里，所以这一读能恢复出旧记录的档名，且**不动任何数值**。
  const band = activationBandOf(qualification);
  const bandTier = bandTierOf(qualification, individual?.nature ?? null);
  let tierLabel = tier?.label ?? null;
  let tierSource = tier?.label ? 'as-is' : (bandTier?.label ? 'activation-band' : 'none');
  const importedOne = importedReadingOf(imported);
  const missing = missingText(qualification);
  let status = 'empty';
  let reason = '';
  let remedy = null;
  // ── U01 历史数据兼容缺口（2026-09-29，监工点名「不以非零数或原因自洽证明真实天分」）──────
  // 本机记录里有一代是**我方自己掷的**（`talent_source` 以 `rolled` 开头：
  // 「先掷激活 1–3 条、激活的那几条 7–10、其余 0 —— 条数与取值都是建模的，非官方概率」）。
  // 那一代掷点**恰好能对上人类给的四档**（激活 1/2/3 项）⇒ 页面会直接给出
  // 「一般般的天分 / 相当好的天分」这种**看起来像这一只真值**的结论，而那几个数**不是游戏数据**。
  // 所以只要来源是掷的，就**必须**把这句话和补救一起摆出来 ——
  // 原来它只写在 localStorage 里，玩家一个字都看不到（真机实测：页面文字里 `rolled` = false）。
  const rolledSource = typeof individual?.talent_source === 'string'
    && /^rolled/.test(individual.talent_source.trim());
  // ⚠ 2026-09-29 **第三轮纠偏第 1 条（最新用户决定覆盖旧口径）**：屏幕上不再出现
  //   「本机掷点 / 不是游戏里的资质」这一整段免责声明（用户图1/图2：几乎每张卡都写着它）。
  //   **内部来源字段照旧保留** —— `rolledSource` / `reading.rolled` / `talent_source`
  //   一个都没删，判据与开发材料仍然读得到；只是不再往玩家可见的文案里铺。
  //   旧文案留档（改钉不删）：
  //     const ROLLED_NOTE = '注意：这一只的资质是「本机掷点」，不是游戏里的资质（来源：本机记录）。'
  //       + '名单那一份同样是建模掷点（这个仓里没有抓包来的资质真值），'
  //       + '所以「用名单那一份重设资质」只是换一份掷点 —— 它只动资质，不动性格/等级/剩余次数。';

  if (tier?.label) {
    status = 'tier';
    // 档位那一句由 `talentTierOf` 给（它带着"被激活的是哪几项"）；这里只补"以谁为准"。
    reason = tier.reason ?? `${tier.label}（被激活的是：${qualification.activatedLabels.join('、')}）`;
    if (rolledSource) remedy = remedy ?? '用名单那一份重设资质（只动资质）';
  } else if (bandTier?.label) {
    // ⭐ R04（2026-09-29）：coach 那一份读法（`>0` 即激活）读不出来，但**按激活档（≥7）**读得出
    // —— 旧口径掷点（随机三项 7–10、其余 0–6）就是落在这里。档名照给，数值一个都不动。
    status = 'tier';
    tierLabel = bandTier.label;
    reason = bandTier.reason ?? `${bandTier.label}（激活档里的是：${band.labels.join('、')}）`;
    if (band.belowCount) {
      // ⚠ 玩家可见文案里**不许出现 markdown 星号**（本仓既有口径；`**重点**` 会原样上屏）。
      reason = `${reason}。六项里有 ${band.belowCount} 项在 1–6`
        + `（${band.belowLabels.join('、')}）—— 按激活档（≥7）读不算激活的项；`
        + '那几个数原样留在这里，没有删、没有截断、也没有重掷'
        + (rolledSource ? '（这是本仓旧口径掷点留下的形状）' : '');
    }
    if (rolledSource) remedy = remedy ?? '用名单那一份重设资质（只动资质）';
  } else if (qualification.missing.length) {
    status = 'missing';
    reason = `${missing}资质 ⇒ 四档判不出来（缺的那几项不知道有没有被激活）`;
    remedy = qualification.present.length
      ? `把缺的 ${qualification.missingLabels.join('、')} 补上就能判档`
      : '这一只的六项资质都还没有数';
  } else if (qualification.hasAny) {
    status = 'unresolved';
    // 认不出时把**两把尺子**都说清：>0 有几项、激活档（≥7）有几项。
    reason = band.count
      ? `按激活档（≥7）读只有 ${band.count} 项（${band.labels.join('、')}）`
        + `${band.belowCount ? `，另外 ${band.belowCount} 项在 1–6（${band.belowLabels.join('、')}）` : ''}`
        + ' —— 四档名只覆盖 1 / 2 / 3 项'
      : `六项资质都有数，但一项都没到激活档（≥7）—— 四档名一条都对不上`;
    // ⚠⚠ 2026-09-29（U01 隔离三条复验抓到的**真错误**）：这一句原来**无条件**写
    //   「按四档口径重掷一份（本机记录里现在这一份是旧口径掷出来的）」。
    //   可它对着**导入字段（真值）**也说同一句 —— 隔离用例 C（`talent_source: 名单导入`、
    //   激活 6 项）实测就落到这里，于是页面会**建议玩家把真值换成掷点**，
    //   与 U01「真值优先」正好相反。
    //   现在按来源分开说：**只有掷点来源才建议重掷**；导入来源如实说"这是真值，
    //   判不出是**口径**的问题，不是数值的问题"。
    if (rolledSource) {
      remedy = '用名单那一份重设资质（只动资质）';
    } else {
      // 一句话说清"判不出是口径问题、不是数值问题"（旧版是一整段，第三轮纠偏后压短）。
      remedy = `四档名只覆盖「激活 1 / 2 / 3 项」，这一只对不上（${qualification.activatedCount} 项）`
        + ' —— 不为了凑档位去改这几个数';
    }
  } else {
    status = 'empty';
    reason = '这一只的六项资质一项都没有数（本机记录里是空的）';
  }

  // 导入 / 名单那一份与屏幕上这一份**不一致**时，如实把两句话都摆出来（不静默二选一）。
  let conflict = null;
  if (importedOne) {
    const sameLabel = Boolean(importedOne.label && tier?.label && importedOne.label === tier.label);
    // ⚠ 2026-09-29 **改（T1 审核 §4.2 抓到的次要缺陷）**：原来先要求**项数相等**
    //   （`importedOne...present.length === qualification.present.length`）再逐值比 ——
    //   于是"导入是**部分项**、且它有的那几项逐值都与本机相同"会被判成**冲突**，
    //   屏幕多印一句"名单那一份…"，看起来像两边打架，其实只是导入缺项。
    //   旧写法留档（别删）：`=== qualification.present.length && importedOne...present.every(...)`
    //   现在的口径：**导入有的每一项都与本机相同 ⇒ 不算冲突**（缺的项不是"不一致"，是"没有"；
    //   缺项本身已经在 `qualification.missing` 那一支里如实说过了，不在这里再说一遍）。
    //   今天链路碰不到（六项恒齐），但这是**对的口径**，不该靠"碰不到"活着。
    const importedPresent = importedOne.qualification.present;
    const sameValues = importedPresent.length > 0
      && importedPresent.every(
        (key) => qualification.values[key] === importedOne.qualification.values[key]);
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
    `天分：${tierLabel ?? '无档名'}（${reason}）`,
    `资质：${qualification.text || NO_VALUE}`,
    missing ? `缺项：${missing}` : null,
    conflict ? `名单那一份：${conflict.label ?? '（没有档名）'}${conflict.valuesText ? `（${conflict.valuesText}）` : ''}` : null,
    remedy ? `补救：${remedy}` : null,
  ].filter(Boolean).join('｜');

  return {
    status,                       // 'tier' | 'unresolved' | 'missing' | 'empty'
    tierLabel,
    tierKey: tier?.key ?? bandTier?.key ?? null,
    // 档名是**怎么**读出来的（判据/排障读它）：'as-is' = coach 那一份；'activation-band' = R04 的恢复读法。
    tierSource,
    band,
    tierReason: tier?.reason ?? bandTier?.reason ?? null,
    qualification,
    qualificationText: qualification.text,
    missingLabels: qualification.missingLabels,
    activatedLabels: qualification.activatedLabels,
    activatedCount: qualification.activatedCount,
    reason, remedy, conflict, title,
    // 屏幕上的这一份是"从哪儿来的"（判据与开发者抽屉读它；玩家看不见这些键）。
    source: 'local-record',
    // U01（2026-09-29）：**来源要不要标到屏幕上**。掷点来源必须标（§24/§31/§32）——
    // 卡片/行/焦点这些"一眼看过去"的地方没有空间展开整段说明，只标一个短后缀。
    rolled: rolledSource,
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
