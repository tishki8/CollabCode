// Phase 0 placeholder: only a health endpoint so the service can run under Docker Compose.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 1234);

createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", service: "collab" }));
  } else {
    res.writeHead(404).end();
  }
}).listen(port, "0.0.0.0", () => console.log("collab listening on", port));
