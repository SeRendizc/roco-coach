# `src/client/**` 玩家可见文案：生产者清单（task-43 交付）

- 生成器：`reports/roco/product-execution/crosscut/player-text-producers.mjs`（可复跑）
- 扫描范围：`src/client/*.js` 共 17 个文件
- **DOM 写入生产者 157 个函数** · 文案表/格式化器 73 个

## A. DOM 写入生产者（玩家可见文本的落点）

| 文件 | 函数 | 函数起行 | 写入行 | 样例 |
|---|---|---|---|---|
| `app.js` | `(顶层)` | 0 | 30 | let profile=newProfile();try{profile=loadProfile(localStorage.getItem(storageKey));}catch{$('save-message').te |
| `app.js` | `refreshChatThreads` | 66 | 73 | option.textContent=chatTitle(session); |
| `app.js` | `save` | 105 | 105 | function save(){try{localStorage.setItem(storageKey,JSON.stringify(profile));}catch{$('save-message').textCont |
| `app.js` | `wallet` | 107 | 107 | function wallet(){$('wallet').textContent=`完成 ${profile.battles} 场 · 胜利 ${profile.wins} 场`;$('record').textCon |
| `app.js` | `renderRestNote` | 126 | 137, 138 | if(!text){el.hidden=true;el.textContent='';delete el.dataset.restNote;continue;} |
| `app.js` | `camp` | 141 | 142, 144 | wallet();$('record').textContent=`完成 ${profile.battles} 场 · 胜利 ${profile.wins} 场`; |
| `app.js` | `renderTypeFilter` | 155 | 162 | $(navId).innerHTML=filters.map(t=>`<button data-roster-type="${t}" class="${cur===t?'selected':''}">${t==='all |
| `app.js` | `deployView` | 194 | 195, 199, 200, 202, 215, 218, 219, 226, 230 | wallet();$('deploy-record').textContent=`完成 ${profile.battles} 场 · 胜利 ${profile.wins} 场`; |
| `app.js` | `renderPickSplit` | 247 | 266, 279 | $('roster-enemy').innerHTML=filteredSpecies('enemyRosterType').map(base=>{ |
| `app.js` | `cultivation` | 308 | 311 | $('cultivation').innerHTML=`<h3>${p.icon} ${p.name}<small>Lv.${v.level}</small></h3>` |
| `app.js` | `renderLoadout` | 323 | 330, 336, 338, 339 | box.innerHTML=`<div class="loadout"><div class="loadout-head"><strong>配招 · 6 选 4</strong><span class="muted">携 |
| `app.js` | `renderSides` | 348 | 348 | function renderSides(state){$('player').innerHTML=sideView(state,'player');$('enemy').innerHTML=sideView(state |
| `app.js` | `render` | 403 | 403, 404, 405, 411, 414, 415, 416 | function render(){$('round-coach').textContent=game.result?'✦ 整局复盘':'✦ 回合回顾';renderSides(game);$('environment- |
| `app.js` | `renderSplitPanels` | 441 | 451, 453, 461 | $('enemy-side-note').textContent=replacing?(rs==='enemy'?(humanOpponent()?'等待对方补位':'对手正在补位'):'轮到你补位'):(humanOp |
| `app.js` | `updateEnemyNote` | 589 | 592 | const phase=$('phase');if(phase&&!busy&&!game.result)phase.textContent=phaseText(); |
| `app.js` | `enemyActionFor` | 597 | 603 | $('action-banner').textContent='对手正在思考…'; |
| `app.js` | `copy` | 670 | 671 | $(text).textContent=concise(copy,120);$(box).hidden=false; |
| `app.js` | `act` | 676 | 708, 715, 742, 748, 755 | render();$('action-banner').textContent='双方正在选择并结算行动…';await pause(20);// 对手这一手在玩家思考的时候就已经定好了（见 decideEnemyFir |
| `app.js` | `showCompanionCue` | 805 | 808, 809, 810, 811 | $('bubble-avatar').textContent=avatar.icon; |
| `app.js` | `strategistCue` | 871 | 883 | $('attention-text').textContent=text;$('attention-cue').hidden=false;speakCue(text); |
| `app.js` | `openCoach` | 887 | 887 | function openCoach(){connectionStatus().then(s=>{$('coach-status').textContent=s.configured?(s.verified?'DeepS |
| `app.js` | `appendChatEntry` | 889 | 890 | const e=document.createElement('div');e.className='chat-entry'+(role==='你'?' user':'');e.innerHTML=`<strong>${ |
| `app.js` | `newChat` | 896 | 896 | function newChat(){advanceContext();chatStore=startChatSession(chatStore);saveChats();conversation=[];$('chat- |
| `app.js` | `showThinking` | 910 | 910 | function showThinking(label){hideThinking();const e=document.createElement('div');e.className='chat-entry thin |
| `app.js` | `ask` | 916 | 917, 919, 920, 921, 922, 925, 928 | if(!text.trim()\|\|asking)return;if(busy){$('coach-status').textContent='请等本回合出招结束，再分析当前战况';return;}asking=true; |
| `app.js` | `startMatch` | 940 | 943, 944, 949 | if(selected.length!==3){document.getElementById('save-message').textContent='请选择三只伙伴再开始。';return;} |
| `app.js` | `toCamp` | 955 | 955 | function toCamp(){if(busy)return;$('mode-badge').textContent=modeBadgeText(matchMode);pvpPicks={player:null,en |
| `app.js` | `syncMode` | 964 | 969, 970, 971, 972 | $('start').textContent=pvp?'开始对战':'开始训练'; |
| `app.js` | `renderRules` | 1017 | 1017, 1018, 1019, 1020, 1025 | function renderRules(){const el=$('rules-body');if(!el)return;el.innerHTML=rulesSections().map(section=>`<sect |
| `app.js` | `renderStages` | 1031 | 1032, 1034 | $('stage-picker').innerHTML=STAGES.map(stage=>`<button data-stage="${stage.id}" class="${stage.id===stageId?'s |
| `app.js` | `presentScene` | 1038 | 1040, 1042 | if(scene.placement==='inline'){$('scene-inline').hidden=false;$('inline-copy').hidden=true;$('inline-copy').te |
| `app.js` | `startPreview` | 1044 | 1048, 1051 | $('scenes-dialog').close();$('preview-bar').hidden=false;$('preview-title').textContent='预制体验 · '+SCENARIOS.fi |
| `app.js` | `exitPreview` | 1053 | 1057, 1059, 1066 | if(game){render();updateCoach();$('action-banner').textContent='已恢复体验前的对战。';}else camp(); |
| `app.js` | `showMatchReview` | 1070 | 1078, 1082, 1086 | box.innerHTML='<div class="coach-whisper"><span class="whisper-icon">✦ 小芽 · 本局回顾</span><span id="result-copy"> |
| `app.js` | `updateCoach` | 1088 | 1125, 1131, 1134, 1136, 1139, 1146, 1153 | box.innerHTML='<div class="coach-whisper"><span class="whisper-icon">✦ '+(teacher?'老师':'军师')+'</span><span id= |
| `app.js` | `showTacticalCue` | 1213 | 1219 | $('attention-text').textContent=cue.text;$('attention-cue').hidden=false;speakCue(cue.text); |
| `app.js` | `logCoachEvent` | 1222 | 1234, 1236 | $('voice-status').textContent='语音已暂停使用 · 文字提示与其余功能不受影响'; |
| `app.js` | `voiceStatus` | 1238 | 1238 | function voiceStatus(text){$('voice-status').textContent=text;} |
| `app.js` | `renderVoiceOptions` | 1260 | 1264 | sel.innerHTML='<option value="">（自动选择）</option>'+list.map(v=>`<option value="${escape(v.name)}">${escape(v.nam |
| `app.js` | `showWatchCue` | 1313 | 1313 | function showWatchCue(){if(profile.coach.mode==='quiet'\|\|coachMuted\|\|attention.dismissed)return false;const cu |
| `box-loadout.js` | `injectStyle` | 551 | 556 | style.textContent = LOADOUT_STYLE; |
| `box-loadout.js` | `hit` | 654 | 663 | label.textContent = query \|\| state.filterCategory |
| `box-loadout.js` | `render` | 675 | 676 | host.innerHTML = loadoutPanelHtml({ |
| `box-loadout.js` | `destroy` | 826 | 830 | else host.innerHTML = ''; |
| `box.js` | `setStatus` | 179 | 182 | el.textContent = String(text ?? ''); |
| `box.js` | `build` | 252 | 254, 259, 260 | box.innerHTML = options.map(([value, label]) => `<button class="filter-chip" data-f="${attr}" |
| `box.js` | `favourites` | 417 | 439, 451, 458 | grid.innerHTML = cards.map((card) => drawerHtml(singleIndividualGroup(card), |
| `box.js` | `renderMeta` | 467 | 473, 477 | $('page-label').textContent = `${page} / ${pages}`; |
| `box.js` | `renderDev` | 512 | 520, 522 | if (!dev) { body.innerHTML = '<p class="muted">还没有取到数据。</p>'; return; } |
| `box.js` | `seq` | 617 | 641, 647, 649 | $('box-empty').textContent = state.favourite |
| `box.js` | `loadTotals` | 655 | 662, 663 | $('count-mine').textContent = state.totals.mine ?? '—'; |
| `box.js` | `renderRestNote` | 1170 | 1184, 1187 | el.hidden = true; el.textContent = ''; delete el.dataset.restNote; |
| `box.js` | `localSameSpecies` | 1222 | 1237, 1241, 1251, 1254 | $('pet-title').textContent = `${name} · 详情`; |
| `box.js` | `lastNote` | 1269 | 1270, 1311, 1316 | note.textContent = state.petNote \|\| refreshFailed \|\| lastNote \|\| ''; |
| `box.js` | `runLocalCleanup` | 1522 | 1558 | if (button) button.textContent = CLEANUP_LABEL; |
| `box.js` | `apply` | 1809 | 1943 | button.textContent = '再点一次就清理（先存档、再删）'; |
| `connect.js` | `show` | 2 | 2 | function show(s){$('status').textContent=s.verified?`已验证连接 · ${s.model}`:s.configured?`密钥已保存，尚未验证 · ${s.model} |
| `connect.js` | `lock` | 5 | 6, 11, 12, 13, 14, 15 | $('connect-form').onsubmit=async e=>{e.preventDefault();if(busy)return;lock(true);$('message').textContent='正在 |
| `roco.js` | `setText` | 207 | 209 | if (el) el.textContent = text; |
| `roco.js` | `sayStatus` | 222 | 226 | el.textContent = text; |
| `roco.js` | `setHtml` | 234 | 236 | if (el) el.innerHTML = html; |
| `roco.js` | `renderMode` | 877 | 881, 893, 896 | // （小芽弹窗）**都已不在 roco.html 里** —— 旧代码那三段 `if (el) el.innerHTML = chips` |
| `roco.js` | `render` | 902 | 905, 915, 916, 948, 953, 963, 976, 979 | $('engine-status').textContent = view ? '规则服务：已连接' : '规则服务：未启动'; |
| `roco.js` | `foeBench` | 983 | 984, 994, 997, 1004, 1014, 1025 | foeLine.innerHTML = rosterLineHtml([view?.opponent?.field ?? null, ...foeBench].filter(Boolean), |
| `roco.js` | `logSource` | 1043 | 1066, 1069, 1097, 1109, 1111, 1113, 1117 | $('events').innerHTML = groups.length ? groups.join('') : '<p class="muted">还没推进。</p>'; |
| `roco.js` | `renderActions` | 1440 | 1446 | box.innerHTML = `<p class="act-none">动作表读不出来：${escapeHtml(String(grouped.reason))}</p>`; |
| `roco.js` | `byKind` | 1450 | 1472, 1507, 1515, 1518 | if (chargeBtnEl) chargeBtnEl.textContent = chargePreviewHtml(byKind('charge')); |
| `roco.js` | `setBtn` | 1528 | 1547, 1551 | switchList.innerHTML = ''; |
| `roco.js` | `moveRow` | 1559 | 1584, 1611, 1618 | itemList.innerHTML = items.length |
| `roco.js` | `flashDamage` | 1647 | 1661 | float.textContent = `−${amount}`; |
| `roco.js` | `renderMemory` | 1672 | 1681 | list.innerHTML = rows.map((row) => `<li data-memory="${escapeAttr(row.id)}"> |
| `roco.js` | `sayWritePlayerLine` | 1817 | 1828 | me.textContent = `你：${String(message ?? '').trim()}`; |
| `roco.js` | `renderModelList` | 1941 | 1963 | box.innerHTML = cells.map((m) => { |
| `roco.js` | `showHeartPop` | 1992 | 1995 | el.textContent = text; |
| `roco.js` | `draw` | 2015 | 2019 | el.innerHTML = `<i>${FULL_HEART.repeat(full)}</i>` |
| `roco.js` | `isBadge` | 2102 | 2138 | slot.innerHTML = ''; |
| `roco.js` | `b3El` | 2144 | 2148, 2151 | el.innerHTML = `<span class="b3-el-ic">${emo}</span><span class="b3-el-nm">${escapeHtml(name \|\| '')}</span>`; |
| `roco.js` | `fillCard` | 2288 | 2292, 2294, 2296, 2298, 2302, 2323, 2324, 2326, 2327 | if (name) name.textContent = pet.name ?? ''; |
| `roco.js` | `legalSkills` | 2332 | 2357, 2359, 2361, 2374, 2393, 2410, 2444, 2453, 2455, 2463 …共15 | if (costEl) costEl.textContent = cost === null ? '⭐ —' : `⭐ ${cost}`; |
| `roco.js` | `act` | 2509 | 2524, 2527, 2552, 2554, 2634, 2646, 2649, 2650, 2654, 2663 …共12 | if (val) val.textContent = Number.isFinite(me?.energy) |
| `roco.js` | `pushRows` | 2569 | 2588, 2592 | foeBuffs.innerHTML = rows.map((r) => `<span class="b3-buff" data-b3-buff-kind="${r.kind}" |
| `roco.js` | `sur` | 2691 | 2700 | chargeVal.textContent = mana === null ? '未核验' : (pool === null ? `${HEART} ${mana}` : `${HEART} ${mana} / ${po |
| `roco.js` | `src` | 2805 | 2815, 2817 | logScroll.innerHTML = '<p class="muted">还没推进。</p>'; |
| `roco.js` | `dots` | 2860 | 2867, 2873, 2880, 2882, 2899, 2902 | if (selfDots) selfDots.innerHTML = dots(selfAlive, size); |
| `roco.js` | `b3SkillDetailNode` | 3223 | 3229 | el.setAttribute('aria-label', '技能详情'); |
| `roco.js` | `b3ShowSkillDetail` | 3239 | 3245, 3250, 3252 | el.textContent = ''; |
| `roco.js` | `b3MountSkillInfo` | 3282 | 3292, 3293 | btn.setAttribute('aria-label', '技能详情'); |
| `roco.js` | `nm` | 3296 | 3297 | btn.setAttribute('aria-label', nm ? `看「${nm}」的技能详情` : '技能详情'); |
| `roco.js` | `b3Float` | 3312 | 3327 | span.textContent = text; |
| `roco.js` | `renderModelChip` | 3334 | 3361, 3364 | chip.textContent = `${toolsLine}；${modelLine}`; |
| `roco.js` | `refreshHint` | 3460 | 3540, 3545, 3556 | $('hint-text').textContent = text.text; |
| `roco.js` | `openingPreviewIconNode` | 3668 | 3675 | span.textContent = typeEmoji(main); |
| `roco.js` | `openingPreviewRowNode` | 3687 | 3705, 3713, 3719, 3724 | nameEl.textContent = name; |
| `roco.js` | `maybeShowOpeningPreview` | 3788 | 3814 | wrap.innerHTML = `<div class="roco-opening-box">` |
| `roco.js` | `tick` | 3847 | 3850, 3851 | if (leftLabel) leftLabel.textContent = text; |
| `roco.js` | `seenRosterRowNode` | 3937 | 3947, 3950, 3961, 3968, 3983 | slotEl.textContent = Number.isInteger(row.slot) ? `第 ${row.slot + 1} 位` : '位次未给'; |
| `roco.js` | `seenRosterPanelNode` | 3991 | 4006, 4009, 4025, 4038 | title.textContent = `已见阵容（${rows.length} 只）`; |
| `roco.js` | `renderSeenRosterEntry` | 4097 | 4116, 4122 | chip.title = '回看已经亮明的对手成员'; |
| `roco.js` | `seq` | 4374 | 4405, 4406 | $('pool-count').textContent = `名单读取失败：${error.message}`; |
| `roco.js` | `build` | 4423 | 4425, 4445 | box.innerHTML = options.map(([value, label]) => `<button class="filter-chip" data-${attr}="${escapeAttr(value) |
| `roco.js` | `renderPoolMeta` | 4459 | 4463, 4464 | $('pool-page').textContent = `${page} / ${pages}`; |
| `roco.js` | `renderTeambar` | 4476 | 4484 | slot.textContent = id ? nameOf(id) : (i === 0 ? '点下面的卡片加入' : `第 ${i + 1} 位`); |
| `roco.js` | `renderPoolCards` | 4500 | 4506 | grid.innerHTML = state.pool.rows.map((pet) => { |
| `roco.js` | `renderRoster` | 4555 | 4559, 4560, 4567, 4571, 4573 | $('count-player').textContent = String(player.length); |
| `roco.js` | `openPetDetail` | 4582 | 4588 | $('pet-detail-name').textContent = `${pet.name} · 详情`; |
| `roco.js` | `moves` | 4594 | 4608 | $('pet-detail-body').innerHTML = |
| `roco.js` | `loadRoster` | 4705 | 4712, 4716, 4724 | $('roster-status').textContent = `${state.roster.length} 只可选（配招来自引擎规范配招）`; |
| `roco.js` | `loadShadowPanel` | 4734 | 4739, 4742, 4751, 4762, 4771 | box.innerHTML = '<p class="muted">先开一局，再问本机小模型。</p>'; |
| `roco.js` | `legal` | 4793 | 4815 | box.textContent = text; |
| `roco.js` | `startBattle` | 4888 | 4906 | $('lesson').textContent = ''; |
| `roco.js` | `finishMatch` | 5128 | 5131, 5132, 5133, 5165 | $('result-verdict').textContent = RESULT_CN[view.battle_result] ?? view.battle_result; |
| `roco.js` | `evidence` | 5171 | 5174, 5178, 5182, 5185, 5187, 5206, 5212, 5213, 5214, 5217 | $('lesson-question').textContent = review.text; |
| `roco.js` | `paintFocusLine` | 5425 | 5436, 5440 | el.textContent = `${live ? '正在看' : '最近看过'}：${bits.join(' · ')}`; |
| `roco.js` | `sayOnce` | 5783 | 5810, 5827, 5870, 5892 | $('say-reply').textContent = configured ? '小芽在查证…' : reply; |
| `roco.js` | `renderCoverage` | 5921 | 5922 | $('coverage').innerHTML = COVERAGE.map(([what, how]) => `<li><strong>${what}</strong><br><span class="muted">看 |
| `roco.js` | `updateStandardPvpBar` | 6200 | 6218, 6224, 6226, 6229, 6231, 6234 | button.textContent = trial ? '试玩一局（理论阵容 · 含未核验按需推算）' |
| `roco.js` | `startStandardPvp` | 6248 | 6274 | $('lesson').textContent = ''; |
| `roco.js` | `loadStatus` | 6398 | 6402 | $('engine-status').textContent = status.available ? '规则服务：已就绪' : '规则服务：正在启动…'; |
| `roco.js` | `bootData` | 6408 | 6413, 6426 | $('engine-status').textContent = `规则服务：未连接（${error.message}）`; |
| `stale-page.js` | `banner` | 20 | 29, 33 | text.textContent = '这个页面还是重启前的旧版本（本机服务已经重启过）。'; |
| `team-workshop.js` | `mountTeamWorkshop` | 892 | 902 | shadow.innerHTML = ` |
| `team-workshop.js` | `renderTeam` | 1438 | 1440, 1506, 1518, 1521 | $('tw-slots').innerHTML = slots.map((slot) => { |
| `team-workshop.js` | `renderReplaceBox` | 1558 | 1565 | box.innerHTML = ''; |
| `team-workshop.js` | `slots` | 1573 | 1575, 1591 | box.innerHTML = `<h4>替换哪只？</h4> |
| `team-workshop.js` | `renderPlan` | 1844 | 1850 | box.innerHTML = ''; |
| `team-workshop.js` | `four` | 1861 | 1871 | box.innerHTML = `<div class="tw-head"><h3>小芽给的整套配置（6 只 × 4 招）</h3> |
| `team-workshop.js` | `pool` | 2230 | 2240, 2256 | note.textContent = cfg.reason ? cfg.reason : (cfg.state === 'invalid' |
| `team-workshop.js` | `renderAnalysis` | 2281 | 2285, 2328 | box.innerHTML = slots.map((slot) => { |
| `team-workshop.js` | `note` | 2492 | 2494 | firstRef.insertAdjacentHTML('beforebegin', |
| `team-workshop.js` | `renderPool` | 2500 | 2517, 2519, 2612, 2615, 2619, 2627 | $('tw-cand-list').innerHTML = `<p class="tw-note" data-tw-empty="yes">` |
| `team-workshop.js` | `seq` | 2646 | 2697 | $('tw-cand-list').innerHTML = `<p class="tw-note">候选池读取失败：${escapeHtml(error.message)}</p>`; |
| `team-workshop.js` | `hideEvalDrawer` | 2755 | 2761 | note.textContent = `阵容评估这一格先收起来：${(plan.limits ?? []).join('；') \|\| '拿不到能给出有用结论的事实'}`; |
| `team-workshop.js` | `wireAskAi` | 2941 | 2952, 2956, 2961, 2964 | box.textContent = '这一页没有接上小芽（宿主页没给 askCoach）：数字就是全部，我不替它编解释。'; |
| `team-workshop.js` | `renderEval` | 2983 | 2991, 2996, 2997, 3026, 3028, 3042, 3044, 3049, 3050, 3054 …共11 | if (!player) { $('tw-eval-body').innerHTML = ''; $('tw-eval-sub').textContent = '—'; return; } |
| `team-workshop.js` | `setPickNote` | 3177 | 3179 | if (el) el.textContent = text; |
| `team-workshop.js` | `setConfigNote` | 3184 | 3186 | if (el) el.textContent = String(text ?? ''); |
| `team-workshop.js` | `fillOpponentOptions` | 3530 | 3541 | opt.textContent = one.name; |
| `team-workshop.js` | `cycle` | 3595 | 3600 | labelEl.textContent = `${key === 'type' ? '属性' : '定位'}：${key === 'role' ? (ROLE_CN[label] ?? label) : label}`; |
| `team-workshop.js` | `fillSelect` | 3604 | 3612, 3762 | el.innerHTML = ['<option value="">' + label + '</option>'] |
| `xiaoya.js` | `decorate` | 653 | 665, 674, 682, 691, 703 | basis.textContent = plain(activityLine); |
| `xiaoya.js` | `decorateAdvice` | 871 | 884 | summary.textContent = `首选行动：${card.headline}`; |
| `xiaoya.js` | `row` | 887 | 894, 897 | key.textContent = label; |
| `xiaoya.js` | `emit` | 911 | 922, 923, 932, 933, 939 | view.textContent = '查看'; |
| `xiaoya.js` | `injectFocusStyles` | 953 | 957 | style.textContent = '.xy-focus{font-size:12.5px;line-height:1.5;color:#9caebe;padding:6px 10px;' |
| `xiaoya.js` | `setStatus` | 1024 | 1024 | const setStatus = (text) => { if (status) status.textContent = text; }; |
| `xiaoya.js` | `scrollLogToBottom` | 1037 | 1043, 1044 | newMsg.textContent = '↓ 有新消息'; |
| `xiaoya.js` | `addEntry` | 1053 | 1061, 1064 | head.textContent = who; |
| `xiaoya.js` | `epoch` | 1095 | 1181 | b.textContent = choice; |
| `xiaoya.js` | `drawHistory` | 1236 | 1259, 1260 | memoryPanel.setAttribute('aria-label', '小芽的记忆'); |
| `xiaoya.js` | `renderMemoryList` | 1262 | 1269 | list.innerHTML = rows.map((row) => `<li data-memory="${esc(row.id)}"> |
| `xiaoya.js` | `forgetMemory` | 1282 | 1303 | statusFold.innerHTML = '<summary id="xy-fold-label">模型与连接</summary>' |
| `xiaoya.js` | `rows` | 1315 | 1321, 1345, 1346, 1357, 1358, 1370, 1371, 1394, 1417 | box.innerHTML = cells.map((m) => { |
| `xiaoya.js` | `updateFocusChip` | 1450 | 1482, 1489, 1493, 1497, 1541, 1569 | chip.textContent = `${prefix}：${bits.join(' · ')}`; |
| `xiaoya.js` | `paintCapability` | 1607 | 1634, 1635, 1636, 1637 | capEl.textContent = capabilityChipText({tools, model}); |
| `xiaoya.js` | `refreshCapability` | 1639 | 1659, 1660, 1661, 1663, 1664, 1667, 1671 | capEl.textContent = capabilityChipText({tools, model}); |
| `xiaoya.js` | `injectPopup` | 1725 | 1740, 1748, 1750 | button.innerHTML = '<span aria-hidden="true">✦</span> 小芽'; |
| `xiaoya.js` | `setCollapsed` | 1799 | 1804, 1805 | button.textContent = collapsed ? '展开' : '收起'; |

## B. 文案表与格式化器（标签/整句的**真源**，改词表必须改这里）

| 文件 | 名字 | 起行 | 出现行 | 样例 |
|---|---|---|---|---|
| `app.js` | `renderRestNote` | 126 | 127 | // **两份一起写**（`#109`：浮层那份管"默认进入"· 营地那份管"收起浮层后"；一个函数写两处 ⇒ 不会漂 ✓） |
| `app.js` | `renderPickSplit` | 247 | 269, 270, 280, 284 | const act=ai?`<button disabled>${at>=0?'AI 已选':'—'}</button>` |
| `app.js` | `renderLoadout` | 323 | 329, 335 | const chips=draft.map(id=>{const s=SKILLS[id];return `<span>${s.name}${s.priority?` <i>先制+${s.priority}</i>`:' |
| `app.js` | `matchContext` | 354 | 357, 358, 363, 364 | // 「我这套阵容怎么样 / 有什么短板」在营地页也要能查引擎：`teamAsk` 认的是 |
| `app.js` | `phaseText` | 385 | 386, 387, 388, 389, 390 | if(busy)return '正在出招…'; |
| `app.js` | `actionLabel` | 424 | 426, 427, 429 | if(a.kind==='skill')return a.id==='guard'?'防御':(SKILLS[a.id]?.name\|\|a.id); |
| `app.js` | `renderSplitPanels` | 441 | 448, 450, 459, 467, 469 | // 「对方行动」这一栏说的永远是对手的状态，所以 rs==='enemy' 就是**对手**在补位。 |
| `app.js` | `modeBadgeText` | 954 | 954 | function modeBadgeText(mode){return mode==='pvp'?'对局 · PVP':mode==='pve'?'训练 · PVE':'营地';} |
| `app.js` | `renderRules` | 1017 | 1027 | // 深链接：`/#pvp` 直接落在选队页（首页那张图的 PVP 热区写的就是 `#pvp`）。 |
| `box-drawer.js` | `STAT_ORDER` | 49 | 49, 50, 53, 57, 58, 60 | export const STAT_ORDER = Object.freeze([['hp', '生命'], ['atk', '物攻'], ['def', '物防'], |
| `box-drawer.js` | `formatTraitValue` | 62 | 66, 67, 68, 77 | // ⚠ 2026-09-29 **改钉**（U01「不能凭空生成」）：这里原来是 `Number.isFinite(Number(value[key]))`， |
| `box-loadout.js` | `seedNoteText` | 63 | 64 | ? `${SEED_NOTE}（这份是${state.seedNote}）` |
| `box-loadout.js` | `numberText` | 136 | 144, 149, 150, 151, 152 | * （`{name,element,category,energy,power_label,desc}`）与引擎学习表的记录 |
| `box-loadout.js` | `powerText` | 215 | 216, 217, 218, 219 | if (fields.hasStaticPower) return `必要威力 ${fields.power}`; |
| `box-loadout.js` | `metaLine` | 223 | 224, 225 | return `系别 ${fields.element ?? NO_ITEM} · 类别 ${fields.category ?? NO_ITEM}` |
| `box-loadout.js` | `chipLine` | 229 | 231, 232, 233, 234, 240 | fields.energy === null ? `耗能 ${NO_ITEM}` : `耗能 ${fields.energy}`]; |
| `box-loadout.js` | `engineLine` | 276 | 277, 278, 279, 282, 286, 287, 288, 290 …共12 | if (fields.mechanicsResolved) return '引擎：这条效果已经结算。'; |
| `box-loadout.js` | `sourcesText` | 303 | 313 | * `data-loadout-raw` 上（与工坊 `playerReasonOf()` / `data-tw-error-raw` 同一条纪律， |
| `box-talent.js` | `QUALIFICATION_LABELS` | 36 | 40, 45, 47 | const NO_VALUE = '没有这一项'; |
| `box-talent.js` | `missingText` | 133 | 135, 138 | return `缺 ${qualification.missingLabels.join('、')} 这 ${qualification.missingLabels.length} 项`; |
| `box.js` | `renderCards` | 403 | 407, 409, 411, 412, 414 | //   实在不行你删掉重新做不行吗？」；Lead 授权"删掉重新做"）： |
| `box.js` | `renderMeta` | 467 | 469, 476, 479, 480, 481, 484, 488, 494 …共12 | // 不然"最后一页"会停在服务端没有那一页上（空页）。 |
| `box.js` | `renderDev` | 512 | 515, 516, 517, 529, 531, 533 | // ⚠ 2026-09-29 第三轮纠偏第 5 条：开发者抽屉（`#dev-drawer`）已从页面上删掉 ⇒ `#dev-body` 不存在。 |
| `box.js` | `STAT_LABELS` | 737 | 737 | const STAT_LABELS = Object.freeze({hp: '生命', atk: '物攻', def: '物防', spa: '魔攻', spd: '魔防', spe: '速度'}); |
| `box.js` | `STAT_NAMES_OF_KEY` | 739 | 739 | const STAT_NAMES_OF_KEY = Object.freeze({hp: '生命', atk: '物攻', def: '物防', spa: '魔攻', spd: '魔防', spe: '速度'}); |
| `box.js` | `STAT_KEY_OF_LABEL` | 740 | 744, 746, 749, 751, 754, 755, 757, 758 …共33 | * 那一行假设清单（逐字，一处事实源）。人类最恨编数字 ⇒ 档位与"给谁看的"都写在屏上。 |
| `box.js` | `renderRestNote` | 1170 | 1174, 1189 | try { memory = readMemory(localStorage.getItem('xiaoya-memory-v1')); } catch { /* 读不到就用空的 */ } |
| `box.js` | `renderPetPage` | 1192 | 1200, 1201, 1202, 1203, 1205, 1208, 1209, 1213 …共12 | // ⚠ 2026-09-28 真机抓到（验收 10b：整页 **84 处** `[object Object]`）： |
| `box.js` | `rerenderAfterAction` | 1694 | 1702, 1703 | * 抽出来的原因（2026-09-28 实测的真 bug）：这段原来只挂在 `#box-grid` 的监听器上， |
| `roco.js` | `setText` | 207 | 216, 217, 218, 220 | * 这些消息原来写向 `#plan-status` —— 那个元素已按 2026-09-23 的版式删掉，而 `roco.js` 里 |
| `roco.js` | `statusText` | 437 | 445, 447, 448, 449 | const RESULT_CN = {win: '我方胜', loss: '我方负', draw: '平局', escaped: '撤退', ongoing: '未结束'}; |
| `roco.js` | `buffLabel` | 663 | 668, 673, 674 | *   · 引擎的公开视图里没有这个量（例如 legacy 配置没有 `energy_max`）⇒ 整条不写， |
| `roco.js` | `modeProbeText` | 864 | 865, 868, 869, 870, 872, 874 | if (!mode \|\| typeof mode !== 'object') return '模式注册表未读取'; |
| `roco.js` | `renderMode` | 877 | 880, 882, 884, 885, 886, 898 | // 三个渲染落点 `#mode-line`（页头徽记）、`#b3-flags`（v3h 备用位）、`#mode-chips` |
| `roco.js` | `renderMemory` | 1672 | 1673, 1685, 1693 | // 甲④-1：旧面板已退役（这一页只有 `xiaoya.js` 一套实现）——元素不在就早退， |
| `roco.js` | `sayWritePlayerLine` | 1817 | 1834, 1835, 1836 | * 为什么要有它：`.companion-body` 是 `overflow:auto` 且有 `max-height`，而小芽最长的那一句 |
| `roco.js` | `renderCompanion` | 1843 | 1844, 1850, 1851, 1852, 1853, 1854, 1855, 1862 | // 甲④-1：旧面板已退役（这一页只有 `xiaoya.js` 一套实现）——元素不在就早退， |
| `roco.js` | `renderModelList` | 1941 | 1942, 1956, 1957, 1958, 1965, 1966, 1967, 1968 …共16 | // 甲④-1：旧面板已退役（这一页只有 `xiaoya.js` 一套实现）——元素不在就早退， |
| `roco.js` | `renderB3Panels` | 2273 | 2280, 2281 | // 对手当前这一只的属性（**公开**信息）。承伤相性（U05）要用它当"攻击系集合"—— |
| `roco.js` | `renderB3Topbar` | 2847 | 2854, 2855, 2856 | // 对手总数**按它自己的名单算**：`opponent.bench` 是后备（不含场上），所以总数 = 1 + bench.length， |
| `roco.js` | `renderModelChip` | 3334 | 3335, 3342, 3343, 3344, 3345, 3346, 3350, 3352 …共17 | // 甲④-1：旧面板已退役（这一页只有 `xiaoya.js` 一套实现）——元素不在就早退， |
| `roco.js` | `renderFirst` | 3434 | 3448, 3457 | + '<p><strong>往后 2—3 回合</strong></p>' |
| `roco.js` | `openingPreviewCountdownText` | 3745 | 3747 | return `知道了（${seconds} 秒后自动关闭）`; |
| `roco.js` | `renderPoolMeta` | 4459 | 4465, 4466 | ? `${pool.total} 只里这一页 ${pool.rows.length} 只 · 每页 ${pool.pageSize}` |
| `roco.js` | `renderTeambar` | 4476 | 4497 | * 机制那一行来自服务端压好的 `mechanism_line`（见 `mechanismOf` 的口径）； |
| `roco.js` | `renderPoolCards` | 4500 | 4508, 4515, 4516, 4518, 4519, 4523, 4533, 4534 …共12 | // 「定位」只有登记层真的标注过才渲染（`ROLE_LABEL` 里没有就是不认识/没给）。 |
| `roco.js` | `renderRoster` | 4555 | 4568 | + `对手：${enemy.map(nameOf).join('、') \|\| '（未选）'}`; |
| `roco.js` | `paintFocusLine` | 5425 | 5434, 5435, 5448 | if (snapshot?.nature) bits.push(`性格 ${snapshot.nature}`); |
| `team-workshop.js` | `poolRowMetaText` | 133 | 135, 137, 138, 139, 143, 144, 150, 152 | // 原来缺等级时印的是 **`Lv—`** —— 那既不是等级、也不说清为什么没有，读起来像"这只没有等级"。 |
| `team-workshop.js` | `AXIS_LABELS` | 337 | 337 | export const AXIS_LABELS = Object.freeze(['环境价值', '最怕的体系', '对局离散度', '操作容错', '覆盖置信']); |
| `team-workshop.js` | `mechanismTagsLine` | 799 | 801 | return list.length ? `机制线索：${list.join(' · ')}` : '机制线索：登记层没有这一只的标签'; |
| `team-workshop.js` | `axisValueText` | 832 | 835, 836, 837, 838, 839, 847, 848, 850 …共14 | // 2026-09-26（人类：面板不是人话）：主行以前直接印**机器 id**（`wing_king_force` 这种） |
| `team-workshop.js` | `axisRawText` | 865 | 870 | const unit = axis.value_kind === 'spread' ? '相对分极差' : '相对分（0～1 的序数标度）'; |
| `team-workshop.js` | `loadoutOwnerLabel` | 1390 | 1391, 1392, 1393 | const who = editor?.petName ? `${editor.petName}` : '这一只'; |
| `team-workshop.js` | `renderTeam` | 1438 | 1444, 1447, 1456, 1458, 1460, 1461, 1462, 1463 …共27 | // 2026-09-26（玩家可见缺陷）：这里原来用 `slot.species_id` 判「是不是我持有的」， |
| `team-workshop.js` | `renderReplaceBox` | 1558 | 1570 | // ⚠ 标记里写死了 `hidden`（默认不占位）⇒ 这里必须**显式取消它**，否则整块永远不显示 |
| `team-workshop.js` | `renderConfig` | 2191 | 2198, 2214, 2215, 2216 | // 免得玩家看到"这套不能应用"却其实是上一套的原因（那是最难查的一种谎）。 |
| `team-workshop.js` | `renderAnalysis` | 2281 | 2288, 2293, 2294, 2295, 2296, 2297, 2298, 2299 …共23 | data-tw-state="empty"><div class="tw-meta">第 ${slot.index} 格（空）</div> |
| `team-workshop.js` | `renderPool` | 2500 | 2501, 2502, 2507, 2518, 2525, 2537, 2541, 2548 …共41 | // ⚠ 2026-09-29：诊断钩子（仓里 `data-tw-*` 本来就是这个惯例）—— |
| `team-workshop.js` | `renderGaps` | 2702 | 2708, 2710 | <span class="tw-state">现在还没补上</span></div>`).join('')} |
| `team-workshop.js` | `renderTeamPlanBlock` | 2790 | 2793 | // `**加粗**` 不许把星号漏到可见文本里（Lead 逐字判的 ②）——先转义、再把成对的 ** → <b> |
| `team-workshop.js` | `renderEngineEvidence` | 2855 | 2859, 2864, 2866, 2869 | return `<p class="tw-note">引擎那一份（五个方面 / 最小替换）这次没有回来。下面的判断来自本机事实：真实学招表、属性相性、速度与能量规则。</p>`; |
| `team-workshop.js` | `renderFullTeam` | 2917 | 2923 | * （`opts.askCoach`，与页面右上角那个小芽是同一条 `/api/coach`）。 |
| `team-workshop.js` | `renderUnknowns` | 2971 | 2974, 2975, 2978 | return `<div class="tw-head" style="margin:12px 0 4px"><h3 style="font-size:13.5px">这一页现在还不知道什么</h3> |
| `team-workshop.js` | `renderEval` | 2983 | 2985, 2987, 2989, 2992, 2999, 3000, 3011, 3012 …共18 | // 从盒子带过来的，页面上要看得见（`data-tw-handoff`），验收脚本按它核对交接真的到位。 |
| `xiaoya.js` | `FOCUS_STAT_BY_LABEL` | 131 | 131, 132, 134, 135, 139, 140 | const FOCUS_STAT_BY_LABEL = Object.freeze({生命: 'hp', 物攻: 'atk', 物防: 'def', |
| `xiaoya.js` | `getContext` | 521 | 528, 530, 531 | * 培养那几样：**每次现读本机记录**（页面读的就是它，刷新/回滚会变）。读不到就 `null`。 |
| `xiaoya.js` | `statusLine` | 711 | 713, 714, 724, 725, 726, 729, 730, 731 …共11 | if (answer.provider === 'deepseek') return 'DeepSeek 已回答 · 依据可展开查看'; |
| `xiaoya.js` | `capabilityChipText` | 787 | 788, 789, 795, 797, 798 | const toolsShort = tools === 'ok' ? '资料可用' : tools === 'down' ? '资料不可用' : '资料：问一句就拉起'; |
| `xiaoya.js` | `sanitizeAdviceText` | 827 | 840 | * 返回 `null` = **不画卡片**（没有建议，或只有一句空话）—— 这时也**不许**退化成 |
| `xiaoya.js` | `openingLine` | 1232 | 1233, 1234, 1235 | ? '我是小芽。这一页对着手游图鉴说话：你的伙伴、属性相性、技能与学习表、天气与规则说明都能查。' |
| `xiaoya.js` | `renderMemoryList` | 1262 | 1273, 1278, 1279 | <button class="mem-forget" data-forget="${esc(row.id)}" aria-label="忘掉这条">忘掉</button> |
| `xiaoya.js` | `renderModelList` | 1306 | 1314 | // R07：27B 不进产品入口（即使 `/api/models` 仍然把它报回来，也不在这一层画出来）。 |

## C. 收编建议（给语料/门禁的接线口径）

1. 语料的 `imp()` 目前只收 `src/game/*` 与 `src/coach/*`；client 侧**没有模块导出可供 `imp()` 调用** ——
   面板文案是**在 DOM 里拼出来的**，所以要收编得先有「可离屏调用」的入口：把 A 表里的渲染函数改成
   **纯函数返回 HTML 字符串**（多数已经是），再由语料侧用一个最小 DOM 桩（或直接调字符串函数）收集。
2. 最低成本的抓手：先收 **B 表**（`STAT_LABELS`/`STAT_NAMES_OF_KEY`/`STAT_ORDER`/`STAT_FIELDS` 这类**标签表**）
   —— 它们就是「面板/属性名」的唯一定义处，退役词只要在这儿出现就是玩家可见（不用跑 DOM）。
3. `auditProducerCoverage`（O-44）要求登记生产者；收编 client 时同样要登记，否则会走成"新增渲染器不登记"的绕过路径。
