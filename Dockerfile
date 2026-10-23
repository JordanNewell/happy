FROM node:20

RUN apt-get update && apt-get install -y python3 ffmpeg make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY scripts ./scripts
COPY patches ./patches
COPY packages/happy-server/package.json packages/happy-server/package.json
COPY packages/happy-server/prisma packages/happy-server/prisma
COPY packages/happy-wire/package.json packages/happy-wire/package.json

ENV SKIP_HAPPY_WIRE_BUILD=1
RUN pnpm install --frozen-lockfile --filter happy-server...

COPY packages/happy-server packages/happy-server
COPY packages/happy-wire packages/happy-wire
RUN pnpm --filter @slopus/happy-wire build
ENV SKIP_HAPPY_WIRE_BUILD=

# happy-server imports @octokit/webhooks (undeclared transitive of `octokit`);
# filtered install doesn't hoist it or its deps into the package's node_modules — copy the family
RUN mkdir -p packages/happy-server/node_modules/@octokit/webhooks packages/happy-server/node_modules/@octokit/webhooks-methods packages/happy-server/node_modules/@octokit/openapi-webhooks-types packages/happy-server/node_modules/@octokit/request-error && \
    cp -rL node_modules/.pnpm/@octokit+webhooks@14.2.0/node_modules/@octokit/webhooks/. packages/happy-server/node_modules/@octokit/webhooks/ && \
    cp -rL node_modules/.pnpm/@octokit+webhooks-methods@6.0.0/node_modules/@octokit/webhooks-methods/. packages/happy-server/node_modules/@octokit/webhooks-methods/ && \
    cp -rL node_modules/.pnpm/@octokit+openapi-webhooks-types@12.1.0/node_modules/@octokit/openapi-webhooks-types/. packages/happy-server/node_modules/@octokit/openapi-webhooks-types/ && \
    cp -rL node_modules/.pnpm/@octokit+request-error@7.1.0/node_modules/@octokit/request-error/. packages/happy-server/node_modules/@octokit/request-error/

ENV NODE_ENV=production

WORKDIR /app/packages/happy-server
EXPOSE 3005
CMD ["pnpm", "start"]
