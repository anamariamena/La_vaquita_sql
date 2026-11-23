const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "public");
const sqlJsAssets = path.join(__dirname, "node_modules", "sql.js", "dist");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
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
  let pathname;
  let decodedPathname;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
    decodedPathname = decodeURIComponent(pathname);
  } catch (error) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, {
      Allow: "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8"
    });
    response.end("Method not allowed");
    return;
  }

  const assetPath = pathname === "/vendor/sql-wasm.js"
    ? path.join(sqlJsAssets, "sql-wasm.js")
    : pathname === "/vendor/sql-wasm.wasm"
      ? path.join(sqlJsAssets, "sql-wasm.wasm")
      : path.join(root, decodedPathname.replace(/^\/+/, ""));
  const resolvedPath = path.resolve(assetPath);
  const allowedRoot = pathname.startsWith("/vendor/")
    ? sqlJsAssets
    : root;

  if (!resolvedPath.startsWith(`${allowedRoot}${path.sep}`) && resolvedPath !== allowedRoot) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  fs.stat(resolvedPath, (error, stats) => {
    const filePath = !error && stats.isDirectory()
      ? path.join(resolvedPath, "index.html")
      : resolvedPath;
    fs.readFile(filePath, (readError, contents) => {
      if (readError) {
        response.writeHead(readError.code === "ENOENT" ? 404 : 500, {
          "Content-Type": "text/plain; charset=utf-8"
        });
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
}).listen(port, host, () => {
  console.log(`La Vaquita disponible en http://${host}:${port}`);
});
