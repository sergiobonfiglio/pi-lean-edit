function commonPrefixLength(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string[], b: string[], prefix: number): number {
  let i = 0;
  while (i < a.length - prefix && i < b.length - prefix && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function highlightChangedPart(text: string, other: string, theme: any): string {
  const points = Array.from(text);
  const otherPoints = Array.from(other);
  const prefix = commonPrefixLength(points, otherPoints);
  const suffix = commonSuffixLength(points, otherPoints, prefix);
  if (prefix + suffix >= points.length) return text;
  return points.slice(0, prefix).join("") + theme.inverse(points.slice(prefix, points.length - suffix).join("")) + points.slice(points.length - suffix).join("");
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
    if (line.startsWith("\\ No newline at end of file")) {
      flush();
      out.push(theme.fg("toolDiffContext", `   ${line}`));
      continue;
    }
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
