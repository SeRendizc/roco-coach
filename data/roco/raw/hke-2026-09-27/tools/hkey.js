'use strict';

/**
 * 小黑盒 (xiaoheihe / heybox) 请求签名 hkey 生成器。
 *
 * 重要结论（决定了本文件的性质）：
 *   hkey = f(请求路径, _time, nonce)，**不包含任何密钥**。
 *   它只是把三个公开值做字符表映射后 MD5，再取片段。没有 secret salt，
 *   没有服务端下发的 token。所以任何人都能离线复算 hkey。
 *
 * 因此 hkey 只解决"这个请求是由官方前端格式构造的"，它**不解决登录态**。
 * 如果接口返回 {"status":"relogin"}，说明缺的是Cookie/会话凭据，不是签名。
 *
 * 参考实现（第三方，仅作算法文本参考，未执行其代码）：
 *   https://github.com/luckylca/xhhBackCrack  (main 分支 Hkey.js, sha 53ee64231ce83df9bc08c3d74b0e07dbecdabc2a)
 */

const crypto = require('crypto');

/** 固定字符表，顺序敏感，不可改动 */
const CHARSET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';

/* ---------- 基础混淆函数（按位运算，作用于 0-255） ---------- */

function Vm(e) {
  if (e & 128) return 255 & ((e << 1) ^ 27);
  return e << 1;
}

function qm(e) {
  return Vm(e) ^ e;
}

function dollar_m(e) {
  return qm(Vm(e));
}

function Ym(e) {
  return dollar_m(qm(Vm(e)));
}

function Gm(e) {
  return Ym(e) ^ dollar_m(e) ^ qm(e);
}

/** 对长度>=4的字节数组做一次 4 路混合 */
function mixed(eArr) {
  const e = eArr.slice();
  const t = [0, 0, 0, 0];
  t[0] = Gm(e[0]) ^ Ym(e[1]) ^ dollar_m(e[2]) ^ qm(e[3]);
  t[1] = qm(e[0]) ^ Gm(e[1]) ^ Ym(e[2]) ^ dollar_m(e[3]);
  t[2] = dollar_m(e[0]) ^ qm(e[1]) ^ Gm(e[2]) ^ Ym(e[3]);
  t[3] = Ym(e[0]) ^ dollar_m(e[1]) ^ qm(e[2]) ^ Gm(e[3]);
  e[0] = t[0];
  e[1] = t[1];
  e[2] = t[2];
  e[3] = t[3];
  return e;
}

/**
 * 把字符串按 charCode % 表长 映射到字符表。
 * @param {string} str 输入
 * @param {string} table 字符表
 * @param {number} [cut] 负数表示先截掉表尾 |cut| 位
 */
function mapChars(str, table, cut) {
  let tbl = table;
  if (typeof cut === 'number') {
    tbl = cut < 0 ? table.slice(0, cut) : table.slice(0, cut);
  }
  let out = '';
  for (const ch of str) {
    out += tbl[ch.charCodeAt(0) % tbl.length];
  }
  return out;
}

/**
 * 计算 hkey。
 * @param {string} urlPath 请求路径，**不含 query**，例如 /game/roco_kingdom/pet/detail
 * @param {number|string} timestamp 10 位秒级时间戳
 * @param {string} nonce 32 位大写十六进制字符串
 * @returns {string} 8 位 hkey，例如 "UVD0D97"
 */
function get_hkey(urlPath, timestamp, nonce) {
  if (typeof urlPath !== 'string' || urlPath.length === 0) {
    throw new Error('get_hkey: urlPath 必填');
  }
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new Error('get_hkey: nonce 必填');
  }

  // 1. 路径规范化：过滤空段，前后各补一个 /
  const parts = String(urlPath).split('/').filter((p) => p);
  const normalizedPath = '/' + parts.join('/') + '/';

  // 2. 三个分量
  const comp1 = mapChars(String(timestamp), CHARSET, -2); // 时间戳，表切掉后 2 位
  const comp2 = mapChars(normalizedPath, CHARSET); // 路径，整表
  const comp3 = mapChars(nonce, CHARSET); // nonce，整表

  // 3. 交错合并：逐位轮流取
  const comps = [comp1, comp2, comp3];
  const maxLen = Math.max(comp1.length, comp2.length, comp3.length);
  let interleaved = '';
  for (let k = 0; k < maxLen; k++) {
    for (const c of comps) {
      if (k < c.length) interleaved += c[k];
    }
  }

  // 4. MD5（取交错串前 20 位）
  const md5hex = crypto
    .createHash('md5')
    .update(interleaved.slice(0, 20))
    .digest('hex');

  // 5. 前缀：MD5 前 5 位映射，表切掉后 4 位
  const hkeyPrefix = mapChars(md5hex.slice(0, 5), CHARSET, -4);

  // 6. 后缀校验：MD5 后 6 位 -> charCode -> 混合 -> 求和 % 100
  const suffixBytes = Array.from(md5hex.slice(-6)).map((c) => c.charCodeAt(0));
  const kmOut = mixed(suffixBytes);
  const checksum = kmOut.reduce((a, b) => a + b, 0) % 100;
  const checksumStr = String(checksum).padStart(2, '0');

  return hkeyPrefix + checksumStr;
}

/** 随机 nonce：MD5(时间戳 + 随机数) 的大写十六进制 */
function generateNonce() {
  const randomStr = String(Date.now()) + String(Math.random());
  return crypto.createHash('md5').update(randomStr).digest('hex').toUpperCase();
}

/** 当前 10 位秒级时间戳 */
function getTimestamp() {
  return Math.floor(Date.now() / 1000);
}

module.exports = {
  CHARSET,
  get_hkey,
  generateNonce,
  getTimestamp,
  mapChars,
};
