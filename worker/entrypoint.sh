#!/bin/bash
# **ファイアウォールを先に張る。忘れられる余地を作らない。**呼び出し側の手順にすると、
# 打ち忘れた 1 回でエージェントが素通しの網の上で動き出す。
# init-firewall.sh は最後に自分で検証し、通ってはいけない先に届いたら exit 1 する。
set -euo pipefail
sudo /usr/local/bin/init-firewall.sh >&2
exec "$@"
