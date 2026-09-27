// RC-802：开发者证据抽屉里**四类值各自与引擎/回执逐字一致**的判据（单一来源）。
//
// 为什么要有这个模块：RC-802 的剩余缺口原话是「`ruleset / support / latency / digest` 这四类各自
// 『抽屉里真的有、且值来自引擎』没有逐类判据（现在只证明了『抽屉默认收起 + 展开后能看到 fail-closed 凭据』）」。
// 判据写成**纯函数**（`problems(facts)`），于是两处共用同一份：浏览器套件
// （`scripts/roco/demo-acceptance.mjs` 读真页面 + 真回执）与单测
// （`tests/roco-dev-drawer.test.js` 拿合成事实做逐条反证）。
//
// 四类各自的**真值来源**（都在代码里指得出）：
//   · ruleset → 引擎公开视图 `view.ruleset_id` + `view.state_version`（`src/client/roco.js:740`）
//   · support → 模式注册表原文（`/api/roco/status` 转发 `data/roco/battle-modes.json`），
//     抽屉里两个落点：`#mode-raw`（JSON 原文）与 `#mode-probe`（同一份数字的摘要，`roco.js:696`）
//   · latency → `/api/roco/shadow` 回执的 `model.latency_ms`（本地小模型那一次的真实耗时）
//   · digest  → 同一回执的 `prompt_digest_pin`（发布评测那一份提示的摘要锚）
//
// 纪律：四类都**只读回执与 DOM**，一个数字都不自己造；对不上就是红，不许放宽。

const text = (v) => String(v ?? '').trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** ruleset：抽屉里那句「规则快照」必须逐字等于引擎公开视图的 `ruleset_id · 状态版本`。 */
export function rulesetProblems(facts = {}) {
  const bad = [];
  const id = text(facts.engineRulesetId);
  const version = num(facts.engineStateVersion);
  const shown = text(facts.rulesetText);
  if (!id) bad.push('引擎公开视图里没有 ruleset_id（读不到就无从核对，算红）');
  if (version === null) bad.push('引擎公开视图里没有 state_version（读不到就无从核对，算红）');
  if (!shown) bad.push('抽屉里的规则快照是空的');
  if (id && version !== null) {
    const want = `${id} · 本局状态版本 ${version}`;
    if (shown !== want) bad.push(`抽屉里写的是「${shown}」，引擎回执是「${want}」`);
  }
  // 写死的样例（README 里那种「roco-world-s4-2026-09-10」裸快照）必须被抓住
  if (id && shown === id) bad.push('只写了规则集 id、没有本局状态版本 —— 那是写死的样例，不是这一局的回执');
  return bad;
}

/**
 * support：`#mode-raw` 必须是注册表**原文**（逐字段一致），`#mode-probe` 的数字必须来自同一份。
 * `registry` 由 `/api/roco/status` 转发（`data/roco/battle-modes.json`）。
 */
export function registryProblems(facts = {}) {
  const bad = [];
  const registry = facts.registry;
  if (!registry || typeof registry !== 'object') return ['没读到模式注册表（/api/roco/status）—— 无真值可核对'];
  let shown = null;
  try { shown = JSON.parse(text(facts.modeRawText)); } catch { bad.push('抽屉里的注册表原文不是合法 JSON'); }
  if (shown && JSON.stringify(shown) !== JSON.stringify(registry)) {
    const keys = [...new Set([...Object.keys(shown), ...Object.keys(registry)])];
    const diff = keys.filter((k) => JSON.stringify(shown[k]) !== JSON.stringify(registry[k]));
    bad.push(`抽屉里的注册表与 /api/roco/status 不一致（字段：${diff.join('、') || '（顺序/嵌套）'}）`);
  }
  const probe = text(facts.modeProbeText);
  if (!probe) bad.push('`#mode-probe` 摘要是空的（工程口径的那一栏没生成）');
  const engineSize = num(registry.engine?.team_size);
  const declaredSize = num(registry.parameters?.team_size);
  if (engineSize !== null && declaredSize !== null) {
    if (!probe.includes(`引擎当前生效规模 ${engineSize} 只`)) bad.push(`摘要里没有「引擎当前生效规模 ${engineSize} 只」`);
    if (!probe.includes(`注册表登记规模 ${declaredSize} 只`)) bad.push(`摘要里没有「注册表登记规模 ${declaredSize} 只」`);
  }
  const unknowns = num(registry.unknowns_count);
  if (unknowns) {
    if (!probe.includes(`注册表登记的未核实项：${unknowns} 条`)) bad.push(`摘要里没有「未核实项：${unknowns} 条」`);
  }
  return bad;
}

/**
 * latency：本机小模型对照那一栏的「耗时 N ms」必须等于 `/api/roco/shadow` 回执的 `model.latency_ms`。
 * 回执说本地模型没跑成（`available:false`）时，页面**不许**显示任何耗时。
 */
export function latencyProblems(facts = {}) {
  const bad = [];
  const panel = text(facts.panelText);
  const available = facts.receiptAvailable !== false;
  const ms = num(facts.receiptLatencyMs);
  if (!available) {
    if (/耗时\s*\d+\s*ms/.test(panel)) bad.push('本地模型这次没跑成，页面却显示了耗时');
    return bad;
  }
  if (ms === null) bad.push('回执里没有 model.latency_ms —— 读不到就不许显示耗时（算红）');
  const match = /耗时\s*([\d.]+)\s*ms/.exec(panel);
  if (!match) { bad.push('对照栏里没有「耗时 N ms」这一项'); return bad; }
  if (ms !== null && Number(match[1]) !== ms) bad.push(`页面写「耗时 ${match[1]} ms」，回执是 ${ms} ms`);
  return bad;
}

/** digest：同一栏的「提示摘要 abcd…」必须是回执 `prompt_digest_pin` 的前 12 位。 */
export function digestProblems(facts = {}) {
  const bad = [];
  const panel = text(facts.panelText);
  const pin = text(facts.receiptDigestPin);
  if (!pin) return ['回执里没有 prompt_digest_pin —— 读不到就不许显示摘要（算红）'];
  const match = /提示摘要\s*([0-9a-fA-F]+)\s*…/.exec(panel);
  if (!match) { bad.push('对照栏里没有「提示摘要 …」这一项'); return bad; }
  const want = pin.slice(0, 12);
  if (match[1] !== want) bad.push(`页面写「提示摘要 ${match[1]}…」，回执前 12 位是「${want}」`);
  if (pin.length < 12) bad.push(`回执的 prompt_digest_pin 只有 ${pin.length} 位，取不出 12 位摘要`);
  return bad;
}

export const DEV_DRAWER_CHECKS = [
  {id: 'ruleset', label: '规则快照逐字来自引擎公开视图', problems: rulesetProblems},
  {id: 'support', label: '模式注册表原文与摘要逐字来自 /api/roco/status', problems: registryProblems},
  {id: 'latency', label: '对照栏的耗时逐值来自 /api/roco/shadow 回执', problems: latencyProblems},
  {id: 'digest', label: '对照栏的提示摘要逐值来自回执的 prompt_digest_pin', problems: digestProblems},
];
