import type { UpdateOwnProfileInput } from "../../account/account-admin-client.js";
import type { SessionStore } from "../../state/session-store.js";

export interface UpdateOwnProfileClient {
  updateOwnProfile(input: UpdateOwnProfileInput): Promise<{ firstName: string; lastName: string }>;
}

export interface UpdateOwnProfileDependencies {
  accountClient: UpdateOwnProfileClient;
  sessionStore: SessionStore;
  now?: () => Date;
  requestIdFactory?: () => string;
}
