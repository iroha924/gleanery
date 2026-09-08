# PR レビューなどを走らせる使い捨てのワーカー。
#
# **信頼できない入力を読む側をここに閉じ込める。**読むのは PR の diff とクローンした
# リポジトリで、どちらも他人が書ける。`claude -p` はサブスクリプションのトークンで動くので
# `--bare` が使えず（bare mode は CLAUDE_CODE_OAUTH_TOKEN を読まない）、**クローンした
# リポジトリの .claude/settings.json のフックと .mcp.json が確認なしで走る**。
# 隔離が任意ではなく前提なのはこのため。
#
# **公式の devcontainer は土台にしない。**anthropics/claude-code の .devcontainer は
# 人が VS Code で使うもので、zsh のテーマ・エディタ・git-delta をビルド時に外部から引く。
# 信頼できないコードを走らせる箱で依存を増やす方向は逆で、公式自身も
# 「maintained base image ではなく working example」と書いている。
# **init-firewall.sh だけは丸ごと借りる**（そちらは本物で、自分で検証まで走らせる）。

FROM ubuntu:24.04

# claude と git のほかは、すべて init-firewall.sh が使う:
# iptables / ipset（規則と集合）、iproute2（既定経路から host を出す）、
# dnsutils（dig）、aggregate（CIDR をまとめる）、jq（GitHub の meta を読む）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git sudo \
      iptables ipset iproute2 dnsutils aggregate jq \
 && rm -rf /var/lib/apt/lists/*

# **root で走らせない。**claude は root だと権限の省略を拒む。
# ubuntu:24.04 は uid 1000 を `ubuntu` が先に取っているので、外してから作る。
RUN userdel -r ubuntu 2>/dev/null || true; useradd -m -u 1000 worker

# **クローンしたリポジトリが持ち込む実行経路を塞ぐ。**`claude -p` はサブスクリプションの
# トークンで動くので `--bare` が使えず、既定では**リポジトリの .claude/settings.json の
# フックと .mcp.json のサーバーが確認なしで走る**（実測: 仕込んだ SessionStart フックが走った）。
# managed settings は設定の階層で最優先なので、リポジトリ側から外せない。
# **フックを 1 本でも要るようになったら `disableAllHooks` を `allowManagedHooksOnly` へ替える。**
# `disableAllHooks` はフックだけを止める。**.mcp.json はこれでは止まらない**（実測）ので、
# run-claude が `--strict-mcp-config` を必ず足す。
COPY managed-settings.json /etc/claude-code/managed-settings.json
COPY run-claude /usr/local/bin/run-claude
COPY verify.sh /usr/local/bin/verify.sh

# **ファイアウォールを張る 1 本にだけ sudo を許す。**公式と同じ形。
COPY init-firewall.sh /usr/local/bin/init-firewall.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/init-firewall.sh /usr/local/bin/entrypoint.sh /usr/local/bin/run-claude /usr/local/bin/verify.sh \
 && echo "worker ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/worker-firewall \
 && chmod 0440 /etc/sudoers.d/worker-firewall

USER worker
WORKDIR /home/worker

# **版を固定し、自動更新を止める。**同じイメージから別の版が動くと、再現しない失敗が出る。
ARG CLAUDE_VERSION=2.1.259
RUN curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_VERSION"
ENV PATH=/home/worker/.local/bin:$PATH \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
