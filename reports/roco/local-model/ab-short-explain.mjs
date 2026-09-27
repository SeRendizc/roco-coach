// 「短解释」对照臂：同一批**真实证据包**上跑 4B 与 DeepSeek，用产品自己的守卫当判据。
//
// 为什么提示词是「规则模板正文」而不是别的：产品在 `on` 档下就是这么调本地模型的
// （`src/server/index.js` 的 `applyLocalModel` → `wrapWithLocalModel` →
// `model.generate({prompt: packet.text})`，`packet.text` 是规则模板渲染出来的正文）。
// 所以这一批提示不是编的：每一条都由**产品自己的 runtime** 产出
// （`buildContext` + `runCoach(provider: localProvider)`），
// 两条臂拿到的是**逐字节相同**的 prompt、相同的 max_tokens、相同 temperature。
//
// 四条判据跑之前钉死（程序判定，不是人工打分）：
//   J1 nonempty   非空
//   J2 chat_limit 可见字符 ≤180（产品 system prompt 的硬性要求）
//   J3 one_sentence 句末标点 ≤1（人类本轮口径「短解释（≤1 句）」）
//   J4 grounded   过产品自己的 `checkGroundedAnswer`（数字/引用/确定性守卫）
//
// 规则模板作为第三条臂（`rule_template`）：它就是 prompt 本身，
// 于是「模型有没有比模板更好」可以直接逐条配对，而不是靠印象。
//
// 用法：
//   node reports/roco/local-model/ab-short-explain.mjs --gateway http://127.0.0.1:8799 \
//     --out /tmp/roco-4b/short-explain.jsonl

import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createGame, legalActions, resolveTurn, chooseEnemy, active, SKILLS, damage} from '../../../src/game/engine.js';
import {stageOptions} from '../../../src/game/content.js';
import {newProfile} from '../../../src/game/progression.js';
import {freshMemory} from '../../../src/coach/memory.js';
import {buildContext, runCoach, localProvider, checkGroundedAnswer, checkReceiptConsistency} from '../../../src/coach/runtime.js';
import {gatewayAsk, deepseekAsk} from '../../../scripts/roco/local-model-ask.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 与 `scripts/eval-live-s04.js` 同源的三个局面工厂（那里没有导出，这里按同样的公开 API 重建）。 */
const bestDamage = (game) => {
  const p = active(game, 'player'); const q = active(game, 'enemy');
  const list = legalActions(game).filter((a) => a.kind === 'skill' && SKILLS[a.id].power)
    .map((a) => ({a, d: damage(p, q, SKILLS[a.id])})).sort((x, y) => y.d - x.d);
  if (list.length) return list[0].a;
  return legalActions(game).filter((a) => a.kind !== 'escape').find((a) => a.kind === 'skill' && a.id === 'guard')
    || legalActions(game).filter((a) => a.kind !== 'escape')[0];
};
function playTurns(game, turns) {
  for (let i = 0; i < turns && !game.result; i += 1) {
    if (game.phase === 'replace') { game = resolveTurn(game, legalActions(game)[0], null); continue; }
    const action = bestDamage(game);
    if (!action) break;
    game = resolveTurn(game, action, chooseEnemy(game));
  }
  return game;
}

const CASES = [
  {id: 'camp-01', kind: 'camp', message: '这回合我该练谁？'},
  {id: 'camp-02', kind: 'camp', message: '简单说一句，现在该干什么。'},
  {id: 'camp-03', kind: 'camp', message: '我的队伍有没有问题？'},
  {id: 'camp-04', kind: 'camp', message: '寂灭骨龙的种族值是多少？'},
  {id: 'mid-01', kind: 'mid', message: '这回合该怎么打？'},
  {id: 'mid-02', kind: 'mid', message: '简单说一句现在该怎么办。'},
  {id: 'mid-03', kind: 'mid', message: '我该不该换人？'},
  {id: 'mid-04', kind: 'mid', message: '我的宠物还剩多少血？'},
  {id: 'mid2-01', kind: 'mid2', message: '这回合该怎么打？'},
  {id: 'mid2-02', kind: 'mid2', message: '对手有两只，先打哪只？'},
  {id: 'mid2-03', kind: 'mid2', message: '简单说一句现在该怎么办。'},
  {id: 'pvp-01', kind: 'pvpLive', message: '这回合该怎么打？'},
  {id: 'pvp-02', kind: 'pvpLive', message: '简单说一句现在该怎么办。'},
  {id: 'pvp-03', kind: 'pvpLive', message: '我该不该换人？'},
  {id: 'pvp-04', kind: 'pvpLive', message: '现在谁占优？'},
  {id: 'open-01', kind: 'open', message: '这回合该怎么打？'},
  {id: 'open-02', kind: 'open', message: '简单说一句现在该怎么办。'},
  {id: 'late-01', kind: 'late', message: '这回合该怎么打？'},
  {id: 'late-02', kind: 'late', message: '刚才那回合发生了什么？'},
  {id: 'late-03', kind: 'late', message: '简单说一句现在该怎么办。'},
];

const profile = newProfile();
export function buildPacket(kind, message) {
  if (kind === 'camp') {
    const camp = createGame(17, ['fox', 'turtle', 'deer'], {mode: 'camp'});
    return buildContext(camp, profile, 'fox', null, 'meadow', message);
  }
  if (kind === 'open') {
    const g = createGame(17, ['fox', 'turtle', 'deer'], {mode: 'pve', ...stageOptions('meadow'), difficulty: 'normal'});
    return buildContext(g, profile, 'fox', null, 'meadow', message);
  }
  if (kind === 'late') {
    const g = playTurns(createGame(18, ['fox', 'turtle', 'deer'], {mode: 'pve', ...stageOptions('meadow'), difficulty: 'normal'}), 8);
    return buildContext(g, profile, 'fox', null, 'meadow', message);
  }
  if (kind === 'mid') {
    const g = playTurns(createGame(17, ['fox', 'turtle', 'deer'], {mode: 'pve', ...stageOptions('meadow'), difficulty: 'normal'}), 9);
    const p = active(g, 'player');
    p.hp = Math.max(12, Math.round(p.maxHp * 0.42)); p.energy = 2;
    g.enemy.items.potion = 1; g.player.items.potion = 2; g.player.items.ether = 1;
    return buildContext(g, profile, 'fox', null, 'meadow', message);
  }
  if (kind === 'mid2') {
    const g = playTurns(createGame(71, ['lion', 'shroom', 'otter'], {mode: 'pve', ...stageOptions('embers'), difficulty: 'hard'}), 12);
    const enemies = g.enemy.pets.filter((x) => x.hp > 0);
    if (enemies.length > 1) enemies[1].hp = Math.max(6, Math.round(enemies[1].maxHp * 0.2));
    g.enemy.pets[g.enemy.active].status = {kind: 'burn', remaining: 2};
    return buildContext(g, profile, 'lion', null, 'embers', message);
  }
  if (kind === 'pvpLive') {
    const g = playTurns(createGame(17, ['fox', 'turtle', 'deer'], {mode: 'pve', ...stageOptions('meadow'), difficulty: 'normal'}), 9);
    return {...buildContext(g, profile, 'fox', null, 'meadow', message), mode: 'pvp-live'};
  }
  throw new Error(`未知局面：${kind}`);
}

/** 可见字符数：去掉空白，中文一字算一个。 */
export const visibleLength = (text) => [...String(text ?? '').replace(/\s+/g, '')].length;
/** 句末标点计数（。！？!?…）——「≤1 句」这个口径的**程序**读法。 */
export const sentenceCount = (text) => (String(text ?? '').match(/[。！？!?]+/g) || []).length;

export function judge({text, packet, templateText}) {
  const reasons = [];
  const body = String(text ?? '');
  if (!body.trim()) reasons.push('J1-empty');
  const len = visibleLength(body);
  if (len > 180) reasons.push(`J2-chat-limit:${len}`);
  const sentences = sentenceCount(body);
  if (sentences > 1) reasons.push(`J3-multi-sentence:${sentences}`);
  const grounded = checkGroundedAnswer({...packet, text: body});
  if (!grounded.valid) reasons.push(...grounded.reasons.map((r) => `J4-${r}`));
  // 产品**真正**的接受/拒绝规则（`src/coach/runtime.js:141-143` 逐字对齐）：
  //   tooLong = text.length > 360；否则 receipt-inconsistent；否则 ungrounded。
  // 被拒 ⇒ 玩家看到的是 `packet.text`，provider 变成 'local-fallback'。
  // 这一条比 J1..J4 都硬：它决定「4B 的这段文字会不会被产品自己扔掉」。
  const consistency = checkReceiptConsistency({...packet, text: body});
  const tooLong = body.length > 360;
  const rejectedReason = tooLong ? 'too-long'
    : !consistency.consistent ? 'receipt-inconsistent'
      : !grounded.valid ? 'ungrounded' : null;
  return {passed: reasons.length === 0, reasons: [...new Set(reasons)],
    chars: len, raw_chars: body.length, sentences,
    production: {too_long: tooLong, receipt_consistent: consistency.consistent,
      grounded: grounded.valid, rejected: rejectedReason !== null, rejected_reason: rejectedReason,
      grounded_reasons: grounded.reasons, consistency_reasons: consistency.reasons},
    identical_to_template: body.trim() === String(templateText ?? '').trim()};
}

function args(argv) {
  const out = {gateway: null, out: null, cloud: true, quiet: false};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--gateway') out.gateway = String(argv[++i]);
    else if (argv[i] === '--out') out.out = String(argv[++i]);
    else if (argv[i] === '--no-cloud') out.cloud = false;
    else if (argv[i] === '--quiet') out.quiet = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return out;
}

async function main() {
  const options = args(process.argv.slice(2));
  const gateway = options.gateway || `http://127.0.0.1:${process.env.ROCO_LOCAL_PORT || 8766}`;
  const local = gatewayAsk(gateway);
  const cloud = options.cloud
    ? deepseekAsk({apiKey: process.env.DEEPSEEK_API_KEY})
    : null;
  const rows = [];
  for (const spec of CASES) {
    const context = buildPacket(spec.kind, spec.message);
    // 产品自己的模板正文：既是 prompt，也是 `rule_template` 臂的输出。
    const template = await runCoach({message: spec.message, role: 'auto', context,
      memory: freshMemory(), conversation: [], provider: localProvider});
    const packet = template;
    const prompt = template.text;
    const base = {case_id: spec.id, kind: spec.kind, message: spec.message, prompt,
      packet_chars: visibleLength(prompt), evidence_count: (packet.evidence || []).length,
      template_text: prompt};
    rows.push({...base, arm: 'rule_template', ok: true, wall_ms: 0, text: prompt,
      judge: judge({text: prompt, packet, templateText: prompt})});
    for (const [arm, ask, budget] of [['local_4b', local, 8000], ['cloud_deepseek', cloud, 30000]]) {
      if (!ask) continue;
      const started = Date.now();
      try {
        const reply = await ask({prompt, maxTokens: 256, temperature: 0, timeoutMs: budget});
        rows.push({...base, arm, ok: true, wall_ms: Date.now() - started, text: reply.text,
          usage: reply.usage ?? null, upstream_model: reply.model ?? null,
          judge: judge({text: reply.text, packet, templateText: prompt})});
      } catch (error) {
        rows.push({...base, arm, ok: false, wall_ms: Date.now() - started,
          error_code: error?.code || 'unknown', error: String(error?.message || error).slice(0, 200),
          judge: {passed: false, reasons: [`ask-failed:${error?.code || 'unknown'}`], chars: 0, sentences: 0,
            identical_to_template: false}});
      }
    }
    if (!options.quiet) process.stderr.write(`[short-explain] ${spec.id} 完成（${rows.length} 行）\n`);
  }
  const out = options.out || join('/tmp', 'roco-4b', 'short-explain.jsonl');
  mkdirSync(dirname(out), {recursive: true});
  writeFileSync(out, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const byArm = {};
  for (const row of rows) {
    const bucket = byArm[row.arm] || (byArm[row.arm] = {rows: 0, asked: 0, failed: 0, passed: 0, reasons: {}});
    bucket.rows += 1;
    if (row.arm !== 'rule_template') { bucket.asked += 1; if (!row.ok) bucket.failed += 1; }
    if (row.judge.passed) bucket.passed += 1;
    if (row.arm !== 'rule_template') {
      bucket.production_rejected = (bucket.production_rejected || 0) + (row.judge.production?.rejected ? 1 : 0);
      bucket.production_grounded = (bucket.production_grounded || 0) + (row.judge.production?.grounded ? 1 : 0);
      bucket.production_receipt_consistent = (bucket.production_receipt_consistent || 0)
        + (row.judge.production?.receipt_consistent ? 1 : 0);
      const key = row.judge.production?.rejected_reason;
      if (key) { bucket.rejected_reasons = bucket.rejected_reasons || {}; bucket.rejected_reasons[key] = (bucket.rejected_reasons[key] || 0) + 1; }
    }
    for (const reason of row.judge.reasons) {
      const key = reason.replace(/:.*$/, '');
      bucket.reasons[key] = (bucket.reasons[key] || 0) + 1;
    }
  }
  process.stdout.write(`${JSON.stringify({cases: CASES.length, by_arm: byArm, written_to: out}, null, 1)}\n`);
}

const invokePath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokePath) {
  main().catch((error) => { process.stderr.write(`[short-explain] 失败：${error?.stack || error}\n`); process.exit(1); });
}
