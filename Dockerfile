FROM node:18

WORKDIR /app

# Install ALL deps (including dev) so nothing is missing
COPY package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

# Railway sets PORT=8080 by default
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
