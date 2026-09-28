#!/usr/bin/env node
/**
 * 全量立绘**解码**核对：把**全部已拥有实例**的立绘在真浏览器里逐一加载出来，量能不能解码、多少字节、多久。
 *
 * 由来（Codex 计划 2026-09-28 P1-03 验收要求）：
 * 「对所有已拥有实例自动检查路径与解码……保存截图及加载体积」「实测真实字节与解码/渲染耗时」。
 *
 * 与 `verify-capture-art.mjs` 的分工：
 *   · 那一份是**文件级**（不联网、不开浏览器）：路径、PNG 签名、IHDR 宽高、sha256 对不对；
 *     （2026-09-29 起它还有 `--server` 那一半：逐只打服务端，读回执头 + 对响应字节的 sha256。）
 *   · 这一份是**浏览器级**：同一批 URL 真的被浏览器取回来并解码出来（`naturalWidth > 0`）。
 *     文件对不等于能解码 —— 截断、色彩配置坏掉、Content-Type 不对，都只有这一份能抓到。
 *
 * 为什么用一个**合成页面**而不是逐页翻：目标是把 542 张都过一遍，
 * 而页面本身是懒加载 + 分页的（一次只画 24 张）。这里直接建一个离屏容器，
 * 用**页面自己的那套 URL**（`/api/roco/sprite?id=<pet_id>&v=default`）逐张加载，
 * 并发限流 8，量与页面完全同源。**不替代**页面判据：页面那份在 `browser-box-acceptance.mjs` 的 41/42。
 *
 * ── 2026-09-29 加的两层（人类逐字：「我看以前我上了自制立绘的还是原来的，你都改成官方吧」）──
 *   ① **来源核对**：每一张回执的 `X-Roco-Sprite-Source`（抓包图）/`X-Roco-Sprite-Key`（策展图）
 *      必须与"官方优先"口径算出来的预期一致 —— 有抓包图却回策展图就算失败。
 *   ② **字节核对**：回执字节的 sha256 必须等于磁盘上那张图（抓包缩略图 / 策展 PNG）的 sha256，
 *      所以尺寸分布那条读数不是"看起来变了"，是**同一批字节**换了出处。
 *   ③ `--shots`：真机截图 + 版式判据（桌面列表 / 详情 / 手机 390×844 不横向溢出、立绘不撑破卡片 /
 *      同名形态各显示自己那张图 / 双系精灵显示自己的图）。截图落 `reports/roco/capture-art/`。
 * 旧口径留档（2026-09-28 那一版，**不删**）：`by_status` 当时只数尺寸，
 * 期望值是 `{"256x256":501,"384x512":41}`（41 只走策展图）；2026-09-29 人类裁决反向后，
 * 期望值变成 `{"256x256":539,"384x512":3}`（只有抓包里根本没有的 3 只走策展图）。
 *
 * 跑法：
 *   node scripts/roco/browser-capture-art-decode.mjs [--json]   # 全量解码 + 来源 + 字节
 *   node scripts/roco/browser-capture-art-decode.mjs --shots    # 真机截图与版式/形态抽检
 */

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BASE = process.env.ROCO_BASE || 'http://127.0.0.1:8765/';
const OUT = join(ROOT, 'reports', 'roco', 'capture-art');
// ⚠ 2026-09-29（Lead 实测踩到）：`.gitignore:79` 有一条 `reports/roco/**/*.png` ⇒ 截图放 reports 里
// **不会进仓库**（磁盘上有、clone 下来没有）。所以截图落到 `docs/` 那一侧（不被忽略），
// reports 只留 json / log。
const SHOTS_DIR = join(ROOT, 'docs', 'roco', 'review-2026-09-28', 'shots', 'batch01');
const CAP = join(ROOT, 'data', 'roco', 'assets', 'capture-pets');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((p) => { try { readFileSync(p); return true; } catch { return false; } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-art-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  let port = 0; let err = '';
  chrome.stderr.on('data', (d) => { err += String(d); const m = /ws:\/\/[^:]+:(\d+)\//.exec(err); if (m) port = Number(m[1]); });
  for (let i = 0; i < 80 && !port; i += 1) await sleep(100);
  if (!port) throw new Error(`Chrome 没起来：${err.slice(-300)}`);
  return {chrome, port};
}

/** 连上 CDP，回一组 `send` / `js`（`js` 把表达式求值并取回传值）。 */
async function attach(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } };
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({id: n, method, params})); });
  const js = async (expr) => (await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true})).result?.result?.value;
  await send('Page.enable');
  return {send, js};
}

/** 轮询一个布尔表达式，直到真或超时。 */
async function waitJs(js, expr, tries = 60, ms = 200) {
  for (let i = 0; i < tries; i += 1) { if (await js(expr)) return true; await sleep(ms); }
  return false;
}

async function gotoSprite(cdp, url, readyExpr) {
  await cdp.send('Page.navigate', {url});
  await sleep(300);
  return waitJs(cdp.js, readyExpr, 80, 200);
}

async function shoot(cdp, name) {
  mkdirSync(SHOTS_DIR, {recursive: true});
  // `send()` 回的是整条 CDP 回执（`{id, result}`），截图数据在 `result.data` 里。
  const msg = await cdp.send('Page.captureScreenshot', {format: 'png'});
  const data = msg?.result?.data;
  if (typeof data !== 'string' || !data) throw new Error(`截图失败（${name}）：CDP 没回图数据`);
  const file = join(SHOTS_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return relative(ROOT, file);
}

/** 期望来源表：有抓包图 ⇒ capture(+两档 sha)；否则策展 ⇒ curated(+磁盘 sha)；都没有 ⇒ none。 */
function expectedSources(species) {
  const capMan = readJson(join(CAP, 'manifest.json'));
  const petsRoot = join(ROOT, 'data', 'roco', 'assets', 'pets');
  const petsMan = readJson(join(petsRoot, 'manifest.json'));
  const keyOfSlot = new Map((Array.isArray(petsMan) ? petsMan : []).map((r) => [Number(r?.slot), String(r?.asset_key || '')]));
  const roster = (() => {
    const doc = readJson(join(ROOT, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10', 'roster-48.json'));
    const rows = Array.isArray(doc) ? doc : (doc.pets ?? []);
    return rows;
  })();
  const keyOfPet = new Map(roster.map((p, i) => [String(p?.pet_id ?? ''), keyOfSlot.get(i + 1) || '']));
  const out = {};
  for (const petId of species) {
    const row = capMan.entries?.[petId];
    const thumb = row?.thumb_file ? join(CAP, 'thumb', String(row.thumb_file)) : null;
    const orig = row?.original_file ? join(CAP, 'originals', String(row.original_file)) : null;
    // 2026-09-29：512 战斗档（`&size=battle`）与 256 列表档分开算 —— 两档的 sha 都记下来，
    // 这样"战斗页拿到的到底是不是那张 512"是可判的，而不是"有个图就行"。
    const battlePack = row?.battle_sha256
      ? {battle_sha: row.battle_sha256, battle_w: row.battle_w, battle_h: row.battle_h} : {};
    if (thumb && existsSync(thumb)) { out[petId] = {source: 'capture', sha: row.thumb_sha256, ...battlePack}; continue; }
    if (orig && existsSync(orig)) { out[petId] = {source: 'capture', sha: row.original_sha256, ...battlePack}; continue; }
    const key = keyOfPet.get(petId);
    const file = key ? join(petsRoot, `${key}-default.png`) : null;
    if (file && existsSync(file)) { out[petId] = {source: 'curated', sha: sha256(readFileSync(file)), key}; continue; }
    out[petId] = {source: 'none', sha: null};
  }
  return out;
}

/** 全量解码核对（含来源与字节核对）。返回退出码。 */
async function decodeSweep(cdp, asJson) {
  const owned = readJson(join(ROOT, 'data', 'roco', 'owned', 'owned-pets.json'));
  const species = [...new Set((owned.instances ?? []).map((i) => String(i.species_id ?? '')).filter(Boolean))];
  const expected = expectedSources(species);

  await gotoSprite(cdp, `${BASE}box.html`, `document.body.dataset.boxReady==='yes'`);
  const report = await cdp.js(`(async()=>{
    const ids=${JSON.stringify(species)};
    const expected=${JSON.stringify(expected)};
    const t0=performance.now();
    const out={total:ids.length, ok:0, failed:[], bytes:0, decode_ms_total:0, max_ms:0, by_status:{},
      by_source:{}, source_mismatch:[], sha_mismatch:[],
      battle_ok:0, battle_failed:[], by_status_battle:{}, battle_bytes:0, battle_sha_mismatch:[]};
    const CONC=8;
    let cursor=0;
    const hex=(buf)=>[...new Uint8Array(buf)].map((b)=>b.toString(16).padStart(2,'0')).join('');
    async function worker(){
      while(cursor<ids.length){
        const petId=ids[cursor++];
        const t=performance.now();
        const url='/api/roco/sprite?id='+encodeURIComponent(petId)+'&v=default';
        const res=await fetch(url).catch(()=>null);
        if(!res||!res.ok){ out.failed.push({petId, why:'HTTP '+(res?res.status:'fetch-failed')}); continue; }
        const buf=await res.arrayBuffer();
        const blob=new Blob([buf]);
        const bmp=await createImageBitmap(blob).catch(()=>null);
        const dt=performance.now()-t;
        if(!bmp||!bmp.width||!bmp.height){ out.failed.push({petId, why:'解码失败（createImageBitmap 拿不到宽高）'}); continue; }
        out.ok+=1; out.bytes+=buf.byteLength; out.decode_ms_total+=dt;
        if(dt>out.max_ms) out.max_ms=dt;
        const k=bmp.width+'x'+bmp.height; out.by_status[k]=(out.by_status[k]??0)+1;
        bmp.close?.();
        // 这一张**究竟解析到了哪一份**（服务端回执头说了算）
        const source=res.headers.get('X-Roco-Sprite-Source')?'capture'
          :(res.headers.get('X-Roco-Sprite-Key')?'curated':'none');
        out.by_source[source]=(out.by_source[source]??0)+1;
        const want=expected[petId]??{source:'none',sha:null};
        if(source!==want.source){ out.source_mismatch.push({petId, got:source, want:want.source}); }
        if(want.sha){
          const got=hex(await crypto.subtle.digest('SHA-256', buf));
          if(got!==want.sha) out.sha_mismatch.push({petId, got:got.slice(0,12), want:String(want.sha).slice(0,12)});
        }
        // ── 512 战斗档（2026-09-29 人类裁决「战斗用大比例」）──────────────────────────
        // 抓包精灵才有战斗档；它必须真的是那一张 512（Variant 头 = battle，宽高 = 512，
        // 字节 sha256 = 清单里 battle_sha256）。
        if(!want.battle_sha) continue;
        const rb=await fetch('/api/roco/sprite?id='+encodeURIComponent(petId)+'&v=default&size=battle').catch(()=>null);
        if(!rb||!rb.ok){ out.battle_failed.push({petId, why:'HTTP '+(rb?rb.status:'fetch-failed')}); continue; }
        const bb=await rb.arrayBuffer();
        const bmpB=await createImageBitmap(new Blob([bb])).catch(()=>null);
        if(!bmpB||!bmpB.width||!bmpB.height){ out.battle_failed.push({petId, why:'战斗档解码失败'}); continue; }
        const variant=rb.headers.get('X-Roco-Sprite-Variant')||'(无)';
        const kk=bmpB.width+'x'+bmpB.height; out.by_status_battle[kk]=(out.by_status_battle[kk]??0)+1;
        out.battle_bytes+=bb.byteLength; bmpB.close?.();
        if(variant!=='battle'){ out.battle_failed.push({petId, why:'Variant='+variant+'（应当是 battle）', dim:kk}); continue; }
        const gotB=hex(await crypto.subtle.digest('SHA-256', bb));
        if(gotB!==want.battle_sha) out.battle_sha_mismatch.push({petId, got:gotB.slice(0,12), want:String(want.battle_sha).slice(0,12)});
        out.battle_ok+=1;
      }
    }
    await Promise.all(Array.from({length:CONC},worker));
    out.wall_ms=performance.now()-t0;
    out.decode_avg_ms=out.ok?out.decode_ms_total/out.ok:0;
    return JSON.stringify(out);
  })()`);

  const r = JSON.parse(report ?? '{}');
  mkdirSync(OUT, {recursive: true});
  if (asJson) {
    writeFileSync(join(OUT, 'decode-sweep.json'), `${JSON.stringify(r, null, 1)}\n`);
    console.log(JSON.stringify(r, null, 1));
  } else {
    console.log(`[art-decode] 全部已拥有实例 ${r.total} 只：解码成功 **${r.ok}**，失败 ${r.failed?.length ?? 0}`);
    console.log(`[art-decode] 合计 ${(r.bytes / 1048576).toFixed(1)} MB（均 ${Math.round(r.bytes / Math.max(1, r.ok))} 字节/张）`
      + `｜单张解码均 ${r.decode_avg_ms?.toFixed(1)} ms、最慢 ${r.max_ms?.toFixed(0)} ms｜整趟墙钟 ${(r.wall_ms / 1000).toFixed(1)} s（并发 8）`);
    console.log(`[art-decode] 尺寸分布：${JSON.stringify(r.by_status)}`);
    console.log(`[art-decode] 来源：${JSON.stringify(r.by_source)}`
      + `｜来源不符 ${r.source_mismatch?.length ?? 0}、字节 sha256 不符 ${r.sha_mismatch?.length ?? 0}`);
    for (const f of (r.failed ?? []).slice(0, 12)) console.log(`  ✖ ${f.petId}：${f.why}`);
    if ((r.failed?.length ?? 0) > 12) console.log(`  …还有 ${r.failed.length - 12} 只`);
    for (const f of (r.source_mismatch ?? []).slice(0, 12)) console.log(`  ✖ ${f.petId}：来源 ${f.got}，要求 ${f.want}`);
  }
  const bad = (r.failed?.length ?? 0) + (r.source_mismatch?.length ?? 0) + (r.sha_mismatch?.length ?? 0);
  return (r.ok === r.total && r.total > 0 && bad === 0) ? 0 : 1;
}

/** `--shots`：真机截图 + 版式/形态抽检。返回退出码。 */
async function shots(cdp, asJson) {
  const problems = [];
  const readings = {};
  const files = [];
  const capMan = readJson(join(CAP, 'manifest.json'));
  const expected = expectedSources(Object.keys(capMan.entries));

  /** 页内：某个 `<img>` 的服务端来源 + 字节 sha256（与页面看到的完全同一个 URL）。 */
  const imgFacts = `async(img)=>{
    const url=img.getAttribute('src');
    const res=await fetch(url);
    const buf=await res.arrayBuffer();
    const hex=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buf))].map((b)=>b.toString(16).padStart(2,'0')).join('');
    const bmp=await createImageBitmap(new Blob([buf])).catch(()=>null);
    return {url, source:res.headers.get('X-Roco-Sprite-Source')?'capture':(res.headers.get('X-Roco-Sprite-Key')?'curated':'none'),
      key:res.headers.get('X-Roco-Sprite-Key'), bytes:buf.byteLength, sha256:hex,
      w:bmp?.width??0, h:bmp?.height??0, natural:[img.naturalWidth,img.naturalHeight],
      shown:[Math.round(img.getBoundingClientRect().width),Math.round(img.getBoundingClientRect().height)]};
  }`;

  const gridFacts = `(()=>{
    const imgs=[...document.querySelectorAll('#box-grid .avatar-art img')];
    const cards=[...document.querySelectorAll('#box-grid .card')];
    return JSON.stringify({
      kind:document.body.dataset.boxKind, page:document.body.dataset.boxPage,
      offset:document.body.dataset.boxOffset, cards:cards.length, imgs:imgs.length,
      names:cards.map((c)=>c.querySelector('.card-name')?.textContent?.trim()??''),
      pending:imgs.filter((i)=>!(i.naturalWidth>0)).length,
      scrollWidth:document.documentElement.scrollWidth, innerWidth:window.innerWidth,
      overflow:imgs.map((i)=>{const r=i.getBoundingClientRect();const c=i.closest('.card').getBoundingClientRect();
        return {pet:i.getAttribute('src'), overLeft:+(c.left-r.left).toFixed(2), overRight:+(r.right-c.right).toFixed(2),
          overTop:+(c.top-r.top).toFixed(2), overBottom:+(r.bottom-c.bottom).toFixed(2)};}),
    });
  })()`;

  /** 等所有立绘解码完（懒加载的要先滚过去）。 */
  const settle = `(async()=>{
    const grid=document.querySelector('#box-grid');
    for(const el of [...grid.querySelectorAll('.card')]){ el.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,60)); }
    grid.scrollIntoView({block:'start'});
    const imgs=[...document.querySelectorAll('#box-grid .avatar-art img')];
    await Promise.all(imgs.map((i)=>i.complete?null:new Promise((r)=>{i.onload=r;i.onerror=r;})));
    await new Promise(r=>setTimeout(r,250));
    return true;
  })()`;

  const setViewport = (w, h, mobile) => cdp.send('Emulation.setDeviceMetricsOverride',
    {width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile});

  /**
   * 翻到某一页并**点开**这一只的详情（玩家真走的那条路：列表 → 点卡片 → 二级页）。
   *
   * ⚠ 两条实测出来的坑（2026-09-29，都在 `src/client/box.js` 里，**不在本次写域**，已记进交接）：
   *   ① 默认档「全部精灵」的卡**没有 `data-detail`**（`cardHtml` 里只写了 `.card-face`，
   *      而点击处理器只认 `[data-detail]`）⇒ 在默认档点卡片**什么都不发生**，详情页进不去；
   *      「我的盒子」那一档走分组抽屉，行上有 `data-detail` ⇒ 能点。
   *      所以这里**先切到「我的盒子」**再点（这是目前能真点到详情的那条路）。
   *   ② 深链 `box.html?pet=<不在当前页的那一只>` 时卡片找不到 ⇒ 大头像 `src` 变成空 id ⇒
   *      服务端 404 ⇒ 详情页没有立绘（`?pet=pet_000012` 在第一页 ⇒ 正常；`?pet=pet_000112` 在第五页 ⇒ 没图）。
   *      所以这里不靠深链，走点击流。
   */
  const openDetailByName = async (name) => {
    await gotoSprite(cdp, `${BASE}box.html`, `document.body.dataset.boxReady==='yes'`);
    await cdp.js(`document.querySelector('#tab-mine')?.click()`);
    await waitJs(cdp.js, `document.body.dataset.boxKind==='mine'`, 40, 200);
    let hit = false;
    for (let i = 0; i < 26 && !hit; i += 1) {
      hit = !!(await cdp.js(`[...document.querySelectorAll('#box-grid .card-name')].some((n)=>n.textContent.trim()===${JSON.stringify(name)})`));
      if (hit) break;
      const before = await cdp.js(`document.body.dataset.boxOffset`);
      await cdp.js(`document.querySelector('#page-next')?.click()`);
      await waitJs(cdp.js, `document.body.dataset.boxOffset!==${JSON.stringify(String(before))}`, 20, 200);
    }
    if (!hit) return {missing: `列表翻到最后一页也没找到「${name}」`};
    await cdp.js(`(async()=>{
      const card=[...document.querySelectorAll('#box-grid .card')].find((c)=>c.querySelector('.card-name')?.textContent.trim()===${JSON.stringify(name)});
      card.scrollIntoView({block:'center'});
      await new Promise(r=>setTimeout(r,250));
      (card.querySelector('[data-detail]')??card.querySelector('.card-face')).click();
      return true;
    })()`);
    const opened = await waitJs(cdp.js, `document.body.dataset.boxView==='pet'`, 40, 200);
    if (!opened) return {missing: `点了「${name}」的卡片但没进二级页（boxView 还是 list）`};
    await waitJs(cdp.js, `/#pet-view .avatar.big.avatar-art img/.test(document.querySelector('#pet-view')?.innerHTML??'')`, 40, 200);
    await sleep(400);
    return JSON.parse(await cdp.js(`(async()=>{
      const img=document.querySelector('#pet-view .avatar.big.avatar-art img');
      const src=img?.getAttribute('src')??null;
      if(img){ await (img.complete?null:new Promise((r)=>{img.onload=r;img.onerror=r;})); }
      return JSON.stringify({clicked:true, urlHasPet:/[?&]pet=/.test(location.search),
        petNav:document.body.dataset.boxPet,
        title:document.querySelector('#pet-title')?.textContent?.trim()??null,
        types:[...document.querySelectorAll('#pet-view .type')].map((t)=>t.textContent.trim()),
        facts: img?await (${imgFacts})(img):null});
    })()`) ?? '{}');
  };

  // ── ① 桌面列表 1440×900（默认档「全部精灵」）：翻到「音速犬」那一页 ────────────────────
  // 它原来是策展 `pet-01-音速犬`（384×512 自制图），现在应当是官方抓包图 256×256。
  await setViewport(1440, 900, false);
  await gotoSprite(cdp, `${BASE}box.html`, `document.body.dataset.boxReady==='yes'`);
  let found = false;
  for (let i = 0; i < 26 && !found; i += 1) {
    found = !!(await cdp.js(`[...document.querySelectorAll('#box-grid .card-name')].some((n)=>n.textContent.trim()==='音速犬')`));
    if (found) break;
    await cdp.js(`document.querySelector('#page-next')?.click()`);
    await sleep(500);
  }
  await cdp.js(settle);
  const listFacts = JSON.parse(await cdp.js(gridFacts) ?? '{}');
  const sonic = JSON.parse(await cdp.js(`(async()=>{
    const card=[...document.querySelectorAll('#box-grid .card')].find((c)=>c.querySelector('.card-name')?.textContent.trim()==='音速犬');
    if(!card) return '{}';
    card.scrollIntoView({block:'center'});
    await new Promise(r=>setTimeout(r,300));
    const img=card.querySelector('.avatar-art img');
    return JSON.stringify({name:'音速犬', select:card.getAttribute('data-select')??null,
      facts: img?await (${imgFacts})(img):null});
  })()`) ?? '{}');
  readings['① 桌面列表·音速犬'] = {kind: listFacts.kind, page: listFacts.page, cards: listFacts.cards,
    imgs: listFacts.imgs, card: sonic};
  const sonicFacts = sonic?.facts;
  if (!sonicFacts) problems.push('① 列表里找不到「音速犬」的卡（翻页 26 次没找到）');
  else {
    if (!sonicFacts.url.includes('id=pet_000062')) problems.push(`① 音速犬的 img 指向 ${sonicFacts.url}，不是 pet_000062`);
    if (sonicFacts.natural?.[0] !== 256 || sonicFacts.natural?.[1] !== 256) {
      problems.push(`① 音速犬立绘没解码成 256×256（naturalWidth/Height=${JSON.stringify(sonicFacts.natural)}）`);
    }
    if (sonicFacts.source !== 'capture') problems.push(`① 音速犬走的还是 ${sonicFacts.source}（要求 capture 官方图）`);
    if (sonicFacts.sha256 !== expected.pet_000062?.sha) problems.push('① 音速犬回执字节与官方抓包缩略图不是同一份（sha256 不符）');
  }
  if (Number(listFacts.pending) > 0) problems.push(`① 列表这一页有 ${listFacts.pending} 张立绘没解码出来`);
  files.push(await shoot(cdp, 'art-01-list-official'));

  // ── ② 桌面详情 1440×900：「雪影娃娃」(列表第 5 页 → 点卡片进二级页) ─────────────────────
  // 它原来是策展 `pet-02-雪影娃娃`（384×512 自制图），现在应当是官方抓包图 256×256。
  const detail = await openDetailByName('雪影娃娃');
  readings['② 桌面详情·雪影娃娃'] = detail;
  if (detail.missing || !detail.facts) problems.push(`② 详情页没开出立绘：${detail.missing ?? '没有 #pet-view 大头像'}`);
  else {
    if (!String(detail.facts.url).includes('id=pet_000112')) problems.push(`② 详情页的图指向 ${detail.facts.url}，不是 pet_000112`);
    if (detail.facts.source !== 'capture') problems.push(`② 雪影娃娃走的还是 ${detail.facts.source}（要求 capture 官方图）`);
    if (detail.facts.sha256 !== expected.pet_000112?.sha) problems.push('② 雪影娃娃回执字节与官方抓包缩略图不是同一份（sha256 不符）');
    if (detail.facts.natural?.[0] !== 256 || detail.facts.natural?.[1] !== 256) {
      problems.push(`② 详情大头像不是 256×256（natural=${JSON.stringify(detail.facts.natural)}）`);
    }
  }
  files.push(await shoot(cdp, 'art-02-detail'));

  // ── ③ 手机 390×844：不横向溢出、立绘不撑破卡片 ────────────────────────────────────────
  await setViewport(390, 844, true);
  await gotoSprite(cdp, `${BASE}box.html`, `document.body.dataset.boxReady==='yes'`);
  await sleep(600);
  await cdp.js(settle);
  const mobile = JSON.parse(await cdp.js(gridFacts) ?? '{}');
  readings['③ 手机 390×844'] = {page: mobile.page, cards: mobile.cards, imgs: mobile.imgs,
    scrollWidth: mobile.scrollWidth, innerWidth: mobile.innerWidth, pending: mobile.pending,
    worstOverflow: (mobile.overflow ?? []).reduce((acc, o) => ({
      overRight: Math.max(acc.overRight, o.overRight), overLeft: Math.max(acc.overLeft, o.overLeft),
      overTop: Math.max(acc.overTop, o.overTop), overBottom: Math.max(acc.overBottom, o.overBottom)}),
      {overRight: -99, overLeft: -99, overTop: -99, overBottom: -99})};
  if (Number(mobile.scrollWidth) > Number(mobile.innerWidth)) {
    problems.push(`③ 手机版横向溢出：scrollWidth=${mobile.scrollWidth} > innerWidth=${mobile.innerWidth}`);
  }
  const spill = (mobile.overflow ?? []).filter((o) => o.overRight > 0.6 || o.overLeft > 0.6
    || o.overTop > 0.6 || o.overBottom > 0.6);
  if (spill.length) problems.push(`③ 有 ${spill.length} 张立绘撑出卡片边界：${JSON.stringify(spill.slice(0, 3))}`);
  if (Number(mobile.pending) > 0) problems.push(`③ 手机这一页有 ${mobile.pending} 张立绘没解码出来`);
  files.push(await shoot(cdp, 'art-03-mobile-390'));

  // ── ④ 同名形态：千棘盔 pet_000271 / pet_000378 各自显示自己那张图 ────────────────────────
  await setViewport(1440, 900, false);
  await gotoSprite(cdp, `${BASE}box.html`, `document.body.dataset.boxReady==='yes'`);
  await waitJs(cdp.js, `document.body.dataset.boxKind==='mine'`, 40, 200);
  await cdp.js(`(()=>{const s=document.querySelector('#box-search');s.value='千棘盔';s.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await sleep(900);
  await cdp.js(settle);
  const forms = JSON.parse(await cdp.js(`(async()=>{
    const cards=[...document.querySelectorAll('#box-grid .card')];
    const out=[];
    for(const card of cards){
      const name=card.querySelector('.card-name')?.textContent.trim()??'';
      const img=card.querySelector('.avatar-art img');
      if(!img) { out.push({name, facts:null}); continue; }
      card.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,250));
      out.push({name, facts: await (${imgFacts})(img)});
    }
    return JSON.stringify({cards:cards.length, rows:out, scrollWidth:document.documentElement.scrollWidth});
  })()`) ?? '{}');
  const rows = forms.rows ?? [];
  readings['④ 同名形态·千棘盔'] = rows.map((r) => ({name: r.name, pet: r.facts?.url,
    source: r.facts?.source, sha256: r.facts?.sha256?.slice(0, 16), natural: r.facts?.natural,
    capture_id: (r.facts?.url?.match(/pet_000271/) ? capMan.entries.pet_000271?.capture_id
      : (r.facts?.url?.match(/pet_000378/) ? capMan.entries.pet_000378?.capture_id : null))}));
  if (rows.length !== 2) problems.push(`④ 搜「千棘盔」应当正好 2 张卡，实际 ${rows.length}`);
  const ids = rows.map((r) => (r.facts?.url ?? '').replace(/.*id=/, '').replace(/&.*/, ''));
  if (new Set(ids).size !== ids.length) problems.push(`④ 两只千棘盔指向了同一张图：${JSON.stringify(ids)}`);
  for (const want of ['pet_000271', 'pet_000378']) {
    const row = rows.find((r) => (r.facts?.url ?? '').includes(`id=${want}`));
    if (!row) { problems.push(`④ 没找到 ${want} 的卡`); continue; }
    if (row.facts.sha256 !== expected[want]?.sha) problems.push(`④ ${want} 显示的不是它自己那张官方图（sha256 与清单不符）`);
    if (row.facts.source !== 'capture') problems.push(`④ ${want} 走的不是官方图（${row.facts.source}）`);
  }
  if (rows.length === 2 && rows[0].facts?.sha256 === rows[1].facts?.sha256) problems.push('④ 两只千棘盔的字节完全相同（同一张图复用）');
  files.push(await shoot(cdp, 'art-04-forms'));

  // ── ⑤ 双系：蹦蹦种子（海神球形态）草系｜毒系 —— 列表卡上两个系别胶囊 + 它自己那张官方图 ─────
  // 为什么量**列表卡**而不是详情页：详情页的系别胶囊读的是服务端详情回执，而那份回执**不含 types**
  // （实测 `player` 的键里有 group/art，没有 types）⇒ 详情页上系别是空的。这不是立绘问题，
  // 但会让"双系"这条判据在详情页上永远量不到东西，所以量卡片这一层（玩家也确实是在卡片上看到系别的）。
  await gotoSprite(cdp, `${BASE}box.html`, `document.body.dataset.boxReady==='yes'`);
  await cdp.js(`(()=>{const s=document.querySelector('#box-search');s.value='蹦蹦种子';s.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await sleep(1000);
  await cdp.js(settle);
  const dual = JSON.parse(await cdp.js(`(async()=>{
    const card=[...document.querySelectorAll('#box-grid .card')].find((c)=>c.querySelector('.card-name')?.textContent.trim()==='蹦蹦种子（海神球形态）');
    if(!card) return JSON.stringify({missing:'搜「蹦蹦种子」后找不到（海神球形态）那一张卡'});
    card.scrollIntoView({block:'center'});
    await new Promise(r=>setTimeout(r,300));
    const img=card.querySelector('.avatar-art img');
    return JSON.stringify({name:card.querySelector('.card-name')?.textContent.trim(), select:card.getAttribute('data-select'),
      types:[...card.querySelectorAll('.card-types .type')].map((t)=>t.textContent.trim()),
      facts: img?await (${imgFacts})(img):null});
  })()`) ?? '{}');
  readings['⑤ 双系·蹦蹦种子（海神球形态）'] = dual;
  if (dual.missing || !dual.facts) problems.push(`⑤ 双系卡片没量到：${dual.missing ?? '卡上没有立绘'}`);
  else {
    if (!String(dual.facts.url).includes('id=pet_000016')) problems.push(`⑤ 双系的图指向 ${dual.facts.url}，不是 pet_000016`);
    if (dual.facts.sha256 !== expected.pet_000016?.sha) problems.push('⑤ 双系显示的不是它自己那张官方图（sha256 与清单不符）');
    if ((dual.types ?? []).length !== 2) problems.push(`⑤ 这只应当是双系，卡片上读到 ${JSON.stringify(dual.types)}`);
    if (dual.facts.natural?.[0] !== 256 || dual.facts.natural?.[1] !== 256) problems.push(`⑤ 双系立绘不是 256×256（natural=${JSON.stringify(dual.facts.natural)}）`);
  }
  files.push(await shoot(cdp, 'art-05-dual-type'));

  // ── ⑥ 两个产品缺口的**读数**（不进本次判据：两处都在 `src/client/box.js`，不在写域）─────────
  // ① 默认档「全部精灵」的卡片没有 `data-detail` ⇒ 点卡片进不了详情（点击处理器只认 `[data-detail]`）；
  // ② 深链到"不在当前页"的那一只 ⇒ 大头像 src 是空 id，服务端 404，详情页没有立绘。
  await gotoSprite(cdp, `${BASE}box.html`, `document.body.dataset.boxReady==='yes'`);
  const gapList = JSON.parse(await cdp.js(`(()=>{
    const g=document.querySelector('#box-grid');
    return JSON.stringify({kind:document.body.dataset.boxKind, grouped:g.dataset.grouped,
      cards:g.querySelectorAll('.card').length, dataDetail:g.querySelectorAll('[data-detail]').length,
      faceHasDetail:g.querySelectorAll('.card-face[data-detail]').length});
  })()`) ?? '{}');
  await cdp.js(`document.querySelector('#box-grid .card .card-face')?.click()`);
  await sleep(600);
  const gapClick = await cdp.js(`document.body.dataset.boxView`);
  readings['⑥ 缺口读数·默认档点卡片'] = {...gapList, viewAfterClick: gapClick,
    note: '默认档（全部精灵）卡上无 data-detail ⇒ 点击处理器 `[data-detail]` 不命中，详情进不去；'
      + '「我的盒子」档走分组抽屉，行上有 data-detail（见 ②/⑤ 就是用那条路进的）'};
  await gotoSprite(cdp, `${BASE}box.html?pet=pet_000112`, `document.body.dataset.boxView==='pet'`);
  await sleep(800);
  readings['⑥ 缺口读数·深链第 5 页的个体'] = JSON.parse(await cdp.js(`(()=>{
    const img=document.querySelector('#pet-view .avatar.big.avatar-art img');
    return JSON.stringify({deepLink:'box.html?pet=pet_000112（第 5 页）', imgSrc:img?.getAttribute('src')??'(没有 img)',
      title:document.querySelector('#pet-title')?.textContent?.trim()??null,
      note:'二级页只从当前已加载那一页的 rows 找卡；找不到 ⇒ card.group 为空 ⇒ src 空 id ⇒ 404'});
  })()`) ?? '{}');

  const report = {base: BASE, problems, readings, files};
  mkdirSync(OUT, {recursive: true});
  writeFileSync(join(OUT, 'shot-checks.json'), `${JSON.stringify(report, null, 1)}\n`);
  if (asJson) { console.log(JSON.stringify(report, null, 1)); return problems.length ? 1 : 0; }
  for (const [k, v] of Object.entries(readings)) console.log(`[art-shots] ${k}：${JSON.stringify(v)}`);
  console.log(`[art-shots] 截图 ${files.length} 张 → ${files.join('、')}`);
  if (problems.length) { console.log(`[art-shots] ✖ ${problems.length} 条问题：`); for (const p of problems) console.log('  - ' + p); }
  else console.log('[art-shots] ✔ 桌面列表/详情、手机 390×844、同名形态、双系 全部通过');
  return problems.length ? 1 : 0;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const asShots = process.argv.includes('--shots');
  const {chrome, port} = await launch();
  let code = 1;
  try {
    const cdp = await attach(port);
    code = asShots ? await shots(cdp, asJson) : await decodeSweep(cdp, asJson);
  } finally {
    try { chrome.kill('SIGKILL'); } catch { /* 进程已经退出 */ }
  }
  process.exit(code);
}

await main();
