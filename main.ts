// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file as lines plus its line break and whether it ends with one (SPEC.md section 3). */
interface FileText {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function trimTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function wsOnly(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

/** SPEC.md section 5: one line equal at a tier. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** All 0-based positions where O occurs in lines at a tier, from `from` on (overlapping allowed). */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2; strict: only 0) at which O occurs at or after `from`, with its positions. */
function findTierOcc(O: string[], lines: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(O, lines, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One hunk/chunk body entry. noNL is set when a `\` line follows it. */
type BodyEntry = { kind: 'ctx' | 'old' | 'new'; text: string; noNL: boolean };

/** O (context + old) and N (context + new) of a body, with context entries mapped to their O index. */
function bodyParts(entries: BodyEntry[]): {
  O: string[];
  N: { text: string; isCtx: boolean; oIdx: number }[];
  lastNoNL: boolean;
} {
  const O: string[] = [];
  const N: { text: string; isCtx: boolean; oIdx: number }[] = [];
  let oIdx = 0;
  let lastNoNL = false;
  for (const e of entries) {
    if (e.kind === 'ctx') {
      O.push(e.text);
      N.push({ text: e.text, isCtx: true, oIdx });
      oIdx += 1;
      lastNoNL = e.noNL;
    } else if (e.kind === 'old') {
      O.push(e.text);
      oIdx += 1;
    } else {
      N.push({ text: e.text, isCtx: false, oIdx: -1 });
      lastNoNL = e.noNL;
    }
  }
  return { O, N, lastNoNL };
}

/** Build the replacement lines for a match at `pos` (SPEC.md section 5). */
function buildNewLines(
  parts: { O: string[]; N: { text: string; isCtx: boolean; oIdx: number }[] },
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  const { O, N } = parts;
  const out: string[] = [];
  if (tier === 2 && O.length > 0) {
    const P = leadingWS(O[0]!);
    const F = leadingWS(fileLines[pos]!);
    for (const n of N) {
      if (n.isCtx) out.push(fileLines[pos + n.oIdx]!);
      else if (!wsOnly(n.text) && n.text.startsWith(P)) out.push(F + n.text.slice(P.length));
      else out.push(n.text);
    }
  } else {
    for (const n of N) {
      if (n.isCtx) out.push(fileLines[pos + n.oIdx]!);
      else out.push(n.text);
    }
  }
  return out;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface USection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: { A: number; entries: BodyEntry[] }[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Path from a `--- ` / `+++ ` header line: after 4 chars, to first tab, trimmed, a/ or b/ removed. */
function headerPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return stripAB(t);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const startSection = (): USection => {
    const s: USection = { oldPath: undefined, newPath: undefined, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    return s;
  };
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection();
      (cur as { gitOld?: string; gitNew?: string }).gitOld = m[1]!;
      (cur as { gitNew?: string }).gitNew = m[2]!;
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        cur = startSection();
        inHeader = true;
      }
      cur.oldPath = headerPath(line);
      cur.newPath = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk = { A: parseInt(m[1]!, 10), entries: [] as BodyEntry[] };
      cur.hunks.push(hunk);
      inHeader = false;
      i += 1;
      // Collect the body.
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          if (b.startsWith('\\')) {
            const prev = hunk.entries[hunk.entries.length - 1];
            if (prev) prev.noNL = true;
          } else if (b === '') {
            hunk.entries.push({ kind: 'ctx', text: '', noNL: false });
          } else if (b.startsWith(' ')) {
            hunk.entries.push({ kind: 'ctx', text: b.slice(1), noNL: false });
          } else if (b.startsWith('-')) {
            hunk.entries.push({ kind: 'old', text: b.slice(1), noNL: false });
          } else {
            hunk.entries.push({ kind: 'new', text: b.slice(1), noNL: false });
          }
          i += 1;
        } else {
          break;
        }
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.entries.length > 0) {
        const last = hunk.entries[hunk.entries.length - 1]!;
        if (last.kind === 'ctx' && last.text === '' && !last.noNL) hunk.entries.pop();
        else break;
      }
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        // A `--- ` line not followed by `+++ ` in a header is a parse error at the line after it.
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = headerPath(line);
      } else if (line.startsWith('rename from ')) {
        cur.oldPath = line.slice(12).trim();
      } else if (line.startsWith('rename to ')) {
        cur.newPath = line.slice(10).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      // index, old/new mode, similarity/dissimilarity, Index: and anything else: ignored.
      i += 1;
      continue;
    }
    // Outside bodies and headers: ignored (prose, code fences).
    i += 1;
  }
  // Fill paths from `diff --git` only where nothing else named one (null means /dev/null, set).
  for (const s of sections) {
    const g = s as USection & { gitOld?: string; gitNew?: string };
    if (s.oldPath === undefined && g.gitOld !== undefined) s.oldPath = stripAB(g.gitOld);
    if (s.newPath === undefined && g.gitNew !== undefined) s.newPath = stripAB(g.gitNew);
    delete g.gitOld;
    delete g.gitNew;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    edits.push(unifiedEdit(s, strict));
  }
  return edits;
}

/** Apply one hunk of a unified section to a file (SPEC.md section 6). */
function applyUnifiedHunk(file: FileText, hunk: { A: number; entries: BodyEntry[] }, d: number, strict: boolean, path: string): FileText {
  const parts = bodyParts(hunk.entries);
  const { O, N } = parts;
  if (O.length === 0) {
    const at = Math.min(hunk.A + d, file.lines.length);
    const newLines = [...file.lines.slice(0, at), ...N.map((n) => n.text), ...file.lines.slice(at)];
    const newFinal = at === file.lines.length ? !parts.lastNoNL : file.final;
    return { lines: newLines, br: file.br, final: newFinal };
  }
  const found = findTierOcc(O, file.lines, 0, strict);
  if (!found) throw new Fail('no-match', path);
  const target = hunk.A - 1 + d;
  let pos = found.occ[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      pos = p;
      best = dist;
    }
  }
  const replacement = buildNewLines(parts, file.lines, pos, found.tier);
  const newLines = [...file.lines.slice(0, pos), ...replacement, ...file.lines.slice(pos + O.length)];
  const runsToEnd = pos + O.length === file.lines.length;
  const newFinal = runsToEnd ? !parts.lastNoNL : file.final;
  return { lines: newLines, br: file.br, final: newFinal };
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = s.oldPath ?? null;
    const newPath = s.newPath ?? null;
    const isCreate = s.isCreate || oldPath === null;
    const isDelete = !isCreate && (s.isDelete || newPath === null);
    if (isCreate) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastNoNL = false;
      let anyPlus = false;
      for (const h of s.hunks) {
        for (const e of h.entries) {
          if (e.kind === 'new') {
            plus.push(e.text);
            lastNoNL = e.noNL;
            anyPlus = true;
          }
        }
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (lastNoNL ? '' : '\n');
      void anyPlus;
      tree.now.set(p, text);
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = oldPath!;
    const newP = newPath!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const isMove = oldP !== newP;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let file = parseFile(before);
    let d = 0;
    for (const h of s.hunks) {
      file = applyUnifiedHunk(file, h, d, strict, oldP);
      const parts = bodyParts(h.entries);
      d += parts.N.length - parts.O.length;
    }
    const out = serializeFile(file);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push({ old: oldP, new: newP });
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // Find ======= then >>>>>>> REPLACE after it.
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    // Path: nearest non-blank line before SEARCH, after the previous block's REPLACE,
    // that does not start with three backticks (after trimming).
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevReplace = rep;
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
        tree.now.set(p, text);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const file = parseFile(before);
      const found = findTierOcc(oldLines, file.lines, 0, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const parts = {
        O: oldLines,
        N: newLines.map((t) => ({ text: t, isCtx: false, oIdx: -1 })),
      };
      const replacement = buildNewLines(parts, file.lines, pos, found.tier);
      const newLinesOut = [...file.lines.slice(0, pos), ...replacement, ...file.lines.slice(pos + oldLines.length)];
      tree.now.set(p, serializeFile({ lines: newLinesOut, br: file.br, final: file.final }));
    });
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

type VSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | {
      kind: 'update';
      path: string;
      moveTo: string | null;
      chunks: { anchor: string | null; eof: boolean; entries: BodyEntry[] }[];
    };

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headIdx = i;
    i += 1;
    // Collect this section's raw lines (until the next section start or *** End Patch).
    const raw: string[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push(l);
      i += 1;
    }
    // Blank lines at the end of a section are not part of it (blank: empty or only whitespace).
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const out: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '') out.push('');
        else if (l.startsWith('+')) out.push(l.slice(1));
        else throw new Exit2(`error: parse ${headIdx + 2 + k}`);
      }
      sections.push({ kind: 'add', path, lines: out });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${headIdx + 2}`);
      sections.push({ kind: 'delete', path });
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        j = 1;
      }
      const chunks: { anchor: string | null; eof: boolean; entries: BodyEntry[] }[] = [];
      let cur: { anchor: string | null; eof: boolean; entries: BodyEntry[] } | null = null;
      const closeChunk = (eof: boolean): void => {
        if (cur) {
          cur.eof = eof;
          // Trailing empty context lines of a chunk are not part of it (blank at end of section
          // already trimmed; a chunk's own trailing empties stay unless the chunk is the last one).
          chunks.push(cur);
          cur = null;
        }
      };
      for (; j < raw.length; j++) {
        const l = raw[j]!;
        if (l.startsWith('@@')) {
          closeChunk(false);
          cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, entries: [] };
        } else if (l === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${headIdx + 2 + j}`);
          closeChunk(true);
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (!cur) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${headIdx + 2 + j}`);
            cur = { anchor: null, eof: false, entries: [] };
          }
          if (l === '') cur.entries.push({ kind: 'ctx', text: '', noNL: false });
          else if (l.startsWith(' ')) cur.entries.push({ kind: 'ctx', text: l.slice(1), noNL: false });
          else if (l.startsWith('-')) cur.entries.push({ kind: 'old', text: l.slice(1), noNL: false });
          else cur.entries.push({ kind: 'new', text: l.slice(1), noNL: false });
        } else {
          throw new Exit2(`error: parse ${headIdx + 2 + j}`);
        }
      }
      closeChunk(false);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headIdx + 1}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
    }
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    edits.push(v4aEdit(s, strict));
  }
  return edits;
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const text = s.lines.length === 0 ? '' : s.lines.join('\n') + '\n';
      tree.now.set(s.path, text);
      return;
    }
    if (s.kind === 'delete') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    // Update.
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let file = parseFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const aFound = findTierOcc([chunk.anchor], file.lines, cursor, strict);
        if (!aFound) throw new Fail('no-match', s.path);
        cursor = aFound.occ[0]! + 1;
      }
      const parts = bodyParts(chunk.entries);
      const { O, N } = parts;
      if (O.length === 0) {
        const at = chunk.eof ? file.lines.length : cursor;
        const ins = N.map((n) => n.text);
        const newLines = [...file.lines.slice(0, at), ...ins, ...file.lines.slice(at)];
        file = { lines: newLines, br: file.br, final: file.final };
        cursor = at + ins.length;
        continue;
      }
      const found = findTierOcc(O, file.lines, cursor, strict);
      if (!found) throw new Fail('no-match', s.path);
      let pos: number | null = null;
      for (const p of found.occ) {
        if (chunk.eof && p + O.length !== file.lines.length) continue;
        pos = p;
        break;
      }
      if (pos === null) throw new Fail('no-match', s.path);
      const replacement = buildNewLines(parts, file.lines, pos, found.tier);
      const newLines = [...file.lines.slice(0, pos), ...replacement, ...file.lines.slice(pos + O.length)];
      file = { lines: newLines, br: file.br, final: file.final };
      cursor = pos + replacement.length;
    }
    const out = serializeFile(file);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push({ old: s.path, new: s.moveTo });
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { path: string; was: string | null; now: string | null }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ path: p, was, now });
  }
  const usedPaths = new Set<string>();
  const rMoves: { old: string; new: string }[] = [];
  for (const m of tree.moves) {
    const oldE = changed.find((c) => c.path === m.old);
    const newE = changed.find((c) => c.path === m.new);
    if (oldE && oldE.was !== null && oldE.now === null && newE && newE.was === null && newE.now !== null) {
      rMoves.push(m);
      usedPaths.add(m.old);
      usedPaths.add(m.new);
    }
  }
  const items: { sortKey: string; line: string }[] = [];
  for (const c of changed) {
    if (usedPaths.has(c.path)) continue;
    const k = c.was === null ? 'A' : c.now === null ? 'D' : 'M';
    items.push({ sortKey: c.path, line: `${k} ${c.path}` });
  }
  for (const m of rMoves) items.push({ sortKey: m.new, line: `R ${m.old} -> ${m.new}` });
  items.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const rows = items.map((i) => i.line);
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.path, { force: true });
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
