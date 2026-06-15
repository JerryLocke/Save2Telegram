FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY *.js ./

EXPOSE 3000
ENTRYPOINT ["node", "server.js"]
