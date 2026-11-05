import handleRequest from "../server.mjs";

export default async function handler(req, res) {
  // Debug logging for Vercel
  const path = req.url || "";
  const method = req.method || "?";
  const bodyType = req.body === undefined ? "undefined" : (Buffer.isBuffer(req.body) ? `Buffer(${req.body.length})` : typeof req.body);
  console.log(`[VERCEL] ${method} ${path} | body: ${bodyType} | host: ${req.headers?.host}`);
  return handleRequest(req, res);
}
