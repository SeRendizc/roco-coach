// 本地模型部署的守卫测试。
//
// 这组测试**不加载权重**：用可注入的假子进程覆盖真实会发生的失败路径
// （超时 / 进程崩溃 / 并发打满 / 上游返回失败 / 客户端取消），并断言
// 「一定会回退」这件事真的成立。
//
// 为什么必须测这些：局内不能因为本地模型慢或挂了就卡住玩家。
// 一条只在理想路径上测过的本地模型接入，等于把「模型可用」当成前提——
// 那是这个项目最不该犯的错。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

import {readFileSync as read} from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const {LocalModel, createLocalProvider, localModelMode, wrapWithLocalModel, createLocalPlan} = await import('../../src/coach/local-model.js');
const {LocalModelGateway, createGatewayServer} = await import('../../scripts/model/local-gateway.mjs');
const {verifyModel, loadManifest} = await import('../../scripts/model/verify-manifest.mjs');

/** 一个可控的假推理子进程：能按时回包、能不回包、能中途死掉。 */
function fakeChild({mode = 'ok', delayMs = 5} = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // 真实子进程的流有 setEncoding；假流也要有，否则会测到「真实现没处理这个调用」
  // 而不是被测行为本身。
  child.stdout.setEncoding = () => child.stdout;
  child.stderr.setEncoding = () => child.stderr;
  child.stdin = {
    writes: [],
    write(line) {
      const payload = JSON.parse(line);
      this.writes.push(payload);
      if (mode === 'silent') return true;
      if (mode === 'die') { setTimeout(() => child.emit('exit', 1, null), delayMs); return true; }
      setTimeout(() => {
        child.stdout.emit('data', `${JSON.stringify({
          id: payload.id, ok: true, text: '规则为准。', prompt_tokens: 10, completion_tokens: 4,
          first_token_ms: 120, total_ms: 180, tokens_per_second: 22, peak_memory_gb: 2.4,
          memory_source: 'mlx-peak', stop_reason: 'stop',
        })}\n`);
      }, delayMs);
      return true;
    },
    // 真实进程在 stdin EOF 时会自己退出（serve_mlx 的 for-line 循环结束）。
    // 假流也照做：否则每个测试都要等 3 秒的 SIGKILL 兜底，
    // 测出来的「慢」是测试装置的，不是实现的。
    end() { setTimeout(() => child.emit('exit', 0, null), 1); return true; },
  };
  child.kill = () => { child.emit('exit', 0, 'SIGTERM'); return true; };
  return child;
}

function fakeSpawn(options) {
  const child = fakeChild(options);
  // 立刻报 ready（真实进程会先打印一行 ready 日志）
  setTimeout(() => child.stderr.emit('data', '{"event": "ready", "load_seconds": 1}\n'), 1);
  return child;
}

test('feature flag 默认关闭：没设置时不会走本地模型', () => {
  assert.equal(localModelMode({}), 'off');
  assert.equal(localModelMode({ROCO_LOCAL_MODEL: ''}), 'off');
  assert.equal(localModelMode({ROCO_LOCAL_MODEL: 'on'}), 'on');
  assert.equal(localModelMode({ROCO_LOCAL_MODEL: 'shadow'}), 'shadow');
  assert.equal(localModelMode({ROCO_LOCAL_MODEL: '莫名其妙'}), 'off', '未知取值必须保守地当成关闭');
});

test('超时不是异常：到点必须 reject 并把这次计成 timeout', async () => {
  const model = new LocalModel({spawnImpl: () => fakeSpawn({mode: 'silent'})});
  await model.start();
  await assert.rejects(() => model.generate({prompt: 'x', timeoutMs: 60}),
    (error) => error.code === 'timeout');
  assert.equal(model.stats.timeouts, 1);
  assert.equal(model.stats.ok, 0);
  await model.stop();
});

test('推理进程崩溃时在途请求立刻失败，而不是各自等满超时', async () => {
  const model = new LocalModel({spawnImpl: () => fakeSpawn({mode: 'die', delayMs: 10})});
  await model.start();
  const started = Date.now();
  await assert.rejects(() => model.generate({prompt: 'x', timeoutMs: 5000}),
    (error) => error.code === 'crashed' || error.code === 'upstream-exit');
  // 关键：远小于 5000ms 预算就返回了
  assert.ok(Date.now() - started < 1000, '崩溃后应当立刻失败');
  await model.stop();
});

test('取消（AbortSignal）也要立刻释放，不等超时', async () => {
  const model = new LocalModel({spawnImpl: () => fakeSpawn({mode: 'silent'})});
  await model.start();
  const controller = new AbortController();
  const pending = model.generate({prompt: 'x', timeoutMs: 5000, signal: controller.signal});
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => pending, (error) => error.code === 'cancelled');
  assert.equal(model.stats.cancelled, 1);
  await model.stop();
});

test('上游返回 ok=false 时要如实变成错误，不能返回空字符串冒充成功', async () => {
  const model = new LocalModel({spawnImpl: () => {
    const child = fakeChild({mode: 'silent'});
    child.stdin.write = function fail(line) {
      const payload = JSON.parse(line);
      setTimeout(() => child.stdout.emit('data', `${JSON.stringify({
        id: payload.id, ok: false, error_type: 'bad_request', message: 'max_tokens 非法',
      })}\n`), 2);
      return true;
    };
    setTimeout(() => child.stderr.emit('data', '{"event": "ready"}\n'), 1);
    return child;
  }});
  await model.start();
  await assert.rejects(() => model.generate({prompt: 'x'}), (error) => error.code === 'bad_request');
  await model.stop();
});

test('provider 一定会回退，并且把回退原因留在 lastFallback', async () => {
  const model = new LocalModel({spawnImpl: () => fakeSpawn({mode: 'silent'})});
  await model.start();
  const provider = createLocalProvider({
    model,
    fallback: (packet) => `本地模板：${packet.text.slice(0, 4)}`,
  });
  const text = await provider.generate({text: '请解释这一手'});
  assert.match(text, /^本地模板：/);
  assert.equal(provider.lastFallback.code, 'timeout');
  assert.equal(provider.name, 'mlx-local');
  await model.stop();
});

test('provider 在本地可用时返回模型输出，并清掉上一次的回退记录', async () => {
  const model = new LocalModel({spawnImpl: () => fakeSpawn({mode: 'ok'})});
  await model.start();
  const provider = createLocalProvider({model, fallback: () => '模板'});
  provider.lastFallback = {code: 'timeout'};
  const text = await provider.generate({text: '问一句'});
  assert.equal(text, '规则为准。');
  assert.equal(provider.lastFallback, null);
  await model.stop();
});

test('没有 fallback 就不允许构造 provider：降级路径是必填的', () => {
  assert.throws(() => createLocalProvider({model: {}}), /fallback/);
});

test('网关：OpenAI 形状的响应带 x_roco 的延迟与内存字段', async () => {
  const gateway = new LocalModelGateway({spawnImpl: () => fakeSpawn({mode: 'ok'}), timeoutMs: 2000});
  await gateway.start();
  const server = createGatewayServer(gateway);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({messages: [{role: 'user', content: '规则是什么'}], max_tokens: 32}),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.choices[0].message.content, '规则为准。');
  assert.equal(payload.usage.prompt_tokens, 10);
  assert.equal(payload.x_roco.first_token_ms, 120);
  assert.equal(payload.x_roco.peak_memory_gb, 2.4);
  // 健康检查里应当能看到这一次的延迟
  const health = gateway.health();
  assert.equal(health.latest.total_ms, 180);
  assert.equal(health.counters.ok, 1);
  server.close();
  await gateway.stop();
});

test('网关：超时返回 504 且形状是 error.type=timeout，而不是 200', async () => {
  const gateway = new LocalModelGateway({spawnImpl: () => fakeSpawn({mode: 'silent'}), timeoutMs: 80});
  await gateway.start();
  const server = createGatewayServer(gateway);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({messages: [{role: 'user', content: 'x'}]}),
  });
  const payload = await response.json();
  assert.equal(response.status, 504);
  assert.equal(payload.error.type, 'timeout');
  server.close();
  await gateway.stop();
});

test('网关：并发打满时快速失败为 429，不无限排队', async () => {
  const gateway = new LocalModelGateway({spawnImpl: () => fakeSpawn({mode: 'silent'}),
    timeoutMs: 500, maxConcurrency: 1, maxQueue: 1});
  await gateway.start();
  const server = createGatewayServer(gateway);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const call = () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({messages: [{role: 'user', content: 'x'}], timeout_ms: 400}),
  });
  const results = await Promise.all([call(), call(), call(), call()]);
  const statuses = results.map((r) => r.status).sort();
  assert.ok(statuses.includes(429), `应当有请求被快速拒绝，实际 ${statuses}`);
  server.close();
  await gateway.stop();
});

test('网关：stream=true 明确 501，不假装支持', async () => {
  const gateway = new LocalModelGateway({spawnImpl: () => fakeSpawn({mode: 'ok'})});
  await gateway.start();
  const server = createGatewayServer(gateway);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({messages: [{role: 'user', content: 'x'}], stream: true}),
  });
  const payload = await response.json();
  assert.equal(response.status, 501);
  assert.equal(payload.error.code, 'stream_unsupported');
  server.close();
  await gateway.stop();
});

test('manifest 校验必须真的比 SHA256：改一个字节就要报错', async () => {
  const manifest = loadManifest();
  const entry = manifest.models[0];
  const ok = await verifyModel(entry);
  assert.equal(ok.ok, true, ok.problems.join('；'));
  assert.ok(ok.checked > 0);
  // 反证：伪造一个错误的 sha256，必须被发现
  const tampered = {...entry, files: {...entry.files,
    'config.json': {...entry.files['config.json'], sha256: 'a'.repeat(64)}}};
  const bad = await verifyModel(tampered);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.join(' ').includes('SHA256'));
});

test('manifest 里登记的许可证与来源是必需的，缺了要报错', async () => {
  const manifest = loadManifest();
  const entry = manifest.models[0];
  assert.equal(entry.license, 'apache-2.0');
  assert.match(entry.source, /^https:\/\/huggingface\.co\//);
  assert.ok(entry.revision, '必须钉住 revision，否则「同一份权重」无法复现');
  const stripped = {...entry, license: undefined};
  const bad = await verifyModel(stripped, {root: ROOT});
  assert.equal(bad.ok, false);
});

test('工具选择：不认识的工具名一律当作「停止」，而不是猜一个', async () => {
  const model = {generate: async () => ({text: '{"tool":"drop_database","args":{}}'})};
  const plan = createLocalPlan({model, tools: ['read_evidence', 'search_rules']});
  const choice = await plan.plan({message: '查一下', receipts: []});
  assert.deepEqual(choice, {stop: true});
  assert.equal(plan.lastDecision.reason, 'unknown-tool');
});

test('工具选择：输出不是 JSON、或模型超时，都退化成停止', async () => {
  const garbage = createLocalPlan({model: {generate: async () => ({text: '我觉得应该查一下规则'})},
    tools: ['read_evidence']});
  assert.deepEqual(await garbage.plan({message: 'x', receipts: []}), {stop: true});
  assert.equal(garbage.lastDecision.reason, 'unparseable');

  const broken = createLocalPlan({model: {generate: async () => {
    throw Object.assign(new Error('本地模型忙'), {code: 'busy'});
  }}, tools: ['read_evidence']});
  assert.deepEqual(await broken.plan({message: 'x', receipts: []}), {stop: true});
  assert.equal(broken.lastDecision.reason, 'busy');
});

test('工具选择：合法输出要真的变成一次调用', async () => {
  const model = {generate: async () => ({text: '好的：\n{"tool":"read_evidence","args":{"turn":3}}'})};
  const plan = createLocalPlan({model, tools: ['read_evidence']});
  assert.deepEqual(await plan.plan({message: '第 3 回合发生了什么', receipts: []}),
    {tool: 'read_evidence', args: {turn: 3}});
  assert.equal(plan.lastDecision.decision, 'call');
});

test('shadow 模式：本地跑一遍，但玩家看到的结果仍然来自云端', async () => {
  const model = new LocalModel({spawnImpl: () => fakeSpawn({mode: 'ok'})});
  await model.start();
  const base = {name: 'deepseek', generate: async () => '云端回答'};
  const provider = wrapWithLocalModel(base, {model, mode: 'shadow'});
  const text = await provider.generate({text: '问一句'});
  assert.equal(text, '云端回答', 'shadow 不允许改变给玩家的结果');
  assert.equal(provider.shadow.local_text, '规则为准。');
  assert.equal(provider.shadow.identical, false);
  await model.stop();
});

test('on 模式：本地成功就走本地，失败就回退并且不抛给玩家', async () => {
  const okModel = new LocalModel({spawnImpl: () => fakeSpawn({mode: 'ok'})});
  await okModel.start();
  const base = {name: 'deepseek', generate: async () => '云端回答'};
  const okProvider = wrapWithLocalModel(base, {model: okModel, mode: 'on'});
  assert.equal(await okProvider.generate({text: '问一句'}), '规则为准。');
  assert.equal(okProvider.stats.localUsed, 1);
  await okModel.stop();

  const silentModel = new LocalModel({spawnImpl: () => fakeSpawn({mode: 'silent'})});
  await silentModel.start();
  const fallbackProvider = wrapWithLocalModel(base, {model: silentModel, mode: 'on'});
  assert.equal(await fallbackProvider.generate({text: '问一句'}), '云端回答');
  assert.equal(fallbackProvider.lastFallback.code, 'timeout');
  assert.equal(fallbackProvider.stats.localUsed, 0);
  await silentModel.stop();
});

test('on 模式：证据包过长时直接不试本地，明确记账而不是截断后假装成功', async () => {
  const model = new LocalModel({spawnImpl: () => fakeSpawn({mode: 'ok'})});
  await model.start();
  const provider = wrapWithLocalModel({name: 'deepseek', generate: async () => '云端'},
    {model, mode: 'on', maxPromptChars: 50});
  assert.equal(await provider.generate({text: 'x'.repeat(200)}), '云端');
  assert.equal(provider.lastFallback.code, 'prompt-too-long');
  await model.stop();
});

test('权重目录不进 git：.models/ 与 .venv-mlx/ 都在 .gitignore 里', () => {
  const ignore = read(join(ROOT, '.gitignore'), 'utf8');
  assert.ok(ignore.includes('.models/'), '.models/ 必须被忽略（权重不入库）');
  assert.ok(ignore.includes('.venv-mlx/'), '.venv-mlx/ 必须被忽略');
  const tracked = execFileSync('git', ['ls-files', '.models', '.venv-mlx'], {cwd: ROOT, encoding: 'utf8'});
  assert.equal(tracked.trim(), '', '权重或虚拟环境被提交进仓库了');
});
