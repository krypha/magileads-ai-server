export function sendScopeFixture(body, res, decision = 'allow') {
  if (body.tool_choice?.function?.name !== 'classify_magileads_request') return false;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'scope',
    function: { name: 'classify_magileads_request', arguments: JSON.stringify({ decision }) } }] } }], usage: { cost: 0.0001 } })}\n\ndata: [DONE]\n\n`);
  return true;
}
