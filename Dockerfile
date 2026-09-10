# syntax=docker/dockerfile:1
FROM cloudron/base:5.0.0@sha256:04fd70dbd8ad6149c19de39e35718e024417c3e01dc9c6637eaf4a41ec4e596c

USER root

# Install Bun into a location that remains readable/executable by the
# non-root cloudron user at runtime.
#
# Use Bun's x64-baseline build instead of the installer auto-detected build.
# Some Cloudron hosts/VMs do not expose AVX/AVX2 CPU instructions; the regular
# x64 Bun binary can crash there with SIGILL ("Illegal instruction").
ARG BUN_VERSION=1.2.22
ARG BUN_TARGET=bun-linux-x64-baseline
ENV BUN_INSTALL=/usr/local/bun
ENV ROUTSTRD_DIR=/app/data/routstrd
ENV PATH="/usr/local/bun/bin:/usr/local/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_TARGET}.zip" -o /tmp/bun.zip \
    && unzip /tmp/bun.zip -d /tmp \
    && mkdir -p /usr/local/bun/bin \
    && mv "/tmp/${BUN_TARGET}/bun" /usr/local/bun/bin/bun \
    && chmod +x /usr/local/bun/bin/bun \
    && ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip "/tmp/${BUN_TARGET}" \
    && apt-get purge -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install routstrd daemon globally. The global install lives
# under /usr/local/bun, not /root, so supervised processes running as cloudron
# can execute the binaries on Cloudron's read-only root filesystem.
RUN bun install --global routstrd \
    && ln -sf /usr/local/bun/bin/routstrd /usr/local/bin/routstrd \
    && test -f /usr/local/bun/install/global/node_modules/routstrd/dist/daemon/index.js

# Cloudron convention: immutable app code in /app/code, persistent data mounted
# by the platform at /app/data at runtime.
RUN mkdir -p /app/code
WORKDIR /app/code

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production
COPY src ./src

# Supervisor manages both long-running processes in the single Cloudron app
# container: routstrd on localhost:8009 and routstrd-auth on 0.0.0.0:8008.
COPY cloudron/supervisord.conf /etc/supervisor/supervisord-cloudron.conf
COPY cloudron/supervisor/routstrd.conf /etc/supervisor/conf.d/routstrd.conf
COPY cloudron/supervisor/auth.conf /etc/supervisor/conf.d/auth.conf

COPY cloudron/start.sh /app/code/start.sh
COPY cloudron/run-auth.sh /app/code/run-auth.sh
RUN chmod +x /app/code/start.sh /app/code/run-auth.sh

EXPOSE 8008

CMD ["/app/code/start.sh"]
