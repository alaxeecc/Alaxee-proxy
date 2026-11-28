/*!
 * Alaxee UI · 曦  v1.1 —— 可选的小脚本（不引也能用 CSS 部分）
 * - data-ax-theme="auto"：守夜时段（19–5 点）暮·梅子，其余曦·晨粉；每分钟看一次时间
 * - AX.theme('dusk')        换主题（记在 localStorage，下次打开还是它；AX.theme('auto') 恢复跟随时间）
 * - 图标跟着一天走、跟着状态变：<img data-ax-icon="brand/icons/animated/">（网页标签小图标：<link rel="icon" data-ax-icon="…" data-ax-icon-size="small">）
 *     时段：守夜 19–5 点 → 破晓 5–7 点（傍晚 17–19 点也是它）→ 晨曦 7–10 点 → 白昼 10–17 点
 *     AX.state('think')  在想事情：晨星呼吸变快；AX.state('sleep') 睡着：守夜里打盹的星；AX.state('') 平常
 *     从守夜换到别的时段（天亮了 / 睡醒了），或者清早打开页面，先放一遍“破晓开场”再接平常的图标
 *     固定 dusk 主题时一直是守夜；固定 xi 主题时夜里用破晓。系统“减少动态效果”时，有 data-ax-icon-static 就换成静止版
 * - AX.period()             现在是哪个时段：'night' | 'day' | 'morning' | 'noon'
 * - AX.toast('已保存', { type: 'success' | 'danger', ms: 2600 })
 * - AX.open('#id') / AX.close('#id')，或在按钮上写 data-ax-open="#id"、弹窗里写 data-ax-close
 * - .ax-seg / .ax-tabs 里的按钮点了自动切换 is-active，并发出 'ax:change' 事件
 * - .ax-btn 点按时迸出几颗小星星（.ax-btn--quiet 不迸）
 * - .ax-range 拖动时更新已填充的那段颜色
 * - .ax-composer 里的 textarea 跟着内容长高
 */
(function () {
  "use strict";
  const root = document.documentElement;
  const KEY = "ax-theme";
  const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches || root.dataset.axMotion === "reduce";

  // ---------------------------------------------------------------- 主题
  let wanted = localStorage.getItem(KEY) || root.dataset.axTheme || "xi";
  function period(d = new Date()) {
    const h = d.getHours();
    return h >= 19 || h < 5 ? "night" : (h < 7 || h >= 17) ? "day" : h < 10 ? "morning" : "noon";
  }
  function skyTheme() { return period() === "night" ? "dusk" : "xi"; }
  function apply() {
    const t = wanted === "auto" ? skyTheme() : wanted;
    if (root.dataset.axTheme !== t) root.dataset.axTheme = t;
    root.dataset.axThemeChoice = wanted;
    root.dataset.axPeriod = period();
    document.querySelectorAll("[data-ax-icon-day]").forEach((img) => {   // v1.0 的写法：只分白天 / 晚上
      const night = t === "dusk" || t === "alaxee" || t === "glass";
      img.src = night ? img.dataset.axIconNight : img.dataset.axIconDay;
    });
    paintIcons();
  }

  // ---------------------------------------------------------------- 图标：跟着时段和状态
  let state = "", lastLook = null, riseUntil = 0, riseTimer = 0;
  function iconPeriod() {
    const p = period();
    if (wanted === "dusk") return "night";               // 固定暮·梅子：一直是守夜
    if (wanted === "xi" && p === "night") return "day";  // 固定曦·晨粉：夜里也不用守夜
    return p;
  }
  function paintIcons() {
    const look = state === "sleep" ? "night" : iconPeriod();
    if (!reduce() && ((lastLook === "night" && look !== "night") || (lastLook === null && look === "day"))) riseUntil = Date.now() + 3600;
    lastLook = look;
    const rising = Date.now() < riseUntil;
    const big = rising ? "day-rise" : state === "sleep" ? "night-sleep" : look + (state === "think" ? "-think" : "");
    const small = (state === "sleep" ? "night-sleep" : look) + "-small";
    document.querySelectorAll("[data-ax-icon]").forEach((el) => {
      const isSmall = el.dataset.axIconSize === "small";
      const still = reduce() && el.dataset.axIconStatic;
      let name = isSmall ? small : big;
      if (still) name = name.replace(/-(think|rise)$/, "").replace("day-rise", "day");
      const url = (still ? el.dataset.axIconStatic : el.dataset.axIcon) + "icon-" + name + ".svg";
      const attr = el.tagName === "LINK" ? "href" : "src";
      if (el.getAttribute(attr) !== url) el.setAttribute(attr, url);
    });
    clearTimeout(riseTimer);
    if (rising) riseTimer = setTimeout(paintIcons, riseUntil - Date.now() + 50);
  }
  function setState(s) {
    if (s === undefined) return state;
    const was = state;
    state = s || "";
    if (was === "sleep" && state !== "sleep" && iconPeriod() !== "night") lastLook = "night";   // 睡醒了：放一遍破晓
    paintIcons();
    document.querySelectorAll(".ax-orb[data-ax-follow]").forEach((o) => { o.dataset.state = state || "idle"; });
    document.dispatchEvent(new CustomEvent("ax:state", { detail: { state } }));
    return state;
  }
  function theme(name) {
    if (!name) return wanted;
    wanted = name;
    localStorage.setItem(KEY, name);
    apply();
    document.dispatchEvent(new CustomEvent("ax:theme", { detail: { choice: wanted, theme: root.dataset.axTheme } }));
    return wanted;
  }
  apply();
  setInterval(() => wanted === "auto" && apply(), 60 * 1000);

  // ---------------------------------------------------------------- 提示条
  let tray;
  function toast(text, opts = {}) {
    if (!tray) { tray = document.createElement("div"); tray.className = "ax-toasts ax"; tray.setAttribute("role", "status"); document.body.appendChild(tray); }
    const el = document.createElement("div");
    el.className = "ax-toast" + (opts.type ? " ax-toast--" + opts.type : "");
    el.innerHTML = '<span class="ax-star ax-star--twinkle"></span><span></span>';
    el.lastChild.textContent = text;
    tray.appendChild(el);
    setTimeout(() => { el.classList.add("is-leaving"); setTimeout(() => el.remove(), 260); }, opts.ms || 2600);
    return el;
  }

  // ---------------------------------------------------------------- 弹窗
  const $ = (sel) => (typeof sel === "string" ? document.querySelector(sel) : sel);
  function open(sel) { const d = $(sel); if (d && !d.open) d.showModal(); }
  function close(sel) { const d = $(sel); if (d && d.open) d.close(); }

  document.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-ax-open]");
    if (opener) { open(opener.dataset.axOpen); return; }
    const closer = e.target.closest("[data-ax-close]");
    if (closer) { close(closer.closest("dialog")); return; }
    if (e.target.matches("dialog.ax-modal")) {                        // 点弹窗外面关掉
      const r = e.target.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(e.target);
    }
    const tab = e.target.closest(".ax-seg > button, .ax-tabs > button");
    if (tab) {
      tab.parentElement.querySelectorAll(":scope > button").forEach((b) => {
        const on = b === tab;
        b.classList.toggle("is-active", on);
        if (b.hasAttribute("aria-selected")) b.setAttribute("aria-selected", on);
        if (b.hasAttribute("aria-pressed")) b.setAttribute("aria-pressed", on);
      });
      tab.parentElement.dispatchEvent(new CustomEvent("ax:change", { bubbles: true, detail: { value: tab.dataset.value ?? tab.textContent.trim(), button: tab } }));
    }
  });

  // ---------------------------------------------------------------- 点按小星星
  document.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest(".ax-btn");
    if (!btn || btn.classList.contains("ax-btn--quiet") || btn.disabled || reduce()) return;
    const r = btn.getBoundingClientRect();
    for (let i = 0; i < 5; i++) {
      const s = document.createElement("i");
      const a = (Math.PI * 2 * i) / 5 + Math.random() * 0.8;
      const d = 18 + Math.random() * 16;
      s.className = "ax-spark";
      s.style.left = e.clientX - r.left - 5 + "px";
      s.style.top = e.clientY - r.top - 5 + "px";
      s.style.setProperty("--dx", Math.cos(a) * d + "px");
      s.style.setProperty("--dy", Math.sin(a) * d + "px");
      s.style.width = s.style.height = 6 + Math.random() * 6 + "px";
      btn.appendChild(s);
      setTimeout(() => s.remove(), 700);
    }
  });

  // ---------------------------------------------------------------- 滑块、输入框
  function fillRange(el) { const min = +el.min || 0, max = +el.max || 100; el.style.setProperty("--v", ((el.value - min) / (max - min)) * 100 + "%"); }
  function grow(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; }
  document.addEventListener("input", (e) => {
    if (e.target.matches(".ax-range")) fillRange(e.target);
    if (e.target.matches(".ax-composer textarea")) grow(e.target);
  });
  function init(scope = document) { scope.querySelectorAll(".ax-range").forEach(fillRange); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { init(); apply(); }); else init();

  window.AX = { theme, period, state: setState, icons: paintIcons, toast, open, close, init, version: "1.1" };
})();
