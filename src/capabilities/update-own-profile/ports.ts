import type { UpdateOwnProfileInput } from "../../account/account-admin-client.js";

export interface UpdateOwnProfileClient {
  updateOwnProfile(input: UpdateOwnProfileInput): Promise<{ firstName: string; lastName: string }>;
}

export interface UpdateOwnProfileDependencies {
  accountClient: UpdateOwnProfileClient;
}
