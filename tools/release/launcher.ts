import { basename } from "node:path";

const entrypoints = new Map<string, () => Promise<unknown>>([
  ["agx", () => import("../agx/src/agx.ts")],
  ["agx-worker", () => import("../agx-worker/src/next/cli.ts")],
  ["agx-ws", () => import("../agx-ws/src/ws.ts")],
  ["agx-ticket", () => import("../agx-ticket/src/tkt.ts")],
  ["agx-status", () => import("../agx-status/src/status.ts")],
  ["jex", () => import("../jex/src/jex.ts")],
]);

const command = basename(process.execPath).replace(/\.exe$/iu, "");
const entrypoint = entrypoints.get(command);

if (entrypoint === undefined) {
  process.stderr.write(`FATAL: Unknown suite command: ${command}\n`);
  process.exitCode = 2;
} else {
  Reflect.set(globalThis, "AGX_RELEASE_ENTRYPOINT", command);
  await entrypoint().finally(() => {
    Reflect.deleteProperty(globalThis, "AGX_RELEASE_ENTRYPOINT");
  });
}
