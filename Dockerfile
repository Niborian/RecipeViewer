# syntax=docker/dockerfile:1

FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG RECIPEVIEWER_BASE=/
ENV RECIPEVIEWER_BASE=${RECIPEVIEWER_BASE}

RUN npm run process-data \
  && npm run build \
  && npm run generate-og

FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/docs /srv

EXPOSE 80
