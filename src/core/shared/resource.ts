export type Resource = {
  readText: (pathOrUrl: string) => Promise<string>;
  resolve: (base: string, target: string) => string;
  exists: (pathOrUrl: string) => Promise<boolean>;
};
