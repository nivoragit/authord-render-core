import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import process from "node:process";
import type { RenderRuntime, RuntimeStat, RunResult } from "../core/shared/runtime.ts";

export function createNodeRuntime(): RenderRuntime {
  return {
    fs: {
      readFile: async (p: string) => new Uint8Array(await fs.readFile(p)),
      writeFile: async (p: string, data: Uint8Array) => {
        await fs.writeFile(p, data);
      },
      stat: async (p: string): Promise<RuntimeStat | null> => {
        try {
          const st = await fs.stat(p);
          return { isFile: st.isFile(), isDirectory: st.isDirectory() };
        } catch {
          return null;
        }
      },
      mkdir: async (p: string, opts?: { recursive?: boolean }) => {
        await fs.mkdir(p, { recursive: opts?.recursive ?? false });
      },
      remove: async (p: string) => {
        await fs.rm(p, { force: true }).catch(() => {});
      },
      makeTempFile: async (opts?: { suffix?: string }) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authord-"));
        const file = path.join(dir, `tmp${opts?.suffix ?? ""}`);
        await fs.writeFile(file, new Uint8Array());
        return file;
      },
    },
    env: {
      get: (name: string) => process.env[name],
    },
    exec: async (cmd: string[], opts?: { cwd?: string }): Promise<RunResult> => {
      return await new Promise((resolve, reject) => {
        const proc = spawn(cmd[0], cmd.slice(1), { cwd: opts?.cwd });
        const stdout: Uint8Array[] = [];
        const stderr: Uint8Array[] = [];
        proc.stdout?.on("data", (chunk: Uint8Array) => stdout.push(chunk));
        proc.stderr?.on("data", (chunk: Uint8Array) => stderr.push(chunk));
        proc.on("error", reject);
        proc.on("close", (code) => {
          resolve({
            code: code ?? 1,
            stdout: stdout.length ? concatBytes(stdout) : undefined,
            stderr: stderr.length ? concatBytes(stderr) : undefined,
          });
        });
      });
    },
    cwd: () => process.cwd(),
  };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
