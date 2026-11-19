import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InboxService, appDirectory, controlEndpoint, daemonPaths, moveToTrash, userKey, writeTextToClipboard } from "../dist/server.bundle.js";

const windowsOnly = { skip: process.platform !== "win32" && "Windows only" };
const fixture = new URL("../../../docs/images/preview.png", import.meta.url);

test("platform directories and the control endpoint follow OS conventions", () => {
  const cache = appDirectory("cache"), state = appDirectory("state");
  assert.ok(cache.endsWith("pinterest-reference-panel") || cache.endsWith(join("pinterest-reference-panel", "Cache")));
  assert.notEqual(cache, state);
  const endpoint = controlEndpoint(join(tmpdir(), "bf-test"), "abc123");
  if (process.platform === "win32") {
    assert.match(endpoint, /^\\\\\.\\pipe\\pinterest-boardflow-[A-Za-z0-9_-]+-abc123$/);
    assert.ok(cache.startsWith(process.env.LOCALAPPDATA ?? ""));
    assert.ok(state.startsWith(process.env.APPDATA ?? ""));
  } else {
    assert.equal(endpoint, join(tmpdir(), "bf-test", "rpc.sock"));
  }
  assert.match(userKey(), /^[A-Za-z0-9_-]+$/);
  const socket = daemonPaths(new InboxService({ inboxRoot: join(tmpdir(), "bf-lib"), stagingRoot: join(tmpdir(), "bf-lib") })).socket;
  if (process.platform === "win32") assert.match(socket, /^\\\\\.\\pipe\\pinterest-boardflow-/);
  else assert.ok(socket.endsWith("rpc.sock"));
});

test("Windows clipboard round-trips a multi-line Chinese path list", windowsOnly, async () => {
  const text = "C:\\Users\\测试\\Pictures\\PinterestInbox\\板\\参考 一.png\r\nC:\\Users\\测试\\Pictures\\PinterestInbox\\板\\参考 二.webp";
  await writeTextToClipboard(text);
  const pasted = execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-Clipboard -Raw"], { encoding: "utf8" });
  assert.equal(pasted.replace(/\r?\n$/, "").replace(/\r\n/g, "\n"), text.replace(/\r\n/g, "\n"));
});

test("Windows trash sends a file to the Recycle Bin", windowsOnly, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boardflow-recycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "删除测试.png");
  await writeFile(file, "recycle me");
  await moveToTrash(file);
  assert.equal(existsSync(file), false);
});

test("Windows thumbnails are small JPEGs, and undecodable formats fall back to the original", windowsOnly, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boardflow-thumbs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const inboxRoot = join(root, "PinterestInbox");
  await mkdir(join(inboxRoot, "board"), { recursive: true });
  await copyFile(fixture, join(inboxRoot, "board", "预览__pin-1.png"));
  // A minimal (valid header) WebP that GDI+ cannot decode.
  await writeFile(join(inboxRoot, "board", "webp__pin-2.webp"), Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]));
  const service = new InboxService({ inboxRoot, cacheRoot: join(root, "cache"), reconcileIntervalMs: 60_000 });
  await service.start();
  context.after(() => service.close());
  const { page } = await service.getPage();
  const png = page.assets.find(asset => asset.extension === ".png");
  const webp = page.assets.find(asset => asset.extension === ".webp");
  const thumbnail = await service.getThumbnail(png.id);
  assert.equal(thumbnail.contentType, "image/jpeg");
  assert.equal(thumbnail.data[0], 0xff); assert.equal(thumbnail.data[1], 0xd8);
  const fallback = await service.getThumbnail(webp.id);
  assert.equal(fallback.contentType, "image/webp");
  assert.equal(fallback.original, true);
});
