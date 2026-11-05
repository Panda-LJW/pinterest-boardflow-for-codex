(function startPinterestInboxCollector() {
  "use strict";

  if (document.getElementById("pinterest-inbox-extension-root")) return;
  const shared = globalThis.PinterestInboxShared;
  const selected = new Map();
  let enabled = true;
  let panelHidden = false;
  let mode = "quick";
  let downloadQuality = shared.DEFAULT_DOWNLOAD_QUALITY;
  let currentJobId = null;
  // UI group of jobs already submitted to the existing serial background queue.
  const currentJobs = new Map();
  let cancellingQueue = false;
  let submissionError = "";
  let scanningBoard = false;
  let abortBoardScan = false;
  let qualityTouched = false;
  let jobNotice = "";
  let position = null;
  // Per-pin visual state: queued | downloading | saved | failed. savedPins is the persisted history.
  const pinStates = new Map();
  const savedPins = new Set();
  const PIN_LABELS = { queued: "排队中", downloading: "下载中…", saved: "✓ 已保存", failed: "下载失败", history: "✓" };
  const DEFAULT_STATUS = "图片保存到 下载 / PinterestInbox，Codex 或 Claude Code 运行时会自动收进素材库。";

  const root = document.createElement("div");
  root.id = "pinterest-inbox-extension-root";
  root.style.cssText = "position:fixed;right:14px;top:78px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host{--paper:#faf9f6;--surface:#fff;--ink:#242522;--muted:#797b74;--line:#e7e7e0;--soft:#efefe8;--red:#d91c3b;--tint:#fcecef;--green:#0a7f45;color-scheme:light}
      *{box-sizing:border-box}[hidden],.hidden{display:none!important}
      .panel{width:272px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 24px);overflow-y:auto;padding:12px;border:1px solid var(--line);border-radius:16px;background:var(--paper);box-shadow:0 8px 32px #24252224;color:var(--ink);font-size:12px;line-height:1.5}
      .head,.identity,.head-actions,.selection-row,.progress-label,.setting-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .head{cursor:grab;user-select:none;touch-action:none}.head.dragging{cursor:grabbing}
      .identity{justify-content:flex-start;min-width:0}.identity>div{min-width:0}.mark{display:grid;place-items:center;width:28px;height:28px;flex:none;border-radius:50%;background:var(--red);color:#fff;font:700 17px Georgia}
      .title{font-weight:750;font-size:13px;letter-spacing:-.3px;white-space:nowrap}.sub{margin-top:1px;color:var(--muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px;font-variant-numeric:tabular-nums}
      .head-actions{gap:4px;flex:none}button{font:inherit;font-weight:600;color:inherit;border:1px solid transparent;cursor:pointer;border-radius:9px;background:var(--soft);padding:8px;transition:background-color 150ms,transform 120ms,box-shadow 150ms}
      button:hover:not(:disabled){background:var(--line)}button:active:not(:disabled){transform:scale(.96)}button:disabled{opacity:.42;cursor:default}button:focus-visible{outline:2px solid var(--red);outline-offset:3px}
      .power,.collapse{padding:4px 8px;height:26px;background:var(--surface);border-color:var(--line);font-size:10px}.power[aria-pressed="false"]{background:var(--ink);color:var(--surface);border-color:var(--ink)}.collapse{width:26px;padding:5px}.collapse svg{display:block;width:14px;fill:none;stroke:currentColor;stroke-width:1.8;transition:transform 180ms}
      .collapsed{width:auto;padding:5px 5px 5px 6px;border-radius:999px}.collapsed .title,.collapsed .power{display:none}.collapsed .sub{margin:0;color:var(--ink);font-size:11px;font-weight:600;max-width:150px}.collapsed .collapse svg{transform:rotate(180deg)}.collapsed .head{cursor:pointer}
      .body{padding-top:12px;animation:enter 180ms ease-out}.modes,.qualities{display:grid;gap:4px}.modes{grid-template-columns:1fr 1fr;padding:3px;border-radius:11px;background:var(--soft)}.modes button{padding:6px 5px;background:none;color:var(--muted);font-size:11px}.modes button.active{background:var(--surface);color:var(--ink);box-shadow:0 1px 4px #0000000b}
      .hint{margin:7px 2px 10px;font-size:10.5px;color:var(--muted);line-height:1.6}
      .setting-row{width:100%;padding:8px 10px;background:var(--surface);border-color:var(--line);font-size:11px;font-weight:500;text-align:left}.setting-row .value{margin-left:auto;font-weight:650}.setting-row svg{width:12px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;transition:transform 180ms}.setting-row[aria-expanded="true"] svg{transform:rotate(180deg)}
      .quality-panel{margin-top:6px}.qualities{grid-template-columns:repeat(3,1fr)}.qualities button{font-size:10px;padding:7px 3px;background:var(--surface);border-color:var(--line)}.qualities button.active{background:var(--tint);border-color:var(--red);color:var(--red)}
      .quality-detail{margin:6px 2px 0;color:var(--muted);font-size:10px}
      .stack{display:grid;gap:7px;margin-top:10px}.selection-row{padding:0 2px;font-size:11px}.selection-row strong{font-variant-numeric:tabular-nums}.text-button{padding:3px 5px;background:none;color:var(--muted);font-size:10px}
      .stack button.action{width:100%;padding:9px 5px;font-size:11px;background:var(--surface);border-color:var(--line)}.stack .primary{background:var(--red)!important;border-color:var(--red)!important;color:white}.stack .primary:hover:not(:disabled){background:#b91934!important}
      .progress-area{margin-top:10px;padding:10px 11px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.progress-label{font-size:10px;color:var(--muted)}.progress-label strong{color:var(--ink);font-weight:650}progress{display:block;width:100%;height:5px;margin:8px 0 10px;accent-color:var(--red);border:0;border-radius:6px;overflow:hidden}progress::-webkit-progress-bar{background:var(--soft)}progress::-webkit-progress-value{background:var(--red);transition:width 180ms}
      .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:9px;color:var(--muted)}.stats strong{display:block;color:var(--ink);font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}.stats .failed strong{color:var(--red)}
      .status{margin:10px 2px 0;color:var(--muted);font-size:10.5px;line-height:1.6;overflow-wrap:anywhere}.status[data-kind="error"]{color:var(--red)}.cancel{width:100%;margin-top:8px;background:var(--tint);color:var(--red);font-size:11px}.paused .body{padding-top:4px}
      @keyframes enter{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
      @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}button:active:not(:disabled){transform:none}}
      @media(prefers-color-scheme:dark){:host{--paper:#232421;--surface:#2b2d29;--ink:#eeeeea;--muted:#a2a69b;--line:#3f423a;--soft:#32352e;--red:#ff647e;--tint:#422930;color-scheme:dark}.stack .primary{color:#251b1d}}
    </style>
    <section class="panel" aria-label="Pinterest BoardFlow 下载器">
      <div id="head" class="head" title="拖动移动面板，双击复位"><div class="identity"><span class="mark" aria-hidden="true">P</span><div><div class="title">Pinterest BoardFlow</div><div id="qualitySummary" class="sub">智能轻量 · 就绪</div></div></div><div class="head-actions"><button id="toggleEnabled" class="power" aria-pressed="true" aria-label="暂停 Pinterest BoardFlow 采集">暂停</button><button id="collapse" class="collapse" aria-label="收起面板" aria-expanded="true" aria-controls="body" title="收起面板"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg></button></div></div>
      <div id="body" class="body"><div id="controls">
        <div class="modes" role="group" aria-label="图片选择方式"><button id="quick" class="active" aria-pressed="true">单张下载</button><button id="multi" aria-pressed="false">多选下载</button></div>
        <p id="modeHint" class="hint">点一张存一张，可连续点击排队；⌘ / Ctrl 点击照常打开。</p>
        <button id="qualityToggle" class="setting-row" aria-expanded="false" aria-controls="qualityPanel"><span>保存质量</span><span id="qualityValue" class="value">智能轻量</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
        <div id="qualityPanel" class="quality-panel" hidden>
          <div class="qualities" role="group" aria-label="图片保存质量"><button data-quality="original">原图</button><button data-quality="high">JPEG 高清</button><button data-quality="light" class="active">智能轻量</button></div>
          <p id="qualityDetail" class="quality-detail">都从 originals 原图获取。WebP 原样保留，其他图片仅在体积更小时缩小。</p>
        </div>
        <div class="stack">
          <button id="downloadPin" class="action primary" hidden>下载这张 Pin</button>
          <div id="selectionArea" class="stack" style="margin:0" hidden>
            <div class="selection-row"><span>已选 <strong id="selectionCount">0</strong> 张</span><button id="clearSelected" class="text-button" disabled>清空选择</button></div>
            <button id="downloadSelected" class="action primary" disabled>下载已选</button>
          </div>
          <button id="downloadBoard" class="action" title="按住 ⇧ 点击：连此前下载过的也重新下载">下载整个图版</button>
        </div>
      </div>
      <div id="progressArea" class="progress-area" hidden><div class="progress-label"><strong id="progressPhase">下载中</strong><span id="progressCount">0 / 0</span></div><progress id="progress" max="1" value="0" aria-label="下载处理进度"></progress><div class="stats"><div><strong id="successCount">0</strong>已保存</div><div><strong id="skippedCount">0</strong>已跳过</div><div class="failed"><strong id="failedCount">0</strong>失败</div></div></div>
      <div id="status" class="status" role="status" aria-live="polite">${DEFAULT_STATUS}</div>
      <button id="cancel" class="cancel hidden">取消下载队列</button>
      </div>
    </section>`;

  const quickButton = shadow.getElementById("quick");
  const multiButton = shadow.getElementById("multi");
  const selectedButton = shadow.getElementById("downloadSelected");
  const boardButton = shadow.getElementById("downloadBoard");
  const pinButton = shadow.getElementById("downloadPin");
  const selectionArea = shadow.getElementById("selectionArea");
  const cancelButton = shadow.getElementById("cancel");
  const status = shadow.getElementById("status");
  const panel = shadow.querySelector(".panel");
  const head = shadow.getElementById("head");
  const body = shadow.getElementById("body");
  const controls = shadow.getElementById("controls");
  const toggleEnabledButton = shadow.getElementById("toggleEnabled");
  const qualitySummary = shadow.getElementById("qualitySummary");
  const qualityToggle = shadow.getElementById("qualityToggle");
  const qualityPanel = shadow.getElementById("qualityPanel");
  const qualityButtons = [...shadow.querySelectorAll("[data-quality]")];
  const clearSelectedButton = shadow.getElementById("clearSelected");
  const progressArea = shadow.getElementById("progressArea");
  const progress = shadow.getElementById("progress");
  const collapseButton = shadow.getElementById("collapse");

  function storageSet(values) {
    try { chrome.storage.local.set(values); } catch { /* storage unavailable: keep in-memory state */ }
  }

  function setStatus(text, kind = "info") {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function isActive() {
    return enabled && !panelHidden;
  }

  function busyNow() {
    return scanningBoard || Boolean(currentJobId);
  }

  function setBusy(busy) {
    cancelButton.classList.toggle("hidden", !busy);
    boardButton.disabled = busy || !enabled;
    selectedButton.disabled = busy || !enabled || selected.size === 0;
    qualityButtons.forEach((button) => { button.disabled = busy || !enabled; });
    quickButton.disabled = multiButton.disabled = busy || !enabled;
    clearSelectedButton.disabled = busy || !enabled || selected.size === 0;
    pinButton.disabled = !enabled || scanningBoard || cancellingQueue || (busy && mode !== "quick");
    panel.setAttribute("aria-busy", String(busy));
  }

  function idleSummary() {
    return `${shared.DOWNLOAD_QUALITIES[downloadQuality].label} · 就绪`;
  }

  function setQuality(nextQuality, persist = true) {
    downloadQuality = shared.normalizeDownloadQuality(nextQuality);
    qualityButtons.forEach((button) => {
      const active = button.dataset.quality === downloadQuality;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const selectedQuality = shared.DOWNLOAD_QUALITIES[downloadQuality];
    if (!busyNow()) qualitySummary.textContent = idleSummary();
    shadow.getElementById("qualityValue").textContent = selectedQuality.label;
    shadow.getElementById("qualityDetail").textContent = downloadQuality === "light"
      ? "都从 originals 原图获取。WebP 原样保留，其他图片仅在体积更小时缩小。"
      : downloadQuality === "high" ? "全分辨率 JPEG 90；透明图片保留为 PNG，体积可能增大。" : "保留原始分辨率、文件字节与真实格式。";
    if (persist) {
      qualityTouched = true;
      storageSet({ downloadQuality, downloadQualityVersion: shared.QUALITY_PREFERENCE_VERSION });
    }
  }

  function setMode(nextMode) {
    if (currentJobId || scanningBoard || !enabled) return;
    mode = nextMode;
    quickButton.classList.toggle("active", mode === "quick");
    multiButton.classList.toggle("active", mode === "multi");
    quickButton.setAttribute("aria-pressed", String(mode === "quick"));
    multiButton.setAttribute("aria-pressed", String(mode === "multi"));
    selectionArea.hidden = mode !== "multi";
    shadow.getElementById("modeHint").textContent = mode === "quick"
      ? "点一张存一张，可连续点击排队；⌘ / Ctrl 点击照常打开。" : "点击图片勾选，再点一次取消；选好后统一下载。";
    if (mode === "quick") {
      clearSelection();
      setStatus("连续单击 Pin 即可加入队列，后台会逐张下载。");
    } else {
      setStatus("单击 Pin 进行勾选，然后点击“下载已选”。");
    }
  }

  function bestImageUrl(image) {
    const candidates = [shared.bestSrcsetUrl(image.getAttribute("srcset")), image.currentSrc, image.src].filter(Boolean);
    return candidates.find(shared.isPinterestImageUrl) ?? null;
  }

  function assetFromAnchor(anchor) {
    const pinId = shared.parsePinId(anchor.href);
    if (!pinId) return { asset: null, reason: "无 Pin ID" };
    const card = anchor.closest('[data-test-id="pin"]') ?? anchor.parentElement ?? anchor;
    if (card.querySelector("video")) return { asset: null, reason: "视频 Pin" };
    const image = anchor.querySelector("img") ?? card.querySelector("img");
    const imageUrl = image ? bestImageUrl(image) : null;
    if (!imageUrl) return { asset: null, reason: "无静态图片" };
    const title = titleFromCard(card, image, pinId);
    return {
      asset: {
        pinId,
        boardSlug: shared.boardSlugFromUrl(location.href),
        title,
        imageUrl
      },
      reason: null
    };
  }

  function selectedKey(anchor) {
    return shared.parsePinId(anchor.href);
  }

  function titleFromCard(card, image, pinId) {
    const structuredTitle = card.querySelector('[data-test-id="pinrep-footer-organic-title"]')?.textContent
      || card.querySelector('[data-test-id="pinrep-footer"] h2')?.textContent
      || card.querySelector("h2")?.textContent;
    const firstVisibleLine = card.innerText?.split("\n").map((line) => line.trim()).find(Boolean);
    return shared.cleanPinTitle(structuredTitle || firstVisibleLine || image.getAttribute("alt"), `pin-${pinId}`);
  }

  // Pin closeup page (/pin/<id>/): the main image is not wrapped in a pin link.
  function currentPinPageId() {
    const match = String(location.pathname ?? "").match(/^\/pin\/([a-zA-Z0-9-]+)/);
    return match?.[1] ?? null;
  }

  function assetFromPinPage() {
    const pinId = currentPinPageId();
    if (!pinId) return { asset: null, reason: "当前不是 Pin 详情页" };
    const closeup = document.querySelector('[data-test-id="closeup-image"], [data-test-id="pin-closeup-image"], [data-test-id="closeup-body-image-container"], [data-test-id="visual-content-container"]');
    if (closeup?.querySelector("video")) return { asset: null, reason: "视频 Pin" };
    let image = closeup?.querySelector("img") ?? null;
    if (!image || !bestImageUrl(image)) {
      // Fallback: the largest rendered pinimg image outside pin-card links.
      let bestArea = 0;
      for (const candidate of document.querySelectorAll('img[src*="pinimg.com"]')) {
        if (candidate.closest('a[href*="/pin/"]')) continue;
        const rect = candidate.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea && bestImageUrl(candidate)) { bestArea = area; image = candidate; }
      }
    }
    const imageUrl = image ? bestImageUrl(image) : null;
    if (!imageUrl) return { asset: null, reason: "没有找到这张 Pin 的静态大图" };
    const heading = document.querySelector('[data-test-id="pinTitle"] h1, [data-test-id="closeup-title"] h1, h1')?.textContent;
    const title = shared.cleanPinTitle(heading || image.getAttribute("alt"), `pin-${pinId}`);
    return { asset: { pinId, boardSlug: shared.boardSlugFromUrl(location.href), title, imageUrl }, reason: null };
  }

  let lastContextUrl = null;
  function refreshPageContext() {
    if (lastContextUrl === location.href) return;
    lastContextUrl = location.href;
    pinButton.hidden = !currentPinPageId();
    boardButton.hidden = shared.boardSlugFromUrl(location.href) === "unsorted";
  }

  function refreshSelectedUi() {
    shadow.getElementById("selectionCount").textContent = String(selected.size);
    selectedButton.textContent = selected.size ? `下载已选 ${selected.size} 张` : "下载已选";
    selectedButton.disabled = !enabled || selected.size === 0 || Boolean(currentJobId) || scanningBoard;
    clearSelectedButton.disabled = selectedButton.disabled;
  }

  function pinVisualState(pinId) {
    const state = pinStates.get(pinId);
    if (state) return state;
    return savedPins.has(pinId) ? "history" : null;
  }

  function refreshSelectionMarks() {
    for (const anchor of document.querySelectorAll('a[href*="/pin/"],a[data-pinterest-inbox-selected],a[data-pinterest-inbox-state]')) {
      const pinId = selectedKey(anchor);
      if (selected.has(pinId)) anchor.setAttribute("data-pinterest-inbox-selected", "true");
      else anchor.removeAttribute("data-pinterest-inbox-selected");
      // Only label image cards, not text links such as comment permalinks.
      const state = anchor.querySelector?.("img") ? pinVisualState(pinId) : null;
      if (state) {
        if (anchor.getAttribute("data-pinterest-inbox-state") !== state) {
          anchor.setAttribute("data-pinterest-inbox-state", state);
          anchor.setAttribute("data-pinterest-inbox-label", PIN_LABELS[state]);
        }
      } else if (anchor.getAttribute("data-pinterest-inbox-state") !== null) {
        anchor.removeAttribute("data-pinterest-inbox-state");
        anchor.removeAttribute("data-pinterest-inbox-label");
      }
    }
  }

  let markFrame = null;
  function scheduleMarks() {
    if (markFrame !== null) return;
    markFrame = requestAnimationFrame(() => { markFrame = null; refreshSelectionMarks(); });
  }

  function setPinState(pinId, state) {
    if (!pinId) return;
    if (state) pinStates.set(pinId, state);
    else pinStates.delete(pinId);
    if (state === "saved") savedPins.add(pinId);
    scheduleMarks();
  }

  function clearSelection() {
    selected.clear();
    document.querySelectorAll('[data-pinterest-inbox-selected="true"]').forEach((element) => element.removeAttribute("data-pinterest-inbox-selected"));
    refreshSelectedUi();
  }

  const pageStyle = document.createElement("style");
  pageStyle.textContent = [
    'html[data-pinterest-inbox-enabled="true"] a[data-pinterest-inbox-selected="true"]{outline:4px solid #e60023!important;outline-offset:2px!important;border-radius:18px!important}',
    'html[data-pinterest-inbox-enabled="true"] a[href*="/pin/"]:hover{cursor:copy}',
    'html[data-pinterest-inbox-enabled="true"] a[data-pinterest-inbox-state]{position:relative!important}',
    'html[data-pinterest-inbox-enabled="true"] a[data-pinterest-inbox-state]::after{content:attr(data-pinterest-inbox-label);position:absolute;top:10px;left:10px;z-index:6;padding:3px 9px;border-radius:999px;background:#111111d9;color:#fff;font:600 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none;box-shadow:0 2px 8px #0003}',
    'html[data-pinterest-inbox-enabled="true"] a[data-pinterest-inbox-state="downloading"]::after{background:#e60023}',
    'html[data-pinterest-inbox-enabled="true"] a[data-pinterest-inbox-state="saved"]::after{background:#0a7f45}',
    'html[data-pinterest-inbox-enabled="true"] a[data-pinterest-inbox-state="failed"]::after{background:#b3122e}',
    'html[data-pinterest-inbox-enabled="true"] a[data-pinterest-inbox-state="history"]::after{padding:2px 7px;background:#0a7f45cc;font-size:11px}'
  ].join("\n");

  function ensureMounted() {
    const html = document.documentElement;
    const pageBody = document.body;
    if (!html || !pageBody) return;
    // Keep extension UI outside Pinterest's application root, in valid HTML containers.
    // Reuse the same nodes after hydration/SPA replacement to retain all UI/job state.
    if (root.parentNode !== pageBody) pageBody.append(root);
    const styleParent = document.head || html;
    if (pageStyle.parentNode !== styleParent) styleParent.append(pageStyle);
    if (html.getAttribute("data-pinterest-inbox-enabled") !== String(isActive())) {
      html.setAttribute("data-pinterest-inbox-enabled", String(isActive()));
    }
  }

  new MutationObserver(() => {
    ensureMounted();
    refreshPageContext();
    if (!selected.size && !pinStates.size && !savedPins.size) return;
    scheduleMarks();
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "data-pinterest-inbox-enabled"] });
  ensureMounted();
  refreshPageContext();

  // ---- Panel position, collapse and visibility ----

  function viewportSize() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function applyPosition() {
    if (!position) {
      root.style.left = "";
      root.style.right = "14px";
      root.style.top = "78px";
      return;
    }
    const { width, height } = viewportSize();
    const panelWidth = panel.offsetWidth || 272;
    const panelHeight = panel.offsetHeight || 48;
    const x = Number.isFinite(width) ? Math.min(Math.max(8, position.x), Math.max(8, width - panelWidth - 8)) : position.x;
    const y = Number.isFinite(height) ? Math.min(Math.max(8, position.y), Math.max(8, height - Math.min(panelHeight, 120) - 8)) : position.y;
    root.style.right = "auto";
    root.style.left = `${Math.round(x)}px`;
    root.style.top = `${Math.round(y)}px`;
  }

  function setCollapsed(collapsed, persist = true) {
    body.hidden = collapsed;
    panel.classList.toggle("collapsed", collapsed);
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "展开面板" : "收起面板";
    collapseButton.setAttribute("aria-label", label); collapseButton.title = label;
    if (persist) storageSet({ panelCollapsed: collapsed });
    if (position) requestAnimationFrame(applyPosition);
  }

  function setPanelHidden(hidden, persist = true) {
    panelHidden = hidden;
    root.style.display = hidden ? "none" : "";
    if (hidden) clearSelection();
    ensureMounted();
    if (persist) storageSet({ panelHidden: hidden });
  }

  let drag = null;
  head.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target?.closest?.("button")) return;
    const rect = root.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, moved: false };
    head.setPointerCapture?.(event.pointerId);
  });
  head.addEventListener("pointermove", (event) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    drag.moved = true;
    head.classList.add("dragging");
    position = { x: event.clientX - drag.dx, y: event.clientY - drag.dy };
    applyPosition();
  });
  const endDrag = (event) => {
    if (!drag) return;
    const { moved } = drag;
    drag = null;
    head.classList.remove("dragging");
    head.releasePointerCapture?.(event.pointerId);
    if (moved) storageSet({ panelPosition: position });
    else if (body.hidden && event.type === "pointerup") setCollapsed(false);
  };
  head.addEventListener("pointerup", endDrag);
  head.addEventListener("pointercancel", endDrag);
  head.addEventListener("dblclick", (event) => {
    if (event.target?.closest?.("button")) return;
    position = null;
    applyPosition();
    storageSet({ panelPosition: null });
  });
  window.addEventListener?.("resize", () => { if (position) applyPosition(); });

  // ---- Queue submission ----

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function newJobId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function enqueueAssets(assets, skipped = 0, clearAcceptedSelection = false, notice = "", appendToQueue = false) {
    if (!enabled) return;
    if (scanningBoard || cancellingQueue || (currentJobId && !(appendToQueue && mode === "quick"))) {
      setStatus(cancellingQueue ? "正在取消队列，请结束后再添加图片。" : "当前任务仍在处理，请完成或取消后再下载。"); return;
    }
    if (assets.length === 0) {
      setStatus(skipped ? `没有可下载的静态图片，已跳过 ${skipped} 项。` : "没有找到可下载的 Pin。"); return;
    }
    if (appendToQueue && currentJobId) {
      const pendingKeys = new Set([...currentJobs.values()].filter(job => !job.acknowledged || job.status.pending > 0).flatMap(job => job.assetKeys));
      assets = assets.filter(asset => !pendingKeys.has(`${asset.boardSlug}/${asset.pinId}`));
      if (!assets.length) { setStatus("这张图片已在下载队列中，无需重复点击。"); return; }
    }
    const jobId = newJobId();
    if (!currentJobId) {
      currentJobs.clear();
      currentJobId = jobId;
      jobNotice = notice;
      submissionError = "";
    }
    const entry = {
      acknowledged: false, cancelling: false,
      pinIds: assets.map(asset => asset.pinId),
      assetKeys: assets.map(asset => `${asset.boardSlug}/${asset.pinId}`),
      status: { jobId, total: assets.length + skipped, pending: assets.length, success: 0, skipped, failed: 0, originalUnavailable: 0, processingFailed: 0, cancelled: false, done: false }
    };
    currentJobs.set(jobId, entry);
    for (const asset of assets) setPinState(asset.pinId, "queued");
    renderQueueProgress();
    try {
      const response = await sendMessage({ type: "pinterestInboxEnqueue", jobId, assets, skipped, quality: downloadQuality });
      if (currentJobs.get(jobId) !== entry) return;
      if (!response?.ok || response.status?.jobId !== jobId) throw new Error(response?.error || "未收到下载队列确认，请重试");
      entry.acknowledged = true;
      if (clearAcceptedSelection) {
        for (const asset of assets) if (selected.get(asset.pinId) === asset) selected.delete(asset.pinId);
        refreshSelectionMarks(); refreshSelectedUi();
      }
      renderProgress(response.status);
      if (cancellingQueue && entry.status.pending) await cancelQueueEntry(entry);
    } catch (error) {
      if (currentJobs.get(jobId) !== entry) return;
      entry.acknowledged = true;
      for (const asset of assets) setPinState(asset.pinId, "failed");
      // Submission failure affects this request only; other queued downloads continue.
      entry.status = { ...entry.status, pending: 0, failed: assets.length, done: true };
      submissionError = `无法启动下载：${error.message}。未加入的图片可重试${clearAcceptedSelection ? "，已选图片仍保留" : ""}。`;
      renderQueueProgress();
    }
  }

  async function cancelQueueEntry(entry) {
    if (!entry.acknowledged || !entry.status.pending || entry.cancelling) return;
    entry.cancelling = true;
    const jobId = entry.status.jobId;
    try {
      const response = await sendMessage({ type: "pinterestInboxCancel", jobId });
      if (currentJobs.get(jobId) !== entry) return;
      if (!response?.ok || response.status?.jobId !== jobId) throw new Error("未收到取消确认，请重试");
      renderProgress(response.status);
    } catch (error) {
      if (currentJobs.get(jobId) === entry && currentJobId) setStatus(`取消失败：${error.message}。可再次点击“取消下载队列”。`, "error");
    } finally {
      entry.cancelling = false;
    }
  }

  async function cancelCurrentQueue() {
    if (!currentJobId) return;
    cancellingQueue = true;
    renderQueueProgress();
    // Unacknowledged requests are cancelled as soon as their enqueue reply arrives.
    await Promise.all([...currentJobs.values()].map(cancelQueueEntry));
  }

  document.addEventListener("click", (event) => {
    if (!enabled) return;
    if (panelHidden) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest('a[href*="/pin/"]');
    if (!anchor || root.contains(target)) return;
    const { asset, reason } = assetFromAnchor(anchor);
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (scanningBoard || (currentJobId && mode !== "quick")) { setStatus("当前任务仍在处理；⌘ / Ctrl 点击可正常打开图片。"); return; }
    if (!asset) {
      setStatus(`${reason}，已跳过。`);
      return;
    }
    if (mode === "quick") {
      void enqueueAssets([asset], 0, false, "", true);
      return;
    }
    const key = selectedKey(anchor);
    if (selected.has(key)) {
      selected.delete(key);
    } else {
      selected.set(key, asset);
    }
    refreshSelectedUi();
    refreshSelectionMarks();
    setStatus(`已选择 ${selected.size} 张静态图片。${savedPins.has(key) ? "这张此前下载过，会覆盖同名文件。" : ""}`);
  }, true);

  function collectVisiblePins(assets, skippedKeys) {
    let added = 0;
    for (const anchor of document.querySelectorAll('a[href*="/pin/"]')) {
      const key = selectedKey(anchor) ?? anchor.href;
      if (assets.has(key) || skippedKeys.has(key)) continue;
      const result = assetFromAnchor(anchor);
      if (result.asset) {
        assets.set(key, result.asset);
        added += 1;
      } else {
        skippedKeys.add(key);
      }
    }
    return added;
  }

  async function collectWholeBoard(includeSaved = false) {
    if (!enabled || currentJobId || scanningBoard) return;
    if (shared.boardSlugFromUrl(location.href) === "unsorted") {
      setStatus("请先打开一个具体 Pinterest 图版，再使用整板下载。");
      return;
    }
    scanningBoard = true;
    abortBoardScan = false;
    setBusy(true);
    const originalScrollY = window.scrollY;
    const originalPath = location.pathname;
    const assets = new Map();
    const skippedKeys = new Set();
    let stableRounds = 0;
    let previousHeight = 0;
    let reachedSafetyLimit = true;
    progressArea.hidden = false;
    progress.removeAttribute("value");
    shadow.getElementById("progressPhase").textContent = "扫描图版";
    for (const id of ["successCount", "skippedCount", "failedCount"]) shadow.getElementById(id).textContent = "0";
    try { for (let step = 0; step < 1000; step += 1) {
      if (abortBoardScan || location.pathname !== originalPath) break;
      const added = collectVisiblePins(assets, skippedKeys);
      const height = document.documentElement.scrollHeight;
      const nearBottom = window.scrollY + window.innerHeight >= height - 32;
      stableRounds = added === 0 && height === previousHeight && nearBottom ? stableRounds + 1 : 0;
      setStatus(`正在扫描图版：发现 ${assets.size} 张，跳过 ${skippedKeys.size} 项…`);
      shadow.getElementById("progressCount").textContent = `发现 ${assets.size} 张`;
      qualitySummary.textContent = `扫描中 · ${assets.size} 张`;
      if (stableRounds >= 5) {
        reachedSafetyLimit = false;
        break;
      }
      previousHeight = height;
      window.scrollTo({ top: Math.min(window.scrollY + Math.max(640, window.innerHeight * 0.85), height), behavior: "auto" });
      await new Promise((resolve) => setTimeout(resolve, 700));
    } } catch (error) {
      abortBoardScan = true;
      setStatus(`扫描未完成：${error.message}`, "error");
      return;
    } finally {
      if (location.pathname === originalPath) window.scrollTo({ top: originalScrollY, behavior: "auto" });
      scanningBoard = false;
      setBusy(Boolean(currentJobId));
      progressArea.hidden = true;
    }
    if (abortBoardScan || location.pathname !== originalPath) {
      qualitySummary.textContent = enabled ? "扫描已停止" : "采集已暂停";
      setStatus(location.pathname !== originalPath ? "页面已切换，整板扫描已停止，未开始下载。"
        : enabled ? `已取消整板扫描；已发现 ${assets.size} 张，未开始下载。` : "采集已暂停，Pin 点击已恢复 Pinterest 原本行为。");
      return;
    }
    let found = [...assets.values()];
    let alreadySaved = 0;
    if (!includeSaved) {
      const fresh = found.filter((asset) => !savedPins.has(asset.pinId));
      alreadySaved = found.length - fresh.length;
      found = fresh;
    }
    if (alreadySaved && found.length === 0) {
      qualitySummary.textContent = idleSummary();
      setStatus(`这个图版的 ${alreadySaved} 张图片此前都下载过。按住 ⇧ 点击“下载整个图版”可全部重新下载。`);
      return;
    }
    const notices = [];
    if (reachedSafetyLimit) notices.push("已达到扫描上限，本次仅处理已发现的图片。");
    if (alreadySaved) notices.push(`已略过此前下载过的 ${alreadySaved} 张（⇧ 点击可全部重下）。`);
    await enqueueAssets(found, skippedKeys.size, false, notices.join(""));
  }

  quickButton.addEventListener("click", () => setMode("quick"));
  multiButton.addEventListener("click", () => setMode("multi"));
  qualityToggle.addEventListener("click", () => {
    qualityPanel.hidden = !qualityPanel.hidden;
    qualityToggle.setAttribute("aria-expanded", String(!qualityPanel.hidden));
  });
  qualityButtons.forEach((button) => button.addEventListener("click", () => {
    if (currentJobId || scanningBoard) return;
    setQuality(button.dataset.quality);
    const selectedQuality = shared.DOWNLOAD_QUALITIES[downloadQuality];
    setStatus(`保存质量已切换为“${selectedQuality.label}”：${selectedQuality.description}。`);
  }));
  selectedButton.addEventListener("click", () => {
    const assets = [...selected.values()];
    void enqueueAssets(assets, 0, true);
  });
  pinButton.addEventListener("click", () => {
    const { asset, reason } = assetFromPinPage();
    if (!asset) { setStatus(`${reason}。`, "error"); return; }
    void enqueueAssets([asset], 0, false, "", true);
  });
  clearSelectedButton.addEventListener("click", () => {
    if (currentJobId || scanningBoard) return;
    clearSelection(); setStatus("已清空选择。");
  });
  collapseButton.addEventListener("click", () => setCollapsed(!body.hidden));
  boardButton.addEventListener("click", (event) => void collectWholeBoard(Boolean(event?.shiftKey)));
  toggleEnabledButton.addEventListener("click", async () => {
    enabled = !enabled;
    panel.classList.toggle("paused", !enabled);
    controls.hidden = !enabled;
    toggleEnabledButton.textContent = enabled ? "暂停" : "启用";
    toggleEnabledButton.setAttribute("aria-pressed", String(enabled));
    toggleEnabledButton.setAttribute("aria-label", enabled ? "暂停 Pinterest BoardFlow 采集" : "启用 Pinterest BoardFlow 采集");
    document.documentElement.setAttribute("data-pinterest-inbox-enabled", String(isActive()));
    if (enabled) {
      setBusy(scanningBoard || Boolean(currentJobId));
      qualitySummary.textContent = scanningBoard ? "正在停止扫描" : currentJobId ? "正在结束原任务" : idleSummary();
      if (scanningBoard) setStatus("正在停止上一次整板扫描…");
      else if (currentJobId) setStatus("采集已启用，正在等待原下载任务结束…");
      else setStatus(mode === "quick" ? `采集已启用。当前使用“${shared.DOWNLOAD_QUALITIES[downloadQuality].label}”质量。` : "采集已启用。单击 Pin 进行勾选。");
      return;
    }
    abortBoardScan = true;
    clearSelection();
    const jobId = currentJobId;
    setBusy(scanningBoard || Boolean(currentJobId));
    qualitySummary.textContent = "采集已暂停";
    setStatus("采集已暂停，Pin 点击已恢复 Pinterest 原本行为。");
    if (jobId) await cancelCurrentQueue();
  });
  cancelButton.addEventListener("click", async () => {
    if (scanningBoard) {
      abortBoardScan = true;
      setStatus("正在停止整板扫描…");
      return;
    }
    await cancelCurrentQueue();
  });

  function renderProgress(value) {
    const entry = currentJobs.get(value.jobId);
    if (!entry || !currentJobId) return;
    // Enqueue/cancel replies can arrive after a newer progress event.
    if (value.pending <= entry.status.pending && !(entry.status.cancelled && !value.cancelled)) {
      entry.status = value;
    }
    renderQueueProgress();
  }

  function renderQueueProgress() {
    const entries = [...currentJobs.values()];
    const value = {total: 0, pending: 0, success: 0, skipped: 0, failed: 0, originalUnavailable: 0, processingFailed: 0, cancelled: cancellingQueue};
    for (const entry of entries) {
      for (const key of ["total", "pending", "success", "skipped", "failed", "originalUnavailable", "processingFailed"]) value[key] += entry.status[key] || 0;
      value.cancelled ||= entry.status.cancelled;
      if (entry.status.lastError) value.lastError = entry.status.lastError;
    }
    const submitting = entries.some(entry => !entry.acknowledged);
    value.done = value.pending === 0 && !submitting;
    const unavailable = value.originalUnavailable ? `（无可用原图 ${value.originalUnavailable}）` : "";
    const processingFailed = value.processingFailed ? `（处理失败 ${value.processingFailed}）` : "";
    const recentError = value.lastError ? ` · ${value.lastError}` : "";
    progressArea.hidden = false;
    progress.max = Math.max(1, value.total);
    progress.value = Math.max(0, value.total - value.pending);
    shadow.getElementById("progressCount").textContent = `${value.total - value.pending} / ${value.total}`;
    const phase = value.cancelled ? value.done ? "已取消" : "取消中" : value.done ? value.failed ? "部分失败" : "处理完成" : submitting ? "加入队列中" : "下载中";
    shadow.getElementById("progressPhase").textContent = phase;
    for (const [id, count] of [["successCount", value.success], ["skippedCount", value.skipped], ["failedCount", value.failed]]) shadow.getElementById(id).textContent = String(count);
    qualitySummary.textContent = value.done ? `${phase} · 已保存 ${value.success} 张` : `${phase} · 剩 ${value.pending} 张`;
    setStatus(`${jobNotice}${value.pending ? `队列还有 ${value.pending} 张，后台按顺序下载。${mode === "quick" ? "可继续点击图片加入。" : ""}` : ""}跳过 ${value.skipped}${unavailable} · 失败 ${value.failed}${processingFailed}${recentError}`, value.failed ? "error" : "info");
    if (value.done) {
      // Anything still marked in-flight was cancelled or skipped: drop its badge.
      for (const entry of entries) {
        for (const pinId of entry.pinIds ?? []) {
          const state = pinStates.get(pinId);
          if (state === "queued" || state === "downloading") setPinState(pinId, null);
        }
      }
      currentJobId = null;
      cancellingQueue = false;
      setBusy(false);
      if (value.cancelled) setStatus(`任务已取消，已保存的 ${value.success} 张图片仍保留。`);
      else if (!value.failed && !value.skipped) setStatus(`${jobNotice}已保存 ${value.success} 张图片到 PinterestInbox。`);
    } else {
      setBusy(true);
      if (value.cancelled) setStatus("正在取消，等待当前下载停止…");
    }
    if (submissionError) setStatus(`${value.pending ? `队列还有 ${value.pending} 张待处理。` : ""}${submissionError}`, "error");
    if (!enabled) setStatus(value.done ? "采集已暂停，Pin 点击已恢复 Pinterest 原本行为。" : "采集已暂停，正在停止原下载任务…");
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "pinterestInboxTogglePanel") {
      setPanelHidden(!panelHidden);
      return;
    }
    if (message?.type !== "pinterestInboxDownloadProgress") return;
    const item = message.item;
    if (item?.pinId) {
      if (item.state === "saved" || item.state === "failed" || item.state === "downloading") setPinState(item.pinId, item.state);
      else if (pinStates.get(item.pinId) !== "saved") setPinState(item.pinId, null);
    }
    if (!currentJobs.has(message.status?.jobId)) return;
    renderProgress(message.status);
  });

  function applySavedPins(record) {
    savedPins.clear();
    for (const pinId of Object.keys(record ?? {})) savedPins.add(pinId);
    scheduleMarks();
  }

  try {
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.savedPins) applySavedPins(changes.savedPins.newValue);
      if (changes.panelHidden && Boolean(changes.panelHidden.newValue) !== panelHidden) setPanelHidden(Boolean(changes.panelHidden.newValue), false);
    });
  } catch { /* storage events unavailable */ }

  chrome.storage.local.get(["downloadQuality", "downloadQualityVersion", "savedPins", "panelPosition", "panelCollapsed", "panelHidden"], (values) => {
    values = values ?? {};
    applySavedPins(values.savedPins);
    if (values.panelPosition && Number.isFinite(values.panelPosition.x) && Number.isFinite(values.panelPosition.y)) {
      position = values.panelPosition;
      applyPosition();
    }
    if (values.panelCollapsed) setCollapsed(true, false);
    if (values.panelHidden) setPanelHidden(true, false);
    if (qualityTouched) return;
    const needsMigration = values.downloadQualityVersion !== shared.QUALITY_PREFERENCE_VERSION;
    const nextQuality = needsMigration ? shared.DEFAULT_DOWNLOAD_QUALITY : values.downloadQuality;
    setQuality(nextQuality, false);
    if (needsMigration) {
      storageSet({
        downloadQuality: shared.DEFAULT_DOWNLOAD_QUALITY,
        downloadQualityVersion: shared.QUALITY_PREFERENCE_VERSION
      });
    }
  });
})();
