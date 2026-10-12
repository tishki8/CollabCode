# One image for every Node service (web, api, collab, runner, migrate). The service is
# chosen by the command in docker-compose.yml. Dev-oriented: source is baked in, run with tsx / next dev.
FROM node:22-slim
# openssl is required by the Prisma engine
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm db:generate
ENV NODE_ENV=development
