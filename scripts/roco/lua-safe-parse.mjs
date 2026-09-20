// 安全 Lua 数据表解析器 —— 只把 Lua 当「文本 / 数据」解析，绝不执行第三方代码。
//
// 为什么必须自己写：
//   上游 `rocom-wiki-data` 的 data/*.lua 是 Lua 表字面量（`return {...}`），
//   用正则拆容易在嵌套 table 和含 `{`/`}`/`,` 的中文描述上出错。
//   这里用一个逐字符扫描器处理：嵌套、字符串转义、`["中文键"]`、数组段与键值段混排。
//
// 明确不做的事：
//   - 不 eval / 不 new Function / 不 require / 不调用 lua 解释器
//   - 不支持函数、方法调用、算术表达式、变量引用；遇到即抛错（fail loud，不静默猜）

const WS = new Set([' ', '\t', '\r', '\n']);

class LuaParseError extends Error {}

function parseLuaTable(source, { file = '<memory>' } = {}) {
  const s = source;
  let i = 0;

  function fail(msg) {
    const line = s.slice(0, i).split('\n').length;
    throw new LuaParseError(`${file}:${line}: ${msg} (offset ${i})`);
  }

  function skip() {
    for (;;) {
      while (i < s.length && WS.has(s[i])) i++;
      // Lua 注释：-- 行注释、--[[ 块注释 ]]
      if (s[i] === '-' && s[i + 1] === '-') {
        i += 2;
        if (s[i] === '[') {
          let j = i + 1;
          let eq = 0;
          while (s[j] === '=') { eq++; j++; }
          if (s[j] === '[') {
            const close = ']' + '='.repeat(eq) + ']';
            const end = s.indexOf(close, j + 1);
            if (end < 0) fail('unterminated block comment');
            i = end + close.length;
            continue;
          }
        }
        while (i < s.length && s[i] !== '\n') i++;
        continue;
      }
      return;
    }
  }

  function readLongString() {
    // [[ ... ]] / [==[ ... ]==]
    let j = i + 1;
    let eq = 0;
    while (s[j] === '=') { eq++; j++; }
    if (s[j] !== '[') fail('bad long string opener');
    const close = ']' + '='.repeat(eq) + ']';
    const end = s.indexOf(close, j + 1);
    if (end < 0) fail('unterminated long string');
    const out = s.slice(j + 1, end);
    i = end + close.length;
    return out;
  }

  function readQuoted() {
    const quote = s[i];
    i++;
    let out = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        i += 2;
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'r') out += '\r';
        else if (n === '\\') out += '\\';
        else if (n === '"') out += '"';
        else if (n === "'") out += "'";
        else if (n === 'u') {
          const hex = s.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else if (n >= '0' && n <= '9') {
          const dec = s.slice(i, i + 3).match(/^\d{1,3}/)[0];
          out += String.fromCharCode(parseInt(dec, 10));
          i += dec.length - 1;
        } else out += n;
        continue;
      }
      if (c === quote) { i++; return out; }
      // Lua 字符串里裸换行不合法；上游数据若出现按原样保留，不猜
      out += c;
      i++;
    }
    fail('unterminated string');
  }

  function readNumber() {
    const m = /^[-+]?(0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/.exec(s.slice(i));
    if (!m) fail('bad number');
    i += m[0].length;
    const raw = m[0];
    if (/^[-+]?0[xX]/.test(raw)) return parseInt(raw.replace(/^[-+]?0[xX]/, ''), 16) * (raw[0] === '-' ? -1 : 1);
    return Number(raw);
  }

  function readIdent() {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!m) fail('bad identifier');
    i += m[0].length;
    return m[0];
  }

  function readValue() {
    skip();
    const c = s[i];
    if (c === '{') return readTable();
    if (c === '"' || c === "'") return readQuoted();
    if (c === '[' && (s[i + 1] === '[' || s[i + 1] === '=')) return readLongString();
    if (c === '-' || c === '+' || (c >= '0' && c <= '9') || c === '.') return readNumber();
    const word = readIdent();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'nil') return null;
    fail(`unsupported value expression starting with "${word}" — 解析器不执行 Lua 表达式`);
  }

  function readTable() {
    if (s[i] !== '{') fail('expected {');
    i++;
    const obj = {};
    let arrayLen = 0;
    for (;;) {
      skip();
      if (i >= s.length) fail('unterminated table');
      if (s[i] === '}') { i++; break; }

      let key = null;
      if (s[i] === '[') {
        i++;
        skip();
        key = s[i] === '"' || s[i] === "'" ? readQuoted() : String(readValue());
        skip();
        if (s[i] !== ']') fail('expected ] after key');
        i++;
        skip();
        if (s[i] !== '=') fail('expected = after [key]');
        i++;
      } else {
        // 可能是 `name=` 也可能是数组元素（数字/字符串/表）
        const save = i;
        if (/[A-Za-z_]/.test(s[i])) {
          const id = readIdent();
          skip();
          if (s[i] === '=' && s[i + 1] !== '=') { key = id; i++; }
          else { i = save; }
        }
        if (key === null) {
          const val = readValue();
          arrayLen += 1;
          obj[arrayLen] = val;
          skip();
          if (s[i] === ',' || s[i] === ';') i++;
          continue;
        }
      }
      const val = readValue();
      obj[key] = val;
      skip();
      if (s[i] === ',' || s[i] === ';') i++;
    }
    return obj;
  }

  skip();
  // 允许 `return {...}` 或裸 `{...}`
  if (s.startsWith('return', i) && !/[A-Za-z0-9_]/.test(s[i + 6] || '')) {
    i += 6;
    skip();
  }
  const root = readValue();
  return { root, parseError: null };
}

// 读取数组段（Lua 1-based 数字键）为普通数组
function luaArrayToArray(tbl) {
  if (!tbl || typeof tbl !== 'object') return [];
  const numeric = Object.keys(tbl).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
  return numeric.map((n) => tbl[n]);
}

export { parseLuaTable, luaArrayToArray, LuaParseError };
