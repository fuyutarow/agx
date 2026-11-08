// A loopback Jev stand-in. Routing sends every ticket to Jev before a launch or a check passes, so
// fixtures that expect acceptance need a reachable endpoint that answers with a requirement class
// (mechanical, localized or cross_module) or a return reason. Tests must never reach the real service.
export function startFakeJev(choice = "mechanical") {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({ answers: { worker: { choice, confidence: 0.9 } } }),
  });
  return {
    url: `http://127.0.0.1:${server.port}/choice`,
    stop: () => server.stop(true),
  };
}
