/**
 * Export d'un rapport (audit de campagne…) en document HTML autonome et imprimable.
 *
 * On capture le HTML DÉJÀ RENDU du message (WYSIWYG), on l'enveloppe dans un
 * document stylé pour l'impression, puis :
 *   1. on ouvre un onglet et on déclenche l'aperçu d'impression (-> "Enregistrer en PDF") ;
 *   2. si le pop-up est bloqué, on retombe sur un TÉLÉCHARGEMENT du .html.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // enlève les accents
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "rapport"
  );
}

const PRINT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #f4f5f7; color: #1a1c1e; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    font-size: 14px; line-height: 1.6; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet { max-width: 820px; margin: 24px auto; background: #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,.12); border-radius: 14px; overflow: hidden; }
  .report-header { background: linear-gradient(135deg, #0f766e, #0e7490); color: #fff; padding: 28px 40px; }
  .report-header .brand { font-size: 12px; font-weight: 600; letter-spacing: .14em;
    text-transform: uppercase; opacity: .85; }
  .report-header h1 { margin: 6px 0 0; font-size: 24px; font-weight: 700; line-height: 1.25; }
  .report-header .date { margin-top: 8px; font-size: 12px; opacity: .85; }
  .report-body { padding: 32px 40px 12px; }
  .report-body h1 { font-size: 20px; margin: 28px 0 10px; }
  .report-body h2 { font-size: 17px; margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #e5e7eb; }
  .report-body h3 { font-size: 15px; margin: 20px 0 8px; }
  .report-body h1:first-child, .report-body h2:first-child, .report-body h3:first-child { margin-top: 0; }
  .report-body p { margin: 10px 0; }
  .report-body ul, .report-body ol { margin: 10px 0; padding-left: 22px; }
  .report-body li { margin: 4px 0; }
  .report-body strong { font-weight: 600; }
  .report-body a { color: #0e7490; }
  .report-body blockquote { margin: 12px 0; padding: 8px 14px; border-left: 3px solid #0f766e;
    background: #f0fdfa; color: #334155; border-radius: 0 6px 6px 0; }
  .report-body code { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: .88em; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
  .report-body pre { background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: 8px; overflow-x: auto; }
  .report-body pre code { background: none; color: inherit; padding: 0; }
  .report-body table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13px; }
  .report-body th, .report-body td { border: 1px solid #e5e7eb; padding: 8px 10px;
    text-align: left; vertical-align: top; }
  .report-body thead th { background: #f0fdfa; font-weight: 600; }
  .report-body tbody tr:nth-child(even) { background: #fafafa; }
  .report-footer { padding: 16px 40px 28px; color: #94a3b8; font-size: 11px; border-top: 1px solid #eef0f2; }
  @page { margin: 14mm; }
  @media print {
    html, body { background: #fff; }
    .sheet { margin: 0; box-shadow: none; border-radius: 0; max-width: none; }
    .report-body h2 { break-after: avoid; }
    .report-body table, .report-body pre, .report-body blockquote { break-inside: avoid; }
  }
`;

/** Titre du rapport = premier titre Markdown, sinon un libellé par défaut. */
export function reportTitleFrom(markdown) {
  const m = String(markdown).match(/^\s*#{1,3}\s+(.+?)\s*#*\s*$/m);
  const t = m?.[1]?.trim();
  return t && t.length <= 120 ? t : "Rapport — Groleads";
}

function buildDoc(contentHtml, title, date) {
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    // Document verrouillé : ni script, ni requête externe (le contenu vient d'un LLM).
    `<meta http-equiv="Content-Security-Policy" ` +
    `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">` +
    `<title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head>` +
    `<body><div class="sheet">` +
    `<header class="report-header"><div class="brand">Groleads</div>` +
    `<h1>${escapeHtml(title)}</h1><div class="date">${escapeHtml(date)}</div></header>` +
    `<main class="report-body">${contentHtml}</main>` +
    `<footer class="report-footer">Généré par l'assistant IA · Groleads</footer>` +
    `</div></body></html>`
  );
}

/**
 * @param {string} contentHtml  innerHTML du message déjà rendu
 * @param {{title:string, date?:string}} opts
 * @returns {boolean} false seulement si les deux voies échouent
 */
export function exportReport(contentHtml, opts) {
  const date =
    opts.date ??
    new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const doc = buildDoc(contentHtml, opts.title, date);

  const w = window.open("", "_blank");
  if (w) {
    w.document.open();
    w.document.write(doc);
    w.document.close();
    w.focus();
    setTimeout(() => {
      try {
        w.print();
      } catch {
        /* l'utilisateur peut imprimer manuellement */
      }
    }, 350);
    return true;
  }

  // Pop-up bloqué -> téléchargement du rapport autonome.
  try {
    const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(opts.title)}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch {
    return false;
  }
}
