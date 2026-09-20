// 为已下载的上游快照生成文件清单 + SHA256（可复现的证据台账）
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const root='data/roco/raw/extracted';
const out=[];
function walk(dir){
  for(const e of readdirSync(dir,{withFileTypes:true})){
    if(e.name==='.git') continue;
    const p=join(dir,e.name);
    if(e.isDirectory()) walk(p);
    else {
      const buf=readFileSync(p);
      out.push({path:relative(root,p), bytes:buf.length, sha256:createHash('sha256').update(buf).digest('hex')});
    }
  }
}
walk(root);
out.sort((a,b)=>a.path.localeCompare(b.path));
writeFileSync('reports/roco/m1-data/snapshot-file-inventory.json', JSON.stringify({generated_at:new Date().toISOString(), root, file_count:out.length, files:out},null,2)+'\n');
console.log('files:', out.length, 'total bytes:', out.reduce((a,b)=>a+b.bytes,0));
