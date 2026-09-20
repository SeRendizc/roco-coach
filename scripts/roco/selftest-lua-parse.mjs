// 解析器自检：确认所有上游 Lua 数据文件都能安全解析（只读文本，不执行）
import { readFileSync } from 'node:fs';
import { parseLuaTable } from './lua-safe-parse.mjs';
const base='data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/';
let fail=0;
for (const f of ['Catalog','Skills','Learnsets','Types','Terms','Overview','Index','Config','Evolutions','Handbooks','History','SkillStoneTopics','TrainingReference']) {
  try {
    const { root } = parseLuaTable(readFileSync(base+f+'.lua','utf8'), {file:f+'.lua'});
    const keys=Object.keys(root);
    console.log(`${f}: OK entries=${keys.length} sampleKeys=${JSON.stringify(keys.slice(0,3))}`);
  } catch(e){ fail++; console.log(`${f}: FAIL ${e.message}`); }
}
console.log(fail===0 ? 'ALL LUA FILES PARSED OK' : `${fail} FILE(S) FAILED`);
process.exit(fail===0?0:1);
