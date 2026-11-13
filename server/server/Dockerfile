FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate --schema prisma/schema.prisma
COPY src ./src
EXPOSE 3001
CMD ["sh", "-c", "npx prisma db push --schema prisma/schema.prisma && npm run dev"]
