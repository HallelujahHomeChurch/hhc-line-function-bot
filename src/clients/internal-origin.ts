/** Production service callers stay on the reviewed internal ACA origins. */
export function validateInternalServiceOrigin(
  value: string,
  service: "asset-api" | "operations-api",
  environment = process.env.NODE_ENV
): void {
  if (environment !== "production") return;
  const expected = `https://${service}.internal.gentleriver-81abd7bc.eastasia.azurecontainerapps.io`;
  if (value.replace(/\/$/u, "") !== expected) {
    throw new Error(`Invalid ${service} private HTTPS origin`);
  }
}
