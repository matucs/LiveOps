FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace apps/api --include-workspace-root
COPY apps/api apps/api
RUN npm run build --workspace apps/api \
    && mkdir -p apps/api/dist/db/migrations \
    && cp apps/api/src/db/migrations/*.sql apps/api/dist/db/migrations/

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/api/package.json apps/api/package.json
RUN npm ci --workspace apps/api --omit=dev --include-workspace-root
COPY --from=build /app/apps/api/dist apps/api/dist
EXPOSE 3000
CMD ["sh", "-c", "node apps/api/dist/db/migrate.js && node apps/api/dist/server.js"]
