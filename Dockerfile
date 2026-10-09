# syntax=docker/dockerfile:1
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public
COPY data/oppmotesteder.json ./data/oppmotesteder.json

USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
