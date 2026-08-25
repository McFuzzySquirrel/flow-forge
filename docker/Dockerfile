FROM node:22-slim

WORKDIR /app

# Bootstrap the monorepo, build the workspace and install dapr SDK bits.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages packages
COPY docker/worker.mjs ./

RUN corepack enable && corepack prepare pnpm@11.5.2 --activate \
    && pnpm install --frozen-lockfile \
    && pnpm build

EXPOSE 3000 50001

CMD ["node", "worker.mjs", "/workforce"]
