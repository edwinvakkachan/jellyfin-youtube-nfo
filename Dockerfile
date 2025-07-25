FROM node:18-alpine

RUN apk add --no-cache \
  python3 \
  py3-pip \
  ffmpeg \
  vips-dev \
  build-base \
  libc6-compat

RUN pip install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["node", "generateNfoFromVideoId.js"]

