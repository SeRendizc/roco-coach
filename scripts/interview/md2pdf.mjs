#!/usr/bin/env node
// 把 docs/interview 下的 Markdown 渲染成 A4 PDF（只读 Markdown，输出到 /tmp 或指定路径）。
// 依赖：本机 Google Chrome（headless 打印）。不安装任何东西。
//
// 用法：
//   node scripts/interview/md2pdf.mjs docs/interview/CHEATSHEET-2026-10-17.md
//   node scripts/interview/md2pdf.mjs docs/interview/CHEATSHEET-2026-10-17.md --out docs/interview/CHEATSHEET-2026-10-17.pdf

import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync, statSync} from 'node:fs';
import {dirname, basename, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('用法: node scripts/interview/md2pdf.mjs <input.md> [--out 输出.pdf]');
  process.exit(2);
}
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? resolve(args[outIdx + 1]) : join('/tmp', `${basename(input, '.md')}.pdf`);

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 极简、够用的 Markdown 渲染：标题 / 表格 / 列表 / 代码块 / 引用 / 分隔线 / 行内样式。
function render(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let inCode = false;
  let code = [];
  let listType = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

  const inline = (text) => {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    return s;
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (inCode) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    if (/^\s*$/.test(line)) { closeList(); continue; }
    if (/^\s*---+\s*$/.test(line)) { closeList(); out.push('<hr/>'); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (/^\s*>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`); continue; }
    // 表格：当前行含 | 且下一行像分隔行
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeList();
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) { body.push(cells(lines[i])); i++; }
      i--;
      out.push('<table>');
      out.push(`<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`);
      for (const row of body) out.push(`<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      out.push('</tbody></table>');
      continue;
    }
    const ol = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (ol) { if (listType !== 'ol') { closeList(); listType = 'ol'; out.push('<ol>'); } out.push(`<li>${inline(ol[2])}</li>`); continue; }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) { if (listType !== 'ul') { closeList(); listType = 'ul'; out.push('<ul>'); } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  closeList();
  return out.join('\n');
}

const css = `
@page { size: A4; margin: 12mm 12mm 12mm 12mm; }
* { box-sizing: border-box; }
body { font-family: "PingFang SC", "Hiragino Sans GB", "Songti SC", sans-serif; font-size: 9.6pt; line-height: 1.42; color: #1a1a1a; }
h1 { font-size: 15pt; margin: 0 0 6pt; color: #0E5484; }
h2 { font-size: 12pt; margin: 10pt 0 4pt; color: #0E5484; border-bottom: 0.8pt solid #AFC5D3; padding-bottom: 2pt; page-break-after: avoid; }
h3 { font-size: 10.5pt; margin: 8pt 0 3pt; color: #0E5484; page-break-after: avoid; }
p { margin: 3pt 0; }
ul, ol { margin: 3pt 0 3pt 14pt; padding: 0; }
li { margin: 1.5pt 0; }
table { border-collapse: collapse; width: 100%; margin: 4pt 0; font-size: 8.8pt; page-break-inside: auto; }
th, td { border: 0.6pt solid #b9c7d2; padding: 2.5pt 4pt; text-align: left; vertical-align: top; }
th { background: #eef3f7; }
code { font-family: "SF Mono", Menlo, monospace; font-size: 8.4pt; background: #f2f4f7; padding: 0 2pt; border-radius: 2pt; }
pre { background: #f6f8fa; border: 0.5pt solid #d8dee4; padding: 5pt; overflow: hidden; white-space: pre-wrap; word-break: break-all; }
pre code { background: none; font-size: 8pt; }
blockquote { margin: 3pt 0; padding: 2pt 8pt; border-left: 2.5pt solid #AFC5D3; background: #f7fafc; color: #333; }
hr { border: none; border-top: 0.6pt solid #d0d7de; margin: 7pt 0; }
a { color: #0E5484; text-decoration: none; }
strong { color: #0b3f63; }
`;

const mdPath = resolve(input);
const md = readFileSync(mdPath, 'utf8');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${css}</style></head><body>${render(md)}</body></html>`;
const htmlPath = join('/tmp', `${basename(input, '.md')}.html`);
mkdirSync(dirname(htmlPath), {recursive: true});
writeFileSync(htmlPath, html, 'utf8');

execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
  `--print-to-pdf=${out}`, `file://${htmlPath}`,
], {stdio: 'ignore'});

const size = statSync(out).size;
console.log(JSON.stringify({input: mdPath, html: htmlPath, pdf: out, bytes: size}, null, 2));
