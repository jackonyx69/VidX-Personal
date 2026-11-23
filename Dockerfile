# Lightweight Node.js + Python + yt-dlp image
FROM node:20-slim

# Install python3, ffmpeg, curl and ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Copy project files
COPY package*.json ./
COPY server.js ./
COPY public/ ./public/
COPY src/ ./src/

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
