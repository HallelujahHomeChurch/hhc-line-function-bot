import { createProductionRuntime } from "./bootstrap/create-production-runtime.js";
import { loadConfigFromEnv } from "./config.js";

const config = loadConfigFromEnv(process.env);
const runtime = await createProductionRuntime(config);

await runtime.app.listen({ host: config.host, port: config.port });
