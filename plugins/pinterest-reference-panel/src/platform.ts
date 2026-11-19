import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const APP = "pinterest-reference-panel";

export const isMac = () => process.platform === "darwin";
export const isWindows = () => process.platform === "win32";

/** Per-user directories: caches can be deleted at any time, state holds baskets and the port. */
export function appDirectory(kind: "cache" | "state") {
  const home = homedir();
  if (isMac()) return kind === "cache" ? join(home, "Library", "Caches", APP) : join(home, "Library", "Application Support", APP);
  if (isWindows()) {
    return kind === "cache"
      ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), APP, "Cache")
      : join(process.env.APPDATA || join(home, "AppData", "Roaming"), APP);
  }
  return kind === "cache"
    ? join(process.env.XDG_CACHE_HOME || join(home, ".cache"), APP)
    : join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), APP);
}

/** A short, filesystem- and pipe-safe identifier for the current OS user. */
export function userKey() {
  const uid = process.getuid?.();
  if (uid !== undefined) return String(uid);
  try { return userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "user"; }
  catch { return "user"; }
}

/** Where the background service listens: a Unix socket, or a named pipe on Windows. */
export function controlEndpoint(runtimeRoot: string, key: string) {
  return isWindows() ? `\\\\.\\pipe\\pinterest-boardflow-${userKey()}-${key}` : join(runtimeRoot, "rpc.sock");
}

/**
 * Runs a Windows PowerShell script. The script travels as -EncodedCommand (UTF-16LE),
 * and `input` is written to stdin as UTF-8, so paths with any characters need no quoting.
 */
export function runPowerShell(script: string, input = "", timeoutMs = 15_000, maxOutput = 65_536) {
  const prelude = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"
    + "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);";
  const encoded = Buffer.from(prelude + script, "utf16le").toString("base64");
  return new Promise<Buffer>((resolveRun, rejectRun) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      stdio: ["pipe", "pipe", "ignore"], windowsHide: true
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error); else resolveRun(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error("PowerShell timeout")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxOutput) { child.kill(); finish(new Error("PowerShell output too large")); }
      else chunks.push(Buffer.from(chunk));
    });
    child.once("error", error => finish(error));
    child.once("close", code => finish(code === 0 ? undefined : new Error("PowerShell command failed")));
    child.stdin.once("error", error => finish(error));
    child.stdin.end(input, "utf8");
  });
}

/** Writes text to the Windows clipboard and returns what the clipboard holds afterwards. */
export async function writeWindowsClipboard(text: string, timeoutMs: number) {
  const copied = await runPowerShell(
    "$t=[Console]::In.ReadToEnd();Set-Clipboard -Value $t;$r=Get-Clipboard -Raw;if($null -ne $r){[Console]::Out.Write($r)}",
    text, timeoutMs, 16_384 * 2
  );
  return copied.toString("utf8");
}

/** Sends a file to the Windows Recycle Bin, where it can be restored. */
export async function moveToWindowsRecycleBin(filePath: string) {
  await runPowerShell(
    "$p=[Console]::In.ReadToEnd();Add-Type -AssemblyName Microsoft.VisualBasic;"
    + "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')",
    filePath
  );
}

/**
 * Renders a JPEG thumbnail (longest edge `maxEdge`) with GDI+, honouring EXIF orientation.
 * GDI+ cannot decode WebP/AVIF; callers fall back to the original bytes when this throws.
 */
export async function renderWindowsThumbnail(sourcePath: string, outputPath: string, maxEdge = 480) {
  await runPowerShell(
    "$lines=[Console]::In.ReadToEnd() -split \"`n\";$src=$lines[0];$out=$lines[1];"
    + "Add-Type -AssemblyName System.Drawing;$img=[System.Drawing.Image]::FromFile($src);"
    + "try{try{$o=$img.GetPropertyItem(274).Value[0]}catch{$o=1};"
    + "$flip=@{2='RotateNoneFlipX';3='Rotate180FlipNone';4='Rotate180FlipX';5='Rotate90FlipX';6='Rotate90FlipNone';7='Rotate270FlipX';8='Rotate270FlipNone'};"
    + "if($flip.ContainsKey([string]$o)){$img.RotateFlip([System.Drawing.RotateFlipType]$flip[[string]$o])};"
    + `$s=[Math]::Min(1,${maxEdge}/[Math]::Max($img.Width,$img.Height));`
    + "$w=[Math]::Max(1,[int][Math]::Round($img.Width*$s));$h=[Math]::Max(1,[int][Math]::Round($img.Height*$s));"
    + "$bmp=New-Object System.Drawing.Bitmap $w,$h;$g=[System.Drawing.Graphics]::FromImage($bmp);"
    + "$g.Clear([System.Drawing.Color]::White);$g.InterpolationMode='HighQualityBicubic';$g.DrawImage($img,0,0,$w,$h);$g.Dispose();"
    + "$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'};"
    + "$params=New-Object System.Drawing.Imaging.EncoderParameters 1;"
    + "$params.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]82);"
    + "$bmp.Save($out,$codec,$params);$bmp.Dispose()}finally{$img.Dispose()}",
    `${sourcePath}\n${outputPath}`, 20_000
  );
}

export const hasMacTool = (name: "pbcopy" | "pbpaste" | "trash" | "sips") => isMac() && existsSync(`/usr/bin/${name}`);
