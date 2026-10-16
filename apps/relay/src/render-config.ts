import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadRelayConfig } from "./config";
import { renderRelayDeployment } from "./deployment";

const output = process.argv[2];
if (!output) {
  throw new Error("An operator-owned output directory is required");
}
const root = resolve(output);
const config = renderRelayDeployment(loadRelayConfig());
await mkdir(root, { recursive: true, mode: 0o700 });
for (const [name, value] of Object.entries({
  "haproxy.cfg": config.haproxy,
  Caddyfile: config.caddy,
  "frps.toml": config.frps,
})) {
  await writeFile(join(root, name), value, { mode: 0o600 });
}
