# syntax=docker/dockerfile:1
FROM node:26.8.1-bookworm-slim AS web
WORKDIR /build/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY apps/web/index.html apps/web/tsconfig.json apps/web/vite.config.ts ./
COPY apps/web/src ./src
RUN npm run build

FROM golang:1.27.0-bookworm AS api
WORKDIR /build/api
COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download
COPY apps/api/internal ./internal
COPY apps/api/cmd ./cmd
COPY apps/api/migrations ./migrations
COPY apps/api/fixtures/embed.go apps/api/fixtures/catalog.json ./fixtures/
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -o /out/server ./cmd/server \
 && CGO_ENABLED=0 go build -mod=readonly -trimpath -o /out/bootstrap-accounts ./cmd/bootstrap-accounts \
 && CGO_ENABLED=0 go build -mod=readonly -trimpath -o /out/migrate ./cmd/migrate

# Pure Go binaries: no shell, package manager, Node, source or writable assets.
FROM scratch
COPY --from=api --chown=0:0 --chmod=0555 /out/ /usr/local/bin/
COPY --from=web --chown=0:0 --chmod=0555 /build/web/dist/ /srv/web/
USER 1000:1000
ENV LUSON_WEB_DIR=/srv/web
EXPOSE 8443
ENTRYPOINT ["/usr/local/bin/server"]
