const token = document.querySelector('meta[name="pinterest-panel-token"]')?.content ?? "";
const referenceSessionId = document.querySelector('meta[name="pinterest-reference-session"]')?.content ?? "";
const DEFAULT_API_TIMEOUT_MS = 8_000;
const THUMBNAIL_TIMEOUT_MS = 20_000;
const REFRESH_TIMEOUT_MS = 120_000;
const MAX_DELETE_PICKS = 100;
const elementIds = ["watcherSummary", "refreshButton", "pinsTab", "boardsTab", "statusBanner", "boardFilter", "content", "loadMoreButton", "toast", "searchInput", "clearSearch", "sortSelect", "browseTools", "resultSummary", "listEnd", "referenceTray", "selectionCount", "selectionStatus", "selectionList", "selectionHint", "clearSelection", "copySelection", "previewDialog", "previewPosition", "closePreview", "previewStage", "previewMessage", "previewImage", "previousPreview", "nextPreview", "previewTitle", "previewMeta", "previewCopy", "previewSelect", "previewDelete", "deleteModeButton", "exitDeleteMode", "deleteStack", "stackStrip", "stackList", "stackDelete", "stackCollapse", "stackPile"];
const elements = Object.fromEntries(elementIds.map(id => [id, document.querySelector(`#${id}`)]));
const state = {
  tab: "pins", boardId: null, boardTitle: null, query: "", sort: "recent",
  assets: [], boards: [], total: 0, libraryTotal: 0, nextCursor: null,
  version: null, watcherStatus: "starting", transfer: null, refreshedAt: null,
  initialLoading: true, pageLoading: false, pageGeneration: 0, dataView: null,
  pageError: null, refreshing: false, offline: false,
  copiedAssetId: null, pendingCopies: new Set(),
  thumbnailUrls: new Map(), thumbnailFailures: new Set(), thumbnailRequests: new Map(),
  thumbnailEpoch: 0, thumbnailActive: 0, thumbnailWaiters: [],
  selection: null, selectionError: null, selectionPending: 0, selectionChain: Promise.resolve(), copyingSelection: false,
  previewAsset: null, previewUrl: null, previewGeneration: 0, previewController: null,
  previewClosing: false, previewCloseToken: 0,
  trashArmedId: null, trashArmTimer: null, trashingId: null,
  deleteMode: false, deletePicks: [], stackOpen: false, bulkArmed: false, bulkArmTimer: null, bulkTrashing: false,
  polling: false, pollTimer: null, pollDelay: 2000, toastTimer: null, searchTimer: null
};

// Motion follows confirmed state; it never delays a request or changes a selection.
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const nodeMotions = new WeakMap();
const activeMotions = new Set();
function playMotion(node, frames, options = {}) {
  nodeMotions.get(node)?.cancel();
  if (!node?.isConnected || !node.animate || reducedMotion?.matches) return null;
  const animation = node.animate(frames, { duration: 200, easing: "cubic-bezier(.22,1,.36,1)", ...options });
  nodeMotions.set(node, animation); activeMotions.add(animation);
  const release = () => {
    activeMotions.delete(animation);
    if (nodeMotions.get(node) === animation) nodeMotions.delete(node);
  };
  animation.finished.then(release, release);
  return animation;
}
// Spring sampled into a CSS linear() curve, for frames that resize (the reference dock).
function springCurve(response, dampingRatio) {
  const omega = (2 * Math.PI) / response, zeta = dampingRatio;
  const at = t => {
    if (zeta >= 1) return 1 - Math.exp(-omega * t) * (1 + omega * t);
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t));
  };
  let settle = 0.1;
  while (settle < 2 && Math.abs(1 - at(settle)) > 0.002) settle += 0.01;
  const points = Array.from({ length: 41 }, (_, index) => (index === 40 ? 1 : Number(at((settle * index) / 40).toFixed(4))));
  const supported = Boolean(globalThis.CSS?.supports?.("animation-timing-function", "linear(0, 1)"));
  return { easing: supported ? `linear(${points.join(", ")})` : "cubic-bezier(.22,1,.36,1)", duration: Math.round(settle * 1000) };
}
const SPRING = springCurve(0.44, 0.86);
// Copying is keyboard-only: ⌘C on macOS, Ctrl+C elsewhere.
const COPY_KEY = /Mac|iPhone|iPad/i.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || "") ? "⌘C" : "Ctrl+C";
function shortcutLabel(node, text) {
  if (!node) return;
  const key = document.createElement("kbd");
  key.textContent = COPY_KEY;
  node.replaceChildren(key, ` ${text}`);
}
function pulseControl(node) {
  playMotion(node, [{ transform: "scale(.86)" }, { transform: "scale(1.1)", offset: .55 }, { transform: "scale(1)" }], { duration: 220 });
}
reducedMotion?.addEventListener("change", () => {
  if (reducedMotion.matches) for (const animation of activeMotions) animation.cancel();
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(className, text, label, onClick) {
  const node = element("button", className, text);
  node.type = "button";
  if (label) { node.setAttribute("aria-label", label); node.title = label; }
  node.addEventListener("click", onClick);
  return node;
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
// Filenames without a real Pinterest title come through as "pin 7046…" — not worth showing.
function displayTitle(asset) {
  const title = String(asset?.title ?? "").trim();
  return /^pin[\s_-]*[0-9a-z-]{6,}$/i.test(title) && /\d{6,}/.test(title) ? "" : title;
}
function viewKey() { return JSON.stringify([state.tab, state.boardId, state.query, state.sort]); }
function selectedIndex(assetId) { return state.selection?.entries.findIndex(entry => entry.id === assetId) ?? -1; }

async function api(path, options = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS);
  const headers = new Headers(options.headers ?? {});
  headers.set("X-Pinterest-Panel-Token", token);
  if (referenceSessionId) headers.set("X-Pinterest-Reference-Session", referenceSessionId);
  headers.set("Accept", options.expectBlob ? "image/*" : "application/json");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  try {
    const response = await fetch(path, {
      method: options.method ?? "GET", credentials: "same-origin", headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal
    });
    if (!response.ok) {
      let message = `请求失败（${response.status}）`;
      try { message = (await response.json()).error || message; } catch (error) { if (error?.name === "AbortError") throw error; }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return options.expectBlob ? await response.blob() : await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("本地服务响应超时");
    throw error;
  } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", cancel); }
}
function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  const feedback = document.querySelector("#previewFeedback");
  if (feedback && elements.previewDialog.open) {
    feedback.textContent = message;
    feedback.classList.toggle("is-error", isError);
  }
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), isError ? 5000 : 3000);
}
function clearThumbnailCache() {
  state.thumbnailEpoch += 1;
  for (const url of state.thumbnailUrls.values()) URL.revokeObjectURL(url);
  state.thumbnailUrls.clear();
  state.thumbnailFailures.clear();
}
async function withThumbnailSlot(task) {
  if (state.thumbnailActive >= 6) await new Promise(resolve => state.thumbnailWaiters.push(resolve));
  state.thumbnailActive += 1;
  try { return await task(); }
  finally { state.thumbnailActive -= 1; state.thumbnailWaiters.shift()?.(); }
}
function thumbnailUrl(assetId) {
  const cached = state.thumbnailUrls.get(assetId);
  if (cached) return Promise.resolve(cached);
  const epoch = state.thumbnailEpoch;
  const requestKey = `${epoch}:${assetId}`;
  if (state.thumbnailRequests.has(requestKey)) return state.thumbnailRequests.get(requestKey);
  const pending = withThumbnailSlot(async () => {
    if (epoch !== state.thumbnailEpoch) throw new Error("thumbnail-generation-changed");
    try {
      const blob = await api(`/api/thumbnails/${assetId}`, { expectBlob: true, timeoutMs: THUMBNAIL_TIMEOUT_MS });
      if (epoch !== state.thumbnailEpoch) throw new Error("thumbnail-generation-changed");
      const url = URL.createObjectURL(blob);
      state.thumbnailUrls.set(assetId, url);
      return url;
    } catch (error) {
      if (epoch !== state.thumbnailEpoch) throw new Error("thumbnail-generation-changed");
      throw error;
    }
  }).finally(() => state.thumbnailRequests.delete(requestKey));
  state.thumbnailRequests.set(requestKey, pending);
  return pending;
}
const observedThumbnails = new Set();
const thumbnailObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    thumbnailObserver.unobserve(entry.target);
    observedThumbnails.delete(entry.target);
    void loadThumbnail(entry.target);
  }
}, { rootMargin: "900px 0px" });
function thumbnailImage(assetId, alt = "") {
  const image = document.createElement("img");
  image.alt = alt;
  image.decoding = "async";
  image.dataset.assetId = assetId;
  image.dataset.thumbnailState = "pending";
  return image;
}
function hydrateThumbnails() {
  for (const image of observedThumbnails) if (!image.isConnected) {
    thumbnailObserver?.unobserve(image); observedThumbnails.delete(image);
  }
  for (const image of document.querySelectorAll('img[data-thumbnail-state="pending"]')) {
    image.dataset.thumbnailState = "waiting";
    if (thumbnailObserver && !state.thumbnailUrls.has(image.dataset.assetId)) {
      thumbnailObserver.observe(image); observedThumbnails.add(image);
    }
    else void loadThumbnail(image);
  }
}
async function loadThumbnail(image) {
  if (!image.isConnected) return;
  const assetId = image.dataset.assetId;
  const frame = image.closest(".thumb-frame, .cover, .selection-thumb, .stack-thumb");
  const fail = () => {
    state.thumbnailFailures.add(assetId);
    frame?.classList.add("has-error");
    frame?.querySelector(".thumb-skeleton")?.remove();
    image.dataset.thumbnailState = "error";
    image.remove();
  };
  if (!assetId || state.thumbnailFailures.has(assetId)) { fail(); return; }
  image.dataset.thumbnailState = "loading";
  try {
    const url = await thumbnailUrl(assetId);
    if (!image.isConnected) return;
    image.addEventListener("load", () => {
      image.classList.add("is-loaded");
      image.dataset.thumbnailState = "loaded";
      frame?.querySelector(".thumb-skeleton")?.remove();
    }, { once: true });
    image.addEventListener("error", fail, { once: true });
    image.src = url;
  } catch (error) { if (error?.message !== "thumbnail-generation-changed" && image.isConnected) fail(); }
}
function mergeSummary(summary, acceptVersion = true) {
  if (!summary) return;
  if (acceptVersion && Number.isInteger(summary.version)) state.version = summary.version;
  if (summary.watcherStatus) state.watcherStatus = summary.watcherStatus;
  if (summary.transfer) state.transfer = summary.transfer;
  if (summary.refreshedAt) state.refreshedAt = summary.refreshedAt;
}
function updateChrome() {
  const status = state.offline ? ["正在重连", "offline"]
    : state.watcherStatus === "watching" ? [`${state.libraryTotal} 张 · 已同步`, "watching"]
      : state.watcherStatus === "degraded" ? ["周期扫描中", "degraded"]
        : state.watcherStatus === "stopped" ? ["监听已停止", "stopped"] : ["连接中", "starting"];
  elements.watcherSummary.textContent = status[0];
  elements.watcherSummary.dataset.state = status[1];
  for (const [tab, node] of [["pins", elements.pinsTab], ["boards", elements.boardsTab]]) {
    node.classList.toggle("is-active", state.tab === tab);
    node.setAttribute("aria-pressed", String(state.tab === tab));
  }
  elements.refreshButton.disabled = state.refreshing;
  elements.clearSearch.hidden = !state.query;
  elements.sortSelect.disabled = state.tab === "boards";
  sortMenu.sync();
  elements.searchInput.placeholder = state.tab === "boards" ? "搜索图版名称" : "搜索标题、图版或 Pin ID";
  const banner = state.offline ? "连接暂时中断，现有素材保留。正在自动重连，也可点击刷新重试。"
    : (state.transfer?.failed ?? 0) > 0 ? `有 ${state.transfer.failed} 个文件未能收取，原文件仍保留在下载临时区。`
      : state.watcherStatus === "degraded" ? "实时监听暂不可用，周期扫描仍在运行。" : "";
  elements.statusBanner.hidden = !banner;
  elements.statusBanner.classList.toggle("is-danger", state.offline || (state.transfer?.failed ?? 0) > 0);
  elements.statusBanner.textContent = banner;
  elements.content.setAttribute("aria-busy", String(state.pageLoading || state.initialLoading));
  elements.content.inert = state.pageLoading && state.dataView !== viewKey();
  elements.loadMoreButton.disabled = state.pageLoading;
  elements.loadMoreButton.textContent = state.pageLoading ? "正在加载…" : "继续加载";
  elements.resultSummary.textContent = state.deleteMode && state.tab === "pins" ? `点选要删除的图片 · 已选 ${state.deletePicks.length} 张`
    : state.initialLoading ? "正在读取素材…"
    : state.pageLoading ? "正在查找…" : state.pageError ? "读取失败，请重试"
      : state.tab === "boards" ? `${visibleBoards().length} 个图版`
        : state.query ? `找到 ${state.total} 张图片` : `${state.boardTitle || "全部素材"} · ${state.total} 张`;
  const filterKey = state.tab === "pins" ? state.boardId ?? "" : "";
  elements.boardFilter.hidden = !filterKey;
  if (elements.boardFilter.dataset.key !== filterKey) {
    elements.boardFilter.dataset.key = filterKey;
    elements.boardFilter.replaceChildren();
    if (filterKey) elements.boardFilter.append(button("filter-clear", "返回全部 ×", "显示全部", () => {
      state.boardId = null; state.boardTitle = null; void loadPage({ reset: true });
    }));
  }
}
function emptyState(title, detail, actionLabel, action) {
  const wrapper = element("section", "empty-state");
  const inner = element("div", "empty-state-inner");
  inner.append(element("div", "empty-mark", "P"), element("h2", "", title), element("p", "", detail));
  if (action) inner.append(button("button secondary", actionLabel, null, action));
  wrapper.append(inner);
  return wrapper;
}
function applyCopyState(card, assetId) {
  const copying = state.pendingCopies.has(assetId);
  const copied = state.copiedAssetId === assetId;
  card.classList.toggle("is-copying", copying);
  card.classList.toggle("is-copied", copied);
}
function updateCopyState(assetId) {
  if (!assetId) return;
  for (const card of elements.content.querySelectorAll(".pin-card")) if (card.dataset.assetId === assetId) applyCopyState(card, assetId);
  if (state.previewAsset?.id === assetId) {
    elements.previewCopy.setAttribute("aria-busy", String(state.pendingCopies.has(assetId)));
    if (state.pendingCopies.has(assetId)) elements.previewCopy.textContent = "复制中…";
    else shortcutLabel(elements.previewCopy, state.copiedAssetId === assetId ? "已复制 ✓" : "复制路径");
  }
}
// Writing an attribute, even with the same value, invalidates style for that card.
function setAttr(node, name, value) { if (node && node.getAttribute(name) !== value) node.setAttribute(name, value); }
function setText(node, value) { if (node && node.textContent !== value) node.textContent = value; }
function canSelectReferences() { return Boolean(state.selection) && !state.selectionError; }
function applySelectionState(card) {
  const id = card.dataset.assetId;
  const index = selectedIndex(id);
  const trigger = card.querySelector(".preview-trigger");
  const badge = card.querySelector(".pin-order");
  const changed = card.classList.contains("is-selected") !== (index >= 0);
  if (changed) card.classList.toggle("is-selected", index >= 0);
  setText(badge, index >= 0 ? String(index + 1) : "");
  const label = canSelectReferences() ? `${index >= 0 ? `移除参考 ${index + 1}` : "加入参考"}：${card.dataset.title}` : `预览：${card.dataset.title}`;
  setAttr(trigger, "aria-label", label);
  setAttr(trigger, "title", canSelectReferences() ? (index >= 0 ? `参考图 ${index + 1} · 点击移除` : "点击加入参考篮") : "点击预览");
  setAttr(trigger, "aria-pressed", String(index >= 0));
  if (changed && index >= 0) playMotion(badge, [{ transform: "scale(.4)", opacity: 0 }, { transform: "scale(1.12)", opacity: 1, offset: .6 }, { transform: "scale(1)", opacity: 1 }], { duration: 300 });
}
// Clicking a pin picks it; the corner button (or the preview fallback when no
// reference basket is attached) opens the large preview.
function activatePin(asset) {
  if (state.deleteMode) { togglePick(asset); return; }
  if (canSelectReferences()) toggleReference(asset); else void openPreview(asset);
}
function pinCard(asset) {
  const card = element("article", "pin-card");
  card.dataset.assetId = asset.id;
  card.dataset.title = asset.title;
  const frame = element("div", "thumb-frame");
  // Reserve the real height before the thumbnail loads so masonry picks the right column.
  if (asset.width > 0 && asset.height > 0) {
    frame.classList.add("has-ratio");
    frame.style.setProperty("--thumb-ratio", `${asset.width} / ${asset.height}`);
  }
  const preview = button("preview-trigger", null, `加入参考：${asset.title}`, () => activatePin(asset));
  preview.append(thumbnailImage(asset.id, asset.title), element("span", "thumb-skeleton"));
  const expand = button("pin-expand", null, `放大预览：${asset.title}`, () => void openPreview(asset));
  expand.title = "放大预览";
  expand.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
  frame.append(preview, expand, element("span", "pin-order"), element("span", "pin-check"));
  const body = element("div", "pin-body");
  const copy = element("div", "pin-copy-text");
  const meta = element("div", "pin-meta");
  meta.append(element("span", "", asset.boardTitle), element("span", "", asset.extension.slice(1).toUpperCase()));
  const shownTitle = displayTitle(asset);
  if (shownTitle) {
    const title = element("p", "pin-title", shownTitle); title.title = shownTitle;
    copy.append(title);
  }
  copy.append(meta);
  const hint = element("span", "pin-shortcut");
  shortcutLabel(hint, "复制路径");
  body.append(copy, hint);
  card.append(frame, body);
  applyCopyState(card, asset.id); applySelectionState(card); applyPickState(card);
  return card;
}
function visibleBoards() {
  const words = state.query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return state.boards.filter(board => words.every(word => board.title.normalize("NFKC").toLocaleLowerCase().includes(word)));
}
function boardCard(board) {
  const card = button("board-card", null, `打开图版 ${board.title}`, () => {
    state.tab = "pins"; state.boardId = board.id; state.boardTitle = board.title;
    state.query = ""; elements.searchInput.value = ""; void loadPage({ reset: true });
  });
  const covers = element("div", "board-covers");
  for (let index = 0; index < 3; index += 1) {
    const cover = element("span", "cover");
    if (board.coverAssetIds[index]) cover.append(thumbnailImage(board.coverAssetIds[index]));
    covers.append(cover);
  }
  const body = element("div", "board-body");
  const meta = element("div", "board-meta");
  meta.append(element("span", "", `${board.pinCount} 张图片`), element("span", "", "查看 →"));
  body.append(element("strong", "", board.title), meta);
  card.append(covers, body);
  return card;
}
// Reuse cards and image nodes on pagination and state changes.
function reconcileGrid(className, records, key, stamp, create) {
  let grid = elements.content.firstElementChild;
  if (!grid?.classList.contains(className)) {
    grid = element("section", className);
    elements.content.replaceChildren(grid);
  }
  const existing = new Map([...grid.children].map(node => [node.dataset.key, node]));
  const keep = new Set();
  let cursor = grid.firstElementChild;
  for (const [index, record] of records.entries()) {
    const id = key(record), signature = stamp(record);
    let card = existing.get(id);
    if (!card || card.dataset.stamp !== signature) {
      card = create(record); card.dataset.key = id; card.dataset.stamp = signature;
      card.style.setProperty("--enter-delay", `${Math.min(index, 6) * 18}ms`);
    }
    if (card !== cursor) grid.insertBefore(card, cursor);
    cursor = card.nextElementSibling;
    keep.add(card);
  }
  for (const child of [...grid.children]) if (!keep.has(child)) child.remove();
}
// Explicit columns: appended cards go to the shortest column and placed cards never move.
function masonryColumnCount() {
  const value = Number.parseInt(getComputedStyle(elements.content).getPropertyValue("--masonry-columns"), 10);
  return Number.isFinite(value) && value > 0 ? value : 2;
}
function shortestColumn(columns) {
  return columns.reduce((best, column) => column.offsetHeight < best.offsetHeight ? column : best);
}
function reconcileMasonry(records, key, stamp, create) {
  const columnCount = masonryColumnCount();
  const keys = records.map(key);
  let grid = elements.content.firstElementChild;
  const previousKeys = grid?.classList.contains("masonry") ? grid.masonryKeys ?? [] : null;
  const appendOnly = previousKeys !== null && grid.children.length === columnCount && previousKeys.length <= keys.length && previousKeys.every((id, index) => id === keys[index]);
  const existing = new Map(previousKeys === null ? [] : [...grid.querySelectorAll(".pin-card")].map(node => [node.dataset.key, node]));
  const cardFor = (record, index, batchIndex) => {
    const id = keys[index], signature = stamp(record);
    let card = existing.get(id);
    if (!card || card.dataset.stamp !== signature) {
      const fresh = create(record); fresh.dataset.key = id; fresh.dataset.stamp = signature;
      fresh.style.setProperty("--enter-delay", `${Math.min(batchIndex, 6) * 18}ms`);
      card?.replaceWith(fresh);
      card = fresh;
    }
    return card;
  };
  if (appendOnly) {
    const columns = [...grid.children];
    for (let index = 0; index < previousKeys.length; index += 1) cardFor(records[index], index, index);
    for (let index = previousKeys.length; index < records.length; index += 1) shortestColumn(columns).append(cardFor(records[index], index, index - previousKeys.length));
  } else {
    grid = element("section", "masonry");
    const columns = Array.from({ length: columnCount }, () => element("div", "masonry-column"));
    grid.append(...columns);
    elements.content.replaceChildren(grid);
    for (const [index, record] of records.entries()) shortestColumn(columns).append(cardFor(record, index, index));
  }
  grid.masonryKeys = keys;
}
// Fetch the next page while the end of the list is still about 1.5 screens away.
// Geometry is read on every check because observer entries lag behind a fresh render.
const loadMoreSentinel = elements.loadMoreButton.parentElement;
function maybeAutoLoad() {
  if (state.tab !== "pins" || !state.nextCursor || state.pageLoading || state.pageError || state.initialLoading || !loadMoreSentinel) return;
  if (loadMoreSentinel.getBoundingClientRect().top < window.innerHeight * 2.5) void loadPage();
}
if (typeof IntersectionObserver !== "undefined" && loadMoreSentinel) {
  new IntersectionObserver(() => maybeAutoLoad(), { rootMargin: "0px 0px 150% 0px" }).observe(loadMoreSentinel);
}
let lastColumnCount = null;
window.addEventListener("resize", () => {
  if (state.tab !== "pins" || !state.assets.length) return;
  const columnCount = masonryColumnCount();
  if (lastColumnCount !== null && columnCount !== lastColumnCount) renderContent();
  lastColumnCount = columnCount;
});
function renderContent() {
  updateChrome();
  if (state.initialLoading) return;
  if ((state.pageError && state.dataView !== viewKey()) || (state.offline && !state.assets.length && !state.boards.length)) {
    elements.content.replaceChildren(emptyState("暂时无法读取素材", state.pageError || "请确认插件仍在运行，或稍后重试。", "重新加载", () => void loadPage({ reset: true })));
    elements.loadMoreButton.hidden = true; elements.listEnd.hidden = true; return;
  }
  if (state.tab === "boards") {
    const boards = visibleBoards();
    if (boards.length) reconcileGrid("boards-grid", boards, board => board.id, board => JSON.stringify(board), boardCard);
    else elements.content.replaceChildren(emptyState(state.query ? "没有匹配的图版" : "还没有图版", state.query ? "试试更短的关键词，或清除搜索。" : "从 Pinterest 下载图片后，素材文件夹会显示在这里。"));
    elements.loadMoreButton.hidden = true; elements.listEnd.hidden = true;
  } else {
    if (state.assets.length) {
      reconcileMasonry(state.assets, asset => asset.id, asset => `${asset.updatedAt}:${asset.size}:${asset.width}x${asset.height}:${state.thumbnailEpoch}`, pinCard);
      lastColumnCount = masonryColumnCount();
    }
    else elements.content.replaceChildren(emptyState(state.query ? "没有找到相关图片" : state.boardId ? "这个图版还没有图片" : "留下一点灵感", state.query ? "搜索会覆盖整个素材库。试试其他标题、图版名称或 Pin ID。" : "在 Pinterest 扩展中下载图片，它们会自动出现在这里。", state.query ? "清除搜索" : null, state.query ? clearSearch : null));
    elements.loadMoreButton.hidden = !state.nextCursor;
    elements.listEnd.hidden = !state.assets.length || Boolean(state.nextCursor);
  }
  hydrateThumbnails();
  maybeAutoLoad();
}
async function copyAsset(asset) {
  if (state.pendingCopies.size || state.copyingSelection) { showToast("正在复制，请稍候"); return; }
  clearCopyFeedback();
  state.pendingCopies.add(asset.id); updateCopyState(asset.id);
  try {
    const result = await api("/api/clipboard", { method: "POST", body: { assetId: asset.id } });
    if (result.status !== "copied" || result.assetId !== asset.id) throw new Error("未收到复制确认，请重试");
    state.copiedAssetId = asset.id;
    for (const card of elements.content.querySelectorAll(".pin-card")) if (card.dataset.assetId === asset.id) {
      playMotion(card.querySelector(".thumb-frame"), [{ transform: "scale(1)" }, { transform: "scale(.97)", offset: .35 }, { transform: "scale(1)" }], { duration: 320 });
    }
    if (state.previewAsset?.id === asset.id) pulseControl(elements.previewCopy);
    showToast("绝对路径已复制 · 回到对话按 ⌘V");
  } catch (error) { showToast(error.message || "复制失败，请重试", true); }
  finally { state.pendingCopies.delete(asset.id); updateCopyState(asset.id); }
}
function clearCopyFeedback() {
  const previousAssetId = state.copiedAssetId;
  state.copiedAssetId = null;
  updateCopyState(previousAssetId);
}
async function loadPage({ reset = false } = {}) {
  if (!reset && state.pageLoading) return;
  if (reset) state.pageGeneration += 1;
  const generation = state.pageGeneration;
  const requestedTab = state.tab, requestedBoardId = state.boardId;
  const requestedQuery = state.query, requestedSort = state.sort;
  const requestedCursor = reset ? null : state.nextCursor;
  const isCurrentRequest = () => generation === state.pageGeneration && requestedTab === state.tab && requestedBoardId === state.boardId && requestedQuery === state.query && requestedSort === state.sort;
  state.pageLoading = true; state.pageError = null; updateChrome();
  try {
    const params = new URLSearchParams({ limit: "30", sort: requestedSort });
    if (requestedCursor) params.set("cursor", requestedCursor);
    if (requestedBoardId) params.set("boardId", requestedBoardId);
    if (requestedQuery && requestedTab === "pins") params.set("q", requestedQuery);
    const result = await api(`/api/inbox?${params}`);
    if (!isCurrentRequest()) return;
    const page = result.page;
    if (!reset && state.version !== null && page.version !== state.version) {
      // Offset cursors from different library versions must never be combined.
      return await loadPage({ reset: true });
    }
    if (state.version !== null && page.version !== state.version) clearThumbnailCache();
    state.assets = reset ? page.assets : [...state.assets, ...page.assets];
    state.boards = page.boards; state.total = page.total; state.libraryTotal = page.libraryTotal;
    state.nextCursor = page.nextCursor; state.dataView = viewKey();
    mergeSummary(page); state.offline = false; state.pollDelay = 2000;
    return true;
  } catch (error) {
    if (!isCurrentRequest()) return;
    state.offline = true; state.pageError = error.message || "读取素材失败";
    showToast(state.pageError, true);
  } finally {
    if (isCurrentRequest()) { state.pageLoading = false; state.initialLoading = false; renderContent(); }
  }
}
async function refreshNow() {
  if (state.refreshing) return;
  state.refreshing = true; updateChrome();
  try {
    const result = await api("/api/refresh", { method: "POST", body: {}, timeoutMs: REFRESH_TIMEOUT_MS });
    mergeSummary(result, false); clearThumbnailCache();
    const loaded = await loadPage({ reset: true });
    if (referenceSessionId) await loadSelection();
    if (loaded) showToast("Pinterest BoardFlow 已刷新");
  } catch (error) { state.offline = true; showToast(error.message || "刷新失败", true); }
  finally { state.refreshing = false; updateChrome(); }
}
function applySelection(result) {
  if (state.selection && result.revision < state.selection.revision) return;
  const changed = JSON.stringify(result) !== JSON.stringify(state.selection);
  const countChanged = state.selection && result.entries.length !== state.selection.entries.length;
  state.selection = result; state.selectionError = null;
  if (changed) renderSelection(); else updateSelectionStatus();
  if (countChanged) pulseControl(elements.selectionCount);
}
async function loadSelection() {
  if (!referenceSessionId || state.selectionPending) return;
  try { applySelection(await api("/api/references")); }
  catch (error) { state.selectionError = error.message || "参考篮暂时不可用"; renderSelection(); }
}
function updateSelectionStatus() {
  const entries = state.selection?.entries ?? [];
  const unavailable = entries.some(entry => entry.status !== "ready");
  elements.selectionCount.textContent = `${entries.length} / 10`;
  elements.selectionStatus.textContent = state.selectionError ? "未同步" : state.selectionPending ? "保存中…" : unavailable ? "需要检查" : entries.length ? "已就绪" : "";
  elements.selectionStatus.classList.toggle("is-error", Boolean(state.selectionError) || unavailable);
  elements.clearSelection.disabled = !entries.length || Boolean(state.selectionPending) || !state.selection;
  const blocked = !entries.length || unavailable || Boolean(state.selectionPending) || Boolean(state.selectionError) || state.copyingSelection;
  elements.copySelection.dataset.blocked = String(blocked);
  elements.copySelection.setAttribute("aria-disabled", String(blocked));
  if (state.copyingSelection) elements.copySelection.textContent = "复制中…";
  else shortcutLabel(elements.copySelection, "复制路径");
  document.body.classList.toggle("has-references", entries.length > 0);
  elements.selectionHint.textContent = !referenceSessionId ? "此页可浏览素材；请让 AI 助手为当前任务打开参考篮。"
    : state.selectionError || (unavailable ? "有参考图已变化或不可用，请移除后重新选择。"
      : entries.length ? "回到对话说“使用选中的参考图”" : "点击图片加入参考篮");
  elements.selectionHint.classList.toggle("is-error", Boolean(state.selectionError) || unavailable);
  const empty = !entries.length && !state.selectionError;
  elements.referenceTray.classList.toggle("is-empty", empty);
  elements.referenceTray.setAttribute("aria-busy", String(state.selectionPending > 0));
}
function renderSelection() {
  const trayBefore = elements.referenceTray.getBoundingClientRect();
  const wasEmpty = elements.referenceTray.classList.contains("is-empty");
  const positions = new Map([...elements.selectionList.children].map(node => [node.dataset.assetId, node.getBoundingClientRect()]));
  nodeMotions.get(elements.referenceTray)?.cancel();
  for (const node of elements.selectionList.children) nodeMotions.get(node)?.cancel();
  updateSelectionStatus();
  const focused = document.activeElement;
  const focusedItem = focused?.closest?.(".selection-item");
  const focusedId = focusedItem?.dataset.assetId;
  const focusedAction = focused?.dataset.selectionAction;
  const scrollLeft = elements.selectionList.scrollLeft;
  const entries = state.selection?.entries ?? [];
  elements.selectionList.hidden = !entries.length;
  // Keep existing tiles (their thumbnails are already decoded); only new picks get new nodes.
  const existingTiles = new Map([...elements.selectionList.children].map(node => [node.dataset.assetId, node]));
  const tiles = entries.map((entry, index) => {
    const ready = entry.status === "ready";
    let item = existingTiles.get(entry.id);
    if (!item || item.dataset.status !== entry.status) {
      item = element("li", "selection-item");
      item.dataset.assetId = entry.id;
      item.dataset.status = entry.status;
      item.classList.toggle("is-unavailable", !ready);
      const thumb = button("selection-thumb", null, "", () => void openPreview(entry));
      thumb.append(thumbnailImage(entry.id), element("span", "selection-number"));
      if (!ready) thumb.append(element("span", "selection-invalid", "失效"));
      const remove = button("selection-remove", "×", "", () => mutateSelection(ids => ids.filter(id => id !== entry.id)));
      for (const [action, node] of [["preview", thumb], ["remove", remove]]) node.dataset.selectionAction = action;
      item.append(thumb, remove);
    }
    const thumb = item.querySelector(".selection-thumb"), remove = item.querySelector(".selection-remove");
    setText(item.querySelector(".selection-number"), String(index + 1));
    setAttr(thumb, "aria-label", `预览参考 ${index + 1}：${entry.title}`);
    setAttr(thumb, "title", `参考 ${index + 1}：拖动调整顺序，点击放大（⌥← / ⌥→ 也可移动）`);
    setAttr(remove, "aria-label", `移除参考 ${index + 1}`);
    setAttr(remove, "title", `移除参考 ${index + 1}`);
    item.draggable = entries.length > 1;
    return item;
  });
  for (const [id, node] of existingTiles) if (!tiles.includes(node)) node.remove();
  tiles.forEach((item, index) => { if (elements.selectionList.children[index] !== item) elements.selectionList.insertBefore(item, elements.selectionList.children[index] ?? null); });
  elements.selectionList.scrollLeft = scrollLeft;
  updateDockOverflow();
  if (focusedId) {
    const item = [...elements.selectionList.children].find(node => node.dataset.assetId === focusedId);
    const action = item?.querySelector(`[data-selection-action="${focusedAction}"]`);
    const fallback = item?.querySelector(".selection-thumb") || elements.selectionList.querySelector(".selection-thumb") || elements.searchInput;
    (action && !action.disabled ? action : fallback).focus({ preventScroll: true });
  }
  for (const card of elements.content.querySelectorAll(".pin-card")) applySelectionState(card);
  updatePreviewControls(); hydrateThumbnails();
  const trayAfter = elements.referenceTray.getBoundingClientRect();
  const items = [...elements.selectionList.children].map(node => ({ node, after: node.getBoundingClientRect(), before: positions.get(node.dataset.assetId) }));
  const spring = { duration: SPRING.duration, easing: SPRING.easing };
  if (Math.abs(trayBefore.width - trayAfter.width) > 1 || Math.abs(trayBefore.height - trayAfter.height) > 1) {
    playMotion(elements.referenceTray, [
      { width: `${trayBefore.width}px`, height: `${trayBefore.height}px` },
      { width: `${trayAfter.width}px`, height: `${trayAfter.height}px` }
    ], spring);
  }
  if (wasEmpty !== elements.referenceTray.classList.contains("is-empty")) {
    for (const part of elements.referenceTray.querySelectorAll(".tray-info, .tray-actions")) playMotion(part, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 60, fill: "backwards" });
  }
  for (const [index, { node, before, after }] of items.entries()) {
    if (!before) {
      playMotion(node, [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }], { ...spring, delay: 40 + Math.min(index, 4) * 20, fill: "backwards" });
    } else {
      const x = before.left - after.left, y = before.top - after.top;
      if (Math.abs(x) > 1 || Math.abs(y) > 1) playMotion(node, [{ transform: `translate(${x}px,${y}px)` }, { transform: "translate(0,0)" }], spring);
    }
  }
}
// Fade the dock's right edge only while more tiles are scrolled out of view.
function updateDockOverflow() {
  const list = elements.selectionList;
  const overflowing = list.scrollWidth - list.clientWidth - list.scrollLeft > 2;
  list.classList.toggle("is-overflowing", overflowing);
}
elements.selectionList.addEventListener("scroll", updateDockOverflow, { passive: true });
function mutateSelection(transform) {
  if (!state.selection || state.selectionError) { showToast(state.selectionError || "参考篮尚未就绪", true); return; }
  state.selectionPending += 1; updateSelectionStatus();
  state.selectionChain = state.selectionChain.then(async () => {
    if (state.selectionError) return;
    const assetIds = transform(state.selection.entries.map(entry => entry.id));
    try {
      const result = await api("/api/references", { method: "POST", body: { assetIds, revision: state.selection.revision } });
      applySelection(result);
    } catch (error) {
      showToast(error.message || "无法保存选择，请重试", true);
      // Stop queued edits after a conflict instead of applying stale user intent.
      state.selectionError = error.message;
      throw error;
    }
  }).catch(() => {}).finally(async () => {
    state.selectionPending -= 1;
    if (!state.selectionPending && state.selectionError) await loadSelection();
    updateSelectionStatus();
  });
}
// Drag to reorder: the dragged tile moves live (siblings glide via FLIP) and the
// final order is saved once on drop. ⌥←/⌥→ on a focused tile does the same by keyboard.
let traySortId = null;
function flipSiblings(mutate) {
  const before = new Map([...elements.selectionList.children].map(node => [node, node.getBoundingClientRect().left]));
  mutate();
  for (const [node, left] of before) {
    const dx = left - node.getBoundingClientRect().left;
    if (Math.abs(dx) > 1 && node.dataset.assetId !== traySortId) playMotion(node, [{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 260 });
  }
}
elements.selectionList.addEventListener("dragstart", event => {
  const item = event.target.closest?.(".selection-item");
  if (!item || state.selectionPending || !state.selection) { event.preventDefault(); return; }
  traySortId = item.dataset.assetId;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", traySortId);
  requestAnimationFrame(() => item.classList.add("is-dragging"));
});
elements.selectionList.addEventListener("dragover", event => {
  if (!traySortId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const dragged = [...elements.selectionList.children].find(node => node.dataset.assetId === traySortId);
  const others = [...elements.selectionList.children].filter(node => node !== dragged);
  const before = others.find(node => { const box = node.getBoundingClientRect(); return event.clientX < box.left + box.width / 2; }) ?? null;
  if (dragged && dragged.nextElementSibling !== before && before !== dragged) flipSiblings(() => elements.selectionList.insertBefore(dragged, before));
});
elements.selectionList.addEventListener("drop", event => { if (traySortId) event.preventDefault(); });
elements.selectionList.addEventListener("dragend", () => {
  const id = traySortId;
  traySortId = null;
  for (const node of elements.selectionList.children) node.classList.remove("is-dragging");
  if (!id || !state.selection) return;
  const order = [...elements.selectionList.children].map(node => node.dataset.assetId);
  const current = state.selection.entries.map(entry => entry.id);
  if (order.join() === current.join()) return;
  // Apply the dropped order against the latest confirmed list, keeping any ids it no longer has out.
  mutateSelection(ids => [...order.filter(item => ids.includes(item)), ...ids.filter(item => !order.includes(item))]);
});
elements.selectionList.addEventListener("keydown", event => {
  if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
  const id = event.target.closest?.(".selection-item")?.dataset.assetId;
  if (!id) return;
  event.preventDefault();
  moveReference(id, event.key === "ArrowLeft" ? -1 : 1);
});
function toggleReference(asset) {
  mutateSelection(ids => ids.includes(asset.id) ? ids.filter(id => id !== asset.id) : [...ids, asset.id]);
}
function moveReference(id, offset) {
  mutateSelection(ids => {
    const index = ids.indexOf(id), target = index + offset;
    if (index >= 0 && target >= 0 && target < ids.length) [ids[index], ids[target]] = [ids[target], ids[index]];
    return ids;
  });
}
async function copySelection() {
  if (state.pendingCopies.size || state.copyingSelection) { showToast("正在复制，请稍候"); return; }
  if (elements.copySelection.dataset.blocked === "true") { showToast(elements.selectionHint.textContent || "参考篮暂时不能复制", true); return; }
  clearCopyFeedback();
  state.copyingSelection = true; updateSelectionStatus();
  const expectedCount = state.selection.entries.length;
  try {
    const result = await api("/api/references/clipboard", { method: "POST", body: { revision: state.selection.revision } });
    if (result.status !== "copied" || result.count !== expectedCount) throw new Error("未收到完整复制确认，请重试");
    pulseControl(elements.copySelection);
    showToast(`已复制 ${result.count} 张图片的路径 · 回到对话按 ⌘V`);
  } catch (error) { showToast(error.message || "复制失败", true); await loadSelection(); }
  finally { state.copyingSelection = false; updateSelectionStatus(); }
}
function updatePreviewControls() {
  if (!state.previewAsset) return;
  const armed = state.trashArmedId === state.previewAsset.id, trashing = state.trashingId === state.previewAsset.id;
  elements.previewDelete.textContent = trashing ? "删除中…" : armed ? "确认删除？" : "删除";
  elements.previewDelete.classList.toggle("is-armed", armed);
  elements.previewDelete.disabled = Boolean(state.trashingId) || state.bulkTrashing;
  elements.previewDelete.setAttribute("aria-busy", String(trashing));
  const index = selectedIndex(state.previewAsset.id);
  elements.previewSelect.textContent = index >= 0 ? `已选为参考 ${index + 1} · 移除` : "加入参考";
  elements.previewSelect.setAttribute("aria-pressed", String(index >= 0));
  elements.previewSelect.disabled = !state.selection || Boolean(state.selectionError);
  const position = state.assets.findIndex(asset => asset.id === state.previewAsset.id);
  elements.previousPreview.disabled = position <= 0;
  elements.nextPreview.disabled = position < 0 || position >= state.assets.length - 1;
  elements.previewPosition.textContent = position >= 0 ? `${position + 1} / ${Math.max(state.total, state.assets.length)}` : "参考图预览";
  elements.nextPreview.disabled = position < 0 || (position >= state.assets.length - 1 && !state.nextCursor);
}
function disarmTrash() {
  clearTimeout(state.trashArmTimer);
  state.trashArmedId = null;
  updatePreviewControls();
}
// Two presses on the same image: the first arms, the second moves it to the Trash.
async function trashPreviewAsset() {
  const asset = state.previewAsset;
  if (!asset || state.trashingId || state.bulkTrashing) return;
  if (state.trashArmedId !== asset.id) {
    clearTimeout(state.trashArmTimer);
    state.trashArmedId = asset.id;
    state.trashArmTimer = setTimeout(disarmTrash, 4000);
    updatePreviewControls(); pulseControl(elements.previewDelete);
    return;
  }
  clearTimeout(state.trashArmTimer);
  state.trashArmedId = null; state.trashingId = asset.id; updatePreviewControls();
  // Pick the follow-up image now: a status poll may reload the list before the response.
  const position = state.assets.findIndex(item => item.id === asset.id);
  const neighbors = position < 0 ? [] : [...state.assets.slice(position + 1), ...state.assets.slice(0, position).reverse()].map(item => item.id);
  try {
    const result = await api("/api/trash", { method: "POST", body: { assetIds: [asset.id] } });
    if (result.status !== "trashed" || result.trashed?.[0]?.assetId !== asset.id) throw new Error("未收到删除确认，请刷新后查看");
    state.trashingId = null;
    forgetTrashed(new Set([asset.id]), result.total);
    const next = neighbors.map(id => state.assets.find(item => item.id === id)).find(Boolean);
    showToast(`已移到废纸篓：${result.trashed[0].title}`);
    if (state.previewAsset?.id === asset.id) {
      if (next) void openPreview(next, 1); else void dismissPreview();
    }
  } catch (error) { showToast(error.message || "删除失败，请重试", true); }
  finally { state.trashingId = null; updatePreviewControls(); }
}
function forgetTrashed(removed, total) {
  const before = state.assets.length;
  state.assets = state.assets.filter(item => !removed.has(item.id));
  state.total = Math.max(0, state.total - (before - state.assets.length));
  state.libraryTotal = Number.isInteger(total) ? total : Math.max(0, state.libraryTotal - removed.size);
  state.deletePicks = state.deletePicks.filter(item => !removed.has(item.id));
  renderContent(); renderDeleteStack();
  if (referenceSessionId) void loadSelection();
}
// Select-to-delete mode: picks keep their click order, which is also the
// left-to-right order of the expanded stack.
function pickIndex(assetId) { return state.deletePicks.findIndex(asset => asset.id === assetId); }
function applyPickState(card) {
  const index = pickIndex(card.dataset.assetId);
  card.classList.toggle("is-picked", index >= 0);
  card.querySelector(".pin-check").textContent = index >= 0 ? String(index + 1) : "";
}
function setDeleteMode(enabled) {
  if (state.bulkTrashing) return;
  state.deleteMode = enabled; state.deletePicks = []; state.stackOpen = false;
  disarmBulkTrash(false);
  document.body.classList.toggle("is-delete-mode", enabled);
  elements.deleteModeButton.hidden = enabled; elements.exitDeleteMode.hidden = !enabled;
  elements.referenceTray.hidden = enabled;
  renderDeleteStack(); updateChrome();
  (enabled ? elements.exitDeleteMode : elements.deleteModeButton).focus({ preventScroll: true });
}
function togglePick(asset) {
  if (state.bulkTrashing) return;
  const index = pickIndex(asset.id);
  if (index >= 0) state.deletePicks.splice(index, 1);
  else if (state.deletePicks.length >= MAX_DELETE_PICKS) { showToast(`一次最多删除 ${MAX_DELETE_PICKS} 张`, true); return; }
  else state.deletePicks.push(asset);
  disarmBulkTrash(false);
  renderDeleteStack(); updateChrome();
  for (const card of elements.content.querySelectorAll(".pin-card")) if (card.dataset.assetId === asset.id) pulseControl(card.querySelector(".pin-check"));
  pulseControl(elements.stackPile.querySelector(".stack-count"));
}
function stackThumb(asset, className) {
  const frame = element("span", className);
  frame.append(thumbnailImage(asset.id, asset.title));
  return frame;
}
function renderDeleteStack() {
  for (const card of elements.content.querySelectorAll(".pin-card")) applyPickState(card);
  const picks = state.deletePicks;
  if (!picks.length) state.stackOpen = false;
  elements.deleteStack.hidden = !state.deleteMode || !picks.length;
  elements.deleteStack.classList.toggle("is-open", state.stackOpen);
  elements.stackPile.hidden = state.stackOpen;
  elements.stackStrip.hidden = !state.stackOpen;
  // Collapsed: the first pick sits in front, later picks peek out to its right.
  elements.stackPile.replaceChildren(...picks.slice(0, 3).map((asset, index) => {
    const layer = stackThumb(asset, "stack-thumb");
    layer.style.setProperty("--layer", String(index));
    return layer;
  }), element("span", "stack-count", String(picks.length)));
  elements.stackPile.setAttribute("aria-label", `已选 ${picks.length} 张待删除，点击展开`);
  elements.stackPile.title = "展开待删除图片";
  elements.stackList.replaceChildren(...picks.map((asset, index) => {
    const item = element("li", "stack-item");
    item.dataset.assetId = asset.id;
    const thumb = stackThumb(asset, "stack-thumb is-flat");
    thumb.append(element("span", "selection-number", String(index + 1)));
    item.append(thumb, button("selection-remove", "×", `不删除：${asset.title}`, () => togglePick(asset)));
    return item;
  }));
  elements.stackDelete.textContent = state.bulkTrashing ? "删除中…" : state.bulkArmed ? `确认删除 ${picks.length} 张？` : `删除 ${picks.length} 张`;
  elements.stackDelete.classList.toggle("is-armed", state.bulkArmed);
  elements.stackDelete.disabled = state.bulkTrashing;
  elements.stackDelete.setAttribute("aria-busy", String(state.bulkTrashing));
  elements.deleteStack.inert = state.bulkTrashing;
  hydrateThumbnails();
}
// Collapsing lifts the strip out of flow so the pile can fade in beneath it
// while the cards slide back into the front of the pile.
let stackCloseToken = 0;
function finishStackClose(token) {
  if (token !== stackCloseToken) return;
  // The fades fill forwards, so they outlive playMotion's bookkeeping.
  for (const node of [elements.stackStrip, elements.stackStrip.querySelector(".stack-actions")]) for (const animation of node.getAnimations()) animation.cancel();
  elements.deleteStack.classList.remove("is-closing");
  elements.stackStrip.style.width = "";
  elements.stackStrip.hidden = !state.stackOpen;
}
function collapseStack() {
  const token = ++stackCloseToken;
  const strip = elements.stackStrip, scroll = elements.stackList.scrollLeft;
  const width = strip.hidden ? 0 : strip.getBoundingClientRect().width;
  renderDeleteStack();
  elements.stackPile.focus({ preventScroll: true });
  if (!width || !state.deletePicks.length || reducedMotion?.matches) { finishStackClose(token); return; }
  strip.style.width = `${width}px`; strip.hidden = false;
  elements.deleteStack.classList.add("is-closing");
  elements.stackList.scrollLeft = scroll;
  // Land each card on the front pile card (82×112 at 0,6 inside the pile).
  const pile = elements.stackPile.getBoundingClientRect();
  const items = [...elements.stackList.children];
  items.forEach((node, index) => {
    const box = node.getBoundingClientRect();
    const dx = pile.left + 41 - (box.left + box.width / 2), dy = pile.top + 62 - (box.top + box.height / 2);
    playMotion(node, [{ opacity: 1, transform: "none" }, { opacity: 1, offset: .55 }, { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(1.25)` }], { duration: 300, delay: Math.min(index, 8) * 16, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
  });
  playMotion(strip.querySelector(".stack-actions"), [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" });
  [...elements.stackPile.children].forEach((node, index) => {
    playMotion(node, [{ opacity: 0, translate: "-12px 4px" }, { opacity: 1, translate: "0 0" }], { duration: 260, delay: 140 + index * 30, fill: "backwards" });
  });
  const fade = playMotion(strip, [{ opacity: 1 }, { opacity: 1, offset: .5 }, { opacity: 0 }], { duration: 300 + Math.min(items.length - 1, 8) * 16, easing: "ease-out", fill: "forwards" });
  if (!fade) { finishStackClose(token); return; }
  fade.finished.then(() => finishStackClose(token), () => finishStackClose(token));
}
function setStackOpen(open) {
  state.stackOpen = open && state.deletePicks.length > 0;
  disarmBulkTrash(false);
  if (!state.stackOpen) { collapseStack(); return; }
  finishStackClose(++stackCloseToken);
  const anchor = elements.deleteStack.getBoundingClientRect().right;
  renderDeleteStack();
  elements.stackList.scrollLeft = 0;
  // Fan out from the pile toward the left; the nearest card lands first.
  const items = [...elements.stackList.children];
  items.forEach((node, index) => {
    const offset = anchor - node.getBoundingClientRect().right;
    playMotion(node, [{ opacity: 0, transform: `translateX(${offset}px) scale(.85)` }, { opacity: 1, transform: "translateX(0) scale(1)" }], { duration: 280, delay: (items.length - 1 - index) * 22, fill: "backwards" });
  });
  playMotion(elements.stackStrip, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
  elements.stackDelete.focus({ preventScroll: true });
}
function disarmBulkTrash(render = true) {
  clearTimeout(state.bulkArmTimer);
  state.bulkArmed = false;
  if (render) renderDeleteStack();
}
// Same two-press confirmation as the preview button.
async function trashPicks() {
  if (!state.deletePicks.length || state.bulkTrashing) return;
  if (!state.bulkArmed) {
    state.bulkArmed = true; state.bulkArmTimer = setTimeout(disarmBulkTrash, 4000);
    renderDeleteStack(); pulseControl(elements.stackDelete);
    return;
  }
  disarmBulkTrash(false);
  state.bulkTrashing = true; renderDeleteStack();
  try {
    const result = await api("/api/trash", { method: "POST", body: { assetIds: state.deletePicks.map(asset => asset.id) }, timeoutMs: REFRESH_TIMEOUT_MS });
    if (result.status !== "trashed" || !Array.isArray(result.trashed)) throw new Error("未收到删除确认，请刷新后查看");
    const removed = new Set([...result.trashed.map(item => item.assetId)]);
    state.bulkTrashing = false;
    forgetTrashed(removed, result.total);
    if (result.failed?.length) showToast(`已移到废纸篓 ${removed.size} 张，${result.failed.length} 张未能删除，请重试`, true);
    else showToast(`已移到废纸篓 ${removed.size} 张 · 可在访达中放回`);
  } catch (error) { showToast(error.message || "删除失败，请重试", true); }
  finally {
    state.bulkTrashing = false;
    if (state.deleteMode && !state.deletePicks.length) setDeleteMode(false); else renderDeleteStack();
  }
}
async function openPreview(asset, direction = 0) {
  const wasOpen = elements.previewDialog.open;
  state.previewCloseToken += 1; state.previewClosing = false;
  elements.previewDialog.classList.remove("is-closing");
  nodeMotions.get(elements.previewDialog)?.cancel();
  nodeMotions.get(elements.previewImage)?.cancel();
  if (state.trashArmedId !== asset.id) { clearTimeout(state.trashArmTimer); state.trashArmedId = null; }
  state.previewAsset = asset;
  const generation = ++state.previewGeneration;
  state.previewController?.abort();
  state.previewController = new AbortController();
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  elements.previewImage.hidden = true; elements.previewImage.removeAttribute("src");
  resetZoom();
  elements.previewImage.alt = displayTitle(asset) || asset.boardTitle;
  document.querySelector("#previewFeedback").textContent = "";
  elements.previewTitle.textContent = displayTitle(asset) || `${asset.boardTitle} · 未命名 Pin`;
  elements.previewMeta.textContent = `${asset.boardTitle} · ${asset.extension.slice(1).toUpperCase()} · ${formatBytes(asset.size)}`;
  elements.previewMessage.textContent = "正在读取原图…"; elements.previewMessage.hidden = false;
  updatePreviewControls(); updateCopyState(asset.id);
  if (!wasOpen) {
    elements.previewDialog.showModal();
    playMotion(elements.previewDialog, [{ opacity: 0, transform: "translateY(12px) scale(.98)" }, { opacity: 1, transform: "translateY(0) scale(1)" }], { duration: 220 });
  }
  try {
    const blob = await api(`/api/previews/${asset.id}`, { expectBlob: true, timeoutMs: 30_000, signal: state.previewController.signal });
    if (generation !== state.previewGeneration || !elements.previewDialog.open) return;
    const url = URL.createObjectURL(blob); state.previewUrl = url;
    elements.previewImage.onload = () => {
      if (generation !== state.previewGeneration) return;
      elements.previewImage.hidden = false; elements.previewMessage.hidden = true;
      playMotion(elements.previewImage, [{ opacity: 0, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: "translateX(0)" }], { duration: 180 });
    };
    elements.previewImage.onerror = () => {
      if (generation !== state.previewGeneration) return;
      elements.previewImage.hidden = true; elements.previewMessage.textContent = "浏览器无法显示这张原图，你仍可加入参考或复制路径。";
    };
    elements.previewImage.src = url;
  } catch (error) { if (generation === state.previewGeneration) elements.previewMessage.textContent = error.message || "原图暂时不可读"; }
}
async function navigatePreview(offset) {
  const index = state.assets.findIndex(asset => asset.id === state.previewAsset?.id);
  if (index < 0) return;
  // Reaching the end of what is loaded fetches the next page instead of stopping.
  if (!state.assets[index + offset] && offset > 0 && state.nextCursor && !state.pageLoading) await loadPage();
  const next = state.assets[index + offset];
  if (next && elements.previewDialog.open) void openPreview(next, offset);
}
// Double-click (or the Z key) zooms the original to its natural size around the
// pointer; drag to pan while zoomed. Navigating or closing resets the view.
const zoom = { active: false, x: 0, y: 0, scale: 1, drag: null };
function applyZoom(animate = true) {
  const image = elements.previewImage;
  elements.previewStage.classList.toggle("is-zoomed", zoom.active);
  image.style.transition = animate ? "transform 320ms cubic-bezier(.22,1,.36,1)" : "none";
  image.style.transform = zoom.active ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` : "";
}
function resetZoom() { zoom.active = false; zoom.x = zoom.y = 0; zoom.scale = 1; zoom.drag = null; applyZoom(false); }
function clampZoom() {
  const stage = elements.previewStage.getBoundingClientRect(), image = elements.previewImage;
  const width = image.offsetWidth * zoom.scale, height = image.offsetHeight * zoom.scale;
  const maxX = Math.max(0, (width - stage.width) / 2), maxY = Math.max(0, (height - stage.height) / 2);
  zoom.x = Math.min(maxX, Math.max(-maxX, zoom.x)); zoom.y = Math.min(maxY, Math.max(-maxY, zoom.y));
}
function toggleZoom(clientX, clientY) {
  const image = elements.previewImage;
  if (image.hidden || !image.naturalWidth) return;
  if (zoom.active) { resetZoom(); applyZoom(true); return; }
  const fitScale = image.offsetWidth / image.naturalWidth;
  zoom.scale = Math.max(2, 1 / fitScale);
  const box = image.getBoundingClientRect();
  const px = (clientX ?? box.left + box.width / 2) - (box.left + box.width / 2);
  const py = (clientY ?? box.top + box.height / 2) - (box.top + box.height / 2);
  zoom.x = -px * (zoom.scale - 1); zoom.y = -py * (zoom.scale - 1);
  zoom.active = true; clampZoom(); applyZoom(true);
}
elements.previewImage.addEventListener("dblclick", event => toggleZoom(event.clientX, event.clientY));
elements.previewImage.addEventListener("pointerdown", event => {
  if (!zoom.active || event.button !== 0) return;
  event.preventDefault();
  zoom.drag = { x: event.clientX - zoom.x, y: event.clientY - zoom.y };
  elements.previewImage.setPointerCapture?.(event.pointerId);
  elements.previewStage.classList.add("is-panning");
});
elements.previewImage.addEventListener("pointermove", event => {
  if (!zoom.drag) return;
  zoom.x = event.clientX - zoom.drag.x; zoom.y = event.clientY - zoom.drag.y;
  clampZoom(); applyZoom(false);
});
for (const type of ["pointerup", "pointercancel"]) elements.previewImage.addEventListener(type, () => {
  zoom.drag = null; elements.previewStage.classList.remove("is-panning");
});
async function dismissPreview() {
  if (!elements.previewDialog.open || state.previewClosing) return;
  state.previewClosing = true;
  const closeToken = ++state.previewCloseToken;
  state.previewGeneration += 1; state.previewController?.abort();
  elements.previewDialog.classList.add("is-closing");
  const animation = playMotion(elements.previewDialog, [{ opacity: 1, transform: "translateY(0) scale(1)" }, { opacity: 0, transform: "translateY(8px) scale(.98)" }], { duration: 130, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
  if (animation) await animation.finished.catch(() => {});
  if (closeToken !== state.previewCloseToken) return;
  elements.previewDialog.close();
  animation?.cancel();
}
function clearSearch() {
  clearTimeout(state.searchTimer); state.query = ""; elements.searchInput.value = "";
  void loadPage({ reset: true }); elements.searchInput.focus();
}
function schedulePoll(delay = state.pollDelay) {
  clearTimeout(state.pollTimer); state.pollTimer = setTimeout(() => void pollStatus(), delay);
}
async function pollStatus() {
  if (state.polling) return;
  if (document.hidden) { schedulePoll(3000); return; }
  state.polling = true;
  const knownVersion = state.version;
  try {
    const suffix = Number.isInteger(knownVersion) ? `?knownVersion=${knownVersion}` : "";
    const result = await api(`/api/status${suffix}`);
    mergeSummary(result, false); state.offline = false; state.pollDelay = 2000; updateChrome();
    if ((!result.unchanged || state.pageError) && !state.pageLoading) await loadPage({ reset: true });
    if (referenceSessionId) await loadSelection();
  } catch { state.offline = true; state.pollDelay = Math.min(10_000, Math.max(2000, state.pollDelay * 2)); updateChrome(); }
  finally { state.polling = false; schedulePoll(); }
}
elements.refreshButton.addEventListener("click", () => void refreshNow());
elements.loadMoreButton.addEventListener("click", () => void loadPage());
for (const [tab, node] of [["pins", elements.pinsTab], ["boards", elements.boardsTab]]) node.addEventListener("click", () => {
  clearTimeout(state.searchTimer); state.tab = tab; state.boardId = null; state.boardTitle = null;
  state.query = ""; elements.searchInput.value = ""; void loadPage({ reset: true });
});
elements.searchInput.addEventListener("input", () => {
  clearTimeout(state.searchTimer); state.query = elements.searchInput.value;
  state.pageGeneration += 1; state.searchTimer = setTimeout(() => void loadPage({ reset: true }), 250); updateChrome();
});
elements.searchInput.addEventListener("keydown", event => { if (event.key === "Escape") clearSearch(); });
elements.clearSearch.addEventListener("click", clearSearch);
elements.sortSelect.addEventListener("change", () => { state.sort = elements.sortSelect.value; void loadPage({ reset: true }); });
// Custom sort menu (a native <select> popup cannot be animated). The hidden
// select stays the source of truth; the menu opens on a spring from its button.
const sortMenu = (() => {
  const root = document.querySelector("#sortMenu"), trigger = document.querySelector("#sortButton");
  const list = document.querySelector("#sortOptions"), label = document.querySelector("#sortLabel");
  let open = false, closing = null;
  const options = () => [...(elements.sortSelect?.options ?? [])];
  function sync() {
    const current = options().find(option => option.value === elements.sortSelect.value);
    if (label && current) label.textContent = current.textContent;
    if (trigger) {
      trigger.disabled = Boolean(elements.sortSelect.disabled);
      trigger.setAttribute("aria-label", `素材排序：${current?.textContent ?? ""}`);
    }
    if (trigger?.disabled && open) close(false);
  }
  function render() {
    list.replaceChildren(...options().map(option => {
      const item = element("li", "sort-option", option.textContent);
      item.setAttribute("role", "option");
      item.dataset.value = option.value;
      item.tabIndex = -1;
      item.setAttribute("aria-selected", String(option.value === elements.sortSelect.value));
      item.addEventListener("click", () => choose(option.value));
      return item;
    }));
  }
  function show() {
    if (!list || trigger.disabled) return;
    closing?.cancel(); closing = null;
    render();
    list.hidden = false; open = true;
    root.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    playMotion(list, [{ opacity: 0, transform: "translateY(-6px) scale(.92)", filter: "blur(2px)" }, { opacity: 1, transform: "none", filter: "none" }], { duration: SPRING.duration, easing: SPRING.easing });
    [...list.children].forEach((item, index) => playMotion(item, [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 240, delay: 40 + index * 30, fill: "backwards" }));
    (list.querySelector('[aria-selected="true"]') ?? list.firstElementChild)?.focus({ preventScroll: true });
  }
  function close(returnFocus = true) {
    if (!open) return;
    open = false;
    root.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) trigger.focus({ preventScroll: true });
    const animation = playMotion(list, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px) scale(.96)" }], { duration: 140, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    if (!animation) { list.hidden = true; return; }
    closing = animation;
    animation.finished.then(() => { if (!open) { list.hidden = true; animation.cancel(); } }, () => {});
  }
  function choose(value) {
    const changed = value !== elements.sortSelect.value;
    elements.sortSelect.value = value;
    sync(); close();
    if (changed) { pulseControl(trigger); elements.sortSelect.dispatchEvent(new Event("change")); }
  }
  trigger?.addEventListener("click", () => (open ? close() : show()));
  trigger?.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); }
  });
  list?.addEventListener("keydown", event => {
    const items = [...list.children], index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (items[index]) choose(items[index].dataset.value);
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
      close(event.key === "Escape");
    }
  });
  // A click outside only dismisses the menu; it must not also pick a pin.
  let swallowClick = false;
  document.addEventListener("pointerdown", event => {
    if (!open || root.contains(event.target)) return;
    close(false); swallowClick = true;
  }, true);
  document.addEventListener("click", event => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault(); event.stopPropagation();
  }, true);
  document.addEventListener("pointerup", () => setTimeout(() => { swallowClick = false; }, 0), true);
  return { sync, close, get open() { return open; } };
})();
// Clearing (button or Esc) can be undone with ⌘Z / Ctrl+Z for a few seconds.
let clearedSelection = null;
function clearReferences() {
  const ids = state.selection?.entries.map(entry => entry.id) ?? [];
  if (!ids.length || !canSelectReferences()) return;
  clearTimeout(clearedSelection?.timer);
  clearedSelection = { ids, timer: setTimeout(() => { clearedSelection = null; }, 8000) };
  mutateSelection(() => []);
  showToast(`已清空参考篮 · ${COPY_KEY.replace("C", "Z")} 撤销`);
}
function undoClearReferences() {
  if (!clearedSelection || state.selection?.entries.length) return false;
  const { ids, timer } = clearedSelection;
  clearTimeout(timer); clearedSelection = null;
  mutateSelection(() => ids);
  showToast(`已恢复 ${ids.length} 张参考图`);
  return true;
}
elements.clearSelection.addEventListener("click", clearReferences);
document.addEventListener("keydown", event => {
  if (event.target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
  if (event.key === "Escape" && !event.repeat && !state.deleteMode && !elements.previewDialog.open && !sortMenu.open && !document.querySelector(".help-menu[open]")) {
    if (state.selection?.entries.length) { event.preventDefault(); clearReferences(); }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && String(event.key).toLowerCase() === "z" && undoClearReferences()) event.preventDefault();
});
elements.closePreview.addEventListener("click", () => void dismissPreview());
elements.previewDialog.addEventListener("cancel", event => { event.preventDefault(); void dismissPreview(); });
elements.previousPreview.addEventListener("click", () => void navigatePreview(-1));
elements.nextPreview.addEventListener("click", () => void navigatePreview(1));
// ⌘C copies what you are looking at: the open preview, else the reference basket,
// else the pin under the pointer. Text selections and form fields keep native copy.
let hoveredAssetId = null;
elements.content.addEventListener("pointerover", event => { hoveredAssetId = event.target?.closest?.(".pin-card")?.dataset.assetId ?? null; });
elements.content.addEventListener("pointerleave", () => { hoveredAssetId = null; });
document.addEventListener("keydown", event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || String(event.key).toLowerCase() !== "c" || event.repeat) return;
  if (event.target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
  if (String(window.getSelection?.() ?? "").trim()) return;
  event.preventDefault();
  if (elements.previewDialog.open && state.previewAsset) { void copyAsset(state.previewAsset); return; }
  if (state.selection?.entries.length) { void copySelection(); return; }
  const hovered = state.assets.find(asset => asset.id === hoveredAssetId);
  if (hovered) { void copyAsset(hovered); return; }
  showToast(`点击图片加入参考篮，或把鼠标移到图片上，再按 ${COPY_KEY} 复制路径`);
});
elements.previewSelect.addEventListener("click", () => { if (state.previewAsset) toggleReference(state.previewAsset); });
elements.previewDelete.addEventListener("click", () => void trashPreviewAsset());
elements.deleteModeButton.addEventListener("click", () => setDeleteMode(true));
elements.exitDeleteMode.addEventListener("click", () => setDeleteMode(false));
elements.stackPile.addEventListener("click", () => setStackOpen(true));
elements.stackCollapse.addEventListener("click", () => setStackOpen(false));
elements.stackDelete.addEventListener("click", () => void trashPicks());
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !state.deleteMode || elements.previewDialog.open || event.target === elements.searchInput) return;
  if (state.stackOpen) setStackOpen(false); else setDeleteMode(false);
});
elements.previewDialog.addEventListener("keydown", event => {
  if (event.key === "ArrowLeft") { event.preventDefault(); void navigatePreview(-1); }
  if (event.key === "ArrowRight") { event.preventDefault(); void navigatePreview(1); }
  // Space adds/removes the previewed image as a reference; Z toggles zoom.
  if (event.key === " " && !event.repeat) { event.preventDefault(); if (state.previewAsset && !elements.previewSelect.disabled) toggleReference(state.previewAsset); }
  if ((event.key === "z" || event.key === "Z") && !event.metaKey && !event.ctrlKey && !event.repeat) { event.preventDefault(); toggleZoom(); }
  if ((event.key === "Delete" || event.key === "Backspace") && !event.repeat) { event.preventDefault(); void trashPreviewAsset(); }
});
elements.previewDialog.addEventListener("close", () => {
  state.previewClosing = false;
  elements.previewDialog.classList.remove("is-closing");
  state.previewGeneration += 1; state.previewAsset = null;
  clearTimeout(state.trashArmTimer); state.trashArmedId = null;
  state.previewController?.abort(); state.previewController = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null; elements.previewImage.removeAttribute("src");
  resetZoom();
});
// Scrolling down tucks the title and tabs away and keeps the search field pinned;
// any upward scroll brings them back. Never hides near the top or while typing.
const chrome = document.querySelector(".panel-chrome");
let lastScrollY = 0;
function measureChrome() {
  if (!chrome?.getBoundingClientRect) return;
  const collapse = Math.max(0, (elements.browseTools?.offsetTop ?? 0) - 10);
  document.documentElement.style.setProperty("--chrome-collapse", `${collapse}px`);
}
function updateChromeVisibility() {
  const y = window.scrollY ?? 0, delta = y - lastScrollY;
  const busy = document.activeElement === elements.searchInput || document.querySelector(".help-menu[open]");
  if (y < 120 || busy || delta < -6) document.body.classList.remove("chrome-tucked");
  else if (delta > 6) document.body.classList.add("chrome-tucked");
  document.body.classList.toggle("is-scrolled", y > 4);
  if (Math.abs(delta) > 6 || y < 120) lastScrollY = y;
}
window.addEventListener("scroll", updateChromeVisibility, { passive: true });
elements.searchInput.addEventListener("focus", () => document.body.classList.remove("chrome-tucked"));
if (typeof ResizeObserver !== "undefined" && chrome) new ResizeObserver(measureChrome).observe(chrome);
// The dock's height feeds the page's bottom padding and the toast offset. Apply it once
// the dock settles, and only to those two elements: a custom property on :root
// restyled every card on every animation frame.
const appShell = document.querySelector(".app-shell");
let appliedTrayHeight = null, trayHeightPending = false;
function applyTrayHeight() {
  const tray = elements.referenceTray;
  const running = tray.getAnimations?.().filter(animation => animation.playState === "running") ?? [];
  if (running.length) {
    if (trayHeightPending) return;
    trayHeightPending = true;
    Promise.all(running.map(animation => animation.finished.catch(() => {}))).then(() => { trayHeightPending = false; applyTrayHeight(); });
    return;
  }
  const height = Math.round(tray.getBoundingClientRect().height);
  if (height === appliedTrayHeight) return;
  appliedTrayHeight = height;
  if (appShell?.style) appShell.style.paddingBottom = `${height + 22}px`;
  if (elements.toast?.style) elements.toast.style.bottom = `${height + 30}px`;
}
if (typeof ResizeObserver !== "undefined") new ResizeObserver(applyTrayHeight).observe(elements.referenceTray);
document.addEventListener("visibilitychange", () => { if (!document.hidden) schedulePoll(0); });
window.addEventListener("beforeunload", () => {
  thumbnailObserver?.disconnect();
  for (const url of state.thumbnailUrls.values()) URL.revokeObjectURL(url);
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
});
shortcutLabel(elements.copySelection, "复制路径");
shortcutLabel(elements.previewCopy, "复制路径");
if (!token) {
  state.initialLoading = false; state.offline = true;
  elements.content.replaceChildren(emptyState("本地面板会话无效", "请从 Pinterest BoardFlow 插件重新打开。"));
  updateChrome();
} else {
  renderSelection();
  void Promise.all([loadPage({ reset: true }), loadSelection()]).finally(() => schedulePoll());
}
