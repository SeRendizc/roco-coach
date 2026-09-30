// F-03-1 改后读数：在线段覆盖 + 命中 + 与旧口径对照
import {readFileSync} from 'node:fs';
const ROOT = 'E:/roco-coach';
const M = await import(`file:///${ROOT}/src/coach/opponent-belief.mjs`);
const src = readFileSync(`${ROOT}/src/coach/opponent-belief.mjs`, 'utf8');

const OLD_ONLINE = (source) => {
  const text = String(source ?? '');
  const at = text.indexOf('<!-- ONLINE-SECTION-END -->');
  const head = at >= 0 ? text.slice(0, at) : text;
  return head.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '')).join('\n');
};

const oldSection = OLD_ONLINE(src);
const newSection = M.onlineSectionOf(src);
const coverage = M.onlineSectionCoverage(src);
console.log('旧口径（改前）: online_lines =', oldSection.split('\n').length,
  ' hits =', JSON.stringify(M.scanForbiddenPatterns(oldSection).map((h) => `${h.code}:${h.pattern}`)),
  ' 覆盖入口 =', JSON.stringify(M.ONLINE_ENTRYPOINTS.filter((n) => new RegExp(`(function|const|let|class)\\s+${n}\\b`).test(oldSection))));
console.log('新口径（改后）: online_lines =', coverage.online_lines,
  ' online_chars =', coverage.online_chars,
  ' hits =', JSON.stringify(coverage.hits));
console.log('  扫到的在线入口 =', JSON.stringify(coverage.scanned_online_entrypoints));
console.log('  缺失的在线入口 =', JSON.stringify(coverage.missing_online_entrypoints));
const audit = M.auditOpponentBelief({beliefs: [M.uniformBelief({catalog: null})], source: src, scope: 'online'});
console.log('  真实源码审计 problems =', JSON.stringify(audit.problems.map((p) => `${p.code}:${p.where}`)));
// 旧口径在线段里不含任何在线入口的证明
console.log('旧口径覆盖空？', M.ONLINE_ENTRYPOINTS.filter((n) => new RegExp(`(function|const|let|class)\\s+${n}\\b`).test(oldSection)).length === 0);
