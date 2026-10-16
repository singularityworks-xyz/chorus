import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Keep engine storage and Chorus's credential/config readers on the same XDG paths. */
export function openCodeStoragePaths(
  env: Record<string, string | undefined> = process.env,
  home = homedir()
) {
  const config = env.XDG_CONFIG_HOME;
  const data = env.XDG_DATA_HOME;
  return {
    configDirectory: join(
      config && isAbsolute(config) ? config : join(home, ".config"),
      "opencode"
    ),
    authFile: join(
      data && isAbsolute(data) ? data : join(home, ".local", "share"),
      "opencode",
      "auth.json"
    ),
  };
}
