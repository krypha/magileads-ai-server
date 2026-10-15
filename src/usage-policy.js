// Deployment-only, temporary opt-out for testing. Never read from the chat body.
// An absent, invalid or expired timestamp keeps the production limits enabled.
//
// Never in the production image (NODE_ENV=production, set by the Dockerfile):
// production was found running with a future AI_TEST_UNLIMITED_UNTIL left in
// its environment (2026-10-15), so no account had a daily share and the
// platform key was spent without a cap — and that environment could not be
// changed at once. Tests and local runs keep the opt-out.
export function usageLimitsEnabled(now = Date.now(), until = process.env.AI_TEST_UNLIMITED_UNTIL,
  environment = process.env.NODE_ENV) {
  if (environment === 'production') return true;
  const expires = Date.parse(until ?? '');
  return !Number.isFinite(expires) || now >= expires;
}
