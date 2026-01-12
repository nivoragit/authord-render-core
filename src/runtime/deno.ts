import type { RenderRuntime, RuntimeStat, RunResult } from "../core/shared/runtime.ts";

export function createDenoRuntime(): RenderRuntime {
  return {
    fs: {
      readFile: async (path: string) => await Deno.readFile(path),
      writeFile: async (path: string, data: Uint8Array) => {
        await Deno.writeFile(path, data);
      },
      stat: async (path: string): Promise<RuntimeStat | null> => {
        try {
          const st = await Deno.stat(path);
          return { isFile: st.isFile, isDirectory: st.isDirectory };
        } catch {
          return null;
        }
      },
      mkdir: async (path: string, opts?: { recursive?: boolean }) => {
        await Deno.mkdir(path, { recursive: opts?.recursive ?? false });
      },
      remove: async (path: string) => {
        await Deno.remove(path).catch(() => {});
      },
      makeTempFile: async (opts?: { suffix?: string }) => {
        return await Deno.makeTempFile({ suffix: opts?.suffix });
      },
    },
    env: {
      get: (name: string) => {
        try {
          return Deno.env.get(name) ?? undefined;
        } catch {
          return undefined;
        }
      },
    },
    exec: async (cmd: string[], opts?: { cwd?: string }): Promise<RunResult> => {
      const proc = new Deno.Command(cmd[0], {
        args: cmd.slice(1),
        cwd: opts?.cwd,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const { code, stdout, stderr } = await proc.output();
      return { code, stdout, stderr };
    },
    cwd: () => Deno.cwd(),
  };
}
