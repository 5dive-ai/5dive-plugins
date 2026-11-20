// Package store keeps the evidence on sqlite as two graphs: an asset graph shared
// across runs (what exists on the box, with first/last seen), and a per-run
// exploration graph (goal -> intent -> fact -> finding).
package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver, registers "sqlite"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
)

const schema = `
CREATE TABLE IF NOT EXISTS assets (
	id          INTEGER PRIMARY KEY,
	kind        TEXT NOT NULL CHECK (kind IN ('host','port','service','url','cert')),
	key         TEXT NOT NULL,
	data        TEXT NOT NULL DEFAULT '{}',
	first_seen  TEXT NOT NULL,
	last_seen   TEXT NOT NULL,
	last_run_id TEXT NOT NULL,
	UNIQUE (kind, key)
);
CREATE TABLE IF NOT EXISTS runs (
	id             TEXT PRIMARY KEY,
	started_at     TEXT NOT NULL,
	finished_at    TEXT,
	engine_version TEXT NOT NULL,
	scope          TEXT NOT NULL,
	approval_mode  TEXT NOT NULL,
	stopped_reason TEXT,
	tokens_used    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS nodes (
	id         INTEGER PRIMARY KEY,
	run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	parent_id  INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
	kind       TEXT NOT NULL CHECK (kind IN ('goal','intent','fact','finding')),
	payload    TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_run ON nodes(run_id);
CREATE TABLE IF NOT EXISTS approvals (
	id        INTEGER PRIMARY KEY,
	run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	step      INTEGER NOT NULL,
	tool      TEXT NOT NULL,
	target    TEXT NOT NULL,
	decision  TEXT NOT NULL CHECK (decision IN ('approved','denied')),
	reason    TEXT NOT NULL,
	node_id   INTEGER REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS findings (
	id         INTEGER PRIMARY KEY,
	run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	finding_id TEXT NOT NULL,
	severity   TEXT NOT NULL,
	title      TEXT NOT NULL,
	what       TEXT NOT NULL,
	why        TEXT NOT NULL,
	fix        TEXT NOT NULL,
	proof      TEXT NOT NULL,
	asset      TEXT NOT NULL,
	node_id    INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
	UNIQUE (run_id, finding_id)
);
`

// Store wraps the sqlite database.
type Store struct{ db *sql.DB }

// Open opens (or creates) the database and applies the schema.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("sqlite schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// nullID stores 0 as NULL so it never points at a missing node.
func nullID(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}

func toJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// StartRun records a run. A retry of the same run_id replaces the earlier attempt.
func (s *Store) StartRun(id, version, approval string, scope any, started time.Time) error {
	if _, err := s.db.Exec(`DELETE FROM runs WHERE id = ?`, id); err != nil {
		return err
	}
	_, err := s.db.Exec(`INSERT INTO runs (id, started_at, engine_version, scope, approval_mode) VALUES (?,?,?,?,?)`,
		id, stamp(started), version, toJSON(scope), approval)
	return err
}

// FinishRun closes a run.
func (s *Store) FinishRun(id, reason string, tokens int, finished time.Time) error {
	_, err := s.db.Exec(`UPDATE runs SET finished_at = ?, stopped_reason = ?, tokens_used = ? WHERE id = ?`,
		stamp(finished), reason, tokens, id)
	return err
}

// AddNode adds an exploration-graph node; parent 0 means none.
func (s *Store) AddNode(runID string, parent int64, kind string, payload any) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO nodes (run_id, parent_id, kind, payload, created_at) VALUES (?,?,?,?,?)`,
		runID, nullID(parent), kind, toJSON(payload), stamp(time.Now()))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// AddApproval records a gate decision.
func (s *Store) AddApproval(runID string, step int, tool, target, decision, reason string, node int64) error {
	_, err := s.db.Exec(`INSERT INTO approvals (run_id, step, tool, target, decision, reason, node_id) VALUES (?,?,?,?,?,?,?)`,
		runID, step, tool, target, decision, reason, nullID(node))
	return err
}

// AddFinding records a finding once per run.
func (s *Store) AddFinding(runID string, f model.Finding, node int64) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO findings (run_id, finding_id, severity, title, what, why, fix, proof, asset, node_id)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, runID, f.ID, f.Severity, f.Title, f.What, f.Why, f.Fix, f.Proof, f.Asset, nullID(node))
	return err
}

// UpsertAsset adds an asset or refreshes its last_seen and data.
func (s *Store) UpsertAsset(runID string, a model.Asset, seen time.Time) error {
	data := "{}"
	if len(a.Data) > 0 {
		data = toJSON(a.Data)
	}
	_, err := s.db.Exec(`INSERT INTO assets (kind, key, data, first_seen, last_seen, last_run_id) VALUES (?,?,?,?,?,?)
		ON CONFLICT (kind, key) DO UPDATE SET data = excluded.data, last_seen = excluded.last_seen, last_run_id = excluded.last_run_id`,
		a.Kind, a.Key, data, stamp(seen), stamp(seen), runID)
	return err
}

// AssetRow is an asset as stored.
type AssetRow struct {
	Kind, Key, Data, FirstSeen, LastSeen, LastRunID string
}

// Assets lists every asset.
func (s *Store) Assets() ([]AssetRow, error) {
	rows, err := s.db.Query(`SELECT kind, key, data, first_seen, last_seen, last_run_id FROM assets ORDER BY kind, key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AssetRow
	for rows.Next() {
		var a AssetRow
		if err := rows.Scan(&a.Kind, &a.Key, &a.Data, &a.FirstSeen, &a.LastSeen, &a.LastRunID); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DB exposes the handle for tests and ad-hoc reads.
func (s *Store) DB() *sql.DB { return s.db }
