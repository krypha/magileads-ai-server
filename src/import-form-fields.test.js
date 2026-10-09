import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from './prompt.js';

const profile = { permissions: [] };

test('form-based import sends destination and account to the form, with a marker the app strips', () => {
  const prompt = buildSystemPrompt(profile, { mode: 'import', formBasedImport: true });
  assert.match(prompt, /CHAMPS DU FORMULAIRE/);
  assert.match(prompt, /\[\[FORM_FIELD:list_name\]\]/);
  assert.match(prompt, /\[\[FORM_FIELD:linkedin_account\]\]/);
  // The destination is the form's: no list search for it in this flow.
  assert.doesNotMatch(prompt, /cherche-la avec list_contact_lists\(query\), puis utilise son contact_list_id/);
});

test('chat-only import still resolves an existing destination list itself', () => {
  const prompt = buildSystemPrompt(profile, { mode: 'import', formBasedImport: false });
  assert.doesNotMatch(prompt, /FORM_FIELD/);
  assert.match(prompt, /cherche-la avec list_contact_lists\(query\), puis utilise son contact_list_id/);
});
