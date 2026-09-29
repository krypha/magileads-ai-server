import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, documentReceipt, DOCUMENT_TOOL } from './documents.js';
import { AI_TOOLS, executeTool } from './tools.js';
import { cardsForTool, changesData } from './cards.js';

const table = { columns: ['Métier', 'Localisation du contact', 'Contacts', 'Actif'], rows: [
  ['Marketing / CMO', 'Île-de-France', 0, true], ['Juridique / légal', 'Germany', null, false],
] };
const args = format => ({ format, title: 'Matrice métiers & secteurs', sections: [{ heading: 'Contacts', table: structuredClone(table) }] });

test('all three document formats have a real advertised tool and validated typed contents', () => {
  assert.ok(AI_TOOLS.includes(DOCUMENT_TOOL));
  for (const format of ['docx', 'csv', 'xlsx']) {
    const result = createDocument(args(format));
    assert.equal(result.status, 'document_ready');
    assert.equal(result.document.format, format);
    assert.ok(result.document.filename.endsWith(`.${format}`));
    assert.deepEqual(result.document.sections[0].table, table);
  }
});

test('Word supports text plus tables, while CSV and Excel require compatible tables', () => {
  const word = args('docx'); word.sections[0].paragraphs = ['Rapport', 'Deuxième ligne'];
  assert.deepEqual(createDocument(word).document.sections[0].paragraphs, word.sections[0].paragraphs);
  assert.equal(createDocument({ ...word, format: 'xlsx' }).error, 'spreadsheet_requires_tables');
  assert.equal(createDocument({ ...args('csv'), sections: [args('csv').sections[0], args('csv').sections[0]] }).error, 'csv_requires_one_table');
  assert.equal(createDocument({ ...args('xlsx'), sections: [{ paragraphs: ['Rapport'] }] }).error, 'spreadsheet_requires_tables');
});

test('invalid document shapes, nonfinite numbers and misaligned rows never yield a card', () => {
  for (const value of [null, [], {}, { ...args('exe') }, { ...args('xlsx'), title: '' },
    { ...args('xlsx'), sections: [] }, { ...args('docx'), sections: [{}] },
    { ...args('xlsx'), sections: [{ table: { columns: ['A'], rows: [[1, 2]] } }] },
    { ...args('xlsx'), sections: [{ table: { columns: ['A'], rows: [[Infinity]] } }] },
    { ...args('xlsx'), sections: [{ table: { columns: ['A'], rows: [[{ formula: '=1' }]] } }] },
  ]) {
    const result = createDocument(value);
    assert.ok(result.error);
    assert.deepEqual(cardsForTool('create_document', JSON.stringify(result)), []);
  }
});

test('documents redact excluded diagnostics and secrets without shifting table values', () => {
  const input = { format: 'docx', title: 'Rapport', api_key: 'do-not-keep', sections: [{
    heading: 'Résultats', paragraphs: ['Campagnes : 3\nMauvaises adresses dans les listes : 2 525', 'Désabonnés dans les listes : 557'],
    table: { columns: ['Campagne', 'api_key', 'contact_email_bounce', 'Contacts'], rows: [
      ['Marketing', 'secret', 2525, 100], ['Cookie Manufacturing', 'secret', 10, 0],
      ['13896 contacts ne contiennent pas d\'email.', 'secret', 1, 3],
    ] },
  }] };
  const result = createDocument(input), serialized = JSON.stringify(result);
  assert.deepEqual(result.document.sections[0].paragraphs, ['Campagnes : 3']);
  assert.deepEqual(result.document.sections[0].table, { columns: ['Campagne', 'Contacts'], rows: [['Marketing', 100], ['Cookie Manufacturing', 0]] });
  assert.doesNotMatch(serialized, /secret|api_key|2525|13896|557/);
  const vertical = args('csv'); vertical.sections[0].table = { columns: ['Champ', 'Valeur'], rows: [['api_key', 'secret'], ['Total', 4]] };
  assert.deepEqual(createDocument(vertical).document.sections[0].table.rows, [['Total', 4]]);
});

test('filenames cannot carry paths, controls, reserved Windows names or another extension', () => {
  for (const name of ['../audit.exe', 'CON', 'nul.csv', '\u0000report.xlsx', 'A:B/C\\D']) {
    const result = createDocument({ ...args('docx'), filename: name });
    assert.match(result.document.filename, /\.docx$/);
    assert.doesNotMatch(result.document.filename, /[<>:"/\\|?*\u0000-\u001f]|^\.\./);
    assert.doesNotMatch(result.document.filename, /^(con|nul)\./i);
  }
});

test('download payloads are complete in normal mode, do not mutate data or call an API, and receipts stay small', async () => {
  const input = args('xlsx');
  input.sections[0].table.rows = Array.from({ length: 500 }, (_, i) => [`Métier ${i}`, `Localisation ${i}`, i, true]);
  const before = global.fetch; global.fetch = () => { throw new Error('must not fetch'); };
  try {
    const raw = await executeTool('create_document', JSON.stringify(input), { accessToken: 'caller' }, { enforceUsageLimits: true });
    const result = JSON.parse(raw), receipt = JSON.parse(documentReceipt(raw));
    assert.ok(raw.length > 12000); assert.equal(result._truncated, undefined);
    assert.equal(result.document.sections[0].table.rows.length, 500);
    assert.deepEqual(cardsForTool('create_document', raw), [{ kind: 'document', document: result.document }]);
    assert.equal(changesData('create_document', raw), false);
    assert.equal(receipt.rows, 500); assert.equal(receipt.sections, 1);
    assert.ok(JSON.stringify(receipt).length < 1000);
    assert.equal(receipt.document, undefined); assert.doesNotMatch(JSON.stringify(receipt), /Métier 499/);
    assert.equal(documentReceipt('{"error":"invalid_document"}'), '{"error":"invalid_document"}');
  } finally { global.fetch = before; }
});
