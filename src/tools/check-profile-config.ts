import { resolve } from "node:path";

import { validateProductionProfileConfig } from "../profile-config-validation.js";

const configPath = process.env.PROFILE_CONFIG_PATH?.trim() || resolve(process.cwd(), "config/profiles.json");
const summary = validateProductionProfileConfig(configPath);

console.log(
  JSON.stringify(
    {
      configPath,
      ...summary
    },
    null,
    2
  )
);
