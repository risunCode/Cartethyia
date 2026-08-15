import * as net from "node:net";
import * as tls from "node:tls";

export async function connectCursorProxy(proxyUrlValue: string, targetUrlValue: string, signal: AbortSignal, timeoutMs = 30_000): Promise<tls.TLSSocket> {
  const proxyUrl = new URL(proxyUrlValue);
  const targetUrl = new URL(targetUrlValue);
  if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") throw new Error("Cursor HTTP/2 transport currently supports HTTP CONNECT proxies only");
  const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80));
  const targetPort = Number(targetUrl.port || 443);
  const rawSocket = await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(proxyPort, proxyUrl.hostname);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Cursor proxy tunnel timed out")); }, timeoutMs);
    const abort = () => { clearTimeout(timer); socket.destroy(); reject(new Error("Cursor proxy tunnel aborted")); };
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    socket.once("connect", () => { cleanup(); resolve(socket); });
    socket.once("error", (error) => { cleanup(); reject(error); });
    signal.addEventListener("abort", abort, { once: true });
  });
  const authority = `${targetUrl.hostname}:${targetPort}`;
  const credentials = proxyUrl.username.length > 0 ? `\r\nProxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}` : "";
  rawSocket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}${credentials}\r\n\r\n`);
  const response = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Cursor proxy CONNECT timed out")), timeoutMs);
    const onData = (chunk: Buffer) => { buffer += chunk.toString("latin1"); if (!buffer.includes("\r\n\r\n")) return; cleanup(); resolve(buffer); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { clearTimeout(timer); rawSocket.off("data", onData); rawSocket.off("error", onError); };
    rawSocket.on("data", onData); rawSocket.once("error", onError);
  });
  if (!/^HTTP\/\d\.\d 200(?: |$)/.test(response)) { rawSocket.destroy(); throw new Error(`Cursor proxy CONNECT failed: ${response.split("\r\n", 1)[0]}`); }
  return await new Promise<tls.TLSSocket>((resolve, reject) => {
    const socket = tls.connect({ socket: rawSocket, servername: targetUrl.hostname, ALPNProtocols: ["h2"] });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
  });
}
