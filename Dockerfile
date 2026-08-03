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
# Alpine works because upstream publishes an x86_64-unknown-linux-musl build.
RUN npm install -g @googleworkspace/cli@0.22.5

# drive_files_download and any gws --output write a temp file into the working
# directory, so it has to be writable by the runtime user.
RUN chown node:node /app

# Credentials are not baked into the image. gws reads them from
#   ~/.config/gws  ->  /home/node/.config/gws in this container
# so mount the host directory there, or point
# GOOGLE_WORKSPACE_CLI_CONFIG_DIR at another mounted path.
# Mount it read-write. gws treats that directory as state, not just input: on
# Linux it keeps the credential encryption key there as .encryption_key, writes
# credentials.enc through credentials.tmp when the OAuth token refreshes, and
# caches tokens and discovery documents in token_cache.json and cache/. A
# read-only mount still answers introspection, but tool calls degrade once
# anything needs to be written back.
# The server starts and answers tools/list with no credentials present; tool
# calls then fail with the gws error until the credentials are there.

USER node
CMD ["node", "build/index.js"]
