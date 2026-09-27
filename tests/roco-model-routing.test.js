// RC-901 第一条切片：**云端只在「值这个钱」时才发**（`src/coach/model-routing.js`）。
//
// 规划出处：`docs/roadmap/MODEL-ROUTING-PLAN.md` §2.3 建议新增第 3 条 ——
//   「云端只在『值这个钱』时才发：判定条件写死为**可判定的三条** ——
//     ① 任务类型 ∈ {长复盘, 开放性提问, 局末教学}；② 4B 档不可用或置信不足；③ 预算还够（< 2500ms 余量）。
//     **反证**：把它降级成「一律先问云端」必须红（那会把 4B 的意义抹掉，也把延迟顶到秒级）。"
//
// 这一组钉四件事：
//   ① **任务类型映射**（计划里那三个名字与仓内 `runtime.js:2883` 的 `review|training|battle` 不是一个快照，
//      所以映射是显式的、要判据的）：teacher 档 / 明确要复盘 / 局末教学 / 陪练开放性提问 / 局内取舍；
//   ② 三条条件**逐条**都能单独把云端挡掉（每条一个用例，免得只测了"合起来能过"）；
//   ③ **反证**：把任务条件去掉（≡「一律先问云端」）⇒ `battle` 与 `fact` 也必须走云端 —— 这条断言必须红；
//   ④ 默认方向是**不发**（缺省参数一律 `useCloud:false`，与「未知 fail closed」同一条纪律）。
//
// 用法：`node --test tests/roco-model-routing.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {CLOUD_MIN_REMAINING_MS, CLOUD_TASKS, cloudDecision, taskLabelOf} from '../src/coach/model-routing.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLOUD_READY = {cloudConfigured: true, localAvailable: false, localRejected: false, remainingMs: 9000};

test('判据①：任务类型映射（teacher/复盘/局末教学/开放性提问/局内取舍）', () => {
  assert.deepEqual([...CLOUD_TASKS], ['review', 'lesson', 'open'], '值得花云端钱的任务类型是被钉住的');
  const cases = [
    [{role: 'teacher', message: '这局我输在哪？'}, 'review'],
    [{role: 'auto', message: '帮我复盘上一局'}, 'review'],
    [{role: 'teacher', message: '看看', hasFinishedMatch: true}, 'lesson'],
    [{role: 'companion', message: '我该练哪只？'}, 'open'],
    [{role: 'companion', message: '知道了'}, 'fact'],
    [{role: 'auto', message: '这回合该防御吗？'}, 'battle'],
    [{role: 'auto', message: '嗯'}, 'fact'],
  ];
  for (const [input, want] of cases) {
    assert.equal(taskLabelOf(input), want, `${JSON.stringify(input)} 应当是 ${want}`);
  }
  // 云端值不值：只有那三类值得
  for (const task of CLOUD_TASKS) {
    assert.equal(cloudDecision({...CLOUD_READY, task}).useCloud, true, `${task} 应当发云端`);
  }
  for (const task of ['battle', 'fact', 'training', null]) {
    const d = cloudDecision({...CLOUD_READY, task});
    assert.equal(d.useCloud, false, `${task} 不该发云端`);
    assert.equal(d.reason, 'task-not-cloud-worthy');
  }
});

test('判据②：三条条件逐条都能单独把云端挡掉（每条一个用例）', () => {
  // ① 任务类型
  assert.equal(cloudDecision({...CLOUD_READY, task: 'battle'}).conditions.task_is_cloud_worthy, false);
  // ② 本地可用 / 或它这轮被守卫判不合格 ⇒ 不必花云端钱（被拒则说明"置信不足"，要花）
  const localOk = cloudDecision({...CLOUD_READY, task: 'review', localAvailable: true});
  assert.equal(localOk.conditions.local_not_usable, false);
  assert.equal(localOk.reason, 'local-usable-this-turn');
  assert.equal(cloudDecision({...CLOUD_READY, task: 'review', localAvailable: true, localRejected: true}).useCloud,
    true, '本地被守卫拒 ⇒ 置信不足 ⇒ 该花云端钱');
  // ③ 预算（阈值写死 2500ms，边界要**严格大于**）
  assert.equal(cloudDecision({...CLOUD_READY, task: 'review', remainingMs: CLOUD_MIN_REMAINING_MS}).useCloud, false,
    '刚好等于 2500 不算"还够"');
  assert.equal(cloudDecision({...CLOUD_READY, task: 'review', remainingMs: CLOUD_MIN_REMAINING_MS + 1}).useCloud, true);
  assert.equal(cloudDecision({...CLOUD_READY, task: 'review', remainingMs: 0}).reason, 'budget-too-tight');
  // 硬前提：没有 key 就谈不上发不发
  assert.equal(cloudDecision({...CLOUD_READY, task: 'review', cloudConfigured: false}).reason, 'cloud-not-configured');
});

test('判据③：默认方向是「不发」（缺省参数不许悄悄变成先问云端）', () => {
  const bare = cloudDecision();
  assert.equal(bare.useCloud, false);
  assert.equal(bare.reason, 'cloud-not-configured');
  // ⚠ `local_not_usable: true` 是**对的**：缺省参数下本地档"不可用"这件事成立，
  // 它表示"这一条不挡云端"；真正挡下的是另外三条（没 key / 任务不值 / 预算没余量）。
  assert.deepEqual(bare.conditions, {cloud_configured: false, task_is_cloud_worthy: false,
    local_not_usable: true, budget_left: false});
  assert.deepEqual(bare.thresholds, {cloud_tasks: [...CLOUD_TASKS], min_remaining_ms: CLOUD_MIN_REMAINING_MS});
});

test('判据④（反证）：把任务条件去掉 ≡「一律先问云端」⇒ 局内取舍与事实短问也会发云端（这条必须红）', () => {
  // 「一律先问云端」= 只看 cloudConfigured（不看 task）——把三条里最省事的那条抹掉。
  const alwaysCloud = (args) => args.cloudConfigured === true;
  for (const task of ['battle', 'fact']) {
    const decided = cloudDecision({...CLOUD_READY, task}).useCloud;
    assert.equal(decided, false, `${task} 必须被任务条件挡下`);
    assert.equal(alwaysCloud({...CLOUD_READY, task}), true,
      '反证本身要成立：抹掉任务条件之后这两类会发云端 ⇒ 上面那条断言就是这道闸门的牙');
  }
});

test('判据⑤（接线）：服务端真的用这个决策选 provider，且默认（local=off）行为不变', () => {
  const src = readFileSync(join(ROOT, 'src', 'server', 'index.js'), 'utf8');
  assert.match(src, /from '\.\.\/coach\/model-routing\.js'/, '服务端必须导入这个纯函数（不许在服务里现算）');
  assert.match(src, /cloudDecision\(/, '服务端必须真的调用它');
  assert.match(src, /taskLabelOf\(/, '任务类型必须由 `taskLabelOf` 落，不许在服务里另写一份正则');
  // 默认档：`localModelMode()` 是 off 时不许改变 provider —— 这一点由模式判断兜住
  assert.match(src, /if\s*\(mode\s*===\s*'off'\s*\|\|\s*!base\)\s*return base;/,
    'off 档必须原样返回 base（默认行为逐字节不变）');
});
