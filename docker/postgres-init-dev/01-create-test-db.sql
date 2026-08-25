-- Dedicated database for `npm run test:integration`. The suites truncate
-- freely, so they need a catalog nothing else reads.
--
-- Created in the development cluster only. The production cluster runs no init
-- scripts at all: a database named `drem_test` sitting next to the real journal
-- is an invitation to point a suite at the wrong one.
CREATE DATABASE drem_test;
