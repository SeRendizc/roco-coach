// 起子进程时的公共约定。
//
// 存在理由（第 28 轮的真缺陷）：从 `node --test` 里再起一个 `node --test`，
// 子进程会继承 `NODE_TEST_CONTEXT=child-v8` / `NODE_TEST_WORKER_ID=1`，
// 于是它**不按参数去跑那个测试文件**，而是当成「父测试的又一个 worker」——
// **永远 exit 0**。
//
// 当时的表现是：守卫自检把 7 条注入**全部报成「仍绿」**，
// 看起来像仓库里所有守卫都失效了，实际是自检自己在测试运行器里跑不动。
// 真红被假绿盖住——这是这个仓库里最危险的一类错误，
// 而它出现在「专门用来发现假绿」的工具身上。
//
// 所以：**任何在测试里起 node 子进程的地方，都要经过 `cleanEnv()`**。
// 这条约定由 `tests/evals/subprocess-env.test.js` 静态检查守着
// （没有守着的话，下一个写测试的人不会知道这件事）。

/**
 * 清掉测试运行器自己的环境变量，返回一份可以传给子进程的 env。
 * 其它变量原样保留——不要顺手把 PATH 之类也清了。
 */
export function cleanEnv(extra = {}, base = process.env) {
  const env = {...base, ...extra};
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

/** `execFileSync` 的包装：默认带上清净的 env。测试里起子进程请用它。 */
export function runNodeSync(args, {env = {}, ...options} = {}) {
  // 动态 import 避免把 node:child_process 拖进任何可能被浏览器图扫到的地方。
  return import('node:child_process').then(({execFileSync}) =>
    execFileSync(process.execPath, args, {encoding: 'utf8', ...options, env: cleanEnv(env)}));
}
