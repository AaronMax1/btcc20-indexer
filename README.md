# BTCC-20 Indexer

这是 BTCC-20 的开源索引器和浏览器。

它负责：

- 扫描 BTCC 链上的 BTCC-20 铭文
- 持久化索引状态，支持增量更新
- 检查最近区块是否重组
- 提供只读 JSON API
- 提供浏览器页面查看 Token、持仓、活动记录和铭刻命令

这个服务不替用户签名，不替用户广播交易。用户打铭文应使用独立开源工具：

```text
../btcc20-inscriber
```

## 目录

```text
btcc20-indexer/
  server.mjs        # 索引服务和只读 API
  public/           # 浏览器前端
  data/             # 本地索引状态目录，不提交真实数据
  package.json
```

## 依赖

需要准备：

- Node.js 18+
- BTCC Core 节点，开启 RPC

## 主网启动

```sh
cd btcc20-indexer

BTCC20_CHAIN=mainnet \
BTCC20_VIEWER_HOST=0.0.0.0 \
BTCC20_VIEWER_PORT=8798 \
BTCC20_RPC_URL=http://127.0.0.1:28476 \
BTCC20_RPC_USER=user \
BTCC20_RPC_PASSWORD=YOUR_RPC_PASSWORD \
BTCC20_INDEX_FILE=/var/lib/btcc20-indexer/index-state.json \
BTCC20_INDEX_INTERVAL_MS=60000 \
npm start
```

浏览器访问：

```text
http://127.0.0.1:8798
```

生产部署建议用 Nginx 反代到 `127.0.0.1:8798`。

## 本地 regtest 启动

```sh
cd btcc20-indexer

BTCC20_CHAIN=regtest \
BTCC20_RPC_URL=http://127.0.0.1:28577 \
BTCC20_RPC_USER=btcc20 \
BTCC20_RPC_PASSWORD=btcc20 \
npm start
```

## Docker 部署

Compose 默认会启动两个服务：

- `btccd`：BTCC Core 节点，负责同步链和提供 RPC
- `btcc20-indexer`：BTCC-20 索引器和浏览器

先在服务器上准备好：

- 能访问 `https://github.com/Marcus-Vane/Bitcoin-Classic`，Compose 会从源码构建 BTCC Core 镜像

复制环境变量模板。Docker Compose 会自动读取项目目录下的 `.env`：

```sh
cp .env.example .env
```

编辑 `.env`，至少设置：

```sh
BTCC20_CHAIN=mainnet
BTCC20_RPC_URL=http://btccd:28476
BTCC20_RPC_USER=你的RPC用户名
BTCC20_RPC_PASSWORD=你的RPC密码
BTCCD_REPO=https://github.com/Marcus-Vane/Bitcoin-Classic.git
BTCCD_REF=feature/asert
BTCCD_IMAGE=btcc-core:local
BTCCD_P2P_PORT=18465
BTCCD_CONNECT=43.163.236.59:18465
```

构建镜像。节点镜像会从 `BTCCD_REPO` 拉源码；默认 `BTCCD_REF=feature/asert`，脚本会对 `btccd` 使用 `--no-cache`，避免 Docker 缓存旧源码：

```sh
npm run docker:build
```

或直接用 Docker Compose 启动：

```sh
docker compose up -d --build
```

如果 Bitcoin-Classic 上游更新了代码，建议先强制重建节点镜像：

```sh
docker compose build --no-cache btccd
docker compose up -d --build
```

如果你想固定到 Bitcoin-Classic 的 release tag，可以把 `.env` 里的 `BTCCD_REF` 改成：

```sh
BTCCD_REF=v1.0.0
```

默认会把 BTCC Core 链数据保存到 Docker volume `btccd-data`，把索引状态保存到 Docker volume `btcc20-indexer-data`，索引器容器内路径是：

```text
/data/index-state.json
```

查看日志：

```sh
docker compose logs -f btcc20-indexer
```

查看节点日志：

```sh
docker compose logs -f btccd
```

如果你要连接服务器上已有的外部 BTCC Core，不想启动 Compose 里的节点，可以把 `BTCC20_RPC_URL` 改成外部地址，并只启动索引器：

```sh
docker compose up -d --build btcc20-indexer
```

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `BTCC20_CHAIN` | 链类型，主网用 `mainnet`，本地用 `regtest` | `regtest` |
| `BTCC20_VIEWER_HOST` | 服务监听地址 | `127.0.0.1` |
| `BTCC20_VIEWER_PORT` | 服务端口 | `8798` |
| `BTCC20_RPC_URL` | BTCC Core RPC 地址 | `http://127.0.0.1:28577` |
| `BTCC20_RPC_USER` | RPC 用户名 | `btcc20` |
| `BTCC20_RPC_PASSWORD` | RPC 密码 | `btcc20` |
| `BTCC20_INDEX_FILE` | 索引状态文件 | `data/index-state.json` |
| `BTCC20_INDEX_INTERVAL_MS` | 自动更新间隔 | `15000` |
| `BTCC20_INDEX_BATCH_SIZE` | 首次扫描时每批 RPC 区块数量，最大按 `500` 限制 | `100` |
| `BTCC20_REORG_CHECK_DEPTH` | 重组检查深度 | `20` |
| `BTCCD_REPO` | Compose 内置 BTCC Core 源码仓库 | `https://github.com/Marcus-Vane/Bitcoin-Classic.git` |
| `BTCCD_REF` | Compose 内置 BTCC Core 源码分支或 tag | `feature/asert` |
| `BTCCD_CONNECT` | BTCC Core 固定连接 peer，用于避免随机 peer 不出块导致同步停住 | `43.163.236.59:18465` |
| `BTCCD_P2P_PORT` | BTCC Core P2P 端口映射 | `18465` |
| `BTCCD_RPC_PORT` | BTCC Core 容器内 RPC 端口 | `28476` |
| `BTCCD_RPC_PUBLISH_PORT` | BTCC Core RPC 发布到宿主机的地址 | `127.0.0.1:28476` |

## API

### 获取当前索引数据

```http
GET /api/scan
```

返回内容包含：

- `ledger.tokens`：Token 部署和供应量
- `ledger.balances`：各地址 BTCC-20 持仓
- `ledger.transfers`：待转账铭文状态
- `events`：deploy / mint / transfer / spend 活动
- `index`：索引状态

强制从当前状态更新：

```http
GET /api/scan?force=1
```

### 获取索引状态

```http
GET /api/index/status
```

## 数据文件

索引会写入：

```text
data/index-state.json
```

生产环境建议放在持久化目录：

```text
/var/lib/btcc20-indexer/index-state.json
```

不要把真实索引文件提交到 Git 仓库。

## 安全边界

这个开源索引器只提供只读 API。

公开服务器不要保存用户钱包，不要提供服务器代打铭文接口。打铭文应该在用户本机通过 `btcc20-inscriber` 完成，由用户自己的 BTCC Core 钱包签名和广播。

## CORD 展示名

`CORD` 的链上 ticker 是：

```text
cord
```

浏览器展示层把它显示为：

```text
Classic Ordinal
```

这个名字只在前端元数据里展示，不改变链上 BTCC-20 payload。
