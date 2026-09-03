function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string, prefix: number): number {
  let i = 0;
  while (i < a.length - prefix && i < b.length - prefix && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function highlightChangedPart(text: string, other: string, theme: any): string {
  const prefix = commonPrefixLength(text, other);
  const suffix = commonSuffixLength(text, other, prefix);
  if (prefix + suffix >= text.length) return text;
  return text.slice(0, prefix) + theme.inverse(text.slice(prefix, text.length - suffix)) + text.slice(text.length - suffix);
}

function renderChangedRun(run: Array<{ sign: "-" | "+"; lineNo: number; text: string }>, theme: any): string[] {
  const removed = run.filter((l) => l.sign === "-");
  const added = run.filter((l) => l.sign === "+");
  const out: string[] = [];
  const pairs = Math.min(removed.length, added.length);
  for (let i = 0; i < removed.length; i++) {
    const text = i < pairs ? highlightChangedPart(removed[i]!.text, added[i]!.text, theme) : removed[i]!.text;
    out.push(theme.fg("toolDiffRemoved", `-${removed[i]!.lineNo} ${text}`));
  }
  for (let i = 0; i < added.length; i++) {
    const text = i < pairs ? highlightChangedPart(added[i]!.text, removed[i]!.text, theme) : added[i]!.text;
    out.push(theme.fg("toolDiffAdded", `+${added[i]!.lineNo} ${text}`));
  }
  return out;
}

export function renderDiffForLeanEdit(diffText: string, theme: any): string {
  const out: string[] = [];
  let run: Array<{ sign: "-" | "+"; lineNo: number; text: string }> = [];
  let oldLine = 0;
  let newLine = 0;
  const flush = () => { if (run.length) { out.push(...renderChangedRun(run, theme)); run = []; } };
  for (const line of diffText.split("\n")) {
    if (!line || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("Index:") || line.startsWith("=")) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { flush(); oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    if (line.startsWith("-")) {
      run.push({ sign: "-", lineNo: oldLine, text: line.slice(1) });
      oldLine++;
    } else if (line.startsWith("+")) {
      run.push({ sign: "+", lineNo: newLine, text: line.slice(1) });
      newLine++;
    } else {
      flush();
      out.push(theme.fg("toolDiffContext", ` ${newLine} ${line.startsWith(" ") ? line.slice(1) : line}`));
      oldLine++;
      newLine++;
    }
  }
  flush();
  return out.join("\n");
}
