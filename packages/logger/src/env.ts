interface MinimalProcess {
  env?: Record<string, string | undefined>;
}

export function readEnv(key: string): string | undefined {
  const proc = (globalThis as { process?: MinimalProcess }).process;
  return proc?.env?.[key];
}
