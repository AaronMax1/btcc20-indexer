# BTCC-20 Indexer 服务器部署

推荐直接在服务器上用 Docker Compose 构建和启动。这样不用维护公开镜像，部署也能固定到 Bitcoin-Classic 的 `feature/asert` 分支。

## 1. 准备服务器

需要：

- Linux 服务器
- Docker 和 Docker Compose 插件
- 能访问 GitHub
- 开放索引器端口，默认 `8798`
- 可选开放 BTCC P2P 端口，默认 `18465`

## 2. 拉代码

```sh
git clone git@github.com:AaronMax1/btcc20-indexer.git
cd btcc20-indexer
```

如果服务器没有配置 GitHub SSH key，也可以用 HTTPS：

```sh
git clone https://github.com/AaronMax1/btcc20-indexer.git
cd btcc20-indexer
```

## 3. 配置环境变量

```sh
cp .env.example .env
```

至少确认这些值：

```sh
BTCC20_VIEWER_PORT=8798
BTCC20_RPC_USER=btcc_rpc_user
BTCC20_RPC_PASSWORD=change_me
BTCCD_REF=feature/asert
BTCCD_P2P_PORT=18465
BTCCD_CONNECT=43.163.236.59:18465
```

公开服务器建议把 `BTCC20_RPC_PASSWORD` 改成强密码。Compose 默认只把 RPC 绑定到宿主机 `127.0.0.1:28476`，不要把 RPC 暴露到公网。

## 4. 启动

```sh
./scripts/deploy.sh
```

这个脚本会：

- 构建 `btcc20-indexer`
- 如果本机没有 `btcc-core:local`，从源码构建 BTCC Core
- 启动 `btccd` 和 `btcc20-indexer`

如果 Bitcoin-Classic 上游更新了代码，需要强制重建节点镜像：

```sh
FORCE_BTCCD_BUILD=1 ./scripts/deploy.sh
```

## 5. 查看状态

```sh
./scripts/status.sh
```

也可以直接访问：

```text
http://服务器IP:8798/api/index/status
```

页面地址：

```text
http://服务器IP:8798
```

## 6. 常用运维命令

查看日志：

```sh
docker compose logs -f btccd
docker compose logs -f btcc20-indexer
```

重启：

```sh
docker compose restart
```

更新 indexer 代码：

```sh
git pull
./scripts/deploy.sh
```

停止服务：

```sh
docker compose down
```

不要随便删除 Docker volume。链数据在 `btccd-data`，索引数据在 `btcc20-indexer-data`。

## 镜像是否需要上传

默认不需要上传镜像，服务器直接跑 `./scripts/deploy.sh` 就行。

只有在服务器编译 BTCC Core 太慢、或者多台服务器要复用同一个节点镜像时，才建议上传镜像。可选方案：

```sh
gcloud builds submit --config cloudbuild.btccd.yaml --project <GCP_PROJECT_ID> .
```

然后把 `.env` 里的 `BTCCD_IMAGE` 改成构建出来的镜像地址，例如：

```sh
BTCCD_IMAGE=gcr.io/<GCP_PROJECT_ID>/btcc-core:asert
```

再启动：

```sh
docker compose pull btccd
docker compose up -d --no-build
```
