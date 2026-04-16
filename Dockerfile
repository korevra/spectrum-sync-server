FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 8080
ENV PORT=8080 \
    HOST=0.0.0.0 \
    STATE_FILE=/app/data/state.json \
    PERSIST_MS=1500
RUN mkdir -p /app/data
CMD ["node", "server.js"]
