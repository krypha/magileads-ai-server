/**
 * Manual import flow smoke check. Node 18+, no dependencies.
 *
 * SERVER_URL=https://... TOKEN=... node examples/import-smoke.mjs
 * To test a real extraction, also set VALIDATE_NAME="Nom de la liste".
 * Without VALIDATE_NAME the script stops after the proposal and cannot launch.
 */
const { SERVER_URL, TOKEN, VALIDATE_NAME } = process.env;
if (!SERVER_URL || !TOKEN) {
  console.error('SERVER_URL et TOKEN sont requis. VALIDATE_NAME est optionnel pour autoriser un lancement réel.');
  process.exitCode = 2;
} else {
  const context = '[Contexte : je suis sur la page de création de liste de prospects. Propose la cible et attends une validation explicite.]';
  const messages = [{ role: 'user', content: `${context}\n${process.env.PROMPT || 'Je cherche des dentistes à Lyon.'}` }];
  try {
    const proposal = await turn(messages, false);
    if (proposal.text) messages.push({ role: 'assistant', content: proposal.text });
    if (VALIDATE_NAME?.trim()) {
      const name = VALIDATE_NAME.trim().slice(0, 80).replaceAll('»', '');
      if (!proposal.text) throw new Error('Aucune proposition à valider ; extraction annulée.');
      messages.push({ role: 'user', content: `La cible me convient : crée la liste « ${name} » et lance la recherche.` });
      await turn(messages, true);
    } else {
      console.log('\nAucune validation envoyée. Définir VALIDATE_NAME pour tester un lancement réel.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

async function turn(messages, approved) {
  const response = await fetch(`${SERVER_URL.replace(/\/+$/, '')}/ai/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'import', tier: 'simple', provider: 'openrouter', messages }),
  });
  if (!response.ok || !response.body) throw new Error(`POST /ai/chat : HTTP ${response.status}`);
  console.log(`\n=== ${approved ? 'Après validation' : 'Avant validation'} ===`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const event = frame.match(/^event:\s*(.+)$/m)?.[1] ?? 'delta';
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      if (event === 'delta') {
        const chunk = payload.choices?.[0]?.delta?.content;
        if (chunk) { text += chunk; process.stdout.write(chunk); }
        continue;
      }
      console.log(`\n${event}: ${JSON.stringify(payload)}`);
      if (!approved && ((event === 'tool.progress' && payload.creates_list) ||
        (event === 'assistant.card' && payload.kind === 'lists'))) {
        await reader.cancel();
        throw new Error('Lancement ou carte de liste reçue avant validation.');
      }
      if (event === 'assistant.error') throw new Error(`Erreur du serveur IA : ${payload.code}`);
    }
    if (done) break;
  }
  return { text };
}
