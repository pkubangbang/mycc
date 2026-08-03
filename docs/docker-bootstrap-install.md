# Docker 引导安装方案（浏览器触发本地安装）

> **状态**：设计完成，待实现 | **日期**：2026-08-03

## 核心思路

构建一个 mycc Docker 镜像，容器启动时自动进入 `--serve` 模式，宿主机浏览器访问 `http://localhost:3173` 即可使用容器内 mycc；Web UI 中新增"安装到本地"功能，通过新增的 `/install/*` API 路由让容器下载/准备安装包到一个挂载的 volume 目录，用户随后从该 volume 拷贝安装包到本地机器、按顺序安装即可在宿主机上原生运行 mycc——无需用户自己处理编译器、Ollama 等前置依赖。

## 完整用户流程

```
┌─────────────────────────────────────────────────────────────┐
│  1. docker compose up                                        │
│     → 容器启动，自动 --serve 模式                             │
│                                                              │
│  2. 浏览器打开 http://localhost:3173                         │
│     → 直接使用容器内 mycc（零配置体验）                        │
│     → 同时 Web UI 显示"安装到本地"按钮                         │
│                                                              │
│  3. 点击"安装到本地"                                          │
│     → 容器下载安装包到 ./install-bundle/ (volume 映射)         │
│     → Web UI 显示安装步骤指引                                  │
│                                                              │
│  4. 用户从 ./install-bundle/ 拷贝到本地                       │
│     → 按步骤安装 Node.js、Ollama、mycc npm 包                  │
│     → 本地原生运行 mycc                                       │
└─────────────────────────────────────────────────────────────┘
```

**两个使用层次**：
- **即时使用**：浏览器直接用容器内 mycc，无需任何本地安装（适合先体验）
- **本地安装**：通过容器准备安装包+引导，迁移到宿主机原生运行（适合长期使用）

## 现有 --serve 架构验证

| 验证项 | 结果 | 证据 |
|--------|------|------|
| `--serve` 可自动启动 | ✅ | `config.ts` `shouldServe()` + `index.ts` 启动时检查 |
| 端口可映射到宿主机 | ✅ | `docker-compose.yml` ports: "3173:3173" |
| Express 路由可扩展 | ✅ | `serve-hub.ts` 已有 `/`、`/history`、`/config` 路由 |
| WS 双向通信可用 | ✅ | `/ws` WebSocket，支持 input/card-response/steer |
| Vue 前端可扩展组件 | ✅ | `src/web/src/components/` 组件化结构 |
| 容器可下载文件到 volume | ✅ | 容器内 curl/wget 下载 → 写入挂载目录 |

## 要创建/修改的文件

### 新增文件（不改动现有源码核心逻辑）

| 文件 | 作用 |
|------|------|
| `Dockerfile` | 镜像构建 |
| `.dockerignore` | 排除不必要文件 |
| `docker/entrypoint.sh` | 容器入口（启动 Ollama + mycc --serve） |
| `docker/install/prepare-bundle.sh` | 准备安装包脚本（容器内运行） |
| `docker/install/install-guide.md` | 安装指引文档（放入 bundle） |
| `docker-compose.yml` | 编排 + volume 映射 |
| `docs/docker-install.md` | 用户文档 |

### 修改现有文件（最小改动）

| 文件 | 改动内容 |
|------|---------|
| `src/serve/serve-hub.ts` | 新增 `/install` GET 路由（返回安装状态）+ `/install/prepare` POST 路由（触发准备安装包）+ `/install/files` GET 路由（列出已准备的文件） |
| `src/web/src/App.vue` | 新增 `<InstallBanner>` 组件引用 |
| `src/web/src/components/InstallBanner.vue` | 新增组件：安装按钮 + 进度显示 + 步骤指引 |

## 实现步骤

### 步骤 1：`Dockerfile`

```dockerfile
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# 系统依赖
RUN apt-get update && apt-get install -y \
    build-essential python3 curl wget git tmux \
    ca-certificates && rm -rf /var/lib/apt/lists/*

# Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# pnpm
RUN npm install -g pnpm

# Ollama
RUN curl -fsSL https://ollama.com/install.sh | sh

# mycc 源码 + 依赖预编译
WORKDIR /opt/mycc
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src/ ./src/
COPY bin/ ./bin/
COPY skills/ ./skills/
COPY scripts/ ./scripts/
RUN pnpm install --frozen-lockfile && npm link

# 安装包准备脚本
COPY docker/install/ /opt/mycc/docker/install/
RUN chmod +x /opt/mycc/docker/install/prepare-bundle.sh

# Ollama 模型目录
ENV OLLAMA_MODELS=/ollama-models
VOLUME ["/ollama-models"]

# 安装包输出目录（映射到宿主机）
VOLUME ["/install-bundle"]

# mycc 配置持久化
VOLUME ["/root/.mycc-store"]

EXPOSE 3173
WORKDIR /workspace
VOLUME ["/workspace"]

ENTRYPOINT ["/opt/mycc/docker/entrypoint.sh"]
```

### 步骤 2：`docker/entrypoint.sh`

```bash
#!/bin/bash
set -e

# 启动 Ollama 服务（后台）
ollama serve &
sleep 2

# 预拉 embedding 模型（首次启动时，后续从 volume 读取）
if ! ollama list 2>/dev/null | grep -q nomic-embed-text; then
  echo "Pulling embedding model..."
  ollama pull nomic-embed-text
fi

# 标记 Docker 环境（供 Web UI 检测）
export MYCC_DOCKER=1

# 自动 --serve 模式启动
cd /workspace
exec mycc --serve --host 0.0.0.0 --skip-healthcheck
```

关键点：
- `--host 0.0.0.0` 让容器内服务可从宿主机访问
- `MYCC_DOCKER=1` 环境变量供前端检测当前运行在 Docker 中

### 步骤 3：`docker/install/prepare-bundle.sh`

容器内运行的脚本，下载/准备安装包到 `/install-bundle/`：

```bash
#!/bin/bash
set -e
BUNDLE_DIR="/install-bundle"
mkdir -p "$BUNDLE_DIR"

echo '{"step": "nodejs", "status": "downloading"}'
# 1. Node.js 安装包
wget -q -O "$BUNDLE_DIR/nodejs-setup.sh" https://deb.nodesource.com/setup_20.x

echo '{"step": "ollama", "status": "downloading"}'
# 2. Ollama 安装脚本
cp /usr/local/bin/ollama "$BUNDLE_DIR/ollama" 2>/dev/null || \
  wget -q -O "$BUNDLE_DIR/ollama-install.sh" https://ollama.com/install.sh

echo '{"step": "mycc", "status": "packaging"}'
# 3. mycc npm 包（打包当前源码）
cd /opt/mycc && npm pack --pack-destination "$BUNDLE_DIR/"

echo '{"step": "guide", "status": "writing"}'
# 4. 安装指引文档
cp /opt/mycc/docker/install/install-guide.md "$BUNDLE_DIR/README.md"

echo '{"step": "done", "status": "complete"}'
```

### 步骤 4：修改 `src/serve/serve-hub.ts` — 新增安装路由

在 `start()` 方法中、`/config` 路由之后新增三个路由。需要额外 import `spawn`（来自 `child_process`）。

```typescript
// GET /install → 返回安装状态（MYCC_DOCKER 环境变量 + bundle 是否已准备）
this.expressApp.get('/install', (_req, res) => {
  const isDocker = process.env.MYCC_DOCKER === '1';
  const bundleDir = process.env.INSTALL_BUNDLE_DIR || '/install-bundle';
  const prepared = fs.existsSync(bundleDir) &&
    fs.readdirSync(bundleDir).length > 0;
  res.status(200).json({ docker: isDocker, prepared });
});

// POST /install/prepare → 触发 prepare-bundle.sh（异步）
this.expressApp.post('/install/prepare', (_req, res) => {
  if (process.env.MYCC_DOCKER !== '1') {
    res.status(400).json({ error: 'Not running in Docker' });
    return;
  }
  const script = '/opt/mycc/docker/install/prepare-bundle.sh';
  const child = spawn('bash', [script], { stdio: 'pipe' });
  // 流式输出 → 通过 WS broadcast 推送进度
  child.stdout.on('data', (d) => {
    this.broadcast('install-progress', d.toString().trim(), 'install');
  });
  child.on('close', (code) => {
    this.broadcast('install-done', code === 0 ? 'success' : 'failed', 'install');
  });
  res.status(202).json({ status: 'started' });
});

// GET /install/files → 列出已准备的安装包
this.expressApp.get('/install/files', (_req, res) => {
  const bundleDir = process.env.INSTALL_BUNDLE_DIR || '/install-bundle';
  try {
    const files = fs.readdirSync(bundleDir).map(name => ({
      name,
      size: fs.statSync(path.join(bundleDir, name)).size,
    }));
    res.status(200).json({ files });
  } catch {
    res.status(200).json({ files: [] });
  }
});
```

### 步骤 5：新增 `src/web/src/components/InstallBanner.vue`

条件渲染的安装引导横幅，仅在 Docker 环境下显示：

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';

const isDocker = ref(false);
const preparing = ref(false);
const prepared = ref(false);
const progress = ref<string[]>([]);

async function checkDocker() {
  const res = await fetch('/install');
  const data = await res.json();
  isDocker.value = data.docker;
  prepared.value = data.prepared;
}

async function prepare() {
  preparing.value = true;
  // 通过 WS 接收进度（复用现有 WS 连接）
  const res = await fetch('/install/prepare', { method: 'POST' });
  if (res.ok) {
    // 进度通过 WS 'install-progress' 消息推送，在 onWsMessage 中处理
  }
}

onMounted(() => checkDocker());
</script>

<template>
  <div v-if="isDocker" class="install-banner">
    <div class="banner-content">
      <span>📦 在本地安装 mycc</span>
      <button v-if="!prepared && !preparing" @click="prepare">
        准备安装包
      </button>
      <span v-if="preparing">准备中...</span>
      <button v-if="prepared">查看安装指引</button>
    </div>
  </div>
</template>
```

### 步骤 6：修改 `src/web/src/App.vue` — 集成 InstallBanner

在 `<StatusBar>` 下方添加 `<InstallBanner />`，并在 script setup 中 import。

同时在 WS `onWsMessage` 处理中新增 `install-progress` 和 `install-done` 消息类型，更新进度。

### 步骤 7：`docker-compose.yml`

```yaml
version: "3.8"
services:
  mycc:
    build: .
    container_name: mycc
    stdin_open: true
    tty: true
    volumes:
      - ./:/workspace
      - mycc-config:/root/.mycc-store
      - ollama-models:/ollama-models
      - ./install-bundle:/install-bundle    # 安装包输出到宿主机
    ports:
      - "3173:3173"
    environment:
      - MYCC_DOCKER=1
      - INSTALL_BUNDLE_DIR=/install-bundle

volumes:
  mycc-config:
  ollama-models:
```

关键点：`./install-bundle:/install-bundle` 将容器内安装包目录直接映射到宿主机 `./install-bundle/`，用户无需从容器拷贝——文件直接出现在宿主机文件系统中。

### 步骤 8：`docker/install/install-guide.md`

放入 bundle 的安装指引，用户打开即看：

```markdown
# mycc 本地安装指引

## 前置条件
本安装包由 Docker 容器自动准备。

## 安装步骤

### 1. 安装 Node.js 20 LTS
# Ubuntu/Debian:
sudo bash nodejs-setup.sh && sudo apt install -y nodejs

### 2. 安装 Ollama
sudo install ollama /usr/local/bin/ollama

### 3. 安装 mycc
npm install -g mycc-*.tgz

### 4. 拉取 embedding 模型
ollama pull nomic-embed-text

### 5. 配置并启动
mycc --setup
mycc
```

## BEFORE / AFTER 对比

**BEFORE**（当前安装流程）：
```
Windows: 装 VS Build Tools + Python + Node.js → npm install -g mycc (编译原生依赖,可能失败)
         → 装 Ollama → ollama pull → 装 tmux/psmux → mycc --setup → mycc
```

**AFTER**（Docker 引导安装）：
```
docker compose up → 浏览器打开 localhost:3173 → 立即使用 mycc
                  → 点击"准备安装包" → ./install-bundle/ 出现完整安装包
                  → 按指引 3 条命令本地安装（安装包已配齐,无编译步骤）
```

## 架构图

```
┌─ 宿主机 ──────────────────────────────────────────┐
│                                                    │
│  浏览器 ──http://localhost:3173──┐                 │
│                                   │                 │
│  ./install-bundle/ ◄──volume──────┤                │
│  (安装包直接出现                    │                │
│   在宿主机文件系统)                 │                │
│                                   │                 │
└───────────────────────────────────┼─────────────────┘
                                    │
┌─ Docker 容器 ─────────────────────┼─────────────────┐
│                                   │                 │
│  entrypoint.sh                     │                 │
│    ├─ ollama serve (后台)          │                 │
│    └─ mycc --serve --host 0.0.0.0 │                 │
│         │                          │                 │
│         ├─ Express + Vite ────────┘ (port 3173)     │
│         ├─ /install      → 检测 Docker 环境        │
│         ├─ /install/prepare → 运行 prepare-bundle.sh│
│         └─ /install/files  → 列出 bundle 文件       │
│                                                    │
│  /install-bundle/ ◄── volume 映射到宿主机           │
│  /ollama-models/  ◄── volume (持久化模型)          │
│  /root/.mycc-store/ ◄── volume (持久化配置)        │
└────────────────────────────────────────────────────┘
```

## 假设与依赖

| 假设 | 依据 |
|------|------|
| `--serve --host 0.0.0.0` 可让容器外访问 | config.ts `getServeHost()` 支持 0.0.0.0 |
| Express 路由可在现有 server 上扩展 | serve-hub.ts 已有 GET 路由模式 |
| WS broadcast 可推送安装进度 | broadcast() 已用于 log/warn/error 推送 |
| Volume 映射让安装包直接出现在宿主机 | Docker volume bind mount 标准行为 |
| 容器内 `npm pack` 可打包 mycc | package.json 有标准 name/version/bin |
| `MYCC_DOCKER` 环境变量可传到容器内 mycc | docker-compose.yml environment 段 |
| 推荐云模型 `glm-5:cloud` 无需 GPU | README 推荐模型 |

## 不在本次范围内

- **发布到 Docker Hub**：CI 自动构建推送（后续工作）
- **预拉 chat 模型**：云模型无需本地拉取，本地模型按需
- **多架构构建**：amd64/arm64（后续 buildx）
- **自动检测宿主机 OS**：安装指引目前手动选择 Ubuntu/macOS/Windows

## 已查阅资源

| 资源 | 状态 |
|------|------|
| `src/serve/serve-hub.ts` — Express+Vite+WS 架构，路由扩展点 | IN USE |
| `src/serve/activate.ts` — serve 激活流程 | IN USE |
| `src/config.ts` — shouldServe/getServeHost/getServePort | IN USE |
| `src/web/src/App.vue` — Vue 组件结构 | IN USE |
| `bin/mycc.js` — tsx 启动方式 | IN USE |
| `package.json` — 依赖与 npm pack 可行性 | IN USE |
| `src/setup/wizard.ts` + `index.ts` + `models.ts` — 配置流程 | IN USE |
| 现有 Dockerfile — 不存在 | NOT FOUND |