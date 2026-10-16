# Binding-code redemption authority

The signed group command still requires current group admission. A binding code
never admits a group by itself. Before consuming a code, the management service
reads its exact issuer/collection identity, checks the issuer's current Account
media-management permission, and checks their current Asset collection-management
access. Missing, revoked or deleted authority fails closed; a remote outage does
not consume the code. Success identifies the group and destination collection.

The local transaction consumes the inspected code ID only, serializes against
rotation/deletion, and checks expiry again after acquiring the collection lock.
Network requests do not hold that lock. A revocation after the remote checks but
before consume remains a cross-service race; this is not a linearizable authority
claim. Eliminating that window needs an authorization revision/claim contract.
Existing bindings are not automatically deleted when the code issuer loses access.

This slice does not expose pause, unbind or retry. Those operations require the
publication-preserving worker fences described in the reviewed implementation plan.

Validation includes signed group ingress, exact-code and post-lock expiry tests
on PostgreSQL, and the offline kernel integration harness with real PostgreSQL
and Redis. CI is required against `main`; PR #104 is the preceding status slice.
