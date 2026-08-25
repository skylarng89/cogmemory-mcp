-- CogMemory MCP — Migration 005: Add metadata JSON column to edges
-- Used for similarity scores (SIMILAR_TO edges) and semantic relation info.

ALTER TABLE edges ADD COLUMN metadata TEXT;

PRAGMA user_version = 5;