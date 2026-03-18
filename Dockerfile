FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /app/logs
VOLUME ["/app/config.json"]
EXPOSE 4000
CMD ["node", "server.js"]
