// 03.3：把引擎回执切片过一遍**真的** Node `publicView()`，产出信念适配器要吃的 view 夹具
import {readFileSync, writeFileSync} from 'node:fs';
const ROOT = 'E:/roco-coach';
const {publicView} = await import(`file:///${ROOT}/src/server/roco-service.js`);

const engine = JSON.parse(readFileSync(`${ROOT}/reports/roco/product-execution/03/raw-03.3-engine.json`, 'utf8'));
const out = {};
for (const [label, key, modeId] of [['pvp', 'pvp_receipt', 'pvp-standard-six-pet'],
  ['legacy', 'legacy_receipt', null]]) {
  const receipt = engine[key];
  if (!receipt) { out[label] = {error: `raw-03.3-engine.json 里没有 ${key}`}; continue; }
  const view = publicView(receipt, {
    modeId,
    rulesetConfigId: receipt?.public?.ruleset_config_id ?? null,
  });
  out[label] = {
    source: `reports/roco/product-execution/03/raw-03.3-engine.json#${key} → src/server/roco-service.js::publicView()`,
    top_keys: Object.keys(view).sort(),
    view,
  };
  writeFileSync(`${ROOT}/reports/roco/product-execution/03/raw-03.3-view-${label}.json`,
    `${JSON.stringify(view, null, 1)}\n`, 'utf8');
}
console.log(JSON.stringify({
  pvp: {top_keys: out.pvp.top_keys, events_n: out.pvp.view?.events?.length,
    seen_roster_n: out.pvp.view?.seen_roster?.length ?? null,
    field_pet: out.pvp.view?.opponent?.field?.pet_id,
    revealed_skills: Object.keys(out.pvp.view?.opponent?.revealed_skills ?? {})},
  legacy: {top_keys: out.legacy.top_keys, events_n: out.legacy.view?.events?.length,
    seen_roster_n: out.legacy.view?.seen_roster?.length ?? null,
    field_pet: out.legacy.view?.opponent?.field?.pet_id},
}, null, 1));
