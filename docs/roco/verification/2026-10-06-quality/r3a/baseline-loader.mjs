import {registerHooks} from 'node:module';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../../../',import.meta.url));
const client=new URL('../../../../../src/coach/client.js',import.meta.url).href;
const original=execFileSync('git',['show','f33d6852:src/coach/client.js'],{cwd:root,encoding:'utf8'});
registerHooks({load(url,context,nextLoad){return url===client?{format:'module',source:original,shortCircuit:true}:nextLoad(url,context);}});
