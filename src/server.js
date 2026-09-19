import http from "node:http";

export function healthPayload() {
  return { status: "ok" };
}

export function createServer() {
  return http.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(healthPayload()));
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createServer().listen(port, "0.0.0.0");
}
