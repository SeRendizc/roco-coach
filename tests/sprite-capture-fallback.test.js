import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {join} from 'node:path';
const source=fs.readFileSync(new URL('../src/server/index.js',import.meta.url),'utf8');
const start=source.indexOf('          const big=hit?.battle_file?');
const end=source.indexOf('          if(filePath&&existsSync(filePath)){',start);
assert.ok(start>=0&&end>start);
// Execute the actual route's selection block; no copied selection algorithm.
const select=(files,{wantBattle=false,wantFull=false}={})=>{
 const context={hit:{battle_file:'same.png',thumb_file:'same.png',original_file:'same.png'},capRoot:'/capture',join,wantBattle,wantFull,existsSync:path=>files.includes(path.replace('/capture/',''))};
 return vm.runInNewContext(source.slice(start,end)+';filePath&&existsSync(filePath)?rel:null',context);
};
test('battle missing but tracked thumb exists falls to same-pet thumb',()=>assert.equal(select(['thumb/same.png'],{wantBattle:true}),'thumb/same.png'));
test('normal thumb missing but battle exists falls to same-pet battle',()=>assert.equal(select(['battle/same.png']),'battle/same.png'));
test('both previews preserve requested priority and no files stays absent',()=>{
 const files=['battle/same.png','thumb/same.png','originals/same.png'];
 assert.equal(select(files,{wantBattle:true}),'battle/same.png');assert.equal(select(files),'thumb/same.png');assert.equal(select([]),null);
});
test('original fallback is tried after both previews; explicit full only uses original',()=>{
 assert.equal(select(['originals/same.png'],{wantBattle:true}),'originals/same.png');
 assert.equal(select(['thumb/same.png','battle/same.png'],{wantFull:true,wantBattle:true}),null);
 assert.equal(select(['thumb/same.png','originals/same.png'],{wantFull:true}),'originals/same.png');
});
