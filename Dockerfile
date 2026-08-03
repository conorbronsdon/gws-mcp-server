# gws-mcp-server — stdio MCP server for Google Workspace via the gws CLI
# Build:  docker build -t gws-mcp-server .
# Run:    docker run -i --rm \
#           -v "$HOME/.config/gws:/home/node/.config/gws" gws-mcp-server

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/build ./build

# The gws CLI is a Rust binary this server shells out to. Its npm package is a
# launcher whose postinstall downloads the matching release, so this install
# must NOT use --ignore-scripts: with scripts off, the launcher instead fetches
# the binary on first run, which needs network at tool-call time and write
# access to a root-owned directory the runtime user does not have.
# Alpine works because upstream publishes an x86_64-unknown-linux-musl build,
# and an aarch64 one, so multi-arch builds work.
# Scope of the version pin: it pins the launcher package, not the binary. The
# postinstall does verify SHA256, but it fetches the checksum from the same
# mutable GitHub release as the artifact, so that is a corruption check rather
# than a trust anchor. A build-time failure is loud, not silent — install.js
# exits 1 and BuildKit aborts the layer.
RUN npm install -g @googleworkspace/cli@0.22.5

# drive_files_download and any gws --output write a temp file into the working
# directory, so it has to be writable by the runtime user.
RUN chown node:node /app

# Credentials are not baked into the image. gws reads them from
#   ~/.config/gws  ->  /home/node/.config/gws in this container
# so mount the host directory there, or point
# GOOGLE_WORKSPACE_CLI_CONFIG_DIR at another mounted path.
# Mount it read-write, and make sure the host directory is writable by uid 1000.
# gws treats that directory as state, not just input, and the first thing it
# writes is not a credential: it caches the API discovery document under cache/
# on the FIRST tool call, before authentication is attempted. So a read-only
# mount does not degrade gracefully, it fails every tool call outright with
#   error[discovery]: Read-only file system (os error 30)
# and a directory the runtime user cannot write fails the same way with
#   error[discovery]: Permission denied (os error 13)
# It also keeps the credential encryption key here as .encryption_key, since on
# Linux there is no OS keyring to hold it, next to credentials.enc.
# That last point is a portability trap worth knowing: a credential minted by
# `gws auth login` on macOS or Windows has its key in the OS keyring rather than
# in this directory, so copying the directory alone into a container yields
# "Decryption failed. Credentials may have been created on a different machine."
# The server starts and answers tools/list with no credentials present. Tool
# calls then return isError: true carrying the gws error — with no mount at all
# that is error[auth]: Access denied. No credentials provided.

USER node
CMD ["node", "build/index.js"]
