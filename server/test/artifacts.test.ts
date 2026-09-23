import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { check, init, selectArtifacts, workingTree } from "../src/artifacts.ts";

/** 一時ディレクトリに git リポジトリを作り、終わったら消す。 */
function withRepo(fn: (repo: string, git: (...a: string[]) => void, outside: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-artifacts-")));
  try {
    const repo = path.join(dir, "repo");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    fn(repo, git, outside);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const write = (repo: string, rel: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};
const manifest = (repo: string, slug: string, value: unknown): void =>
  write(repo, `.gleanery/changes/${slug}/change.json`, JSON.stringify(value));

test("init は repository のどこから呼んでもルートに作り、2 回目は既存として成功する", () => {
  withRepo((repo) => {
    fs.mkdirSync(path.join(repo, "sub", "deep"), { recursive: true });
    const first = init(path.join(repo, "sub", "deep"));
    assert.equal(first.root, repo);
    assert.equal(first.created, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, ".gleanery/project.json"), "utf8")), {
      schema: "gleanery/project/1",
    });
    assert.ok(fs.statSync(path.join(repo, ".gleanery/changes")).isDirectory());
    const before = fs.readFileSync(path.join(repo, ".gleanery/project.json"), "utf8");
    const second = init(repo);
    assert.equal(second.created, false);
    assert.equal(fs.readFileSync(path.join(repo, ".gleanery/project.json"), "utf8"), before);
  });
});

test("init は git 管理外では指定した場所に作る", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-plain-")));
  try {
    assert.equal(init(dir).root, dir);
    assert.ok(fs.existsSync(path.join(dir, ".gleanery/project.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init は存在しない場所を作らない", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-missing-")));
  try {
    assert.throws(() => init(path.join(dir, "nope")), /ディレクトリではない/);
    assert.equal(fs.existsSync(path.join(dir, "nope")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init は既存の未知 schema・壊れた JSON・通常ファイルを上書きしない", () => {
  withRepo((repo) => {
    write(repo, ".gleanery/project.json", JSON.stringify({ schema: "gleanery/project/9" }));
    assert.throws(() => init(repo), /project\.json/);
    assert.match(fs.readFileSync(path.join(repo, ".gleanery/project.json"), "utf8"), /project\/9/);

    write(repo, ".gleanery/project.json", "{ not json");
    assert.throws(() => init(repo), /JSON として読めない/);
    assert.equal(fs.readFileSync(path.join(repo, ".gleanery/project.json"), "utf8"), "{ not json");
  });
  withRepo((repo) => {
    write(repo, ".gleanery", "file");
    assert.throws(() => init(repo), /\.gleanery がディレクトリではない/);
  });
});

test("init は symlink を辿らず、repository の外へ書かない", () => {
  for (const rel of [".gleanery", ".gleanery/changes", ".gleanery/project.json"]) {
    withRepo((repo, _git, outside) => {
      if (rel !== ".gleanery") fs.mkdirSync(path.join(repo, ".gleanery"));
      fs.symlinkSync(outside, path.join(repo, rel));
      assert.throws(() => init(repo), `${rel} の symlink を受け付けた`);
      assert.deepEqual(fs.readdirSync(outside), [], `${rel} を辿って外に書いた`);
    });
  }
});

test("check は正しい change を通し、Markdown より先に書いた draft のキーも通す", () => {
  withRepo((repo) => {
    init(repo);
    manifest(repo, "auth", { schema: "gleanery/change/1", title: "認証", requirements: { status: "draft" } });
    assert.deepEqual(check(repo).problems, []);
    write(repo, ".gleanery/changes/auth/requirements.md", "# 要件\n");
    fs.writeFileSync(path.join(repo, ".gleanery/changes/.DS_Store"), "");
    const r = check(repo);
    assert.deepEqual(r.problems, []);
    assert.equal(r.changes, 1);
  });
});

test("check は不正な manifest を拒否し、ファイルの内容をエラーに出さない", () => {
  const cases: [string, (repo: string) => void, RegExp][] = [
    [
      "壊れた JSON",
      (repo) => write(repo, ".gleanery/changes/a/change.json", "SECRET_TOKEN=abc"),
      /JSON として読めない/,
    ],
    [
      "未知の status",
      (repo) =>
        manifest(repo, "a", { schema: "gleanery/change/1", title: "t", requirements: { status: "done" } }),
      /requirements\.status/,
    ],
    [
      "design だけ approved",
      (repo) =>
        manifest(repo, "a", {
          schema: "gleanery/change/1",
          title: "t",
          requirements: { status: "draft" },
          design: { status: "approved" },
        }),
      /approved でないのに design が approved/,
    ],
    [
      "Markdown があるのにキーが無い",
      (repo) => {
        manifest(repo, "a", { schema: "gleanery/change/1", title: "t", requirements: { status: "draft" } });
        write(repo, ".gleanery/changes/a/design.md", "# d\n");
      },
      /design\.md があるのに design のキーが無い/,
    ],
    [
      "manifest が無い",
      (repo) => write(repo, ".gleanery/changes/a/requirements.md", "# r\n"),
      /change\.json: 無い/,
    ],
    [
      "slug の規則違反",
      (repo) => manifest(repo, "Bad_Name", { schema: "gleanery/change/1", title: "t" }),
      /小文字英数字/,
    ],
  ];
  for (const [label, arrange, want] of cases) {
    withRepo((repo) => {
      init(repo);
      arrange(repo);
      const text = check(repo)
        .problems.map((p) => `${p.path}: ${p.reason}`)
        .join("\n");
      assert.match(text, want, label);
      assert.doesNotMatch(text, /SECRET_TOKEN/, `${label}: 内容がエラーに出た`);
    });
  }
});

// Zod の message は未知のキー名をそのまま含み、ディレクトリ名は制御文字を含みうる。どちらも端末と同期ログへ流れる。
// C1 の CSI（U+009B）は ESC [ と同じに解釈する端末があり、U+202E は表示の向きを反転させる。
test("check は未知のキー名と規則外の名前を、エラーにそのまま出さない", () => {
  withRepo((repo) => {
    init(repo);
    manifest(repo, "a", { schema: "gleanery/change/1", title: "t", SECRET_KEY_NAME: 1 });
    fs.mkdirSync(path.join(repo, ".gleanery/changes/bad\u001b[31m\u009b31m\u202e"));
    const text = check(repo)
      .problems.map((p) => `${p.path}: ${p.reason}`)
      .join("\n");
    assert.match(text, /unrecognized_keys/);
    assert.doesNotMatch(text, /SECRET_KEY_NAME/);
    assert.equal(text.includes("\u001b"), false, "制御文字がそのまま出た");
    assert.equal(text.includes("\u009b"), false, "C1 の CSI がそのまま出た");
    assert.equal(text.includes("\u202e"), false, "双方向制御がそのまま出た");
    assert.match(text, /\\u001b.*\\u009b.*\\u202e/);
  });
});

// 上限が無いと、巨大な change.json 1 つで取り込みのプロセスごと落ちる（OOM）。
test("check は大きすぎる manifest を読まない", () => {
  withRepo((repo) => {
    init(repo);
    write(repo, ".gleanery/changes/a/change.json", `[${"{},".repeat(30_000)}{}]`);
    assert.match(
      check(repo)
        .problems.map((p) => p.reason)
        .join("\n"),
      /大きすぎる/,
    );
  });
});

test("check は symlink の change.json を読まない", () => {
  withRepo((repo, _git, outside) => {
    init(repo);
    fs.writeFileSync(path.join(outside, "secret.env"), "SECRET_TOKEN=abc");
    fs.mkdirSync(path.join(repo, ".gleanery/changes/a"));
    fs.symlinkSync(path.join(outside, "secret.env"), path.join(repo, ".gleanery/changes/a/change.json"));
    const text = check(repo)
      .problems.map((p) => p.reason)
      .join("\n");
    assert.match(text, /symlink/);
    assert.doesNotMatch(text, /SECRET_TOKEN/);
  });
});

test("check は追跡済みの Markdown に未追跡の change.json を拒否し、git 管理外では見ない", () => {
  withRepo((repo, git) => {
    init(repo);
    manifest(repo, "a", { schema: "gleanery/change/1", title: "t", requirements: { status: "approved" } });
    write(repo, ".gleanery/changes/a/requirements.md", "# r\n");
    git("add", ".gleanery/changes/a/requirements.md");
    assert.match(
      check(repo)
        .problems.map((p) => p.reason)
        .join("\n"),
      /未追跡/,
    );
    git("add", ".gleanery/changes/a/change.json");
    assert.deepEqual(check(repo).problems, []);
  });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gleanery-plain-")));
  try {
    init(dir);
    manifest(dir, "a", { schema: "gleanery/change/1", title: "t", requirements: { status: "approved" } });
    write(dir, ".gleanery/changes/a/requirements.md", "# r\n");
    assert.deepEqual(check(dir).problems, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("同期は approved の成果物だけを選び、.gleanery のそれ以外を選ばない", () => {
  withRepo((repo) => {
    init(repo);
    manifest(repo, "auth", {
      schema: "gleanery/change/1",
      title: "認証",
      requirements: { status: "approved" },
      design: { status: "draft" },
    });
    write(repo, ".gleanery/changes/auth/requirements.md", "# r\n");
    write(repo, ".gleanery/changes/auth/design.md", "# d\n");
    write(repo, ".gleanery/notes.md", "# n\n");
    const r = selectArtifacts(workingTree(repo), [
      ".gleanery/changes/auth/requirements.md",
      ".gleanery/changes/auth/design.md",
      ".gleanery/notes.md",
      "README.md",
    ]);
    // 未追跡の change.json も問題になるが、ここで見たいのは選別なので追跡状態は問わない
    assert.deepEqual(
      [...r.include.entries()],
      [
        [
          ".gleanery/changes/auth/requirements.md",
          { kind: "requirements", change: "auth", changeTitle: "認証" },
        ],
      ],
    );
  });
});

test("同期は追跡済みの成果物を持つ change の不正を問題として返す", () => {
  withRepo((repo, git) => {
    init(repo);
    manifest(repo, "a", { schema: "gleanery/change/1", title: "t", requirements: { status: "approved" } });
    write(repo, ".gleanery/changes/a/requirements.md", "# r\n");
    git("add", "-A");
    assert.deepEqual(
      selectArtifacts(workingTree(repo), [".gleanery/changes/a/requirements.md"]).problems,
      [],
    );
    write(repo, ".gleanery/changes/a/change.json", "{");
    const r = selectArtifacts(workingTree(repo), [".gleanery/changes/a/requirements.md"]);
    assert.equal(r.include.size, 0);
    assert.match(r.problems.map((p) => p.reason).join("\n"), /JSON として読めない/);
    // 成果物を 1 つも追跡していなければ .gleanery を読みにいかない
    assert.deepEqual(selectArtifacts(workingTree(repo), ["README.md"]).problems, []);
  });
});
