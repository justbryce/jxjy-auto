// 显示器睡没睡。
//
// 为什么要单独判这个：**显示器休眠和锁屏是两回事，后果也完全不同。**
//  · 只是锁屏（显示器还亮着）→ 新建的窗口仍然是 visible，重建窗口就能恢复满速。
//  · 显示器休眠 → 连新建的窗口都是 occluded，**任何窗口操作都救不回来**。
//    这时候 hidden 页面被 Chrome 密集节流到定时器 ~1 次/分钟，
//    像网易云那种 SPA 播放器**连 <video> 元素都挂载不出来** —— 是彻底跑不动，不是慢。
//
// 实测唤不醒（都试过）：caffeinate -u / -dimsu、System Events 敲键、pmset displaysleep 0。
// 断开屏幕共享时 macOS 会强制把物理显示器睡掉，绕不过去，只能人到机器前。
import { execFileSync } from 'node:child_process';

let cache = { at: 0, asleep: false };
export function displayAsleep() {
  // system_profiler 挺慢（~1s），缓存 30 秒
  if (Date.now() - cache.at < 30_000) return cache.asleep;
  try {
    const out = execFileSync('system_profiler', ['SPDisplaysDataType'],
      { encoding: 'utf8', timeout: 20000 });
    cache = { at: Date.now(), asleep: /Display Asleep:\s*Yes/i.test(out) };
  } catch { cache = { at: Date.now(), asleep: false }; }   // 查不出来就当醒着，别误停
  return cache.asleep;
}
