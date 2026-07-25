import {
  createLocalRuntime,
  createProductionRuntime
} from "./bootstrap/create-production-runtime.js";
import { loadConfigFromEnv } from "./config.js";

const config = loadConfigFromEnv(process.env);
const runtime =
  process.env.NODE_ENV === "production"
    ? await createProductionRuntime(config)
    : await createLocalRuntime(config);

await runtime.app.listen({ host: config.host, port: config.port });
