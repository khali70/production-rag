-- Runs once, when the data volume is first created.
-- The extension must exist before the app connects: the pg client registers
-- the `vector` type parser on connect, which needs the type to be present.
CREATE EXTENSION IF NOT EXISTS vector;

-- Separate database for the contract test suite (TEST_DATABASE_URL).
CREATE DATABASE rag_test;
\connect rag_test
CREATE EXTENSION IF NOT EXISTS vector;
