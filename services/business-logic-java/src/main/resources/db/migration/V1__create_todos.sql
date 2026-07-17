-- V1 baseline: the todos table, translated from the retired SQLite/Bun schema
-- (services/business-logic/src/db.ts) to native PostgreSQL types.
--
-- Type-mapping decisions (SQLite -> PostgreSQL), justified:
--   id         TEXT           -> text        Kept as text, NOT uuid: ids are
--                                            generated app-side as canonical
--                                            lowercase UUIDv7 strings, and the
--                                            service pins case-SENSITIVE exact
--                                            match semantics (an upper-cased
--                                            UUID must MISS at the repo layer,
--                                            see MainTest). A uuid column would
--                                            canonicalise case and silently
--                                            change that behaviour.
--   title      TEXT           -> text        Direct.
--   completed  INTEGER 0/1    -> boolean     SQLite lacked a boolean type; the
--                                            domain model is already a boolean.
--                                            Postgres has a real boolean, so the
--                                            honest column type is boolean
--                                            (default false, was INTEGER 0).
--   created_at TEXT (ISO str) -> timestamptz Was an ISO-8601 millis string in
--   updated_at                                SQLite; the domain model is
--                                            java.time.Instant, so the honest
--                                            type is timestamptz. The app writes
--                                            explicit millisecond-truncated
--                                            values (preserving Bun's ms
--                                            granularity); DEFAULT now() is a
--                                            safety net for direct inserts.
CREATE TABLE todos (
    id         text        PRIMARY KEY,
    title      text        NOT NULL,
    completed  boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
