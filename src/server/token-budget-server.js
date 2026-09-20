import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export function countModelTokens(messages){return new Promise((resolve,reject)=>{
 if(!existsSync(root+'.models/deepseek-v4-tokenizer/tokenizer.json'))return reject(Error('tokenizer-unavailable'));
 const p=spawn(root+'.venv-agent/bin/python',['scripts/count-tokens.py'],{cwd:root,stdio:['pipe','pipe','ignore']});let output='';
 const timer=setTimeout(()=>{p.kill();reject(Error('tokenizer-timeout'));},4000);p.on('error',()=>{clearTimeout(timer);reject(Error('tokenizer-unavailable'));});p.stdout.on('data',x=>{output+=x;});p.on('close',code=>{clearTimeout(timer);try{if(code)throw Error();resolve(JSON.parse(output));}catch{reject(Error('tokenizer-failed'));}});p.stdin.end(JSON.stringify({messages}));
});}
// 模型真实容量来自 DeepSeek 官方文档；这里用真实 tokenizer（不是字节估算）计数。
export const MODEL_CONTEXT=1000000;
export const WORKING_CONTEXT=200000;
export async function fitTokenBudget(messages,{window=WORKING_CONTEXT,output=320,reserve=1024}={}){
 const copy=structuredClone(messages);let count=await countModelTokens(copy);
 while(count.tokens+output+reserve>window&&copy.length>2){copy.splice(1,1);count=await countModelTokens(copy);}
 if(count.tokens+output+reserve>window)throw Error('token-budget-exceeded');
 return {messages:copy,audit:{...count,window,outputReserve:output,safetyReserve:reserve,totalBudget:count.tokens+output+reserve}};
}
