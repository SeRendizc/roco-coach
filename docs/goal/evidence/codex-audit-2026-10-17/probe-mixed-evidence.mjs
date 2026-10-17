import {pathToFileURL} from 'node:url';
const {checkGroundedAnswer}=await import(pathToFileURL(process.argv[2]+'/src/coach/runtime.js'));
const text='电系打翠顶夫人是 2 倍伤害';
const target={kind:'type_multiplier',text:'翼系|水系 受 电系 ×3（强力克制）',multiplier:3};
const unrelated={kind:'type_multiplier',text:'翼系 受 电系 ×2（克制）',multiplier:2};
console.log(JSON.stringify({text,only_target:checkGroundedAnswer({text,evidence:[target],toolTrace:[]}),with_unrelated:checkGroundedAnswer({text,evidence:[target,unrelated],toolTrace:[]})},null,2));
