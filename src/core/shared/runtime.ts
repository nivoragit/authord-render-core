export type RunResult = {
  code: number;
  stdout?: Uint8Array;
  stderr?: Uint8Array;
};

export type RuntimeStat = {
  isFile: boolean;
  isDirectory: boolean;
};

export type RuntimeFs = {
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  stat: (path: string) => Promise<RuntimeStat | null>;
  mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
  remove: (path: string) => Promise<void>;
  makeTempFile?: (opts?: { suffix?: string }) => Promise<string>;
};

export type RuntimeEnv = {
  get: (name: string) => string | undefined;
};

export type RuntimeExec = (cmd: string[], opts?: { cwd?: string }) => Promise<RunResult>;

export type RenderRuntime = {
  fs?: RuntimeFs;
  env?: RuntimeEnv;
  exec?: RuntimeExec;
  cwd?: () => string;
};

let runtime: RenderRuntime | null = null;

export function setRenderRuntime(rt: RenderRuntime | null) {
  runtime = rt;
}

export function getRenderRuntime(): RenderRuntime | null {
  return runtime;
}

export function requireRenderRuntime(): RenderRuntime {
  if (!runtime) {
    throw new Error("Render runtime not set. Call setRenderRuntime() before rendering.");
  }
  return runtime;
}

export function resolveRuntime(override?: RenderRuntime): RenderRuntime | null {
  return override ?? runtime;
}

export function readEnv(name: string, override?: RenderRuntime): string | undefined {
  return (override ?? runtime)?.env?.get(name);
}
