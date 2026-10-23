// Test-only gh protocol fixture. Never invokes gh or any network process.
import { appendFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { jsonOf, z } from "../zod.ts";

const stateSchema = z.object({
  draft: z.boolean(),
  attempts: z.record(z.string(), z.number()),
  assets: z.array(
    z.object({ name: z.string(), state: z.string(), size: z.number() }),
  ),
});
// argv-forwarding: fake gh release protocol, mirroring gh's argument vector in tests.
const args = process.argv.slice(2);
const mode = process.env.RELEASE_TEST_GH_MODE;
const path = join(process.cwd(), "gh-state.json");
await appendFile(join(process.cwd(), "calls"), JSON.stringify(args) + "\n");
const file = Bun.file(path);
function refuse(message: string): never {
  process.stderr.write(`Fake gh refused: ${message}\n`);
  process.exit(98);
}
const parsed = jsonOf(stateSchema).safeParse(
  (await file.exists())
    ? await file.text()
    : JSON.stringify({ draft: true, attempts: {}, assets: [] }),
);
if (!parsed.success) refuse(parsed.error.message);
const state = parsed.data;

if (args[0] !== "release") refuse("Expected gh release");
if (args[1] === "create") {
  if (await file.exists()) refuse("Release already exists");
  if (!args.includes("--draft") || !args.includes("--target"))
    refuse("Create must use a draft and an explicit target");
  // The release tag is immediately followed by flags: no bundled asset paths.
  if (args[3] !== "--draft") refuse("Create must not upload assets");
  await Bun.write(path, JSON.stringify(state));
} else if (args[1] === "upload") {
  if (!(await file.exists()) || !state.draft) refuse("Expected existing draft");
  const archive = args[3];
  if (archive === undefined) refuse("Missing asset");
  const name = basename(archive);
  const attempt = (state.attempts[name] ?? 0) + 1;
  state.attempts[name] = attempt;
  const large = name.endsWith(".tar.gz");
  const fails =
    large &&
    (mode === "failure" ||
      mode === "silent" ||
      (mode === "retry" && attempt === 1));
  if (attempt > 1 && !args.includes("--clobber")) refuse("Retry must clobber");
  state.assets = state.assets.filter((asset) => asset.name !== name);
  state.assets.push({
    name,
    state: fails ? "starter" : "uploaded",
    size: fails ? 0 : (await stat(archive)).size,
  });
  await Bun.write(path, JSON.stringify(state));
  if (fails && mode !== "silent")
    process.stderr.write(`HTTP 502: upload failed for ${name}\n`);
  if (fails) process.exitCode = 1;
} else if (args[1] === "view") {
  if (!args.includes("--json") || !args.includes("assets"))
    refuse("Expected asset inspection");
  const assets = state.assets.map((asset) => ({ ...asset }));
  const first = assets[0];
  if (mode === "missing") assets.shift();
  if (first !== undefined && mode === "wrong-size") first.size++;
  if (first !== undefined && mode === "starter") first.state = "starter";
  process.stdout.write(
    mode === "malformed" ? "invalid JSON" : JSON.stringify({ assets }),
  );
} else if (args[1] === "edit") {
  if (!args.includes("--draft=false") || !args.includes("--latest"))
    refuse("Expected final publication");
  if (
    state.assets.length !== 2 ||
    state.assets.some((asset) => asset.state !== "uploaded")
  )
    refuse("Cannot publish incomplete assets");
  state.draft = false;
  await Bun.write(path, JSON.stringify(state));
} else {
  refuse(`Unexpected gh command: ${JSON.stringify(args)}`);
}
