FROM oven/bun:1.4.2-slim

WORKDIR /app

# Install production dependencies first so this layer is cached independently
# from application source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY assets ./assets
COPY tsconfig.json ./tsconfig.json

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
