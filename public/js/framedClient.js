// Framed Protocol Client (application/x-tss-framed)
export async function fetchFramed(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("x-tsr-serverFn", "true");
  headers.set("accept", "application/x-tss-framed, application/json");

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const contentType = response.headers.get("content-type") || "";

  // إذا كانت الاستجابة بنظام التأطير الثنائي Framed
  if (contentType.includes("application/x-tss-framed")) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = new Uint8Array(0);

    const parts = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const next = new Uint8Array(buffer.length + value.length);
      next.set(buffer);
      next.set(value, buffer.length);
      buffer = next;

      // قراءة كل إطار بحجم 9 بايتات كحد أدنى
      while (buffer.length >= 9) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, 9);
        const type = view.getUint8(0);
        const streamId = view.getUint32(1, false);
        const len = view.getUint32(5, false);

        if (buffer.length < 9 + len) {
          // في انتظار بقية بيانات الإطار
          break;
        }

        const payload = buffer.subarray(9, 9 + len);
        buffer = buffer.subarray(9 + len);

        if (type === 0 || type === 1) {
          try {
            const parsed = JSON.parse(decoder.decode(payload));
            parts.push({ type, streamId, data: parsed });
          } catch {
            parts.push({ type, streamId, raw: payload });
          }
        }
      }
    }

    return parts;
  }

  return await response.json();
}
