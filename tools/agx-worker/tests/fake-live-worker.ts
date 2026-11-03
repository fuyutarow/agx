#!/usr/bin/env bun
// A worker process that stays alive for argv[2] ms so the run it stands for reads as running.
await Bun.sleep(Number(Bun.argv[2] ?? "5000"));
export {};
