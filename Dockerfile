FROM node:24-slim

# Build tools for native deps (sharp, lancedb)
RUN apt-get update && apt-get install -y \
    git build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (layer cache: only rebuilds when package.json changes)
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

# Bake mycc source into image
COPY . .
RUN npm link

# Ollama stays on host; container connects via host.docker.internal
ENV OLLAMA_HOST=http://host.docker.internal:11434
ENV MYCC_ROOT=/app

ENTRYPOINT ["mycc"]