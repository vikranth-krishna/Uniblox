import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { jsonLogger } from "./observability.js";

const config = loadConfig();
const app = createApp({ config, logger: jsonLogger });

const server = app.listen(config.port, () => {
  jsonLogger.info("server started", {
    port: config.port,
    couponEveryN: config.couponEveryN,
    couponPercent: config.couponPercent,
  });
});

// Let in-flight requests finish when the platform asks us to stop.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    jsonLogger.info("shutting down", { signal });
    server.close(() => process.exit(0));
  });
}
