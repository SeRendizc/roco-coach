// 01.1 字段矩阵：**Python 回执 → Node `publicView`** 这一跳的键树读数。
//
// 输入是 `probe-09-field-matrix.py` 产出的 `raw-leg-receipt.json`（已剔除私有 `state`），
// 也就是 Node 那一层真正常用的东西。产出 `raw-publicview-keys.json`。
//
// 运行（仓库根）：node reports/roco/product-execution/01/probe-10-publicview-keys.mjs

import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {publicView} from '../../../../src/server/roco-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'raw-leg-receipt.json'), 'utf8'));

const keytree = (node, depth = 2) => {
 if (depth <= 0) return Array.isArray(node) ? 'array' : typeof node;
 if (Array.isArray(node)) return node.length ? [keytree(node[0], depth - 1)] : [];
 if (node && typeof node === 'object') {
  const out = {};
  for (const key of Object.keys(node).sort()) out[key] = keytree(node[key], depth - 1);
  return out;
 }
 return node === null ? 'null' : typeof node;
};

const view = publicView(receipt, {
 modeId: null,
 rulesetConfigId: receipt?.public?.ruleset_config_id ?? null,
});

const out = {
 engine: {
  match_id: receipt.match_id ?? null,
  rules_version: receipt.rules_version ?? null,
  decision_id: receipt.decision_id ?? null,
  state_version: receipt.state_version ?? null,
 },
 view_top_keys: Object.keys(view).sort(),
 view: keytree(view),
 checks: {
  has_private_state: Object.prototype.hasOwnProperty.call(view, 'state'),
  contract_forwarded: view.match_id === receipt.match_id
   && view.rules_version === receipt.rules_version
   && view.decision_id === receipt.decision_id,
  seen_roster_present: Array.isArray(view.seen_roster),
  seen_roster: view.seen_roster ?? null,
  revealed_skills: view.opponent?.revealed_skills ?? null,
  bench_keys: (view.opponent?.bench ?? []).map((row) => Object.keys(row).sort()),
 },
};

writeFileSync(join(here, 'raw-publicview-keys.json'),
 JSON.stringify(out, null, 1) + '\n', 'utf8');
console.log(JSON.stringify({view_top_keys: out.view_top_keys, checks: out.checks}, null, 1));
console.log('WROTE raw-publicview-keys.json');
