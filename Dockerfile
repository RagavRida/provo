FROM node:22-slim
WORKDIR /app
COPY buyer-agent/package*.json ./
RUN npm ci --omit=dev
COPY buyer-agent/ .
EXPOSE 3001
CMD ["node", "index.js", "--serve", "--min-tok-s", "90", "--max-spend", "0.05", "--latency-sensitive", "--min-vram", "40", "--prefer-region", "us-east"]
