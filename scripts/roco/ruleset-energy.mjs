// 规则配置（RC-101）的只读访问口。
//
// 为什么 Node 脚本需要它：能量上限这类值以前在每个脚本里各抄一份
// （`const ENGINE_ENERGY_MAX = 6;`），规则 candidate 一变就没有一处说得清谁跟着变。
// 现在唯一事实源是 `data/roco/rulesets/*.json`，脚本只能从这里读；
// 仓库里另有结构契约（`tests/evals/structure-contract.test.js`）钉住这件事：
// `src/**`、`roco/src/**`、`scripts/**` 里**只有**规则配置文件可以出现这些字面量。
//
// 读不到就抛错（fail closed），不返回一个「看起来合理」的默认值 —— 那正是这份配置
// 要消灭的东西。

import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');

/** Python 侧默认配置的同一个 id（`roco_env/rule_config.py::DEFAULT_RULE_CONFIG_ID`）。 */
export const DEFAULT_RULESET_CONFIG_ID = 'legacy_sim_v1';

export const rulesetConfigPath = (id = DEFAULT_RULESET_CONFIG_ID) =>
  join(ROOT, 'data', 'roco', 'rulesets', `${id.replace(/_/g, '-')}.json`);

/**
 * 读一份规则配置。
 *
 * @param {string} id 配置 id（默认 `legacy_sim_v1`）
 * @returns {{ruleset_config_id: string, is_default: boolean, path: string, energy: object, raw: object}}
 */
export function readRulesetConfig(id = DEFAULT_RULESET_CONFIG_ID) {
  const path = rulesetConfigPath(id);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`读不到规则配置 ${id}（${path}）：${error?.message ?? error}`);
  }
  const leaf = (dotted) => {
    const node = dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), raw);
    if (!node || typeof node !== 'object' || !('value' in node)) {
      throw new Error(`规则配置 ${id} 缺字段 ${dotted}`);
    }
    return node;
  };
  const max = leaf('energy.max');
  const regen = leaf('energy.regen.per_turn');
  const initial = leaf('energy.initial');
  return {
    ruleset_config_id: raw.ruleset_config_id,
    is_default: raw.is_default === true,
    path,
    energy: {
      max: max.value,
      regen_per_turn: regen.value,
      initial: initial.value,
      max_confidence: max.confidence,
      max_evidence_id: max.evidence_id,
      regen_confidence: regen.confidence,
      initial_confidence: initial.confidence,
    },
    raw,
  };
}

/** 只取「当前生效的」能量上限；给「能耗 > 上限即引擎层面不可用」这类判据用。 */
export function engineEnergyMax(id = DEFAULT_RULESET_CONFIG_ID) {
  return readRulesetConfig(id).energy.max;
}
