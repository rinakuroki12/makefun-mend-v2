// mend applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits as specified in SPEC.md.
// It uses Node's standard library and runs as `node main.ts [options] [PATCH]`.
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
  readonly origins = new Map<string, string | null>();
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
  origin(p: string): string | null {
    return this.origins.has(p) ? this.origins.get(p)! : this.original(p) === null ? null : p;
  }
  set(p: string, value: string | null, origin?: string | null): void {
    this.now.set(p, value);
    this.origins.set(p, value === null ? null : origin === undefined ? this.origin(p) : origin);
  }
  move(from: string, to: string, value: string): void {
    const origin = this.origin(from);
    this.set(from, null, null);
    this.set(to, value, origin);
  }
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
      tree.set(p, text, null);
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
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
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
      tree.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

type FileLines = { lines: string[]; final: boolean; br: string };
function fileLines(text: string): FileLines {
  const n = text.indexOf('\n');
  const br = n > 0 && text[n - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], final: false, br };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, final, br };
}
function buildFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}
function leading(s: string): string { return (s.match(/^[ \t]*/) ?? [''])[0]!; }
function tierLine(s: string, tier: number): string {
  if (tier === 1) return s.replace(/[ \t]+$/g, '');
  if (tier === 2) return s.replace(/^[ \t]+|[ \t]+$/g, '');
  return s;
}
function occurrences(hay: string[], needle: string[], tier: number, start = 0, eof = false): number[] {
  if (needle.length === 0) return [];
  const out: number[] = [];
  for (let i = Math.max(0, start); i + needle.length <= hay.length; i++) {
    if (eof && i + needle.length !== hay.length) continue;
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (tierLine(hay[i + j]!, tier) !== tierLine(needle[j]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(hay: string[], needle: string[], strict: boolean, start = 0, eof = false): { tier: number; positions: number[] } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const positions = occurrences(hay, needle, tier, start, eof);
    if (positions.length) return { tier, positions };
  }
  return null;
}
type BodyLine = { kind: 'context' | 'old' | 'new'; text: string; noNl?: boolean };
function oldNew(body: BodyLine[]): { old: string[]; newer: string[] } {
  const old: string[] = [], newer: string[] = [];
  for (const e of body) {
    if (e.kind !== 'new') old.push(e.text);
    if (e.kind !== 'old') newer.push(e.text);
  }
  return { old, newer };
}
function tier2New(lines: string[], source: string, oldFirst: string): string[] {
  const f = leading(source), p = leading(oldFirst);
  return lines.map((line) => line !== '' && line.trim() !== '' && line.startsWith(p) ? f + line.slice(p.length) : line);
}
function applyLineReplacement(file: FileLines, body: BodyLine[], at: number, tier: number): number {
  const { old, newer } = oldNew(body);
  const adapted = tier === 2 && old.length ? tier2New(newer, file.lines[at]!, old[0]!) : newer;
  // Context lines are emitted from their original matched positions; old lines advance that position too.
  let consumed = 0, out: string[] = [], newIndex = 0;
  for (const e of body) {
    if (e.kind === 'context') { out.push(file.lines[at + consumed]!); consumed++; newIndex++; }
    else if (e.kind === 'old') consumed++;
    else { out.push(adapted[newIndex]!); newIndex++; }
  }
  file.lines.splice(at, old.length, ...out);
  return out.length;
}
function oneSafe(...paths: string[]): void { for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p); }

type UnifiedHunk = { line: number; target: number; body: BodyLine[]; finalNoNl: boolean };
type UnifiedSection = { line: number; oldPath: string | null; newPath: string | null; renameFrom: string | null; renameTo: string | null; isNew: boolean; isDelete: boolean; hunks: UnifiedHunk[] };
function gitPath(s: string): string { return s.replace(/^[ab]\//, ''); }
function headerPath(s: string): string {
  const tab = s.indexOf('\t');
  return gitPath((tab >= 0 ? s.slice(0, tab) : s).trim());
}
function pairHeader(lines: string[], i: number): boolean { return lines[i]?.startsWith('--- ') === true && (lines[i + 1] ?? '').startsWith('+++ '); }
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (!line.startsWith('diff --git ') && !pairHeader(lines, i)) { i++; continue; }
    const s: UnifiedSection = { line: i + 1, oldPath: null, newPath: null, renameFrom: null, renameTo: null, isNew: false, isDelete: false, hunks: [] };
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*?)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      s.oldPath = m[1]!; s.newPath = m[2]!; i++;
    } else {
      s.oldPath = headerPath(line.slice(4)); s.newPath = headerPath(lines[i + 1]!.slice(4)); i += 2;
    }
    let sawPair = line.startsWith('--- ');
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('diff --git ')) break;
      if (pairHeader(lines, i)) {
        if (!sawPair && s.hunks.length === 0) {
          s.oldPath = headerPath(h.slice(4)); s.newPath = headerPath(lines[i + 1]!.slice(4));
          sawPair = true; i += 2; continue;
        }
        break;
      }
      if (h.startsWith('@@')) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/.exec(h);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        const target = Number(m[1]);
        const hunk: UnifiedHunk = { line: i + 1, target, body: [], finalNoNl: false };
        i++;
        while (i < lines.length) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ') || pairHeader(lines, i) || b.startsWith('@@')) break;
          if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
            const kind = b === '' || b[0] === ' ' ? 'context' : b[0] === '-' ? 'old' : 'new';
            hunk.body.push({ kind, text: b === '' ? '' : b.slice(1) });
            i++; continue;
          }
          if (b.startsWith('\\')) {
            const prev = hunk.body[hunk.body.length - 1];
            if (prev) prev.noNl = true;
            i++; continue;
          }
          break;
        }
        while (hunk.body.length && hunk.body[hunk.body.length - 1]!.kind === 'context' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
        const finalOutput = [...hunk.body].reverse().find((e) => e.kind !== 'old');
        hunk.finalNoNl = finalOutput?.noNl === true;
        s.hunks.push(hunk);
        continue;
      }
      if (h.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        s.oldPath = headerPath(h.slice(4)); s.newPath = headerPath(lines[i + 1]!.slice(4)); sawPair = true; i += 2; continue;
      }
      if (h.startsWith('rename from ')) s.renameFrom = h.slice(12).trim();
      else if (h.startsWith('rename to ')) s.renameTo = h.slice(10).trim();
      else if (h.startsWith('new file mode ')) s.isNew = true;
      else if (h.startsWith('deleted file mode ')) s.isDelete = true;
      i++;
    }
    if (!sawPair) {
      if (s.renameFrom !== null) s.oldPath = s.renameFrom;
      if (s.renameTo !== null) s.newPath = s.renameTo;
    }
    sections.push(s);
  }
  if (!sections.length) throw new Exit2('error: parse 1');
  return sections.map((s): Edit => (tree) => {
    const oldP = s.oldPath, newP = s.newPath;
    if (oldP !== null && oldP !== '/dev/null') oneSafe(oldP);
    if (newP !== null && newP !== '/dev/null') oneSafe(newP);
    const creation = oldP === '/dev/null' || s.isNew;
    const deletion = newP === '/dev/null' || s.isDelete;
    const src = creation ? null : oldP;
    const dst = deletion ? null : newP;
    if (src === null) {
      const p = dst!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let finalNoNl = false;
      for (const h of s.hunks) for (const e of h.body) if (e.kind === 'new') { out.push(e.text); finalNoNl = e.noNl === true; }
      tree.set(p, out.length ? out.join('\n') + (finalNoNl ? '' : '\n') : '', null);
      return;
    }
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (deletion) { tree.set(src, null, null); return; }
    if (dst !== src && tree.get(dst!) !== null) throw new Fail('exists', dst!);
    const f = fileLines(before);
    let d = 0;
    for (const h of s.hunks) {
      const { old, newer } = oldNew(h.body);
      let at: number;
      let tier = 0;
      if (old.length) {
        const found = findTier(f.lines, old, strict);
        if (!found) throw new Fail('no-match', src);
        tier = found.tier;
        const target = h.target - 1 + d;
        at = found.positions.reduce((best, x) => Math.abs(x - target) < Math.abs(best - target) || (Math.abs(x - target) === Math.abs(best - target) && x < best) ? x : best);
      } else at = Math.min(f.lines.length, Math.max(0, h.target + d));
      const end = at + old.length === f.lines.length;
      const written = applyLineReplacement(f, h.body, at, tier);
      d += newer.length - old.length;
      if (end) f.final = !h.finalNoNl;
    }
    const result = buildFile(f);
    if (dst !== src) tree.move(src, dst!, result); else tree.set(src, result);
  });
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const markers = (i: number, text: string) => (lines[i] ?? '').trimEnd() === text;
  const edits: Edit[] = [];
  let prevEnd = -1, previousPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!markers(i, '<<<<<<< SEARCH')) continue;
    let sep = i + 1;
    while (sep < lines.length && !markers(sep, '=======')) sep++;
    let end = sep + 1;
    while (end < lines.length && !markers(end, '>>>>>>> REPLACE')) end++;
    if (sep >= lines.length || end >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) { path = t; break; }
    }
    if (path === null) path = previousPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    const p = path;
    const old = lines.slice(i + 1, sep), newer = lines.slice(sep + 1, end);
    edits.push((tree) => {
      oneSafe(p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.set(p, newer.length ? newer.join('\n') + '\n' : '', null);
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const f = fileLines(text), found = findTier(f.lines, old, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const body: BodyLine[] = old.map((x) => ({ kind: 'old', text: x })).concat(newer.map((x) => ({ kind: 'new', text: x })));
      applyLineReplacement(f, body, found.positions[0]!, found.tier);
      tree.set(p, buildFile(f));
    });
    previousPath = p; prevEnd = end; i = end;
  }
  if (!edits.length) throw new Exit2('error: parse 1');
  return edits;
}

type VChunk = { anchor: string | null; eof: boolean; body: BodyLine[] };
type VSection = { kind: 'add' | 'delete' | 'update'; line: number; path: string; move: string | null; lines: string[]; chunks: VChunk[] };
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1; while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const header = lines[i]!, m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(header);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = { kind: m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update', line: i + 1, path: m[2]!.trim(), move: null, lines: [], chunks: [] };
    i++;
    const start = i;
    while (i < last && !/^\*\*\* (?:Add File|Delete File|Update File): /.test(lines[i]!)) i++;
    let region = lines.slice(start, i);
    while (region.length && blank(region[region.length - 1]!)) region.pop();
    if (sec.kind === 'add') {
      for (let j = 0; j < region.length; j++) {
        const l = region[j]!;
        if (l === '') sec.lines.push('');
        else if (l.startsWith('+')) sec.lines.push(l.slice(1));
        else throw new Exit2(`error: parse ${start + j + 1}`);
      }
    } else if (sec.kind === 'delete') {
      if (region.length) throw new Exit2(`error: parse ${start + 1}`);
    } else {
      let j = 0;
      if (region[0]?.startsWith('*** Move to: ')) { sec.move = region[0]!.slice(13).trim(); j++; }
      let chunk: VChunk | null = null;
      const finish = () => { if (chunk) { sec.chunks.push(chunk); chunk = null; } };
      for (; j < region.length; j++) {
        const l = region[j]!, ln = start + j + 1;
        if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${ln}`);
        if (l === '*** End of File') {
          if (!chunk) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${start + j + 1}`);
            chunk = { anchor: null, eof: true, body: [] };
          }
          else chunk.eof = true;
          finish(); continue;
        }
        if (l.startsWith('@@')) {
          finish(); chunk = { anchor: l.slice(2).trim() || null, eof: false, body: [] }; continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (!chunk) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
            chunk = { anchor: null, eof: false, body: [] };
          }
          chunk.body.push({ kind: l === '' || l[0] === ' ' ? 'context' : l[0] === '-' ? 'old' : 'new', text: l === '' ? '' : l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      finish();
      if (!sec.chunks.length && sec.move === null) throw new Exit2(`error: parse ${sec.line}`);
    }
    sections.push(sec);
  }
  if (!sections.length) throw new Exit2('error: parse 1');
  return sections.map((s): Edit => (tree) => {
    oneSafe(s.path, ...(s.move === null ? [] : [s.move]));
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.set(s.path, s.lines.length ? s.lines.join('\n') + '\n' : '', null); return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.kind === 'delete') { tree.set(s.path, null, null); return; }
    if (s.move !== null && tree.get(s.move) !== null) throw new Fail('exists', s.move);
    const f = fileLines(before);
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null) {
        const found = findTier(f.lines, [c.anchor], strict, cursor);
        if (!found) throw new Fail('no-match', s.path);
        cursor = found.positions[0]! + 1;
      }
      const { old } = oldNew(c.body);
      let at: number;
      let tier = 0;
      if (old.length) {
        const found = findTier(f.lines, old, strict, cursor, c.eof);
        if (!found) throw new Fail('no-match', s.path);
        tier = found.tier; at = found.positions[0]!;
      } else at = c.eof ? f.lines.length : Math.min(f.lines.length, cursor);
      const written = applyLineReplacement(f, c.body, at, tier);
      cursor = at + written;
    }
    const result = buildFile(f);
    if (s.move !== null) tree.move(s.path, s.move, result); else tree.set(s.path, result);
  });
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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchEdits(lines, strict)
      : kind === 'v4a' ? v4aEdits(lines, strict)
      : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeOrigins = new Map(tree.origins);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.origins.clear();
      for (const [k, v] of beforeOrigins) tree.origins.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const movedOrigins = new Map<string, string>();
  for (const p of tree.now.keys()) {
    if (tree.get(p) === null) continue;
    const origin = tree.origin(p);
    if (origin !== null && origin !== p && tree.original(origin) !== null && tree.original(p) === null && tree.get(origin) === null) movedOrigins.set(origin, p);
  }
  const movedOld = new Set(movedOrigins.keys()), movedNew = new Set(movedOrigins.values());
  const items: { sort: string; line: string; path: string; old?: string }[] = [];
  for (const [oldPath, newPath] of movedOrigins) items.push({ sort: newPath, line: `R ${oldPath} -> ${newPath}`, path: newPath, old: oldPath });
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    if (was === now) continue;
    items.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p });
  }
  items.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  for (const item of items) {
    const p = item.path;
    const now = tree.get(p);
    if (check) continue;
    if (item.line.startsWith('D ')) rmSync(p, { force: true });
    else if (item.line.startsWith('R ')) {
      rmSync(item.old!, { force: true });
      const contents = tree.get(p)!;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, contents);
    }
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now!);
    }
  }
  return { code: 0, out: [...items.map((x) => x.line), `ok: ${items.length} ${items.length === 1 ? 'file' : 'files'}`] };
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
