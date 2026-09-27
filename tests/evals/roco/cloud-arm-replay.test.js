// 云臂（DeepSeek）**离线回放**门禁：不联网、不花钱，复验「事实守卫 + 臂身份 + 回执完整性」。
//
// 为什么单独一条：`scripts/eval-live-s04.js` 的 44 条预注册判据要真调 DeepSeek，
// 它**不在 24 套门禁里** ⇒ 云臂输出质量没有任何自动化守卫（人类 2026-09-25：
// 「无预算限制，但也不要浪费」+「做真 agentic 的东西」）。这一条把「真跑一次」换成
// 「回放可提交的**合成**样本」：判据照跑，网络一次都不发，且**没命中指纹就抛错**。
//
// 合成样本：`tests/evals/fixtures/cloud-arm/synthetic-deepseek.json`（手写，不是模型输出）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkGroundedAnswer} from '../../../src/coach/runtime.js';
import {CloudReplayMissError, fingerprintOf, makeReplayFetch, materializeStore}
  from '../../../src/coach/cloud-replay.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURE = join(ROOT, 'tests/evals/fixtures/cloud-arm/synthetic-deepseek.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

/** 建一个临时 store 目录，把合成样本物化进去（键由 `fingerprintOf()` 现算，绝不手写哈希）。
 *  ⚠ 必须 async 且**在 await 之后再删目录**：同步版会在 async 回调真正跑之前把 store 删掉 ——
 *  第一版就是这样红的（四个用例全报「未命中指纹」，而模块本身单独跑是命中的）。 */
async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'roco-cloud-arm-'));
  try {
    const entries = materializeStore(fixture.entries, dir);
    return await fn(dir, entries);
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

/**
 * 被回放的样本对应的那条请求（url + 请求体）。
 * 两种形状都要认：**fixture 形状**（`request.messages` + `request.params`）与
 * `materializeStore()` 物化后的**store 形状**（`request.body` 已经是完整请求体）。
 */
const bodyOf = (e) => e.request?.body
  ?? {model: e.model, messages: e.request?.messages ?? [], ...(e.request?.params ?? {})};

/** 引擎给的事实（判据的 evidence 侧）。**故意与正文解耦** —— 从正文里取 evidence 会让判据自我实现。 */
const ENGINE_EVIDENCE = ['第 3 回合：你的宠物还剩 442 血', '对手现在剩 318 血'];

/**
 * 云臂判据（这一条测试的**判据本体**，4 个反证都打在它身上）：
 *   ① 臂身份必须是 deepseek（回放里的 `provider` 是被录制下来的那一栏，不许拿别的臂的响应冒充云臂）；
 *   ② 回执必须带 `usage`（否则不能证明这是一次真调用 —— 合成样本也必须照这条走）；
 *   ③ 正文必须过产品自己的事实守卫 `checkGroundedAnswer`（数字白名单在本仓是**真守卫**）。
 * 返回 problems[]（空 = 通过）。
 */
function judgeCloudArm({provider, text, usage, evidence = []}) {
  const problems = [];
  if (provider !== 'deepseek') {
    problems.push(`臂身份不对：provider=${JSON.stringify(provider)} —— 云臂回放只认 deepseek（别的臂的响应不许冒充云臂证据）`);
  }
  if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens)) {
    problems.push(`回执里没有 usage（${JSON.stringify(usage ?? null)}）—— 不能证明这是一次真调用`);
  }
  const guard = checkGroundedAnswer({text, evidence});
  if (!guard.valid) problems.push(`事实守卫判不合格：${guard.reasons.join('/')}`);
  return problems;
}

/** 走一遍「回放 → 取正文 → 判据」，返回可逐字节比较的结果（两遍比对用）。 */
async function replayOnce(dir, entry, {fetchImpl} = {}) {
  const replay = makeReplayFetch({dir, fetchImpl});
  const response = await replay.fetchImpl(entry.url, {
    method: 'POST', headers: {Authorization: 'Bearer sk-fixture-not-real', 'Content-Type': 'application/json'},
    body: JSON.stringify(bodyOf(entry)),
  });
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const usage = data.usage ?? null;
  return {
    status: response.status, text, usage,
    problems: judgeCloudArm({provider: entry.provider, text, usage, evidence: ENGINE_EVIDENCE}),
    stats: replay.stats, fingerprint: fingerprintOf({url: entry.url, body: bodyOf(entry)}),
  };
}

test('① 合成样本命中指纹 → 回放成功；同一 fixture 跑两遍逐字节相同', async () => {
  await withStore(async (dir, entries) => {
    const first = await replayOnce(dir, entries[0]);
    const second = await replayOnce(dir, entries[0]);
    assert.equal(first.status, 200);
    assert.ok(first.text.includes('442'), `回放正文应含样本里的数字：${first.text}`);
    assert.deepEqual(first.problems, [], `判据必须全过，实际：${first.problems.join(' | ')}`);
    assert.equal(first.stats.hits, 1);
    assert.equal(first.stats.misses, 0);
    // 逐字节可复现：把两遍结果序列化后必须完全相同（不含时间戳的东西）
    assert.equal(JSON.stringify({...first, stats: null}), JSON.stringify({...second, stats: null}),
      '同一 fixture 两遍回放必须逐字节相同');
  });
});

test('② 未命中指纹 → 必须抛错，且**绝不回落真网络**', async () => {
  await withStore(async (dir, entries) => {
    let networkCalls = 0;
    const spy = async () => { networkCalls += 1; throw new Error('不该走到真网络'); };
    const replay = makeReplayFetch({dir, fetchImpl: spy});
    // 同一个 url、**不同的 messages**（合成样本里没有这一条）
    const miss = entries[0].url;
    const missBody = {model: entries[0].model,
      messages: [{role: 'user', content: '这条请求在录制里不存在'}],
      max_tokens: 64, stream: false, thinking: {type: 'disabled'}};
    await assert.rejects(() => replay.fetchImpl(miss, {method: 'POST', body: JSON.stringify(missBody)}),
      (error) => {
        assert.ok(error instanceof CloudReplayMissError, `要抛 CloudReplayMissError，实际 ${error?.name}`);
        assert.equal(error.code, 'CLOUD_REPLAY_MISS');
        assert.match(error.message, /不许回落到真网络/);
        return true;
      });
    assert.equal(networkCalls, 0, '未命中时一次真网络调用都不许发生');
  });
});

test('③ 反证：把 fixture 的 provider 改掉 → 同一条判据必须红', async () => {
  await withStore(async (dir, entries) => {
    const good = await replayOnce(dir, entries[0]);
    assert.deepEqual(good.problems, [], '先确认健康样本是绿的（否则反证自己是空的）');
    const tampered = await replayOnce(dir, {...entries[0], provider: 'local'});
    assert.ok(tampered.problems.length > 0, '把 provider 改成 local 之后判据必须报问题');
    assert.match(tampered.problems.join(' | '), /臂身份不对/);
  });
});

test('④ 反证：把一条响应换成「含未登记数字」的正文 → 同一条判据必须红', async () => {
  await withStore(async (dir, entries) => {
    const entry = entries[0];
    const fixtureEntry = fixture.entries[0];
    const tamperedDir = mkdtempSync(join(tmpdir(), 'roco-cloud-arm-bad-'));
    try {
      materializeStore([{...fixtureEntry,
        response: {status: 200, body: {...fixtureEntry.response.body,
          choices: [{index: 0, message: {role: 'assistant',
            content: '第 3 回合：这一手能打 999 伤害，直接带走。'}, finish_reason: 'stop'}]}}}], tamperedDir);
      const bad = await replayOnce(tamperedDir, entry);
      assert.ok(bad.problems.length > 0, '塞了未登记数字的正文必须被判红');
      assert.match(bad.problems.join(' | '), /unsupported-number:999/);
    } finally { rmSync(tamperedDir, {recursive: true, force: true}); }
  });
});
