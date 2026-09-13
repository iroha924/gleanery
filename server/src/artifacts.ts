// `.mitos/` の作業領域。要件定義と設計書の置き場所と、公開してよいかを決める manifest。
//
// **承認状態は change.json だけが持つ。**本文の自然言語から推測しない。
// 文書の同期（commit の tree を読む）と `mitos check`（作業ツリーを読む）は、同じ検査を読み先だけ替えて通す。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { rootOf } from "./project.ts";

const MITOS = ".mitos";
const CHANGES = ".mitos/changes";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * 同期と画面が成果物として扱う path。これ以外の `.mitos` 配下の Markdown は取り込まない。
 * 自動記録も同じ定数で「読んだ成果物」を選ぶ。種別は画面の SessionArtifact.kind と `scripts/check-pairs.mjs` が突き合わせる。
 */
export const ARTIFACT_PATH = /^\.mitos\/changes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(requirements|design)\.md$/;
/** manifest は数行の JSON。上限が無いと、巨大なファイル 1 つで日次同期のプロセスごと落ちる（OOM）。 */
export const MAX_MANIFEST = 64 * 1024;

export type ArtifactKind = "requirements" | "design";
export type Artifact = { kind: ArtifactKind; change: string; changeTitle: string };
export type Problem = { path: string; reason: string };

const projectSchema = z.object({ schema: z.literal("mitos/project/1") }).strict();
const phase = z.object({ status: z.enum(["draft", "approved"]) }).strict();
const changeSchema = z
  .object({
    schema: z.literal("mitos/change/1"),
    title: z.string().trim().min(1).max(200),
    requirements: phase.optional(),
    design: phase.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.design && !c.requirements) {
      ctx.addIssue({ code: "custom", message: "requirements が無いのに design がある" });
    }
    if (c.design?.status === "approved" && c.requirements?.status !== "approved") {
      ctx.addIssue({ code: "custom", message: "requirements が approved でないのに design が approved" });
    }
  });
type Change = z.infer<typeof changeSchema>;

/** 検査の読み先。種別は symlink を辿らずに見る（symlink とサブモジュールは other）。 */
export type Snapshot = {
  kind: (rel: string) => "dir" | "file" | "other" | null;
  size: (rel: string) => number;
  read: (rel: string) => string;
  /** git が追っている path。分からなければ null */
  tracked: Set<string> | null;
};

/** 作業ツリーを読む（`mitos check`）。 */
export function workingTree(root: string): Snapshot {
  const stat = (rel: string) => fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false });
  return {
    kind: (rel) => {
      const st = stat(rel);
      if (!st) return null;
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    },
    size: (rel) => stat(rel)?.size ?? 0,
    read: (rel) => fs.readFileSync(path.join(root, rel), "utf8"),
    tracked: trackedChanges(root),
  };
}

/**
 * JSON を読む。**エラーにファイルの内容を出さない。**`JSON.parse` のエラー文は入力の先頭を含むので、
 * 追跡された symlink が資格情報を指していると、その断片が同期ログへ出る。
 */
function readJson(snap: Snapshot, rel: string): { value: unknown } | { reason: string } {
  const kind = snap.kind(rel);
  if (kind === null) return { reason: "無い" };
  if (kind !== "file") return { reason: "通常のファイルではない（symlink も受け付けない）" };
  if (snap.size(rel) > MAX_MANIFEST) return { reason: `大きすぎる（${MAX_MANIFEST} bytes まで）` };
  try {
    return { value: JSON.parse(snap.read(rel)) };
  } catch {
    return { reason: "JSON として読めない" };
  }
}

/**
 * Zod の理由から**入力由来の文字列を除く。**`message` は未知のキー名をそのまま含み、キー名に制御文字があれば
 * 端末と同期ログへ流れる。path は schema のキーか添字だけなので出してよい。自前の検査（custom）の文言は固定文。
 */
const zodReason = (e: z.ZodError): string =>
  e.issues
    .map((i) => `${i.path.join(".") || "(根)"}: ${i.code === "custom" ? i.message : i.code}`)
    .join(" / ");

/** `.mitos/changes` 配下で git が追っている path。git 管理外なら null。 */
function trackedChanges(root: string): Set<string> | null {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--", CHANGES], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * change 1 つを検査する。
 *
 * **Markdown より先に draft のキーを書く**契約なので、キーがあって Markdown がまだ無い状態は正常。
 * 逆に Markdown があるのにキーが無い状態は、承認されているかを決められないので不正。
 */
function inspectChange(snap: Snapshot, slug: string): { change: Change | null; problems: Problem[] } {
  const dir = `${CHANGES}/${slug}`;
  const problems: Problem[] = [];
  // 規則外の名前はそのまま出さない。制御文字を含むと端末と同期ログへ流れる。JSON.stringify は C0 だけを
  // エスケープし、C1（U+009B は ESC [ と同じに解釈する端末がある）と双方向制御を素通しするので、ASCII の外も直す。
  if (!SLUG.test(slug))
    return {
      change: null,
      problems: [
        {
          path: `${CHANGES}/${JSON.stringify(slug).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}`,
          reason: "change の名前は小文字英数字とハイフンだけにする",
        },
      ],
    };
  if (snap.kind(dir) !== "dir") {
    return {
      change: null,
      problems: [{ path: dir, reason: "ディレクトリではない（symlink も受け付けない）" }],
    };
  }
  const manifest = `${dir}/change.json`;
  const read = readJson(snap, manifest);
  if ("reason" in read) return { change: null, problems: [{ path: manifest, reason: read.reason }] };
  const parsed = changeSchema.safeParse(read.value);
  if (!parsed.success)
    return { change: null, problems: [{ path: manifest, reason: zodReason(parsed.error) }] };

  for (const kind of ["requirements", "design"] as const) {
    const md = `${dir}/${kind}.md`;
    const exists = snap.kind(md);
    if (exists !== null && exists !== "file")
      problems.push({ path: md, reason: "通常のファイルではない（symlink も受け付けない）" });
    if (exists !== null && !parsed.data[kind])
      problems.push({ path: manifest, reason: `${kind}.md があるのに ${kind} のキーが無い` });
    // 別のマシンの作業ツリーには manifest が無く、そのリポジトリの文書同期が毎日失敗する。
    if (snap.tracked?.has(md) && !snap.tracked.has(manifest))
      problems.push({ path: manifest, reason: `追跡済みの ${kind}.md に対して未追跡` });
  }
  return { change: parsed.data, problems };
}

/** `.mitos` と `.mitos/changes` が symlink でない実ディレクトリか。 */
function inspectRoot(snap: Snapshot): Problem[] {
  for (const rel of [MITOS, CHANGES]) {
    const kind = snap.kind(rel);
    if (kind === null) return [{ path: rel, reason: "無い（mitos init を実行する）" }];
    if (kind !== "dir") return [{ path: rel, reason: "ディレクトリではない（symlink も受け付けない）" }];
  }
  return [];
}

/**
 * 作業ツリーの `.mitos` を全部検査する（`mitos check`）。draft は未追跡のことが多いので、追跡状態を問わず全 change を見る。
 */
export function check(dir: string): { root: string; changes: number; problems: Problem[] } {
  const root = rootOf(dir);
  const snap = workingTree(root);
  const rootProblems = inspectRoot(snap);
  if (rootProblems.length) return { root, changes: 0, problems: rootProblems };
  const problems: Problem[] = [];
  const project = readJson(snap, `${MITOS}/project.json`);
  if ("reason" in project) problems.push({ path: `${MITOS}/project.json`, reason: project.reason });
  else {
    const parsed = projectSchema.safeParse(project.value);
    if (!parsed.success) problems.push({ path: `${MITOS}/project.json`, reason: zodReason(parsed.error) });
  }
  // `.DS_Store` のような OS の置き物で落ちないよう、ドットで始まる名前は change として扱わない。
  const slugs = fs.readdirSync(path.join(root, CHANGES)).filter((name) => !name.startsWith("."));
  for (const slug of slugs) problems.push(...inspectChange(snap, slug).problems);
  return { root, changes: slugs.length, problems };
}

/**
 * 文書の同期で取り込む成果物を決める。本文と manifest は同じ commit の tree から読むので、読む順に依存しない。
 *
 * 成果物の Markdown を持つ change だけを検査し、1 つでも不正なら problems を返す。
 * 呼び出し側はそのとき、埋め込みと DB 書き込みの前にそのリポジトリの同期を止める。
 */
export function selectArtifacts(
  snap: Snapshot,
  files: string[],
): { include: Map<string, Artifact>; problems: Problem[] } {
  const include = new Map<string, Artifact>();
  const bySlug = new Map<string, { rel: string; kind: ArtifactKind }[]>();
  for (const rel of files) {
    const m = ARTIFACT_PATH.exec(rel);
    if (m?.[1] && m[2]) bySlug.set(m[1], [...(bySlug.get(m[1]) ?? []), { rel, kind: m[2] as ArtifactKind }]);
  }
  if (bySlug.size === 0) return { include, problems: [] };
  const rootProblems = inspectRoot(snap);
  if (rootProblems.length) return { include, problems: rootProblems };
  const problems: Problem[] = [];
  for (const [slug, docs] of bySlug) {
    const r = inspectChange(snap, slug);
    problems.push(...r.problems);
    if (!r.change) continue;
    for (const { rel, kind } of docs) {
      if (r.change[kind]?.status === "approved")
        include.set(rel, { kind, change: slug, changeTitle: r.change.title });
    }
  }
  return { include, problems };
}

/**
 * `.mitos` 配下の Markdown か。承認済みの成果物以外は同期しない。**入れ子の `.mitos` も含める** —
 * 根にしか承認の判定が無いので、サブディレクトリの draft が通常の文書として検索に入る。
 */
export const underMitos = (rel: string): boolean => rel.startsWith(`${MITOS}/`) || rel.includes(`/${MITOS}/`);

/**
 * `.mitos/` を作る。**Git リポジトリの中なら常に根へ**置く。
 *
 * **symlink を辿らない。**`mkdirSync` と `writeFileSync(..., { flag: "wx" })` は既存なら EEXIST で止まり、
 * O_EXCL は末端が symlink でも止まる。途中のディレクトリの symlink は O_EXCL でも辿るので、
 * EEXIST のあとに lstat で種別を見て拒否する。
 */
export function init(dir: string): { root: string; created: boolean } {
  // rootOf() は存在しない path をそのまま返すので、先に確かめる。
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${dir} はディレクトリではない`);
  const root = rootOf(dir);
  let created = false;
  for (const rel of [MITOS, CHANGES]) {
    try {
      fs.mkdirSync(path.join(root, rel));
      created = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (workingTree(root).kind(rel) !== "dir")
        throw new Error(`${rel} がディレクトリではない（symlink も受け付けない）`);
    }
  }
  const rel = `${MITOS}/project.json`;
  try {
    fs.writeFileSync(path.join(root, rel), `${JSON.stringify({ schema: "mitos/project/1" }, null, 2)}\n`, {
      flag: "wx",
    });
    created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const read = readJson(workingTree(root), rel);
    if ("reason" in read) throw new Error(`${rel}: ${read.reason}`);
    const parsed = projectSchema.safeParse(read.value);
    if (!parsed.success) throw new Error(`${rel}: ${zodReason(parsed.error)}`);
  }
  return { root, created };
}
