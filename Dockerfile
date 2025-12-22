FROM node:18-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV DATA_DIR=/data

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/db \
  && mkdir -p /data/assets/videos /data/assets/audios /data/assets/sfx /data/assets/avatars /data/thumbs /data/logs

EXPOSE 6969

CMD ["npm", "start"]