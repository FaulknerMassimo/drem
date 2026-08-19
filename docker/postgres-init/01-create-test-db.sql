-- Dedicated database for `npm run test:integration`. The suites truncate
-- freely; they must never share a catalog with the owner's journal.
CREATE DATABASE drem_test;
