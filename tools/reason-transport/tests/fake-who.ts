#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

const session = process.env.REASON_NETWORK_SESSION ?? "";
if (process.env.WHO_MARKER) appendFileSync(process.env.WHO_MARKER, "started\n");
if (process.argv.slice(2).join(" ") !== "who --json") process.exit(2);
if (session === "hang") await new Promise(() => {});
if (session === "nonzero") process.exit(1);
if (session === "broken") { process.stdout.write("{"); process.exit(0); }
const row = { address: `${process.env.REASON_NETWORK_AGENT}/${session}`, is_me: true };
const sessions = session === "empty" ? [] : session === "no-me" ? [{ ...row, is_me: false }] : session === "multiple" ? [row, row] : [{ address: "other", is_me: false }, row];
process.stdout.write(JSON.stringify({ sessions }));
