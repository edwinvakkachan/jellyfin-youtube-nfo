
FROM node:22-alpine

# System dependencies, including Deno for yt-dlp JavaScript extraction
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    deno \
    vips-dev \
    build-base \
    libc6-compat

# Install yt-dlp
RUN pip install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm install

# Copy application source
COPY . .

CMD ["node", "generateNfoFromVideoId.js"]
