// In-process webhook capture server for the demos: records every request
// (headers + raw body text) so the demo can verify signatures in the same
// process that received them. Replaces any external listener.
import { createServer } from "node:http";

export function startCapture(port) {
  const items = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      items.push({
        at: new Date().toISOString(),
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        items,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}
