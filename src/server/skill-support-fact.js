// 技能档位 → 玩家能读的一句**事实**（2026-09-30 从 `roco-service.js` 原样搬出）。
//
// **为什么要单独一个文件**：这四个件原来**写在 `roco-service.js` 的第 0 列，却嵌在
// `createRocoService` 体内**（括号配平实测净深度 **2**）⇒ 在那里写 `export` 是**非法语法**
// （`node --check` 报 `Unexpected token 'export'`）。⚠ **零缩进 ≠ 顶层** —— 判作用域要看括号配平，
// 不看缩进、也不看"首行 `^}`"。搬出来之后它们才是真正的模块级导出，判据可以直接 import 真实现
// （不必再经服务实例，也就不必重启 8765 才能验）。
//
// **只搬纯件**：`SKILL_SUPPORT_SETTLED` · `SUPPORT_INTERNAL` · `plainSupportClause` · `skillSupportFact`。
// 依赖实测：`skillSupportFact` 只用到前三个 + `String`（内建），**不依赖 service 实例、不依赖外层状态** ✓
// ⚠ **留在 `roco-service.js` 的**：`SKILL_SUPPORT_CACHE`（缓存）· `skillSupportOf`（要 `client`）·
// `attachSkillSupport`（要挂到 service 上）—— 它们要 service 实例，**不许搬**。
//
// 文案口径与留档注释**逐字未改**（改钉不删 ✓）。

export const SKILL_SUPPORT_SETTLED=new Set(['SIMULATABLE_UNVERIFIED','FULL_VERIFIED']);
//: 引擎内部说法不许进玩家文案（`support_unparsed` 命中这些片段时，退回一句通用说法）
export const SUPPORT_INTERNAL=/(未识别机制|机制词|原语|effect_support|unsupported|parse|coverage|认领)/i;

export function plainSupportClause(segments){
 for(const raw of (Array.isArray(segments)?segments:[])){
  let s=String(raw??'').trim();
  if(!s)continue;
  s=s.replace(/（[^）]*）/g,'').replace(/\([^)]*\)/g,'').trim();   // 去掉内部注解
  s=s.replace(/^[\u4e00-\u9fa5]{1,2}：/,'').trim();               // 去掉「变：」「每：」这类前置词
  if(!s||SUPPORT_INTERNAL.test(s))continue;                      // 内部说法：不进玩家文案
  const head=(s.split('、')[0]||s).trim();
  if(!head)continue;
  return [...head].length>22?`${[...head].slice(0,22).join('')}…`:head.replace(/[。；;]$/,'');
 }
 return null;
}

/** 引擎的档位记录 → 玩家能读的一句**事实**（不是建议）。
 * 2026-09-30（Lead 定案）：**「会结算」也是一条事实，不能返回 null**。
 * 以前这一支返回 `null` ⇒ `attachSkillSupport` 什么都不挂 ⇒ 前端**分不清「会结算」与「不知道」**，
 * 只能回落读静态 `effect_support`（引擎早就不再用它判结论）⇒ 玩家看到「引擎没有结算这条效果」，
 * 而战报里那一手明明结算了（报告 L19/L30 实测：防御 10→9 且减伤 70%）。这是 ㉛「三种空」的又一实例。
 * 所以：**真未知（没有档位）才 `null`**；**会结算 ⇒ 返回正面事实**（`settled:true`）。
 * 旧写法留档（改钉不删）：`if(!tier||SKILL_SUPPORT_SETTLED.has(tier))return null;`
 */
export function skillSupportFact(record){
 const tier=String(record?.support_tier??'');
 if(!tier)return null;
 if(SKILL_SUPPORT_SETTLED.has(tier))return {tier,settled:true,note:'引擎会结算这条效果。'};
 // ⚠⚠ 2026-09-29（人类实测 Q3②：「**齿轮切开 168 伤害 + 传动 1 已执行，UI 却说得点了不会生效**」）：
 //   旧文案「**点了不会生效**」是**错的** —— 真机实测（临时实例，1/2/3 号位各打一手）：
 //     · `damage` 事件照发（`power_used=130`）· `position_shift` 事件照发（`shift=1` + 顺序重排）；
 //     · **只有「1 号或 3 号位时能耗 -2」那一段没被结算**（三处能量都是 **-5** 全额，没有 -2）。
 //   ⇒ 档位 `KNOWLEDGE_ONLY` 本身**不冤**（确实有一段没实现），但**句子把"有一段没算"说成了"整招没用"**。
 //   改法：①**点名是哪一段**（复用下面那个 `plainSupportClause(record.support_unparsed)`，
 //   PARTIAL 那一支早就在用它、KNOWLEDGE_ONLY 这一支漏了）；②**不再声称整招不生效**。
 //   旧文案留档（改钉不删）：return {tier,note:'这招的效果引擎还不会算，点了不会生效'};
 if(tier==='KNOWLEDGE_ONLY'){
  const clause=plainSupportClause(record?.support_unparsed);
  return {tier,note:clause
   ? `这招点了照常出手（伤害按威力算），但「${clause}」这一段本机规则没有对应结算`
   : '这招点了照常出手（伤害按威力算），但有一部分说明本机规则没有对应结算'};
 }
 if(tier==='REFUSED')return {tier,note:'这招的效果缺少依据，引擎不会结算'};
 const clause=plainSupportClause(record?.support_unparsed);
 return {tier,note:clause?`这招有一部分引擎还不会算：${clause}`:'这招有一部分效果引擎还不会算'};
}
