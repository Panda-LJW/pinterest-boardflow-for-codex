import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PanelDaemonClient } from "../dist/server.bundle.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = new URL("../", import.meta.url);

async function cleanupDaemon(root, inboxRoot) {
  const previous = { ...process.env };
  try {
    process.env.PINTEREST_INBOX_DIR = inboxRoot;
    process.env.PINTEREST_PANEL_STATE_DIR = join(root, "state");
    const daemon = new PanelDaemonClient();
    if ((await daemon.status()).pid) {
      await daemon.call("shutdown");
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!(await daemon.status()).pid) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  } finally {
    for (const key of ["PINTEREST_INBOX_DIR", "PINTEREST_PANEL_STATE_DIR"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}

async function openWebSession(url) {
  const response = await fetch(url);
  const html = await response.text();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const token = html.match(/name="pinterest-panel-token" content="([^"]+)"/)?.[1];
  assert.ok(cookie);
  assert.ok(token);
  return { cookie, token };
}

function holdRefreshRequest(url, session) {
  const target = new URL("/api/refresh", url);
  const request = httpRequest(target, {
    method: "POST",
    headers: {
      Cookie: session.cookie,
      "X-Pinterest-Panel-Token": session.token,
      Origin: target.origin,
      "Content-Type": "application/json",
      "Content-Length": "2",
      Expect: "100-continue"
    }
  });
  const accepted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => request.destroy(new Error("timed out waiting for 100 Continue")), 2_000);
    timer.unref();
    request.once("continue", () => {
      clearTimeout(timer);
      resolve();
    });
    request.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  request.on("error", () => {});
  request.flushHeaders();
  return { request, accepted };
}

test("stdio MCP lists Inbox content and safely imports one indexed image", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pinterest-mcp-test-"));
  const inboxRoot = join(root, "PinterestInbox");
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(inboxRoot, "editorial"), { recursive: true });
  await mkdir(workspaceRoot);
  await writeFile(join(inboxRoot, "editorial", "456__signal-poster.jpg"), "image-fixture");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.bundle.js"],
    cwd: pluginRoot,
    env: { ...process.env, PINTEREST_INBOX_DIR: inboxRoot, PINTEREST_PANEL_STATE_DIR: join(root, "state") },
    stderr: "pipe"
  });
  const client = new Client({ name: "inbox-test", version: "0.2.0" });
  context.after(async () => {
    await client.close();
    await cleanupDaemon(root, inboxRoot);
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "get_pinterest_inbox_web_status",
    "get_pinterest_reference_selection",
    "import_pinterest_reference",
    "list_pinterest_inbox",
    "open_pinterest_inbox_web",
    "render_pinterest_reference_panel",
    "stop_pinterest_inbox_web"
  ]);
  assert.equal(tools.tools.find((tool) => tool.name === "list_pinterest_inbox")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "import_pinterest_reference")?.annotations?.readOnlyHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "open_pinterest_inbox_web")?.annotations?.readOnlyHint, false);
  assert.equal(tools.tools.find((tool) => tool.name === "get_pinterest_inbox_web_status")?.annotations?.readOnlyHint, true);

  const rendered = await client.callTool({
    name: "render_pinterest_reference_panel",
    arguments: { workspaceRoot }
  });
  assert.equal(rendered.structuredContent.mode, "inbox");
  assert.equal(rendered.structuredContent.total, 1);
  assert.equal(rendered.structuredContent.workspace.available, true);
  assert.equal(rendered.structuredContent.workspace.token, undefined);
  assert.equal(rendered._meta.pinterestInbox.inboxPath, inboxRoot);
  assert.equal(rendered._meta.pinterestInbox.stagingPath, inboxRoot);
  assert.match(rendered._meta.pinterestInbox.workspaceToken, /^[a-zA-Z0-9_-]+$/);

  const opened = await client.callTool({ name: "open_pinterest_inbox_web", arguments: {} });
  assert.equal(opened.structuredContent.status, "running");
  assert.match(opened.structuredContent.url, /^http:\/\/127\.0\.0\.1:\d+\/\?ref=[a-f0-9]{32}$/);

  const webStatus = await client.callTool({ name: "get_pinterest_inbox_web_status", arguments: {} });
  assert.equal(webStatus.structuredContent.status, "running");
  assert.equal(webStatus.structuredContent.url, new URL("/", opened.structuredContent.url).href);

  const referenceSessionId = opened.structuredContent.referenceSessionId;
  const browser = await openWebSession(opened.structuredContent.url);
  const other = await client.callTool({ name: "open_pinterest_inbox_web", arguments: {} });
  assert.notEqual(other.structuredContent.referenceSessionId, referenceSessionId);
  const assetId = rendered.structuredContent.assets[0].id;
  const selected = await fetch(new URL("/api/references", opened.structuredContent.url), {
    method: "POST",
    headers: { Cookie: browser.cookie, "X-Pinterest-Panel-Token": browser.token,
      "X-Pinterest-Reference-Session": referenceSessionId,
      Origin: new URL(opened.structuredContent.url).origin, "Content-Type": "application/json" },
    body: JSON.stringify({ assetIds: [assetId], revision: 0 })
  });
  assert.equal(selected.status, 200);
  const read = await client.callTool({ name: "get_pinterest_reference_selection", arguments: { referenceSessionId, expectedRevision: 1 } });
  assert.equal(read.isError, undefined);
  assert.equal(read.structuredContent.files[0].assetId, assetId);
  assert.match(read.structuredContent.files[0].path, /editorial\/456__signal-poster\.jpg$/);
  const unversioned = await client.callTool({ name: "get_pinterest_reference_selection", arguments: { referenceSessionId } });
  assert.equal(unversioned.structuredContent.files[0].assetId, assetId);
  const empty = await client.callTool({ name: "get_pinterest_reference_selection", arguments: { referenceSessionId: other.structuredContent.referenceSessionId } });
  assert.equal(empty.isError, true);
  const stale = await client.callTool({ name: "get_pinterest_reference_selection", arguments: { referenceSessionId, expectedRevision: 0 } });
  assert.equal(stale.isError, true);
  const reopened = await client.callTool({ name: "open_pinterest_inbox_web", arguments: { referenceSessionId } });
  assert.equal(reopened.structuredContent.url, opened.structuredContent.url);

  const stopped = await client.callTool({ name: "stop_pinterest_inbox_web", arguments: {} });
  assert.equal(stopped.structuredContent.status, "stopped");
  assert.equal(stopped.structuredContent.wasRunning, true);
  const stoppedStatus = await client.callTool({ name: "get_pinterest_inbox_web_status", arguments: {} });
  assert.equal(stoppedStatus.structuredContent.status, "stopped");
  assert.equal(stoppedStatus.structuredContent.url, undefined);
  const afterClose = await client.callTool({ name: "get_pinterest_reference_selection", arguments: { referenceSessionId } });
  assert.equal(afterClose.structuredContent.revision, 1, "HTTP close keeps durable reference sessions");

  const imported = await client.callTool({
    name: "import_pinterest_reference",
    arguments: {
      assetId: rendered.structuredContent.assets[0].id,
      workspaceToken: rendered._meta.pinterestInbox.workspaceToken
    }
  });
  assert.equal(imported.structuredContent.status, "imported");
  assert.equal(imported.structuredContent.relativePath, "references/pinterest/editorial/456__signal-poster.jpg");

  const resource = await client.readResource({ uri: "ui://pinterest-reference-panel/panel.html" });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.contents[0].text, /Pinterest BoardFlow/);
});

test("stdio EOF exits promptly while the independent local panel remains reachable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinterest-mcp-eof-test-"));
  const inboxRoot = join(root, "PinterestInbox");
  await mkdir(inboxRoot, { recursive: true });
  await writeFile(join(inboxRoot, "one__asset.jpg"), "image-fixture");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.bundle.js"],
    cwd: pluginRoot,
    env: { ...process.env, PINTEREST_INBOX_DIR: inboxRoot, PINTEREST_PANEL_STATE_DIR: join(root, "state") },
    stderr: "pipe"
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const client = new Client({ name: "inbox-eof-test", version: "0.4.0" });

  try {
    await client.connect(transport);
    const opened = await client.callTool({ name: "open_pinterest_inbox_web", arguments: {} });
    assert.equal(opened.structuredContent.status, "running");
    const child = transport._process;
    assert.ok(child, "stdio child process should be available after connect");
    const startedAt = Date.now();
    await client.close();
    assert.ok(Date.now() - startedAt < 1_800, "EOF cleanup should finish before the client termination fallback");
    assert.equal(child.exitCode, 0, Buffer.concat(stderr).toString("utf8"));
    assert.equal((await fetch(opened.structuredContent.url)).status, 200);
  } finally {
    await client.close();
    await cleanupDaemon(root, inboxRoot);
    await rm(root, { recursive: true, force: true });
  }
});

test("open waits for an in-flight stop and never overlaps local panel instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinterest-mcp-lifecycle-test-"));
  const inboxRoot = join(root, "PinterestInbox");
  await mkdir(inboxRoot, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.bundle.js"],
    cwd: pluginRoot,
    env: { ...process.env, PINTEREST_INBOX_DIR: inboxRoot, PINTEREST_PANEL_STATE_DIR: join(root, "state") },
    stderr: "pipe"
  });
  const client = new Client({ name: "inbox-lifecycle-test", version: "0.4.0" });
  let heldRequest;

  try {
    await client.connect(transport);
    const first = await client.callTool({ name: "open_pinterest_inbox_web", arguments: {} });
    const session = await openWebSession(first.structuredContent.url);
    const held = holdRefreshRequest(first.structuredContent.url, session);
    heldRequest = held.request;
    await held.accepted;

    const completionOrder = [];
    const stopping = client.callTool({ name: "stop_pinterest_inbox_web", arguments: {} }).then((result) => {
      completionOrder.push("stop");
      return result;
    });
    const duringStop = await client.callTool({ name: "get_pinterest_inbox_web_status", arguments: {} });
    assert.equal(duringStop.structuredContent.status, "stopping");

    const reopening = client.callTool({ name: "open_pinterest_inbox_web", arguments: {} }).then((result) => {
      completionOrder.push("open");
      return result;
    });

    const [stopped, reopened] = await Promise.all([stopping, reopening]);
    assert.equal(stopped.structuredContent.status, "stopped");
    assert.equal(reopened.structuredContent.status, "running");
    assert.deepEqual(completionOrder, ["stop", "open"], "the old service must finish stopping before reopen resolves");
    assert.equal(new URL(reopened.structuredContent.url).origin, new URL(first.structuredContent.url).origin);
    assert.equal((await fetch(reopened.structuredContent.url)).status, 200);
    await client.callTool({ name: "stop_pinterest_inbox_web", arguments: {} });
  } finally {
    heldRequest?.destroy();
    await client.close();
    await cleanupDaemon(root, inboxRoot);
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGTERM exits the MCP process without interrupting the local panel", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinterest-mcp-signal-test-"));
  const inboxRoot = join(root, "PinterestInbox");
  await mkdir(inboxRoot, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.bundle.js"],
    cwd: pluginRoot,
    env: { ...process.env, PINTEREST_INBOX_DIR: inboxRoot, PINTEREST_PANEL_STATE_DIR: join(root, "state") },
    stderr: "pipe"
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const client = new Client({ name: "inbox-signal-test", version: "0.4.0" });

  try {
    await client.connect(transport);
    const opened = await client.callTool({ name: "open_pinterest_inbox_web", arguments: {} });
    const child = transport._process;
    assert.ok(child, "stdio child process should be available after connect");
    const closed = new Promise((resolveClosed) => child.once("close", (code, signal) => resolveClosed({ code, signal })));
    const startedAt = Date.now();
    assert.equal(child.kill("SIGTERM"), true);
    const result = await closed;
    assert.ok(Date.now() - startedAt < 1_800, "signal cleanup should finish promptly");
    assert.deepEqual(result, { code: 0, signal: null }, Buffer.concat(stderr).toString("utf8"));
    assert.equal((await fetch(opened.structuredContent.url)).status, 200);
  } finally {
    await client.close();
    await cleanupDaemon(root, inboxRoot);
    await rm(root, { recursive: true, force: true });
  }
});

test("local panel startup errors are sanitized in MCP tool output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinterest-mcp-start-error-test-"));
  const inboxRoot = join(root, "PinterestInbox");
  await mkdir(inboxRoot, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.bundle.js"],
    cwd: pluginRoot,
    env: { ...process.env, PINTEREST_INBOX_DIR: inboxRoot, PINTEREST_PANEL_STATE_DIR: join(root, "state"), PINTEREST_PANEL_PORT: "70000" },
    stderr: "pipe"
  });
  const client = new Client({ name: "inbox-start-error-test", version: "0.4.0" });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "open_pinterest_inbox_web", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "无法启动 Pinterest BoardFlow 本地网页；请检查插件安装后重试。");
    assert.equal(result.content[0].text.includes(inboxRoot), false);
    assert.equal(result.content[0].text.includes("70000"), false);
  } finally {
    await client.close();
    await cleanupDaemon(root, inboxRoot);
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent MCP hosts share one service and recover the same URL and basket after a daemon crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinterest-mcp-recovery-test-"));
  const inboxRoot = join(root, "PinterestInbox");
  await mkdir(inboxRoot);
  await writeFile(join(inboxRoot, "asset__pin-1.jpg"), "image-fixture");
  const env = { ...process.env, PINTEREST_INBOX_DIR: inboxRoot, PINTEREST_PANEL_STATE_DIR: join(root, "state") };
  const clients = [];
  async function connect() {
    const client = new Client({ name: "recovery-test", version: "1" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/server.bundle.js"], cwd: pluginRoot, env, stderr: "pipe" }));
    return client;
  }
  try {
    const [a, b] = await Promise.all([connect(), connect()]);
    const [first, other] = await Promise.all([a, b].map(client => client.callTool({ name: "open_pinterest_inbox_web", arguments: {} })));
    assert.equal(first.isError, undefined, JSON.stringify(first));
    assert.equal(other.isError, undefined, JSON.stringify(other));
    const opened = first.structuredContent;
    assert.equal(other.structuredContent.pid, opened.pid);
    assert.equal(other.structuredContent.port, opened.port);
    assert.notEqual(other.structuredContent.referenceSessionId, opened.referenceSessionId);
    const browser = await openWebSession(opened.url);
    const headers = { Cookie: browser.cookie, "X-Pinterest-Panel-Token": browser.token,
      "X-Pinterest-Reference-Session": opened.referenceSessionId,
      Origin: new URL(opened.url).origin, "Content-Type": "application/json" };
    const listing = await a.callTool({ name: "list_pinterest_inbox", arguments: {} });
    const assetId = listing.structuredContent.assets[0].id;
    assert.equal((await fetch(new URL("/api/references", opened.url), { method: "POST", headers,
      body: JSON.stringify({ assetIds: [assetId], revision: 0 }) })).status, 200);
    await Promise.all([a.close(), b.close()]);
    assert.equal((await fetch(new URL("/api/references", opened.url), { headers })).status, 200);
    const c = await connect();
    const beforeCrash = await c.callTool({ name: "open_pinterest_inbox_web", arguments: { referenceSessionId: opened.referenceSessionId } });
    assert.equal(beforeCrash.structuredContent.url, opened.url);
    process.kill(opened.pid, "SIGKILL");
    // Wait for the OS to release the singleton owner before asking a fresh host to reconnect.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(opened.pid, 0); }
      catch (error) { if (error.code === "ESRCH") break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const recovered = await c.callTool({ name: "open_pinterest_inbox_web", arguments: { referenceSessionId: opened.referenceSessionId } });
    assert.equal(recovered.isError, undefined, JSON.stringify(recovered));
    assert.equal(recovered.structuredContent.url, opened.url);
    assert.notEqual(recovered.structuredContent.pid, opened.pid);
    const read = await c.callTool({ name: "get_pinterest_reference_selection", arguments: { referenceSessionId: opened.referenceSessionId, expectedRevision: 1 } });
    assert.equal(read.structuredContent.files[0].assetId, assetId);
    assert.equal((await fetch(new URL("/api/references", opened.url), { headers })).status, 401);
    const refreshed = await openWebSession(opened.url);
    const selection = await fetch(new URL("/api/references", opened.url), { headers: { ...headers,
      Cookie: refreshed.cookie, "X-Pinterest-Panel-Token": refreshed.token } });
    assert.equal((await selection.json()).entries[0].id, assetId);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await cleanupDaemon(root, inboxRoot);
    await rm(root, { recursive: true, force: true });
  }
});
