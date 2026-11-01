import type { ReactNode } from "react";

type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "rule" }
  | { type: "table"; headers: string[]; rows: string[][] };

function listItem(line: string): { ordered: boolean; text: string } | null {
  const ordered = line.match(/^ {0,3}\d+[.)]\s+(.+)$/);
  if (ordered) return { ordered: true, text: ordered[1] };
  const unordered = line.match(/^ {0,3}[-*+]\s+(.+)$/);
  return unordered ? { ordered: false, text: unordered[1] } : null;
}

function splitTableRow(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
}

function isTableSeparator(line: string) {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function startsBlock(lines: string[], index: number) {
  const line = lines[index];
  return /^ {0,3}#{1,6}\s+/.test(line)
    || /^\s*```/.test(line)
    || /^ {0,3}>/.test(line)
    || listItem(line) !== null
    || /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1]));
}

function parseBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (/^\s*```/.test(line)) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    if (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const item = listItem(line);
    if (item) {
      const items: string[] = [];
      const ordered = item.ordered;
      while (index < lines.length) {
        const current = listItem(lines[index]);
        if (current && current.ordered === ordered) {
          items.push(current.text);
          index += 1;
          continue;
        }
        if (!lines[index].trim()) {
          let next = index + 1;
          while (next < lines.length && !lines[next].trim()) next += 1;
          const nextItem = next < lines.length ? listItem(lines[next]) : null;
          if (nextItem?.ordered === ordered) {
            index = next;
            continue;
          }
          break;
        }
        if (/^\s{2,}\S/.test(lines[index]) && items.length > 0) {
          items[items.length - 1] += ` ${lines[index].trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^ {0,3}>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join(" ") });
      continue;
    }

    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;
  return text.split(pattern).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{renderInline(part.slice(2, -2))}</strong>;
    if (part.startsWith("__") && part.endsWith("__")) return <strong key={index}>{renderInline(part.slice(2, -2))}</strong>;
    if (part.startsWith("~~") && part.endsWith("~~")) return <del key={index}>{renderInline(part.slice(2, -2))}</del>;
    if (part.startsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) {
      return <em key={index}>{renderInline(part.slice(1, -1))}</em>;
    }
    return part;
  });
}

function splitReadingParagraph(text: string): string[] {
  // Keep inline Markdown intact; existing Markdown paragraphs retain their structure.
  if (text.length < 200 || /[*_`\[\]]/.test(text) || typeof Intl.Segmenter === "undefined") return [text];
  const sentences = new Intl.Segmenter("zh", { granularity: "sentence" }).segment(text);
  const paragraphs: string[] = [];
  let paragraph = "";
  for (const { segment } of sentences) {
    if (paragraph && paragraph.length + segment.length > 160) {
      paragraphs.push(paragraph.trim());
      paragraph = "";
    }
    paragraph += segment;
  }
  if (paragraph.trim()) paragraphs.push(paragraph.trim());
  return paragraphs;
}

export default function MarkdownContent({ content, readableParagraphs = false }: { content: string; readableParagraphs?: boolean }) {
  const blocks = parseBlocks(content);
  return <div className="markdown-content">
    {blocks.map((block, index) => {
      if (block.type === "heading") {
        const content = renderInline(block.text);
        if (block.level === 1) return <h1 key={index}>{content}</h1>;
        if (block.level === 2) return <h2 key={index}>{content}</h2>;
        if (block.level === 3) return <h3 key={index}>{content}</h3>;
        if (block.level === 4) return <h4 key={index}>{content}</h4>;
        if (block.level === 5) return <h5 key={index}>{content}</h5>;
        return <h6 key={index}>{content}</h6>;
      }
      if (block.type === "paragraph") return (readableParagraphs ? splitReadingParagraph(block.text) : [block.text]).map((paragraph, paragraphIndex) => <p key={`${index}-${paragraphIndex}`}>{renderInline(paragraph)}</p>);
      if (block.type === "list") {
        const List = block.ordered ? "ol" : "ul";
        return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</List>;
      }
      if (block.type === "quote") return <blockquote key={index}>{renderInline(block.text)}</blockquote>;
      if (block.type === "code") return <pre key={index}><code>{block.text}</code></pre>;
      if (block.type === "table") return <div className="markdown-table-wrap" key={index}><table><thead><tr>{block.headers.map((header, headerIndex) => <th key={headerIndex}>{renderInline(header)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.headers.map((_, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] ?? "")}</td>)}</tr>)}</tbody></table></div>;
      return <hr key={index} />;
    })}
  </div>;
}
