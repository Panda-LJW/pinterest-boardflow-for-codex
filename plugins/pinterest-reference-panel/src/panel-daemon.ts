import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { InboxService } from "./inbox.js";
import { ReferenceError, ReferenceSessions } from "./references.js";
import { startLocalPanelServer, type LocalPanelServerHandle } from "./local-panel-server.js";
import { readState, writeState } from "./persistent-state.js";

type Summary = ReturnType<InboxService["getSummary"]>;
type Address = Pick<LocalPanelServerHandle, "host" | "port" | "url">;
type Status = { status: "stopped" | "stopping" | "running"; inbox: Summary; pid: number } & Partial<Address>;
type Commands = {
  status: () => Status;
  open: (referenceSessionId?: string) => Promise<Status & Address & { referenceSessionId: string }>;
  stop: () => Promise<{ status: "stopped"; wasRunning: boolean; inbox: Summary }>;
  summary: () => Summary;
  page: (options: Parameters<InboxService["getPage"]>[0]) => ReturnType<InboxService["getPage"]>;
  asset: (id: string) => ReturnType<InboxService["resolveAsset"]>;
  selection: (id: string, revision?: number) => ReturnType<ReferenceSessions["resolve"]>;
  shutdown: () => { status: "stopping" };
};

export function daemonPaths(inbox = new InboxService()) {
  const key = createHash("sha256").update(JSON.stringify([
    inbox.inboxRoot, inbox.stagingRoot, process.env.PINTEREST_PANEL_STATE_DIR ?? "default"
  ])).digest("hex").slice(0, 20);
  const stateRoot = join(resolve(process.env.PINTEREST_PANEL_STATE_DIR ?? join(homedir(), "Library", "Application Support", "pinterest-reference-panel")), key);
  // macOS Unix socket paths are limited to 104 bytes; never use the long plugin cache path.
  const runtimeRoot = join(tmpdir(), `bf-${process.getuid?.() ?? "user"}-${key}`);
  return { stateRoot, runtimeRoot, socket: join(runtimeRoot, "rpc.sock"), lock: join(runtimeRoot, "owner") };
}

function unavailable(error: unknown) {
  return ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function rpc<K extends keyof Commands>(socketPath: string, method: K, args: Parameters<Commands[K]>): Promise<Awaited<ReturnType<Commands[K]>>> {
  return new Promise((resolveReply, rejectReply) => {
    const req = request({ socketPath, path: "/rpc", method: "POST", headers: { "Content-Type": "application/json" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", rejectReply);
      response.once("end", () => {
        try {
          const reply = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (reply.error) rejectReply(new ReferenceError(reply.status ?? 500, reply.error));
          else resolveReply(reply.result);
        } catch (error) { rejectReply(error); }
      });
    });
    req.setTimeout(120_000, () => req.destroy(new Error("BoardFlow 后台服务响应超时")));
    req.once("error", rejectReply);
    // JSON arrays turn undefined into null, which would accidentally require
    // revision=null on selection reads that omitted expectedRevision.
    const parameters = [...args];
    while (parameters.length && parameters.at(-1) === undefined) parameters.pop();
    req.end(JSON.stringify({ method, args: parameters }));
  });
}

export class PanelDaemonClient {
  readonly paths = daemonPaths();
  private starting: Promise<void> | null = null;
  private connected = false;

  async status(): Promise<Status> {
    try {
      const result = await rpc(this.paths.socket, "status", []);
      this.connected = true;
      return result;
    }
    catch (error) {
      if (!unavailable(error)) throw error;
      this.connected = false;
      return { status: "stopped", inbox: new InboxService().getSummary(), pid: 0 };
    }
  }

  private async ensure() {
    if (!this.starting) this.starting = (async () => {
      try { await rpc(this.paths.socket, "status", []); return; }
      catch (error) { if (!unavailable(error)) throw error; }
      mkdirSync(this.paths.stateRoot, { recursive: true, mode: 0o700 });
      const log = openSync(join(this.paths.stateRoot, "service.log"), "a", 0o600);
      let spawnError: Error | undefined;
      let exitCode: number | null = null;
      try {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--panel-daemon"], {
          detached: true, stdio: ["ignore", log, log], env: process.env
        });
        child.once("error", error => { spawnError = error; });
        child.once("exit", code => { exitCode = code; });
        child.unref();
      } finally { closeSync(log); }
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (exitCode !== null && exitCode !== 0) throw new Error("BoardFlow 后台服务启动失败，请查看 service.log");
        try { await rpc(this.paths.socket, "status", []); return; }
        catch (error) { if (!unavailable(error)) throw error; }
        await delay(100);
      }
      throw new Error("BoardFlow 后台服务未能启动，请查看 service.log");
    })().finally(() => { this.starting = null; });
    await this.starting;
    this.connected = true;
  }

  async call<K extends keyof Commands>(method: K, ...args: Parameters<Commands[K]>): Promise<Awaited<ReturnType<Commands[K]>>> {
    if (!this.connected) await this.ensure();
    try { return await rpc(this.paths.socket, method, args); }
    catch (error) {
      if (unavailable(error)) this.connected = false;
      // Only retry a connection that was never established. A lost reply (reset/pipe)
      // may belong to a committed mutation, so it must be returned to the caller.
      if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await this.ensure();
      return rpc(this.paths.socket, method, args);
    }
  }
}

function claimService(paths: ReturnType<typeof daemonPaths>) {
  mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
  chmodSync(paths.runtimeRoot, 0o700);
  // A short-lived exclusive gate serializes stale-owner recovery across launchers.
  // Fail closed if a launcher died inside the gate; no second watcher may start.
  const gate = join(paths.runtimeRoot, "launching");
  try {
    mkdirSync(gate, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
  try {
    try {
      const owner = Number(readFileSync(join(paths.lock, "pid"), "utf8"));
      if (!Number.isInteger(owner) || owner <= 0) throw new Error("BoardFlow service owner is invalid");
      try { process.kill(owner, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    rmSync(paths.lock, { recursive: true, force: true });
    mkdirSync(paths.lock, { mode: 0o700 });
    writeFileSync(join(paths.lock, "pid"), String(process.pid), { mode: 0o600 });
    return true;
  } finally { rmSync(gate, { recursive: true, force: true }); }
}

export async function runPanelDaemon() {
  const inbox = new InboxService();
  const paths = daemonPaths(inbox);
  if (!claimService(paths)) return;
  const log = (message: string) => process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
  let localPanel: LocalPanelServerHandle | null = null;
  let localPanelStart: Promise<LocalPanelServerHandle> | null = null;
  let localPanelStop: Promise<boolean> | null = null;
  let closePromise: Promise<void> | null = null;
  let control: ReturnType<typeof createServer> | undefined;
  const close = () => closePromise ??= (async () => {
    log("service stopping");
    const closingControl = control?.listening ? new Promise<void>((resolveClose, rejectClose) => {
      const forceClose = setTimeout(() => control?.closeAllConnections(), 500);
      forceClose.unref();
      control!.close(error => {
        clearTimeout(forceClose);
        if (error) rejectClose(error); else resolveClose();
      });
      control!.closeIdleConnections();
    }) : Promise.resolve();
    await stopPanel();
    await inbox.close();
    await closingControl;
    await rm(paths.socket, { force: true });
    await rm(paths.lock, { recursive: true, force: true });
  })();
  const onSignal = (signal: string) => { log(`received ${signal}`); void close().then(() => process.exit(0), error => { log(String(error)); process.exit(1); }); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  async function stopPanel() {
    if (!localPanelStop) localPanelStop = (async () => {
      const handle = localPanel ?? (localPanelStart ? await localPanelStart : null);
      if (!handle) return false;
      await handle.close();
      if (localPanel === handle) localPanel = null;
      log("web stopped explicitly");
      return true;
    })().finally(() => { localPanelStop = null; });
    return localPanelStop;
  }

  try {
    const references = new ReferenceSessions(inbox, join(paths.stateRoot, "references.json"));
    const portPath = join(paths.stateRoot, "web.json");
    const stored = readState(portPath);
    if (stored !== undefined && (!stored || typeof stored !== "object" || !("port" in stored)
      || !Number.isInteger(stored.port) || Number(stored.port) < 1 || Number(stored.port) > 65535)) {
      throw new Error("BoardFlow saved port is invalid");
    }
    const saved = stored as { port: number; enabled?: boolean } | undefined;
    let preferredPort = process.env.PINTEREST_PANEL_PORT === undefined ? saved?.port ?? 0 : Number(process.env.PINTEREST_PANEL_PORT);
    async function ensurePanel() {
      if (localPanelStop) await localPanelStop;
      if (localPanel) return localPanel;
      if (!localPanelStart) localPanelStart = (async () => {
        // A saved port is never silently replaced: old URLs must remain meaningful.
        const handle = await startLocalPanelServer({ inbox, references, port: preferredPort });
        try { writeState(portPath, { version: 1, port: handle.port, enabled: true }); }
        catch (error) { await handle.close(); throw error; }
        preferredPort = handle.port;
        localPanel = handle;
        log(`web listening on ${handle.url}`);
        return handle;
      })().finally(() => { localPanelStart = null; });
      return localPanelStart;
    }
    const status = (): Status => ({ status: localPanelStop ? "stopping" : localPanel ? "running" : "stopped",
      ...(localPanel ? { host: localPanel.host, port: localPanel.port, url: localPanel.url } : {}),
      inbox: inbox.getSummary(), pid: process.pid });
    const handlers: Commands = {
      status, summary: () => inbox.getSummary(), page: options => inbox.getPage(options),
      asset: id => inbox.resolveAsset(id), selection: (id, revision) => references.resolve(id, revision),
      open: async id => {
        if (id) references.require(id);
        const handle = await ensurePanel();
        const referenceSessionId = id ?? references.create();
        return { ...status(), host: handle.host, port: handle.port, url: `${handle.url}?ref=${referenceSessionId}`, referenceSessionId };
      },
      stop: async () => {
        const wasRunning = await stopPanel();
        if (preferredPort) writeState(portPath, { version: 1, port: preferredPort, enabled: false });
        return { status: "stopped", wasRunning, inbox: inbox.getSummary() };
      },
      shutdown: () => { setTimeout(() => onSignal("RPC shutdown"), 50); return { status: "stopping" }; }
    };
    await inbox.start();
    // Resume an existing web address on daemon recovery, before accepting MCP calls.
    if (saved?.port && saved.enabled !== false) await ensurePanel();
    await rm(paths.socket, { force: true });
    control = createServer((req, res) => {
      void (async () => {
        if (req.method !== "POST" || req.url !== "/rpc") throw new Error("invalid RPC request");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 64_000) throw new Error("RPC request too large");
          chunks.push(chunk);
        }
        const { method, args } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!Object.hasOwn(handlers, method) || !Array.isArray(args)) throw new Error("invalid RPC method");
        const handler = handlers[method as keyof Commands] as (...args: unknown[]) => unknown;
        return handler(...args);
      })().then(result => {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ result }));
      }, error => {
        log(`RPC failed: ${error instanceof Error ? error.message : String(error)}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof ReferenceError ? error.message : "BoardFlow 后台服务暂时无法完成请求", status: error instanceof ReferenceError ? error.status : 500 }));
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      control!.once("error", rejectListen);
      control!.listen(paths.socket, () => { control!.off("error", rejectListen); resolveListen(); });
    });
    chmodSync(paths.socket, 0o600);
    log(`service ready pid=${process.pid}`);
  } catch (error) {
    await close();
    throw error;
  }
}
