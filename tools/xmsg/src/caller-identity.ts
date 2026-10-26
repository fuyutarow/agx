import { canonicalUuid } from "./recipient-prefix.ts";
import { attempt } from "../../shared/src/attempt.ts";

export type ProcessIdentity = {
  pid: number;
  ppid: number;
  comm: string;
  argv: string[];
  environment?: ReadonlyMap<string, string>;
};

export type CallerIdentity = {
  sender?: string;
  checked: string[];
  missing: string[];
};

const basename = (name: string | undefined) =>
  name?.split("/").at(-1)?.toLowerCase();

const vendorNames = (process: ProcessIdentity) => {
  const command = basename(process.argv[0]);
  const names = [basename(process.comm), command];
  if (command === "node" || command === "nodejs")
    names.push(basename(process.argv[1]));
  return names;
};

const vendorOf = (process: ProcessIdentity): "codex" | "claude" | null => {
  const names = vendorNames(process);
  if (names.includes("codex")) return "codex";
  if (names.includes("claude")) return "claude";
  return null;
};

export function resolveNearestVendorIdentity(
  ancestry: readonly ProcessIdentity[],
): CallerIdentity {
  const checked = ["caller parent chain", "nearest vendor process"];
  const nearest = ancestry.find((process) => vendorOf(process) !== null);
  if (nearest === undefined)
    return {
      checked,
      missing: ["nearest codex/claude process in caller ancestry"],
    };

  const vendor = vendorOf(nearest);
  if (vendor !== "codex")
    return {
      checked,
      missing: ["nearest vendor process is not codex"],
    };

  checked.push("nearest codex process's own CODEX_THREAD_ID");
  const rawId = nearest.environment?.get("CODEX_THREAD_ID");
  const id = rawId === undefined ? undefined : canonicalUuid(rawId);
  if (id === undefined) {
    let missing: string;
    if (rawId !== undefined)
      missing = "nearest codex process CODEX_THREAD_ID is not a full UUID";
    else if (nearest.environment === undefined)
      missing = "nearest codex process environment unreadable";
    else
      missing = "CODEX_THREAD_ID absent from nearest codex process environment";
    return {
      checked,
      missing: [missing],
    };
  }

  return { sender: `codex:${id}`, checked, missing: [] };
}

function parseEnvironment(raw: Uint8Array): ReadonlyMap<string, string> {
  const environment = new Map<string, string>();
  for (const entry of new TextDecoder().decode(raw).split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0)
      environment.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return environment;
}

async function readProcess(pid: number): Promise<ProcessIdentity | undefined> {
  const result = await attempt(async () => {
    const [stat, comm, cmdline] = await Promise.all([
      Bun.file(`/proc/${pid}/stat`).text(),
      Bun.file(`/proc/${pid}/comm`).text(),
      Bun.file(`/proc/${pid}/cmdline`).text(),
    ]);
    const fieldsAfterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fieldsAfterComm[1]);
    if (!Number.isInteger(ppid) || ppid < 0) return null;
    const identity: ProcessIdentity = {
      pid,
      ppid,
      comm: comm.trim(),
      argv: cmdline.split("\0").filter(Boolean),
    };
    if (vendorOf(identity) === "codex") {
      const environment = await attempt(() =>
        Bun.file(`/proc/${pid}/environ`)
          .arrayBuffer()
          .then((raw) => parseEnvironment(new Uint8Array(raw))),
      );
      if (environment.ok) identity.environment = environment.value;
    }
    return identity;
  });
  if (!result.ok || result.value === null) return undefined;
  return result.value;
}

export async function resolveCallingThreadIdentity(
  startPid = process.pid,
): Promise<CallerIdentity> {
  const ancestry: ProcessIdentity[] = [];
  let pid = startPid;
  const visited = new Set<number>();
  for (let depth = 0; depth < 256 && pid > 0 && !visited.has(pid); depth++) {
    visited.add(pid);
    const process = await readProcess(pid);
    if (process === undefined) break;
    ancestry.push(process);
    if (vendorOf(process) !== null) break;
    pid = process.ppid;
  }
  return resolveNearestVendorIdentity(ancestry);
}

export function unknownSender(identity: CallerIdentity): string {
  const checked = identity.checked.join(", ");
  const missingText = identity.missing.join(", ");
  const missing = missingText.length === 0 ? "none" : missingText;
  return `unknown (sender identity unavailable; checked: ${checked}; missing: ${missing}; use --from backend:<full-session-id>)`;
}
