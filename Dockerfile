# Proofmesh: Node for the core and the TypeScript, syntax and Python adapters; the .NET runtime for the C# adapter.
# Repositories mount read-only at /repos/<id>; the data directory is the /data volume; only the loopback port is served.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS csharp
WORKDIR /src
COPY adapters/csharp/ adapters/csharp/
RUN dotnet build adapters/csharp/Proofmesh.Adapter.CSharp.csproj -c Release -o /out/csharp

FROM node:22-bookworm-slim AS build
# Native modules (better-sqlite3) compile from source where no prebuilt binary fits the platform; only this stage has a toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
COPY --from=csharp /out/csharp packages/proofmesh/dist/adapters/csharp
RUN pnpm deploy --legacy --filter proofmesh --prod /app

FROM node:22-bookworm-slim
COPY --from=mcr.microsoft.com/dotnet/runtime:10.0 /usr/share/dotnet /usr/share/dotnet
# The .NET runtime's own system libraries, which copying /usr/share/dotnet does not bring.
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 libicu72 ca-certificates && rm -rf /var/lib/apt/lists/*
ENV DOTNET_ROOT=/usr/share/dotnet PATH="/usr/share/dotnet:${PATH}" PROOFMESH_DATA_DIR=/data DOTNET_CLI_TELEMETRY_OPTOUT=1
RUN useradd --create-home --uid 10001 proofmesh && mkdir -p /data /repos && chown proofmesh:proofmesh /data
COPY --from=build --chown=proofmesh:proofmesh /app /app
USER proofmesh
WORKDIR /app
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/bin/proofmesh.mjs"]
CMD ["--help"]
