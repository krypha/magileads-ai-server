import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, languageInstruction } from './language.js';

test('the last message language is detected for the five app languages', () => {
  assert.equal(detectLanguage('How many contact lists do I have, and which one is the biggest?'), 'en');
  assert.equal(detectLanguage("j'ai combien de contacts avec civilité « Monsieur » en tout ?"), 'fr');
  assert.equal(detectLanguage('Wie viele Kontaktlisten habe ich und welche ist die größte?'), 'de');
  assert.equal(detectLanguage('¿Cuántas listas de contactos tengo y cuál es la más grande?'), 'es');
  assert.equal(detectLanguage('Quante liste di contatti ho e quale è la più grande?'), 'it');
});

test('screen context before the question does not decide the language', () => {
  const message = '[Screen context from the app, not written by the user]\nPage: Contact list. The list has 406 contacts.\n\nCombien de contacts ont un email dans cette liste ?';
  assert.equal(detectLanguage(message), 'fr');
});

test('too short or unclear messages name no language', () => {
  assert.equal(detectLanguage('ok'), null);
  assert.equal(detectLanguage('test'), null);
  assert.equal(languageInstruction('merci'), null);
  assert.match(languageInstruction('How many lists do I have?'), /anglais/);
});
