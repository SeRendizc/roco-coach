# 战斗技能支持文案：本地候选，待根复核

基线663aa2f4b44786ebd9e52276c449cbff7b954444。仅改roco.js三个技能支持显示消费点及一个新定向Node测试；未修改server/support事实、其它源码/package/Git/服务/模型/STATE/画像数据。

正常settled=true的技能不再在常显技能卡上重复强调“引擎会结算这条效果”，正面来源事实仍在技能详情可查。部分支持/不支持的具体note保持常显；换人/换技能复用卡片时，从部分支持切到正常支持会撤除旧警示。伤害预计值及“未核验”标记保持。展开详情优先使用真实support.note，避免丢失具体未实现片段；正常来源标签改为“结算依据”，不再放在“未实现部分”标签下。

`node --test tests/roco-skill-support-wording.test.js`：before.tap exit1，2条consumer反例均红。新测试提取并执行实际skillSlotHtml、b3SkillDetailRows及实际battle slot支持渲染块；DOM对象仅提供append/remove，不复制显示逻辑。

`node --test tests/roco-skill-support-wording.test.js tests/roco-skill-support-fact.test.js`：after.tap exit0，7通过/0失败取消跳过。覆盖正常警示隐藏而详情来源保留、PARTIAL/KNOWLEDGE_ONLY具体note、估算标记保留和复用卡片警示清理；既有server支持事实5项未改。基线服务正面事实保持settled=true，未以null混淆未知。

`node --check src/client/roco.js`及定向diffcheck均exit0。未启动服务、未发模型请求、未新跑浏览器或全库；此处证明实际显示consumer合同，最终页面视觉由根验收。新tests/roco-skill-support-wording.test.js需要根登记，未自行改package。下一步仅根独立复核与整合。
