FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM base AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# next.config.mjs resolves its /api proxy target inside rewrites(), which Next
# evaluates during the build and freezes into routes-manifest.json — the value
# present at run time is never consulted. It has to be supplied here.
ARG API_INTERNAL_URL=http://localhost:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN pnpm build

FROM build AS runtime
ARG APP_FILTER=@huxtrade/api
ENV APP_FILTER=$APP_FILTER
CMD ["sh", "-c", "pnpm --filter $APP_FILTER start"]
