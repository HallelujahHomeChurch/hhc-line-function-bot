import { createHash, randomBytes } from "node:crypto";

export interface RegistrationInviteCode {
  code: string;
  expiresAt: string;
}

export interface CreateRegistrationInviteCodeInput {
  profileName: string;
  createdBy: string;
  ttlMinutes: number;
  now?: Date;
}

export interface RegistrationInviteCodeStore {
  create(input: CreateRegistrationInviteCodeInput): Promise<RegistrationInviteCode>;
  consume(profileName: string, code: string): Promise<boolean>;
}

export interface RedisRegistrationInviteCodeClient {
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  getDel(key: string): Promise<string | null>;
}

interface InviteCodeRecord {
  profileName: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

export class InMemoryRegistrationInviteCodeStore implements RegistrationInviteCodeStore {
  private readonly records = new Map<string, InviteCodeRecord>();
  private readonly codeFactory: () => string;
  private readonly now: () => Date;

  constructor(options: { codeFactory?: () => string; now?: () => Date } = {}) {
    this.codeFactory = options.codeFactory ?? generateInviteCode;
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateRegistrationInviteCodeInput): Promise<RegistrationInviteCode> {
    const now = input.now ?? this.now();
    const code = this.codeFactory();
    const expiresAt = addMinutes(now, input.ttlMinutes).toISOString();
    this.records.set(inviteCodeKey(input.profileName, code), {
      profileName: input.profileName,
      createdBy: input.createdBy,
      createdAt: now.toISOString(),
      expiresAt
    });
    return { code, expiresAt };
  }

  async consume(profileName: string, code: string): Promise<boolean> {
    const key = inviteCodeKey(profileName, code);
    const record = this.records.get(key);
    if (!record) {
      return false;
    }
    this.records.delete(key);
    return new Date(record.expiresAt).getTime() > this.now().getTime();
  }
}

export class RedisRegistrationInviteCodeStore implements RegistrationInviteCodeStore {
  private readonly client: RedisRegistrationInviteCodeClient;
  private readonly keyPrefix: string;
  private readonly codeFactory: () => string;
  private readonly now: () => Date;

  constructor(options: {
    client: RedisRegistrationInviteCodeClient;
    keyPrefix: string;
    codeFactory?: () => string;
    now?: () => Date;
  }) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix;
    this.codeFactory = options.codeFactory ?? generateInviteCode;
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateRegistrationInviteCodeInput): Promise<RegistrationInviteCode> {
    const now = input.now ?? this.now();
    const code = this.codeFactory();
    const ttlSeconds = Math.max(1, Math.trunc(input.ttlMinutes * 60));
    const expiresAt = addMinutes(now, input.ttlMinutes).toISOString();
    const record: InviteCodeRecord = {
      profileName: input.profileName,
      createdBy: input.createdBy,
      createdAt: now.toISOString(),
      expiresAt
    };
    await this.client.setEx(this.key(input.profileName, code), ttlSeconds, JSON.stringify(record));
    return { code, expiresAt };
  }

  async consume(profileName: string, code: string): Promise<boolean> {
    const record = await this.client.getDel(this.key(profileName, code));
    if (!record) {
      return false;
    }
    try {
      const parsed = JSON.parse(record) as InviteCodeRecord;
      return (
        parsed.profileName === profileName &&
        new Date(parsed.expiresAt).getTime() > this.now().getTime()
      );
    } catch {
      return false;
    }
  }

  private key(profileName: string, code: string): string {
    return `${this.keyPrefix}:registration-invite:${profileName}:${hashInviteCode(code)}`;
  }
}

export function generateInviteCode(): string {
  return randomBytes(12).toString("base64url");
}

function inviteCodeKey(profileName: string, code: string): string {
  return `${profileName}:${hashInviteCode(code)}`;
}

function hashInviteCode(code: string): string {
  return createHash("sha256").update(code.trim(), "utf8").digest("hex");
}

function addMinutes(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60 * 1000);
}
