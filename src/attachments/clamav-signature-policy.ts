export const CLAMAV_SIGNATURE_WARNING_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClamAvSignatureManifest {
  version: 1;
  signatureVersion: string;
  lastSuccessfulAt: string;
  databaseDirectory?: string;
}

export interface ClamAvSignaturePolicy {
  warningAgeMs: number;
}

export type ClamAvSignatureHealth = "current" | "warning";

export type ClamAvSignatureAssessment =
  | {
      status: "usable";
      health: ClamAvSignatureHealth;
      manifest: ClamAvSignatureManifest;
    }
  | { status: "invalid" };

export function assessClamAvSignatureManifest(
  value: unknown,
  now: Date,
  policy: ClamAvSignaturePolicy = { warningAgeMs: CLAMAV_SIGNATURE_WARNING_AGE_MS }
): ClamAvSignatureAssessment {
  if (!isValidPolicy(policy) || !Number.isFinite(now.getTime())) {
    return { status: "invalid" };
  }
  if (!value || typeof value !== "object") return { status: "invalid" };

  const manifest = value as Partial<ClamAvSignatureManifest>;
  if (
    manifest.version !== 1 ||
    typeof manifest.signatureVersion !== "string" ||
    !/^[A-Za-z0-9._-]{1,120}$/u.test(manifest.signatureVersion) ||
    typeof manifest.lastSuccessfulAt !== "string" ||
    !isValidDatabaseDirectory(manifest.databaseDirectory)
  ) {
    return { status: "invalid" };
  }

  const timestamp = Date.parse(manifest.lastSuccessfulAt);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== manifest.lastSuccessfulAt ||
    timestamp > now.getTime()
  ) {
    return { status: "invalid" };
  }

  const validatedManifest: ClamAvSignatureManifest = {
    version: manifest.version,
    signatureVersion: manifest.signatureVersion,
    lastSuccessfulAt: manifest.lastSuccessfulAt,
    ...(manifest.databaseDirectory === undefined
      ? {}
      : { databaseDirectory: manifest.databaseDirectory })
  };
  return {
    status: "usable",
    health: now.getTime() - timestamp < policy.warningAgeMs ? "current" : "warning",
    manifest: validatedManifest
  };
}

function isValidPolicy(policy: ClamAvSignaturePolicy): boolean {
  return (
    typeof policy === "object" &&
    policy !== null &&
    Number.isFinite(policy.warningAgeMs) &&
    policy.warningAgeMs > 0
  );
}

function isValidDatabaseDirectory(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && /^sets\/[A-Za-z0-9._-]{1,120}$/u.test(value))
  );
}
