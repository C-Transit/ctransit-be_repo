FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.mjs"]
