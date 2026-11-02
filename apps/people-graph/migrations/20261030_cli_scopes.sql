-- Existing challenges retain NULL and continue to mint read-only pgd1 credentials.
ALTER TABLE cli_challenges ADD COLUMN requested_scopes TEXT;
