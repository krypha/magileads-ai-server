import { hasSecret, redactHiddenAuditText, sanitize } from './assistant-policy.js';

const cell = { type: ['string', 'number', 'boolean', 'null'] };
export const DOCUMENT_TOOL = {
  type: 'function',
  function: {
    name: 'create_document',
    description: 'Préparer un fichier Word (.docx), CSV (.csv) ou Excel (.xlsx) téléchargeable dans le chat. Aucun stockage ni upload ; le front génère le fichier. Utiliser uniquement les textes demandés et les données réellement obtenues. CSV = un tableau ; Excel = une feuille par section ; Word = titres, paragraphes et tableaux.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        format: { type: 'string', enum: ['docx', 'csv', 'xlsx'] },
        title: { type: 'string', description: 'Titre du document.' },
        filename: { type: 'string', description: 'Nom de fichier facultatif, sans chemin. L’extension est imposée par le format.' },
        sections: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              heading: { type: 'string', description: 'Titre de section Word ou nom de feuille Excel.' },
              paragraphs: { type: 'array', items: { type: 'string' }, description: 'Word uniquement : texte brut, retours à la ligne autorisés.' },
              table: {
                type: 'object', additionalProperties: false,
                properties: {
                  columns: { type: 'array', minItems: 1, items: { type: 'string' } },
                  rows: { type: 'array', items: { type: 'array', items: cell }, description: 'Chaque ligne a exactement autant de cellules que columns. Nombres = valeurs numériques, null = valeur manquante, jamais un zéro inventé.' },
                },
                required: ['columns', 'rows'],
              },
            },
          },
        },
      },
      required: ['format', 'title', 'sections'],
    },
  },
};

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? sanitize(redactHiddenAuditText(value)) ?? '' : '';
const hiddenText = value => typeof value === 'string' && text(value) !== value;
const hiddenColumn = value => hiddenText(value) || hasSecret({ [value.replace(/\s+/g, '_')]: true });
const secretLabel = value => typeof value === 'string' && /^(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|cookie|credentials?)$/i.test(value.trim());
const validCell = value => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

function filename(value, title, format) {
  let base = typeof value === 'string' && value.trim() ? value.trim() : title;
  base = base.replace(/\.[a-z0-9]{1,10}$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 160);
  if (!base || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = 'document';
  return `${base}.${format}`;
}

/** Validate and project model arguments. Never return arbitrary properties. */
export function createDocument(args) {
  if (!object(args) || !['docx', 'csv', 'xlsx'].includes(args.format) || !text(args.title).trim() || !Array.isArray(args.sections) || !args.sections.length) {
    return { error: 'invalid_document', note: 'Préciser format, title et au moins une section non vide.' };
  }
  const sections = [];
  for (const section of args.sections) {
    if (!object(section) || (section.heading != null && typeof section.heading !== 'string') ||
      (section.paragraphs != null && (!Array.isArray(section.paragraphs) || section.paragraphs.some(p => typeof p !== 'string')))) {
      return { error: 'invalid_document_section' };
    }
    const heading = text(section.heading).trim();
    const paragraphs = (section.paragraphs ?? []).map(text).filter(p => p.trim());
    let table;
    if (section.table != null) {
      const input = section.table;
      if (!object(input) || !Array.isArray(input.columns) || !input.columns.length || input.columns.length > 16_384 ||
        input.columns.some(column => typeof column !== 'string' || !column.trim()) ||
        !Array.isArray(input.rows) || input.rows.length >= 1_048_576 ||
        input.rows.some(row => !Array.isArray(row) || row.length !== input.columns.length || row.some(value => !validCell(value)))) {
        return { error: 'invalid_document_table', note: 'Chaque ligne doit avoir autant de cellules que de colonnes ; cellules texte, nombre, booléen ou null.' };
      }
      // Remove excluded diagnostics/secrets as whole columns or rows, never
      // shift a value under the wrong header when sanitizing array contents.
      const indices = input.columns.map((column, index) => hiddenColumn(column) ? -1 : index).filter(index => index >= 0);
      if (!indices.length) return { error: 'document_has_no_exportable_columns' };
      table = {
        columns: indices.map(index => input.columns[index]),
        rows: input.rows.filter(row => !secretLabel(row[0]) && !indices.some(index => hiddenText(row[index])))
          .map(row => indices.map(index => row[index])),
      };
    }
    if (args.format !== 'docx' && (!table || paragraphs.length)) {
      return { error: 'spreadsheet_requires_tables', note: 'CSV/Excel : un tableau dans chaque section, sans paragraphes. Utiliser Word pour un rapport rédigé.' };
    }
    if (!paragraphs.length && !table) return { error: 'empty_document_section' };
    sections.push({ ...(heading ? { heading } : {}), ...(paragraphs.length ? { paragraphs } : {}), ...(table ? { table } : {}) });
  }
  if (args.format === 'csv' && sections.length !== 1) return { error: 'csv_requires_one_table', note: 'Un CSV contient un seul tableau. Utiliser Excel pour plusieurs feuilles.' };
  if (args.format === 'xlsx' && sections.some(section => section.table.columns.some(column => column.length > 32_767) || section.table.rows.some(row => row.some(value => typeof value === 'string' && value.length > 32_767)))) {
    return { error: 'spreadsheet_cell_too_long', note: 'Une cellule Excel ne peut dépasser 32 767 caractères. Utiliser Word pour les textes longs.' };
  }
  const document = { format: args.format, title: text(args.title).trim(), filename: filename(args.filename, text(args.title), args.format), sections };
  return { status: 'document_ready', document };
}

/** The downloadable contents go to the UI once; the model only needs receipt. */
export function documentReceipt(raw) {
  try {
    const result = JSON.parse(raw);
    if (result.status !== 'document_ready' || !result.document) return raw;
    const { format, title, filename, sections } = result.document;
    return JSON.stringify({ status: result.status, format, title, filename, sections: sections.length,
      rows: sections.reduce((count, section) => count + (section.table?.rows.length ?? 0), 0),
      note: 'La carte de téléchargement est affichée. Le navigateur génère le fichier au clic ; aucun fichier n’est enregistré sur le serveur IA. Ne recopie pas son contenu.' });
  } catch { return raw; }
}
