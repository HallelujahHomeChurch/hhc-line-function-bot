import type {
  UpdateOwnProfileInput,
  OwnProfileResult
} from "../../account/account-admin-client.js";

export interface UpdateOwnProfileClient {
  updateOwnProfile(input: UpdateOwnProfileInput): Promise<OwnProfileResult>;
}

export interface UpdateOwnProfileDependencies {
  accountClient: UpdateOwnProfileClient;
}
