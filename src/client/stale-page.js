/**
 * 「这一页跑的是**重启前**的代码」探测器（2026-09-25）。
 *
 * 为什么要有：人类这一晚上至少三次看到「还是老版本 / 为什么 0.1 的代码还在跑」，
 * 而每一次服务端其实都已经是新代码了 —— 问题出在**浏览器那一页**：静态资源是 `no-store`
 * 没错，但**已经在跑的那份 document** 不会自己变；页面上的按钮仍然绑着旧 handler，
 * 点出来的自然还是旧界面（这一轮实测：首页热区去的是新的单独小芽页，而页眉那个
 * 「✦ 小芽」还绑着旧版式的页内面板）。
 *
 * 判据必须是**服务端事实**，不是猜：`/api/bootstrap`（GET、只读语义、页面本来就用它启动）
 * 在 `server.started_at` 里报**进程启动时刻**、`server.assets` 里报静态资源清单规模。
 * 页面加载时记一份，之后每次回到前台再取一份 —— 两份不一样就说明"页面比服务端旧"，
 * 摆一条横幅让他刷新。（`/api/status` 只接 POST，探测不该走那条路。）
 *
 * 纪律：这条横幅**只报告、不自动刷新**（自动 reload 会在玩家打字/出招时把状态冲掉）；
 * 也不写"请重启 npm start"这类工程话 —— 玩家要做的只有一件事：刷新。
 */
const BANNER_ID = 'stale-page-banner';

function banner() {
  let el = document.getElementById(BANNER_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = BANNER_ID;
  el.className = 'stale-page-banner';
  el.setAttribute('role', 'alert');
  el.hidden = true;
  const text = document.createElement('span');
  text.textContent = '这个页面还是重启前的旧版本（本机服务已经重启过）。';
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'stale-page-reload';
  button.textContent = '刷新这一页';
  button.addEventListener('click', () => location.reload());
  el.append(text, button);
  document.body.appendChild(el);
  return el;
}

/** 记下"这一页是哪次启动的"；返回一个可手动触发的检查函数（测试与调试用）。 */
export function mountStalePageBanner({fetchImpl = globalThis.fetch?.bind(globalThis), poll = true} = {}) {
  if (typeof document === 'undefined' || !document.body) return {check: async () => null, loaded: null};
  const el = banner();
  let loaded = null;
  const read = async () => {
    try {
      const response = await fetchImpl('/api/bootstrap', {cache: 'no-store'});
      if (!response?.ok) return null;
      const data = await response.json();
      const startedAt = data?.server?.started_at;
      return typeof startedAt === 'string' ? startedAt : null;
    } catch {
      return null;   // 服务没起来 / 网络抖动：不报警，也不清空已知状态
    }
  };
  const check = async () => {
    const now = await read();
    if (now === null) return null;
    if (loaded === null) { loaded = now; return now; }
    if (now !== loaded) el.hidden = false;
    return now;
  };
  void check();
  if (poll) {
    window.addEventListener('focus', () => { void check(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void check();
    });
  }
  return {check, get loaded() { return loaded; }};
}
