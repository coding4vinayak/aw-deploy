// The LinkedIn messaging API has no feedback loop: the response to the POST
// is the only words it will ever give about a recipient. This stub is those
// words on tap — it answers by the member slug in `recipients`, so one
// sending account can play the reachability oracle for four prospects at
// once: nina/odin get the 400 that accuses the recipient, liam a 429 that
// accuses only the hour, and anyone else a 200 with a provider id. The demo
// process owns the port and the app reaches it through LINKEDIN_API_BASE,
// exactly the stand-in the SMTP sink is for email.
import http from "node:http";

export function startLinkedInStub(port) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ url: req.url, body });
      const reply = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      let who = "";
      try {
        const recipients = JSON.parse(body)?.recipients ?? [];
        who = recipients.join(",").toLowerCase();
      } catch {
        who = "";
      }
      if (who.includes("nina") || who.includes("odin")) {
        reply(400, { message: "The requested recipient could not be found" });
        return;
      }
      if (who.includes("liam")) {
        reply(429, { message: "Too many requests for this recipient today" });
        return;
      }
      reply(200, { id: `li-stub-${seen.length}` });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({ server, seen, close: () => new Promise((r) => server.close(r)) }),
    );
  });
}
