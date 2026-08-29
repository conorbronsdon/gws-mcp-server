# gws-mcp-server — stdio MCP server for Google Workspace via the gws CLI
# Build:  docker build -t gws-mcp-server .
# Run:    docker run -i --rm \
#           -v "$HOME/.config/gws:/home/node/.config/gws" gws-mcp-server

# Pin the multi-architecture base for reproducible MCP Catalog builds.
# Dependabot checks the Node 22 / Alpine 3.24 tag weekly for a new digest.
FROM node:22-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

FROM node:22-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS gws-cli
ARG TARGETARCH
ARG GWS_VERSION=0.22.5
ARG GWS_SHA256_AMD64=4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920
ARG GWS_SHA256_ARM64=e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-musl; expected="$GWS_SHA256_AMD64" ;; \
      arm64) target=aarch64-unknown-linux-musl; expected="$GWS_SHA256_ARM64" ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    archive=/tmp/google-workspace-cli.tar.gz; \
    wget -q -O "$archive" \
      "https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-${target}.tar.gz"; \
    echo "$expected  $archive" | sha256sum -c -; \
    tar -xzf "$archive" -C /usr/local/bin ./gws; \
    chmod 0755 /usr/local/bin/gws; \
    rm "$archive"; \
    /usr/local/bin/gws --version

FROM node:22-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/build ./build

# Copy only the independently checksum-pinned Rust binary. This avoids the npm
# launcher's postinstall, whose artifact and checksum share one mutable origin,
# and keeps the global npm package out of the runtime image.
COPY --from=gws-cli /usr/local/bin/gws /usr/local/bin/gws

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
