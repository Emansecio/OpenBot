/**
 * Process entry of the local gateway (`node dist/entry.js`).
 *
 * The supervisor only spawns and watches the worker, so it loads nothing but
 * the supervisor module; the worker loads the whole gateway once. Importing
 * src/main.ts here would load that graph in both processes.
 */
import { installLocalFileLoggerFromEnvironment } from "./local-logger.js";
import { GATEWAY_SUPERVISOR_ENV, GATEWAY_WORKER_ENV, superviseGateway } from "./server/gateway-supervisor.js";

if (process.env[GATEWAY_WORKER_ENV] === "1" || process.env[GATEWAY_SUPERVISOR_ENV] === "0") {
  const { runGateway } = await import("./main.js");
  runGateway();
} else {
  // A separate file: each logger must be the only writer of the file it rotates.
  installLocalFileLoggerFromEnvironment(process.env, console, {
    standard: "gateway-supervisor.log",
    errors: "gateway-supervisor.log",
  });
  superviseGateway();
}
