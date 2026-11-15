const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "public");
const sqlJsAssets = path.join(__dirname, "node_modules", "sql.js", "dist");
const dataDirectory = path.join(__dirname, "data");
const databasePath = path.join(dataDirectory, "cuenta-clara.db");
const port = Number(process.env.PORT || 3000);
const maximumDatabaseSize = 50 * 1024 * 1024;
const sqliteHeader = Buffer.from("SQLite format 3\0");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm"
};

http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/api/database") {
    const origin = request.headers.origin;
    let originHost;
    try {
      originHost = origin ? new URL(origin).host : null;
    } catch (error) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    if (originHost && originHost !== request.headers.host) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      fs.readFile(databasePath, (error, contents) => {
        if (error) {
          if (error.code === "ENOENT") {
            response.writeHead(204);
            response.end();
            return;
          }
          console.error("No se pudo leer la base de datos automática:", error);
          response.writeHead(500);
          response.end("No se pudo leer la base de datos.");
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/vnd.sqlite3",
          "Content-Length": contents.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        response.end(request.method === "HEAD" ? undefined : contents);
      });
      return;
    }

    if (request.method !== "PUT") {
      response.writeHead(405, { Allow: "GET, HEAD, PUT" });
      response.end("Method not allowed");
      return;
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumDatabaseSize) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", async () => {
      if (tooLarge) {
        response.writeHead(413);
        response.end("La base de datos supera el tamaño máximo permitido.");
        return;
      }
      const contents = Buffer.concat(chunks);
      if (contents.length < sqliteHeader.length || !contents.subarray(0, sqliteHeader.length).equals(sqliteHeader)) {
        response.writeHead(400);
        response.end("El archivo recibido no es una base de datos SQLite válida.");
        return;
      }

      const temporaryPath = `${databasePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.promises.mkdir(dataDirectory, { recursive: true });
        await fs.promises.writeFile(temporaryPath, contents);
        await fs.promises.rename(temporaryPath, databasePath);
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
      } catch (error) {
        fs.promises.unlink(temporaryPath).catch(() => {});
        console.error("No se pudo guardar la base de datos automática:", error);
        response.writeHead(500);
        response.end("No se pudo guardar la base de datos.");
      }
    });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }

  const assetPath = pathname === "/vendor/sql-wasm.js"
    ? path.join(sqlJsAssets, "sql-wasm.js")
    : pathname === "/vendor/sql-wasm.wasm"
      ? path.join(sqlJsAssets, "sql-wasm.wasm")
      : path.join(root, decodeURIComponent(pathname).replace(/^\/+/, ""));
  const resolvedPath = path.resolve(assetPath);
  const allowedRoot = pathname.startsWith("/vendor/")
    ? sqlJsAssets
    : root;

  if (!resolvedPath.startsWith(`${allowedRoot}${path.sep}`) && resolvedPath !== allowedRoot) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.stat(resolvedPath, (error, stats) => {
    const filePath = !error && stats.isDirectory()
      ? path.join(resolvedPath, "index.html")
      : resolvedPath;
    fs.readFile(filePath, (readError, contents) => {
      if (readError) {
        response.writeHead(readError.code === "ENOENT" ? 404 : 500);
        response.end(readError.code === "ENOENT" ? "Not found" : "Server error");
        return;
      }

      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store"
      });
      response.end(request.method === "HEAD" ? undefined : contents);
    });
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`La Vaquita disponible en http://127.0.0.1:${port}`);
});
