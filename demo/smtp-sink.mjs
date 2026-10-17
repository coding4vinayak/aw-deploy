// In-process SMTP sink for the demos: enough of the protocol for nodemailer
// (greeting, EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA) so a product's real
// send path can deliver to it and the demo can read exactly what left the app.
// No mail is sent anywhere; messages land in the returned array.
import net from "node:net";

export function startSmtpSink(port) {
  const messages = [];
  let counter = 0;

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 smtp-sink.demo ESMTP ready\r\n");
    let buffer = "";
    let inData = false;
    let dataLines = [];
    let authState = null; // "plain-wait" | "username" | "password"
    let from = null;
    let rcpt = [];

    const send = (line) => socket.write(line + "\r\n");
    const reset = () => {
      from = null;
      rcpt = [];
      dataLines = [];
    };

    const endData = () => {
      inData = false;
      const raw = dataLines.join("\r\n");
      counter += 1;
      messages.push({
        receivedAt: new Date().toISOString(),
        from,
        to: rcpt.slice(),
        messageId: (raw.match(/^Message-ID:\s*(.+)$/im) || [, ""])[1].trim(),
        subject: (raw.match(/^Subject:\s*(.+)$/im) || [, ""])[1].trim(),
        raw,
      });
      send(`250 2.0.0 Ok: queued as DEMO${counter}`);
      reset();
    };

    const handle = (line) => {
      if (inData) {
        if (line === ".") endData();
        else dataLines.push(line.startsWith("..") ? line.slice(1) : line);
        return;
      }
      const upper = line.toUpperCase();
      if (authState === "plain-wait") {
        authState = null;
        return send("235 2.7.0 Authentication successful");
      }
      if (authState === "username") {
        authState = "password";
        return send("334 UGFzc3dvcmQ6");
      }
      if (authState === "password") {
        authState = null;
        return send("235 2.7.0 Authentication successful");
      }
      if (upper.startsWith("EHLO")) {
        socket.write(
          "250-smtp-sink.demo\r\n250-8BITMIME\r\n250-SIZE 10485760\r\n250-AUTH PLAIN LOGIN\r\n250 PIPELINING\r\n"
        );
        return;
      }
      if (upper.startsWith("HELO")) return send("250 smtp-sink.demo");
      if (upper.startsWith("AUTH PLAIN")) {
        const arg = line.slice(10).trim();
        if (arg) return send("235 2.7.0 Authentication successful");
        authState = "plain-wait";
        return send("334 ");
      }
      if (upper.startsWith("AUTH LOGIN")) {
        authState = "username";
        return send("334 VXNlcm5hbWU6");
      }
      if (upper.startsWith("MAIL FROM")) {
        from = (line.match(/<([^>]*)>/) || [, line.slice(10).trim()])[1];
        return send("250 2.1.0 Ok");
      }
      if (upper.startsWith("RCPT TO")) {
        rcpt.push((line.match(/<([^>]+)>/) || [, ""])[1]);
        return send("250 2.1.5 Ok");
      }
      if (upper === "DATA") {
        inData = true;
        dataLines = [];
        return send("354 End data with <CR><LF>.<CR><LF>");
      }
      if (upper === "QUIT") {
        send("221 2.0.0 Bye");
        return socket.end();
      }
      if (upper === "RSET" || upper === "NOOP") {
        reset();
        return send("250 2.0.0 Ok");
      }
      send("250 2.0.0 Ok");
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handle(line);
      }
    });
    socket.on("error", () => {});
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        messages,
        close: () => new Promise((r) => server.close(() => r())),
      })
    );
  });
}
