import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const MAX_OVERRIDES_BYTES = 5 * 1024 * 1024;

function isOverridesDocument(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const document = value as Record<string, unknown>;
  return (
    document.version === 1 &&
    Boolean(document.locations) &&
    typeof document.locations === "object" &&
    !Array.isArray(document.locations) &&
    Array.isArray(document.additions)
  );
}

function mergeOverridesDocuments(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(current);
  const currentLocations = merged.locations as Record<
    string,
    Record<string, unknown>
  >;
  const incomingLocations = incoming.locations as Record<
    string,
    Record<string, unknown>
  >;
  for (const [serviceId, incomingDecision] of Object.entries(incomingLocations)) {
    const currentDecision = currentLocations[serviceId];
    const incomingReviewedAt = incomingDecision.reviewed_at;
    const currentReviewedAt = currentDecision?.reviewed_at;
    if (
      !currentDecision ||
      (typeof incomingReviewedAt === "string" &&
        (typeof currentReviewedAt !== "string" ||
          incomingReviewedAt >= currentReviewedAt))
    ) {
      currentLocations[serviceId] = incomingDecision;
    }
  }

  const currentAdditions = merged.additions as Array<Record<string, unknown>>;
  const additionIds = new Set(currentAdditions.map((addition) => addition.id));
  for (const addition of incoming.additions as Array<Record<string, unknown>>) {
    if (!additionIds.has(addition.id)) {
      currentAdditions.push(addition);
      additionIds.add(addition.id);
    }
  }
  return merged;
}

export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), "index.html"),
        admin: resolve(process.cwd(), "admin.html"),
      },
    },
  },
  plugins: [
    {
      name: "local-curation-api",
      configureServer(server) {
        const overridesPath = resolve(
          server.config.root,
          "data/curation-overrides.json",
        );
        server.middlewares.use(
          "/api/curation-overrides",
          async (request, response) => {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Content-Type", "application/json; charset=utf-8");

            if (request.method === "GET") {
              try {
                response.end(await readFile(overridesPath, "utf8"));
              } catch (error) {
                console.error("Unable to read curation overrides", error);
                response.statusCode = 500;
                response.end(JSON.stringify({ error: "Unable to read overrides file." }));
              }
              return;
            }

            if (request.method !== "POST") {
              response.statusCode = 405;
              response.setHeader("Allow", "GET, POST");
              response.end(JSON.stringify({ error: "Method not allowed." }));
              return;
            }
            if (!request.headers["content-type"]?.startsWith("application/json")) {
              response.statusCode = 415;
              response.end(JSON.stringify({ error: "Expected application/json." }));
              return;
            }

            let body = "";
            try {
              for await (const chunk of request) {
                body += chunk.toString();
                if (Buffer.byteLength(body) > MAX_OVERRIDES_BYTES) {
                  throw new Error("Overrides document exceeds 5 MB.");
                }
              }
              const document = JSON.parse(body) as unknown;
              if (!isOverridesDocument(document)) {
                throw new Error("Invalid curation overrides document.");
              }
              const currentDocument = JSON.parse(
                await readFile(overridesPath, "utf8"),
              ) as unknown;
              if (!isOverridesDocument(currentDocument)) {
                throw new Error("Repository curation overrides document is invalid.");
              }
              const mergedDocument = mergeOverridesDocuments(
                currentDocument as Record<string, unknown>,
                document as Record<string, unknown>,
              );

              const temporaryPath = `${overridesPath}.${randomUUID()}.tmp`;
              try {
                await writeFile(
                  temporaryPath,
                  `${JSON.stringify(mergedDocument, null, 2)}\n`,
                  "utf8",
                );
                await rename(temporaryPath, overridesPath);
              } catch (error) {
                try {
                  await unlink(temporaryPath);
                } catch (cleanupError) {
                  if (
                    !(cleanupError instanceof Error) ||
                    !("code" in cleanupError) ||
                    cleanupError.code !== "ENOENT"
                  ) {
                    console.error("Unable to clean up temporary overrides", cleanupError);
                  }
                }
                throw error;
              }
              response.end(
                JSON.stringify({ ok: true, document: mergedDocument }),
              );
            } catch (error) {
              const message =
                error instanceof SyntaxError
                  ? "Invalid JSON document."
                  : error instanceof Error
                    ? error.message
                    : "Unable to write overrides file.";
              const isInputError =
                error instanceof SyntaxError ||
                message === "Invalid curation overrides document." ||
                message === "Overrides document exceeds 5 MB.";
              if (!isInputError) {
                console.error("Unable to write curation overrides", error);
              }
              response.statusCode = isInputError ? 400 : 500;
              response.end(JSON.stringify({ error: message }));
            }
          },
        );
      },
    },
  ],
  server: {
    watch: {
      ignored: ["**/data/curation-overrides.json"],
    },
    proxy: {
      "/osm-tiles": {
        target: "https://tile.openstreetmap.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/osm-tiles/, ""),
        headers: {
          "User-Agent": "safe-access-zones-local-development/0.1",
        },
      },
    },
  },
});
