FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# Skip redis-memory-server's download/compile during install.
ENV REDISMS_DISABLE_POSTINSTALL=1
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx src/index.ts"]
