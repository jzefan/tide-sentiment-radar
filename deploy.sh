#!/usr/bin/env bash
#
# 潮汐 · A股舆情雷达 一键部署脚本
# 用法：
#   ./deploy.sh            # 交互式输入 SSH 密码（仅首次需要）
#   ./deploy.sh --check    # 只做本地打包检查，不部署
#   SSH_PORT=22022 ./deploy.sh   # SSH 端口非 22 时
set -euo pipefail

SERVER_HOST="218.244.152.142"
SERVER_PORT="20085"
SERVER_USER="xht2020"
REMOTE_DIR="~/stock"
SSH_PORT="${SSH_PORT:-22}"

CONTROL_PATH="$HOME/.ssh/cm-tide-deploy-%r@%h:%p"
# 注意：ssh 用小写 -p 指定端口，scp 用大写 -P；两者不能共用同一组参数。
SSH_OPTS=(-o ControlMaster=auto -o ControlPath="$CONTROL_PATH" -o ControlPersist=600 -o ConnectTimeout=10 -p "$SSH_PORT")
SCP_OPTS=(-o ControlMaster=auto -o ControlPath="$CONTROL_PATH" -o ConnectTimeout=10 -P "$SSH_PORT")

# 远程命令统一通过登录 shell 执行，使 PATH 与用户交互登录时一致：
# 系统级安装的 node/npm 通常依赖 /etc/profile.d 等登录脚本注入 PATH，
# 而 ssh 直接执行命令时不会加载这些脚本，导致明明已安装却检测不到。
remote() {
  local cmd
  printf -v cmd '%q ' "$1"
  ssh "${SSH_OPTS[@]}" "$SERVER_USER@$SERVER_HOST" "bash -lc $cmd"
}

# npm 源：默认用国内镜像（服务器访问国外源经常超时），可覆盖：
# NPM_REGISTRY=https://registry.npmjs.org ./deploy.sh
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
REMOTE_ENV="export PATH=\"\$PATH:\$HOME/.local/bin:/usr/local/bin\"; export npm_config_registry=\"$NPM_REGISTRY\""

say()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[deploy] 失败：%s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 本地打包
TARBALL="tide-release-$(date +%Y%m%d-%H%M%S).tar.gz"
say "正在打包项目（排除 node_modules / dist / data / .git）……"
tar --no-xattrs \
    --exclude='./node_modules' \
    --exclude='./dist' \
    --exclude='./data' \
    --exclude='./.git' \
    --exclude='./.pnpm-store' \
    --exclude='./*.tsbuildinfo' \
    --exclude='./.DS_Store' \
    --exclude='./tide-release-*.tar.gz' \
    -czf "$TARBALL" .

if [[ "${1:-}" == "--check" ]]; then
  say "打包完成：${TARBALL}（$(du -h "$TARBALL" | cut -f1)），未执行部署。"
  exit 0
fi

# ---------------------------------------------------------------- 建立连接
say "连接 $SERVER_USER@$SERVER_HOST:$SSH_PORT ……"
if ! remote 'echo deploy-ok' >/dev/null; then
  fail "无法登录服务器，请确认账号、密码与 SSH 端口。"
fi
say "连接成功（后续命令复用本连接，不再要求密码）。"

# ---------------------------------------------------------------- 远程环境
# 服务器已预装 Node.js / npm（系统级安装，通过登录 shell 的 PATH 生效）。
say "检查服务器上的 npm……"
NPM_STATE=$(remote "$REMOTE_ENV; npm -v 2>/dev/null" || true)
if [[ "$NPM_STATE" =~ [0-9]+\.[0-9]+ ]]; then
  say "服务器 npm：$NPM_STATE"
else
  fail "未找到 npm，请确认服务器上已安装 Node.js（自带 npm）。"
fi

# ---------------------------------------------------------------- 上传解压
say "上传发布包（${TARBALL}）……"
scp "${SCP_OPTS[@]}" "$TARBALL" "$SERVER_USER@$SERVER_HOST:~/tide-upload.tar.gz" \
  || fail "上传失败。"
# 上传成功后立即删除本地发布包，避免堆积
rm -f "$TARBALL"
say "已删除本地发布包 ${TARBALL}"

say "解压到 ${REMOTE_DIR}（直接覆盖，保留 data 数据库目录与 .env）……"
# 直接覆盖：清掉旧代码再解压，不做 .bak 备份；data（SQLite 数据库）和 .env 必须保留
remote "mkdir -p $REMOTE_DIR && cd $REMOTE_DIR && find . -mindepth 1 -maxdepth 1 ! -name data ! -name .env -exec rm -rf {} + && tar -xzf ~/tide-upload.tar.gz -C $REMOTE_DIR && rm -f ~/tide-upload.tar.gz" \
  || fail "解压失败。"

# ---------------------------------------------------------------- 依赖与构建
say "安装依赖并构建（服务器上，使用国内镜像 ${NPM_REGISTRY}，可能需要几分钟）……"
# 先探测镜像源连通性，便于定位网络问题
REGISTRY_CODE=$(remote "curl -sSL -m 8 -o /dev/null -w '%{http_code}' $NPM_REGISTRY/react 2>/dev/null" || true)
say "镜像源连通性：HTTP ${REGISTRY_CODE:-无法访问}"
if [[ "${REGISTRY_CODE:-000}" != 2* && "${REGISTRY_CODE:-000}" != 3* ]]; then
  fail "无法访问 npm 镜像源 $NPM_REGISTRY，请检查服务器网络，或用 NPM_REGISTRY=其他源 ./deploy.sh 换源。"
fi
remote "cd $REMOTE_DIR && $REMOTE_ENV && npm install --registry=$NPM_REGISTRY --no-audit --no-fund" \
  || fail "依赖安装失败，请查看上方 npm 的具体报错。"
remote "cd $REMOTE_DIR && $REMOTE_ENV && npm run build" \
  || fail "构建失败。"

# ---------------------------------------------------------------- 环境变量
# 生成雪球同步令牌：本机同步脚本（pnpm xueqiu:sync）与服务器凭此令牌互信，
# 服务器只接收推送、不直连雪球，规避无头服务器的 WAF / 机房 IP / 无 GUI 限制。
SYNC_TOKEN=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))" 2>/dev/null || echo "xueqiu-sync-$(date +%s)")
LOCAL_ENV=$(mktemp)
cat > "$LOCAL_ENV" <<ENVEOF
API_PORT=$SERVER_PORT
XUEQIU_SYNC_TOKEN=$SYNC_TOKEN
# 雪球讨论通过「本机同步推送」接入（服务器不直连雪球）：
#   1) 本机 .env 设置 XUEQIU_SYNC_TOKEN=$SYNC_TOKEN 与 XUEQIU_SERVER_URL=http://$SERVER_HOST:$SERVER_PORT
#   2) 本机运行 pnpm xueqiu:sync（建议 cron/launchd 每 5 分钟一次）
# 若服务器装有 Chrome 且为住宅 IP，也可设置 XUEQIU_COOKIE 让其自主抓取作兜底。
ENVEOF
say "写入 .env（API_PORT=${SERVER_PORT}，XUEQIU_SYNC_TOKEN 已生成）……"
scp "${SCP_OPTS[@]}" "$LOCAL_ENV" "$SERVER_USER@$SERVER_HOST:$REMOTE_DIR/.env" \
  || fail ".env 写入失败。"
rm -f "$LOCAL_ENV"
echo "[deploy] 本机同步令牌（复制到本机 .env 的 XUEQIU_SYNC_TOKEN）：$SYNC_TOKEN"

# ---------------------------------------------------------------- 启动服务
say "重启服务……"
# 关键：服务端不自动加载 .env，这里用 set -a 把 .env 里的变量导入进程环境，
# 否则 API_PORT 不生效，服务会回落到默认端口 8788，健康检查就会失败。
# pkill 兜底：防止 server.pid 失效时旧进程没被杀掉、新进程起不来（端口被旧进程占用）。
remote "cd $REMOTE_DIR && [ -f server.pid ] && kill \$(cat server.pid) 2>/dev/null || true; pkill -f 'server/index\.ts\$' 2>/dev/null || true; sleep 1; $REMOTE_ENV; set -a; [ -f .env ] && . ./.env; set +a; nohup ./node_modules/.bin/tsx server/index.ts > tide.log 2>&1 & echo \$! > server.pid" \
  || fail "服务启动失败。"

# ---------------------------------------------------------------- 健康检查
say "等待服务就绪……"
HEALTH=""
for _ in $(seq 1 30); do
  HEALTH=$(remote "curl -sS -m 3 http://127.0.0.1:$SERVER_PORT/api/health 2>/dev/null" || true)
  [[ "$HEALTH" == *'"ok"'* ]] && break
  sleep 2
done

if [[ "$HEALTH" != *'"ok"'* ]]; then
  say "服务未在 30 次重试内就绪，最近的启动日志："
  remote "tail -n 30 $REMOTE_DIR/tide.log" || true
  fail "健康检查未通过。"
fi
say "服务健康检查通过：$HEALTH"

# ---------------------------------------------------------------- 完成
EXTERNAL_OK=$(curl -sS -m 5 "http://$SERVER_HOST:$SERVER_PORT/api/health" 2>/dev/null || echo "")
echo
say "部署完成 ✅"
say "访问地址：http://$SERVER_HOST:$SERVER_PORT"
if [[ -z "$EXTERNAL_OK" ]]; then
  printf '\033[1;33m[deploy]\033[0m 外网暂时访问不到 %s 端口，请在服务器上放行防火墙后重试：\n' "$SERVER_PORT"
  echo "  firewalld: sudo firewall-cmd --zone=public --add-port=$SERVER_PORT/tcp --permanent && sudo firewall-cmd --reload"
  echo "  ufw:       sudo ufw allow $SERVER_PORT/tcp"
  echo "  （或联系云服务商在安全组中放行 ${SERVER_PORT}）"
fi
echo "  服务目录：$REMOTE_DIR   日志：tail -f $REMOTE_DIR/tide.log"
echo "  重启服务：ssh $SERVER_USER@$SERVER_HOST 'cd $REMOTE_DIR && kill \$(cat server.pid); set -a; . ./.env; set +a; nohup ./node_modules/.bin/tsx server/index.ts > tide.log 2>&1 & echo \$! > server.pid'"
