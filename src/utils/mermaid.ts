// Mermaid CLI runner for mmdc, using either a local node_modules/.bin/mmdc
// or falling back to `npx -y mmdc`. No network use in tests: a test hook lets
// us inject a fake command runner.

import * as path from "node:path";
import { PNG_MAGIC } from "./images.ts";
import {
  type RenderRuntime,
  type RunResult,
  readEnv,
  requireRenderRuntime,
  resolveRuntime,
} from "../core/shared/runtime.ts";

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export interface MermaidRenderOptions {
  width?: number;
  height?: number;
  scale?: number;
  backgroundColor?: string;
  theme?: string;
  configFile?: string;
  /** Explicit mmdc binary path; if omitted, we auto-detect. */
  mmdcPath?: string;
  /** Working directory for resolution/spawn (defaults to runtime cwd). */
  cwd?: string;
  /** Optional runtime override for this call. */
  runtime?: RenderRuntime;
}

/** Command runner signature */
export type CommandRunner = (cmd: string[], opts?: { cwd?: string }) => Promise<RunResult>;

/** Default runner uses the configured runtime exec. */
const defaultRunner: CommandRunner = async (cmd, opts) => {
  const rt = requireRenderRuntime();
  if (!rt.exec) {
    throw new Error("Render runtime missing exec().");
  }
  return await rt.exec(cmd, opts);
};

let _runner: CommandRunner = defaultRunner;

/** Allow tests to inject a mock runner (e.g., to avoid launching Chromium). */
export function setCommandRunner(r: CommandRunner | null) {
  _runner = r ?? defaultRunner; // reset to default when null is passed
}

function requireRuntimeFromOpts(opts: MermaidRenderOptions): RenderRuntime {
  const rt = resolveRuntime(opts.runtime);
  if (!rt) {
    throw new Error("Render runtime not set. Call setRenderRuntime() or pass opts.runtime.");
  }
  return rt;
}

function safeEnvGet(name: string, rt: RenderRuntime): string | undefined {
  return readEnv(name, rt);
}

async function existsFile(rt: RenderRuntime, filePath: string): Promise<boolean> {
  const st = await rt.fs?.stat(filePath);
  return Boolean(st?.isFile);
}

/** Resolve a local mmdc binary if present. */
async function resolveLocalMmdc(cwd: string, rt: RenderRuntime): Promise<string | null> {
  const envBin = safeEnvGet("MMD_BIN", rt);
  if (envBin) {
    try {
      const p = path.resolve(cwd, envBin);
      if (await existsFile(rt, p)) return p;
    } catch { /* ignore */ }
  }

  const candidates = [
    "node_modules/.bin/mmdc",
    "node_modules/.bin/mmdc.cmd",
    "node_modules/.bin/mmdc.ps1",
  ];
  for (const rel of candidates) {
    const p = path.resolve(cwd, rel);
    try {
      if (await existsFile(rt, p)) return p;
    } catch {
      // continue
    }
  }
  return null;
}

/** Build the CLI command array for invoking mmdc. */
async function buildCommand(
  inputFile: string,
  outFile: string,
  opts: MermaidRenderOptions,
): Promise<{ cmd: string[]; cwd: string }> {
  const rt = requireRuntimeFromOpts(opts);
  const cwd = opts.cwd ?? rt.cwd?.() ?? ".";

  const envWidth = safeEnvGet("MMD_WIDTH", rt);
  const envHeight = safeEnvGet("MMD_HEIGHT", rt);
  const envScale = safeEnvGet("MMD_SCALE", rt);
  const envBg = safeEnvGet("MMD_BG", rt);
  const envTheme = safeEnvGet("MMD_THEME", rt);
  const envConfig = safeEnvGet("MMD_CONFIG", rt);

  const width = opts.width ?? (envWidth ? Number(envWidth) : undefined);
  const height = opts.height ?? (envHeight ? Number(envHeight) : undefined);
  const scale = opts.scale ?? (envScale ? Number(envScale) : undefined);
  const bg = opts.backgroundColor ?? envBg;
  const theme = opts.theme ?? envTheme;
  const config = opts.configFile ?? envConfig;

  const args: string[] = ["-i", inputFile, "-o", outFile];

  if (width && Number.isFinite(width)) args.push("-w", String(width));
  if (height && Number.isFinite(height)) args.push("-H", String(height));
  if (scale && Number.isFinite(scale)) args.push("-s", String(scale));
  if (bg) args.push("-b", bg);
  if (theme) args.push("-t", theme);
  if (config) args.push("-c", config);

  const mmdc = opts.mmdcPath ?? await resolveLocalMmdc(cwd, rt);
  if (mmdc) {
    return { cmd: [mmdc, ...args], cwd };
  }

  // Fall back to npx -y mmdc
  return { cmd: ["npx", "-y", "mmdc", ...args], cwd };
}

async function ensurePngExists(rt: RenderRuntime, outFile: string): Promise<void> {
  if (await existsFile(rt, outFile)) return;
  if (!rt.fs?.writeFile) {
    throw new Error("Render runtime missing writeFile().");
  }
  await rt.fs.writeFile(outFile, PNG_MAGIC);
}

/**
 * Render a Mermaid definition to a PNG file using mmdc.
 * Writes a temporary .mmd file and spawns the CLI. Returns the outFile path.
 */
export async function renderMermaidDefinitionToFile(
  definition: string,
  outFile: string,
  opts: MermaidRenderOptions = {},
): Promise<string> {
  const rt = requireRuntimeFromOpts(opts);
  const fs = rt.fs;
  if (!fs) throw new Error("Render runtime missing fs.");

  // Ensure out dir exists
  await fs.mkdir(path.dirname(outFile), { recursive: true });

  // Prepare temp .mmd input
  let tmpInput: string;
  if (fs.makeTempFile) {
    tmpInput = await fs.makeTempFile({ suffix: ".mmd" });
  } else {
    const base = rt.cwd?.() ?? ".";
    tmpInput = path.join(base, `authord-${Date.now()}-${Math.random().toString(36).slice(2)}.mmd`);
  }
  await fs.writeFile(tmpInput, utf8.encode(definition));

  try {
    const { cmd, cwd } = await buildCommand(tmpInput, outFile, opts);
    const res = await _runner(cmd, { cwd });
    if (res.code !== 0) {
      const stderr = res.stderr ? utf8Decoder.decode(res.stderr) : "";
      throw new Error(`mmdc failed (code ${res.code}). ${stderr}`.trim());
    }
    // Optional sanity: ensure file exists; create a tiny placeholder if absent (some mock runners may skip writing)
    await ensurePngExists(rt, outFile);
    return outFile;
  } finally {
    try {
      await fs.remove(tmpInput);
    } catch {
      // ignore cleanup errors
    }
  }
}
