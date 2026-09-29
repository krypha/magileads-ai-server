// Deployment-only, temporary opt-out for testing. Never read from the chat body.
// An absent, invalid or expired timestamp keeps the production limits enabled.
export function usageLimitsEnabled(now = Date.now(), until = process.env.AI_TEST_UNLIMITED_UNTIL) {
  const expires = Date.parse(until ?? '');
  return !Number.isFinite(expires) || now >= expires;
}
