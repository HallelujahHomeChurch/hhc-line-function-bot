-- Legacy table from the removed direct OpenAI/Codex OAuth provider.
-- Run manually after confirming the deployment no longer uses that provider.

DROP TABLE IF EXISTS llm_auth_profiles;
