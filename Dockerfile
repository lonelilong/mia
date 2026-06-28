FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src/ ./src/

VOLUME /data

EXPOSE 3002

CMD ["node", "src/server.js"]
