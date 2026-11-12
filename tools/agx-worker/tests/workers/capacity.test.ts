import { expect, test } from "bun:test";
import {
  capacityMessage,
  creditsUnavailable,
} from "../../src/workers/capacity.ts";

test("credit failures are distinct from capacity and assistant text", () => {
  for (const message of [
    "Your credit balance is too low to access the Anthropic API",
    "Credit balance too low",
    "Credit balance is too low",
    '{"type":"result","is_error":true,"result":"Credit balance is too low"}',
    "You have reached your specified API usage limits",
    "You have reached your specified workspace API usage limits",
    '{"type":"error","error_code":"enforced_spend_limit_reached"}',
    '{"type":"system","subtype":"api_retry","error":"billing_error"}',
  ])
    expect(creditsUnavailable(message)).toBe(true);
  expect(
    creditsUnavailable(
      '{"type":"assistant","message":"Credit balance too low"}',
    ),
  ).toBe(false);
  const overloaded =
    '{"type":"system","subtype":"api_retry","error_status":529}';
  expect(creditsUnavailable(overloaded)).toBe(false);
  expect(capacityMessage(overloaded, "claude")).toBeDefined();
});
