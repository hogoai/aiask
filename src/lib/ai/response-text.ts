/** Collect final answer text without including reasoning or tool outputs. */
export function getOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("output" in payload) || !Array.isArray(payload.output)) return null;
  const messages: string[] = [];
  for (const item of payload.output) {
    if (!item || typeof item !== "object" || item.type !== "message" || !Array.isArray(item.content)) continue;
    const text = item.content
      .filter((part: unknown): part is { type: "output_text"; text: string } => Boolean(
        part && typeof part === "object" && "type" in part && part.type === "output_text" && "text" in part && typeof part.text === "string",
      ))
      .map((part: { text: string }) => part.text)
      .join("");
    if (text.trim()) messages.push(text);
  }
  return messages.length ? messages.join("\n\n") : null;
}
