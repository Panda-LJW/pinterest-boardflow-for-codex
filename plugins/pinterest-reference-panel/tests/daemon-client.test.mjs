import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { test } from "node:test";
import { PanelDaemonClient } from "../dist/server.bundle.js";

function transport(t, respond) {
  const calls = [];
  t.mock.method(http, "request", (_options, onResponse) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.end = body => {
      const message = JSON.parse(body);
      calls.push(message);
      queueMicrotask(() => {
        const reply = respond(message);
        if (reply instanceof Error) request.emit("error", reply);
        else onResponse(Readable.from([Buffer.from(JSON.stringify(reply))]));
      });
    };
    return request;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

const ready = { result: { status: "running", pid: 123, inbox: {} } };

test("RPC preserves omitted revisions and omitted session IDs instead of converting them to null", async t => {
  const calls = transport(t, message => message.method === "status" ? ready : { result: { ok: true } });
  const daemon = new PanelDaemonClient();
  await daemon.call("selection", "a".repeat(32), undefined);
  await daemon.call("selection", "a".repeat(32), 0);
  await daemon.call("open", undefined);
  assert.deepEqual(calls.map(call => [call.method, call.args]), [
    ["status", []], ["selection", ["a".repeat(32)]], ["selection", ["a".repeat(32), 0]], ["open", []]
  ]);
});

test("a lost mutation reply is not replayed and the next explicit action can reconnect", async t => {
  let opens = 0;
  const calls = transport(t, message => {
    if (message.method === "status") return ready;
    opens++;
    return opens === 1 ? Object.assign(new Error("lost reply"), { code: "ECONNRESET" }) : { result: { ok: true } };
  });
  const daemon = new PanelDaemonClient();
  await assert.rejects(daemon.call("open"), /lost reply/);
  assert.equal(opens, 1);
  assert.equal((await daemon.call("open")).ok, true);
  assert.deepEqual(calls.map(call => call.method), ["status", "open", "status", "open"]);
});

test("status checks do not start a stopped service and RPC validation errors retain their status", async t => {
  let available = false;
  transport(t, message => !available ? Object.assign(new Error("not running"), { code: "ENOENT" })
    : message.method === "status" ? ready : { error: "参考篮已变化", status: 409 });
  const daemon = new PanelDaemonClient();
  assert.equal((await daemon.status()).status, "stopped");
  available = true;
  await assert.rejects(daemon.call("selection", "a".repeat(32), 1), error => error.status === 409 && error.message === "参考篮已变化");
});
