import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("../assets/local-panel.js", import.meta.url), "utf8");

// Only the DOM surface used at startup; browser checks cover the rendered cards.
function node() {
  return {
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {}, querySelectorAll() { return []; }
  };
}

function createHarness(fetch) {
  const nodes = new Map();
  const timers = new Map();
  let timerId = 0;
  const context = {
    fetch, AbortController, Headers, URL, URLSearchParams, Error,
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    document: {
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, node());
        return nodes.get(selector);
      },
      createElement: node,
      addEventListener() {}
    },
    window: { addEventListener() {} }
  };
  // Keep request, paging, refresh, and toast behavior intact; isolate layout work.
  runInNewContext(`${source}\nrenderContent = () => {}; updateChrome = () => {}; renderSelection = () => {}; updateSelectionStatus = () => {};
    globalThis.panel = { api, loadPage, refreshNow, mutateSelection, copyAsset, copySelection, state };`, context);
  return { ...context.panel, nodes, timers };
}

for (const expectBlob of [false, true]) {
  test(`request timeout remains active until the ${expectBlob ? "image" : "JSON"} body finishes`, async () => {
    let finishBody;
    const harness = createHarness(async (_path, { signal }) => {
      const body = new Promise((resolve, reject) => {
        finishBody = resolve;
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
      return { ok: true, json: () => body, blob: () => body };
    });
    const pending = harness.api("/api/test", { expectBlob, timeoutMs: 25 });
    // Observe rejection before manually advancing the request timer.
    const outcome = pending.then((value) => ({ value }), (error) => ({ error }));
    try {
      await setImmediate();
      const timeout = [...harness.timers.values()].find((timer) => timer.delay === 25);
      assert.ok(timeout, "receiving headers must not clear the body deadline");
      timeout.callback();
      assert.equal((await outcome).error?.message, "本地服务响应超时");
      assert.equal(harness.timers.size, 0);
    } finally {
      finishBody({});
      await outcome;
    }
  });
}

test("a completed response releases its request timeout", async () => {
  const harness = createHarness(async () => ({ ok: true, json: async () => ({ ready: true }) }));
  assert.deepEqual(await harness.api("/api/test"), { ready: true });
  assert.equal(harness.timers.size, 0);
});

const emptyPage = {
  version: 1, assets: [], boards: [], total: 0, libraryTotal: 0,
  nextCursor: null, watcherStatus: "watching"
};

test("failed repeat copy clears the previous success marker", async () => {
  let fail = false;
  const harness = createHarness(async () => ({ ok: !fail, status: fail ? 503 : 200,
    json: async () => fail ? { error: "未能确认路径已写入剪贴板，请重新复制" } : { status: "copied", assetId: "a" }
  }));
  await harness.copyAsset({ id: "a" });
  assert.equal(harness.state.copiedAssetId, "a");
  fail = true;
  await harness.copyAsset({ id: "a" });
  assert.equal(harness.state.copiedAssetId, null);
  assert.equal(harness.state.pendingCopies.size, 0);
  assert.match(harness.nodes.get("#toast").textContent, /未能确认/);
});

test("HTTP 200 without the matching copy confirmation cannot announce success", async () => {
  for (const result of [{}, { status: "copied", assetId: "b" }]) {
    const harness = createHarness(async () => ({ ok: true, json: async () => result }));
    await harness.copyAsset({ id: "a" });
    assert.equal(harness.state.copiedAssetId, null);
    assert.match(harness.nodes.get("#toast").textContent, /未收到复制确认/);
  }
});

for (const first of ["asset", "selection"]) {
  test(`pending ${first} copy prevents overlapping writes from other copy buttons`, async () => {
    const requests = [];
    let finish;
    const harness = createHarness(async path => {
      requests.push(path);
      return { ok: true, json: () => new Promise(resolve => { finish = resolve; }) };
    });
    harness.state.selection = { revision: 1, entries: [{ id: "a" }, { id: "b" }] };
    harness.state.copiedAssetId = "old";
    const pending = first === "asset" ? harness.copyAsset({ id: "a" }) : harness.copySelection();
    await setImmediate();
    assert.equal(harness.state.copiedAssetId, null);
    await harness.copyAsset({ id: "b" });
    await harness.copySelection();
    assert.equal(requests.length, 1);
    finish(first === "asset" ? { status: "copied", assetId: "a" } : { status: "copied", count: 2 });
    await pending;
    assert.equal(harness.state.pendingCopies.size, 0);
    assert.equal(harness.state.copyingSelection, false);
    assert.match(harness.nodes.get("#toast").textContent, /已复制/);
  });
}

test("batch copy requires confirmation of the complete path count", async () => {
  const harness = createHarness(async () => ({ ok: true, json: async () => ({ status: "copied", count: 1 }) }));
  harness.state.selection = { revision: 1, entries: [{ id: "a" }, { id: "b" }] };
  await harness.copySelection();
  assert.match(harness.nodes.get("#toast").textContent, /未收到完整复制确认/);
  assert.equal(harness.state.copyingSelection, false);
});

test("refresh preserves the page-read error instead of announcing success", async () => {
  const harness = createHarness(async (path) => {
    if (path === "/api/refresh") return { ok: true, json: async () => ({ version: 1 }) };
    return { ok: false, status: 503, json: async () => ({ error: "素材暂时不可读" }) };
  });
  await harness.refreshNow();
  assert.equal(harness.nodes.get("#toast").textContent, "素材暂时不可读");
  assert.equal(harness.state.offline, true);
  assert.equal(harness.state.refreshing, false);
  assert.equal(harness.state.pageLoading, false);
});

test("refresh announces success after the new page is available", async () => {
  const harness = createHarness(async (path) => ({
    ok: true,
    json: async () => path === "/api/refresh" ? { version: 1 } : { page: emptyPage }
  }));
  await harness.refreshNow();
  assert.equal(harness.nodes.get("#toast").textContent, "Pinterest BoardFlow 已刷新");
  assert.equal(harness.state.offline, false);
  assert.equal(harness.state.refreshing, false);
});

test("a superseded refresh page cannot announce success over the current view", async () => {
  let finishPage;
  const harness = createHarness(async (path) => ({
    ok: true,
    json: () => path === "/api/refresh"
      ? Promise.resolve({ version: 1 })
      : new Promise((resolve) => { finishPage = resolve; })
  }));
  const refresh = harness.refreshNow();
  await setImmediate();
  harness.state.pageGeneration += 1;
  harness.state.tab = "boards";
  finishPage({ page: emptyPage });
  await refresh;
  assert.notEqual(harness.nodes.get("#toast").textContent, "Pinterest BoardFlow 已刷新");
  assert.equal(harness.state.version, null);
  assert.equal(harness.state.refreshing, false);
});

test("rapid selections serialize against the latest confirmed revision without losing clicks", async () => {
  const requests = [];
  const harness = createHarness(async (_path, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    await setImmediate();
    return { ok: true, json: async () => ({ revision: body.revision + 1, entries: body.assetIds.map(id => ({ id })) }) };
  });
  harness.state.selection = { revision: 0, entries: [] };
  harness.mutateSelection(ids => [...ids, "a"]);
  harness.mutateSelection(ids => [...ids, "b"]);
  harness.mutateSelection(ids => ids.filter(id => id !== "a"));
  await harness.state.selectionChain;
  assert.deepEqual(requests, [{ assetIds: ["a"], revision: 0 }, { assetIds: ["a", "b"], revision: 1 }, { assetIds: ["b"], revision: 2 }]);
  assert.equal(harness.state.selectionPending, 0);
  assert.equal(harness.state.selection.revision, 3);
});

test("a reference conflict cancels queued edits instead of applying stale intent", async () => {
  let calls = 0;
  const harness = createHarness(async () => {
    calls++;
    return { ok: false, status: 409, json: async () => ({ error: "参考篮已在其他页面更新" }) };
  });
  harness.state.selection = { revision: 0, entries: [] };
  harness.mutateSelection(ids => [...ids, "a"]);
  harness.mutateSelection(ids => [...ids, "b"]);
  await harness.state.selectionChain;
  assert.equal(calls, 1);
  assert.equal(harness.state.selection.revision, 0);
  assert.equal(harness.state.selectionPending, 0);
});

test("slow search results cannot replace a newer query result", async () => {
  let finishSlow;
  const harness = createHarness(async path => ({ ok: true, json: () => path.includes("q=slow")
    ? new Promise(resolve => { finishSlow = resolve; })
    : Promise.resolve({ page: { ...emptyPage, assets: [{ id: "new" }], total: 1 } }) }));
  harness.state.query = "slow";
  const slow = harness.loadPage({ reset: true });
  await setImmediate();
  harness.state.query = "new";
  await harness.loadPage({ reset: true });
  finishSlow({ page: { ...emptyPage, assets: [{ id: "old" }], total: 1 } });
  await slow;
  assert.equal(harness.state.assets[0].id, "new");
  assert.equal(harness.state.pageLoading, false);
});

test("an expired browser token is renewed once and reads reconnect without reloading the page", async () => {
  const renewed = "r".repeat(32);
  const calls = [];
  const harness = createHarness(async (path, options) => {
    calls.push({ path, options });
    if (path.startsWith("/?ref=")) return { ok: true, text: async () => `<meta name="pinterest-panel-token" content="${renewed}">` };
    if (options.headers.get("X-Pinterest-Panel-Token") !== renewed) {
      return { ok: false, status: 401, json: async () => ({ error: "expired" }) };
    }
    return { ok: true, json: async () => ({ recovered: true }) };
  });
  harness.state.version = 42;
  const results = await Promise.all([harness.api("/api/status"), harness.api("/api/references")]);
  assert.equal(results.every(result => result.recovered), true);
  assert.equal(calls.filter(call => call.path.startsWith("/?ref=")).length, 1);
  assert.equal(harness.state.version, null, "service recovery invalidates the old index version");
  assert.equal(harness.timers.size, 0);
});

test("authentication recovery does not replay mutations and failed recovery can be retried later", async () => {
  let recoveryAttempts = 0;
  let writes = 0;
  const harness = createHarness(async (path) => {
    if (path.startsWith("/?ref=")) {
      recoveryAttempts++;
      if (recoveryAttempts === 1) throw new Error("offline");
      return { ok: true, text: async () => `<meta name="pinterest-panel-token" content="${"s".repeat(32)}">` };
    }
    writes++;
    return { ok: false, status: 403, json: async () => ({ error: "expired" }) };
  });
  await assert.rejects(harness.api("/api/clipboard", { method: "POST", body: { assetId: "a" } }), /offline/);
  await assert.rejects(harness.api("/api/clipboard", { method: "POST", body: { assetId: "a" } }), /expired/);
  assert.equal(writes, 2, "each explicit call writes at most once");
  assert.equal(recoveryAttempts, 2);
  assert.equal(harness.timers.size, 0);
});
