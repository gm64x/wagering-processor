FROM oven/bun:1.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# SIGTERM chega direto ao bun (PID 1) -> shutdown gracioso do consumidor
CMD ["bun", "src/main.ts"]
