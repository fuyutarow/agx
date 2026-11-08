import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  workerEnvironment,
  workerSharedCaches,
  workerWritableRoots,
} from "../../src/workers/environment.ts";

test.each([
  [{ HOME: "/worker-home" }, "/worker-home/.cache/uv"],
  [{ HOME: "/worker-home", XDG_CACHE_HOME: "/xdg-cache" }, "/xdg-cache/uv"],
  [
    {
      HOME: "/worker-home",
      XDG_CACHE_HOME: "/xdg-cache",
      UV_CACHE_DIR: "uv-cache",
    },
    resolve("uv-cache"),
  ],
])(
  "uv cache is shared by the worker environment and writable roots",
  (source, root) => {
    const environment = workerEnvironment(source);
    const cache = workerSharedCaches(environment).find(
      (entry) => entry.key === "UV_CACHE_DIR",
    );
    expect(cache).toEqual({ key: "UV_CACHE_DIR", root });
    expect(workerWritableRoots({ source: environment })).toContain(root);
  },
);
