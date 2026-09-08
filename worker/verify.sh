#!/bin/bash
# **コンテナの中で走らせて、隔離が成立していることを確かめる。**
#
#   sudo docker run --rm --cap-add=NET_ADMIN --cap-add=NET_RAW \
#     --env-file ~/.claude/worker.env mitos-worker:<版> /usr/local/bin/verify.sh
#
# **claude が実際に答えることまで確かめる。**起動していなければフックも MCP も走らないので、
# そこを見ないと「塞げた」が空振りと区別できない。
set -uo pipefail
fail=0
ok() { echo "GREEN $1"; }
ng() { echo "RED   $1"; fail=1; }

reach() { timeout 4 bash -c "echo > /dev/tcp/$1/$2" 2>/dev/null; }

# 届いてはいけない先。DB と tailnet は host の ufw が、それ以外は init-firewall.sh が止める。
# **host(docker0) を止めているのは ufw のほうである** — init-firewall.sh は既定経路の /24 を
# 明示的に許可している。ufw の既定 deny が外れると、ここは開く。
for t in "100.113.29.17 5432 本番DB" "172.17.0.1 5432 host(docker0)" "100.111.148.102 22 tailnet の他ノード" "93.184.216.34 443 任意のインターネット"; do
  set -- $t
  reach "$1" "$2" && ng "$3 に届いてしまう ($1:$2)" || ok "$3 に届かない"
done
# 届かないと仕事にならない先。
for t in "api.github.com 443 GitHub" "api.anthropic.com 443 推論"; do
  set -- $t
  reach "$1" "$2" && ok "$3 に届く" || ng "$3 に届かない ($1:$2)"
done

# クローンしたリポジトリが持ち込む実行経路。**仕込んで、走らないことを見る。**
work=$(mktemp -d)
mkdir -p "$work/.claude"
cd "$work" && git init -q .
cat > .claude/settings.json <<'JSON'
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/HOOK_RAN"}]}]}}
JSON
cat > .mcp.json <<'JSON'
{"mcpServers":{"x":{"command":"sh","args":["-c","touch /tmp/MCP_RAN"]}}}
JSON
rm -f /tmp/HOOK_RAN /tmp/MCP_RAN
out=$(run-claude -p "2+2は？数字だけ答えて" --output-format json 2>/dev/null)
code=$?

# **先にここを見る。**claude が動いていなければ、下の 2 つは何も証明しない。
# **jq で読む。**このイメージに python3 は入っていない（実測: 解析が黙って空を返した）。
answer=$(printf '%s' "$out" | jq -r 'if .is_error then "" else .result end' 2>/dev/null)
if [ "$code" -eq 0 ] && [ -n "$answer" ]; then
  ok "claude が答えた（$answer）— 下の 2 つは空振りではない"
else
  ng "claude が答えていない（exit=$code）。下の 2 つは何も証明しない"
fi
[ -e /tmp/HOOK_RAN ] && ng "リポジトリのフックが走った" || ok "リポジトリのフックは走らない"
[ -e /tmp/MCP_RAN ]  && ng "リポジトリの .mcp.json が起動した" || ok "リポジトリの .mcp.json は起動しない"

echo
[ "$fail" -eq 0 ] && echo "隔離は成立している" || echo "**成立していない項目がある**"
exit "$fail"
