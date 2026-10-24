/** The bullet lines of MEMORY.md, each with the line it sits on so one can be taken out again. */
export interface MemoryNote {
  line: number;
  text: string;
}

const BULLET = /^\s*[-*]\s+(.+?)\s*$/;

export function memoryNotes(text: string): MemoryNote[] {
  return text.split("\n").flatMap((raw, line) => {
    const note = BULLET.exec(raw)?.[1];
    return note ? [{ line, text: note }] : [];
  });
}

export function withoutMemoryNote(text: string, line: number): string {
  const lines = text.split("\n");
  if (!BULLET.test(lines[line] ?? "")) return text;
  lines.splice(line, 1);
  return lines.join("\n");
}

export function withMemoryNote(text: string, note: string): string {
  const body = text.replace(/\s+$/, "");
  const bullet = `- ${note.trim().replace(/\s*\n\s*/g, " ")}`;
  return body ? `${body}\n${bullet}\n` : `${bullet}\n`;
}
