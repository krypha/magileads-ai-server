/**
 * Rendu Markdown des réponses de l'assistant, mappé sur des composants Mantine.
 *
 * Couvre ce que l'assistant produit réellement : titres, paragraphes, listes,
 * gras/italique, `code`, blocs de code, citations, liens et surtout les
 * TABLEAUX (audits de campagne) — avec défilement horizontal.
 *
 * SÉCURITÉ : le HTML brut n'est PAS interprété (comportement par défaut de
 * react-markdown) et les URLs javascript:/data: sont neutralisées.
 * ⚠️ N'ajoute JAMAIS `rehype-raw` ici : le contenu vient d'un LLM et il est aussi
 * réutilisé tel quel dans l'export du rapport → ce serait une faille XSS.
 *
 * Dépendances : react-markdown, remark-gfm, @mantine/core (v7+).
 */

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Anchor,
  Blockquote,
  Code,
  Divider,
  List,
  ScrollArea,
  Table,
  Text,
  Title,
} from "@mantine/core";

/** Extrait le texte brut d'un arbre de children React (pour les blocs de code). */
function textOf(children) {
  if (children == null || children === false) return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children.props?.children) return textOf(children.props.children);
  return "";
}

// `node` est injecté par react-markdown : il ne doit jamais atterrir sur le DOM.
const components = {
  h1: ({ node, ...p }) => <Title order={3} mt="md" mb="xs" {...p} />,
  h2: ({ node, ...p }) => <Title order={4} mt="md" mb="xs" {...p} />,
  h3: ({ node, ...p }) => <Title order={5} mt="sm" mb={6} {...p} />,
  h4: ({ node, ...p }) => <Title order={6} mt="sm" mb={6} {...p} />,

  p: ({ node, ...p }) => <Text size="sm" my={8} style={{ lineHeight: 1.65 }} {...p} />,

  ul: ({ node, ordered, ...p }) => (
    <List size="sm" spacing={4} withPadding my={8} {...p} />
  ),
  ol: ({ node, ordered, start, ...p }) => (
    <List size="sm" spacing={4} withPadding my={8} type="ordered" {...p} />
  ),
  li: ({ node, checked, ...p }) => <List.Item {...p} />,

  strong: ({ node, ...p }) => <Text span fw={600} inherit {...p} />,
  em: ({ node, ...p }) => <Text span fs="italic" inherit {...p} />,

  a: ({ node, href, ...p }) => (
    <Anchor href={href} target="_blank" rel="noopener noreferrer" size="sm" {...p} />
  ),

  blockquote: ({ node, ...p }) => <Blockquote my="sm" p="sm" radius="md" fz="sm" {...p} />,

  hr: () => <Divider my="md" />,

  // `pre` rend directement le bloc de code (on n'imbrique pas <code> dedans).
  pre: ({ children }) => (
    <Code block my="sm" style={{ fontSize: 13, whiteSpace: "pre", overflowX: "auto" }}>
      {textOf(children)}
    </Code>
  ),
  // …donc ce mapping ne concerne plus que le code EN LIGNE.
  code: ({ node, className, children, ...p }) => (
    <Code {...p}>{children}</Code>
  ),

  // Tableaux (stats d'audit) : défilement horizontal pour ne jamais casser la mise en page.
  table: ({ node, ...p }) => (
    <ScrollArea type="auto" my="sm" offsetScrollbars>
      <Table
        striped
        highlightOnHover
        withTableBorder
        withColumnBorders
        fz="xs"
        style={{ tabularNums: true }}
        {...p}
      />
    </ScrollArea>
  ),
  thead: ({ node, ...p }) => <Table.Thead {...p} />,
  tbody: ({ node, ...p }) => <Table.Tbody {...p} />,
  tr: ({ node, isHeader, ...p }) => <Table.Tr {...p} />,
  th: ({ node, isHeader, style, ...p }) => (
    <Table.Th style={{ whiteSpace: "nowrap", ...style }} {...p} />
  ),
  td: ({ node, isHeader, style, ...p }) => <Table.Td style={style} {...p} />,
};

export default function MarkdownMessage({ children }) {
  return (
    <div style={{ wordBreak: "break-word" }}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </Markdown>
    </div>
  );
}
