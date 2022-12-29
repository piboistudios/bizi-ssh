FROM node:16.18.0
COPY . app
WORKDIR /app
RUN npm install
CMD ["node","index"]

# EXPOSE 22