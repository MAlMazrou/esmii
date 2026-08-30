import net from "node:net";
import tls from "node:tls";

function encodeCommand(parts: readonly string[]): Buffer {
  const chunks = [`*${parts.length}\r\n`];
  for (const part of parts) {
    chunks.push(`$${Buffer.byteLength(part)}\r\n${part}\r\n`);
  }
  return Buffer.from(chunks.join(""), "utf8");
}

function decodeUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("Valkey health probe failed");
  }
}

export async function pingValkey(rawUrl: string, timeoutMs = 3_000): Promise<void> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error("Valkey health probe failed");
  }
  if (target.protocol !== "redis:" && target.protocol !== "rediss:") {
    throw new Error("Valkey health probe failed");
  }

  const username = decodeUserInfo(target.username);
  const password = decodeUserInfo(target.password);
  const expectedResponses = password.length > 0 ? 2 : 1;
  const commands = [
    ...(password.length === 0
      ? []
      : [encodeCommand(username.length === 0 ? ["AUTH", password] : ["AUTH", username, password])]),
    encodeCommand(["PING"]),
  ];

  await new Promise<void>((resolve, reject) => {
    let response = "";
    let settled = false;
    const port = Number(target.port || (target.protocol === "rediss:" ? 6380 : 6379));

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error === undefined) {
        resolve();
      } else {
        reject(new Error("Valkey health probe failed"));
      }
    };

    const onConnected = (): void => {
      for (const command of commands) {
        socket.write(command);
      }
    };

    const socket =
      target.protocol === "rediss:"
        ? tls.connect(
            {
              host: target.hostname,
              port,
              rejectUnauthorized: true,
              servername: target.hostname,
            },
            onConnected,
          )
        : net.createConnection({ host: target.hostname, port }, onConnected);

    socket.setTimeout(timeoutMs, () => finish(new Error("timeout")));
    socket.on("error", () => finish(new Error("socket")));
    socket.on("close", () => finish(new Error("closed")));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (response.length > 4_096 || response.includes("\r\n-")) {
        finish(new Error("response"));
        return;
      }

      const lines = response.split("\r\n").filter((line) => line.length > 0);
      if (lines.some((line) => line.startsWith("-"))) {
        finish(new Error("response"));
        return;
      }

      if (lines.length >= expectedResponses) {
        const finalLine = lines.at(expectedResponses - 1);
        finish(finalLine === "+PONG" ? undefined : new Error("response"));
      }
    });
  });
}
