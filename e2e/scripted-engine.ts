import { startScriptedEngine } from "../apps/serve/scripts/fixtures/opencode-engine";

const engine = startScriptedEngine({ port: Number(process.argv[2]) });
process.once("SIGTERM", () => {
  engine.stop().then(() => process.exit(0));
});
