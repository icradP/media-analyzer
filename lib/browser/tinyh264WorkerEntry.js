import { init } from "../tinyh264/index.js";

init().catch((err) => {
  const message = err?.message || String(err);
  try {
    self.postMessage({
      type: "tinyh264WorkerInitError",
      message,
      stack: err?.stack || null,
    });
  } catch {
    // ignore postMessage failures
  }
  throw err;
});
