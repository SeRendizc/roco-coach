// `--selftest` 用的临时目录脚手架。
//
// 单独立一个文件，是为了让**入口脚本**可以完全不写文件：入口脚本只读，
// 这份脚手架只在自检时按传入的描述造一棵小树，跑完删掉。
// 于是「检查器只检查」这句话有一条可执行的判据，而不是一句注释：
// `assertNoAutomation(source)` 会在自检里扫入口脚本的源码，发现写文件 API 就抛。

import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

/**
 * 造一棵临时树。
 *
 * @param {Record<string, unknown>} files 相对路径 → 内容。
 *   字符串原样写入；对象与数组 `JSON.stringify` 后写入（缩进 1，便于人读）。
 * @returns `{dir, io, cleanup}`；`cleanup()` 幂等。
 */
export function makeTree(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roco-train-selftest-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 1)}\n`);
  }
  let cleaned = false;
  return {
    dir,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(dir, {recursive: true, force: true});
    },
  };
}

/**
 * 在指定目录下写文件（`makeTree` 的增量版，供多阶段自检用）。
 * 路径必须已经在 `dir` 里，避免自检把文件写到临时目录之外。
 */
export function putFile(dir, rel, content) {
  const target = join(dir, rel);
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 1)}\n`);
  return target;
}
