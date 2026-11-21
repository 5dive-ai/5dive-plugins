// Package store keeps the evidence on sqlite as two graphs: an asset graph shared
// across runs (what exists on the box, with first/last seen), and a per-run
// exploration graph (goal -> intent -> fact -> finding).
//
// Every run scans a NEW clone with a new IP, so the asset graph is keyed on the
// clone-free label (model.StableAsset): keyed on the IP, every asset of every run
// would be «new» and nothing would ever carry over (DIVE-8925).
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
	first_run_id TEXT,
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
CREATE TABLE IF NOT EXISTS traffic (
	id       INTEGER PRIMARY KEY,
	run_id   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	node_id  INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
	proto    TEXT NOT NULL,
	target   TEXT NOT NULL,
	request  TEXT NOT NULL,
	response TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traffic_run ON traffic(run_id);
CREATE TABLE IF NOT EXISTS finding_evidence (
	run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	finding_id TEXT NOT NULL,
	evidence   TEXT NOT NULL,
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
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("sqlite migrate: %w", err)
	}
	return s, nil
}

// migrate brings a database written by an older engine up to date: it adds
// first_run_id (NULL = seen before this engine, so never «new»), and re-keys
// assets stored under a clone IP onto their clone-free key, merging the copies
// each earlier clone left. Idempotent: a second pass finds nothing to do.
func (s *Store) migrate() error {
	var has int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('assets') WHERE name = 'first_run_id'`).Scan(&has); err != nil {
		return err
	}
	if has == 0 {
		if _, err := s.db.Exec(`ALTER TABLE assets ADD COLUMN first_run_id TEXT`); err != nil {
			return err
		}
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT id, kind, key FROM assets ORDER BY id`)
	if err != nil {
		return err
	}
	type stale struct {
		id        int64
		kind, key string
	}
	var todo []stale
	for rows.Next() {
		var a stale
		if err := rows.Scan(&a.id, &a.kind, &a.key); err != nil {
			rows.Close()
			return err
		}
		if model.StableAsset(a.key) != a.key {
			todo = append(todo, a)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, a := range todo {
		key := model.StableAsset(a.key)
		var keep int64
		switch err := tx.QueryRow(`SELECT id FROM assets WHERE kind = ? AND key = ?`, a.kind, key).Scan(&keep); err {
		case sql.ErrNoRows:
			if _, err := tx.Exec(`UPDATE assets SET key = ? WHERE id = ?`, key, a.id); err != nil {
				return err
			}
			continue
		case nil:
		default:
			return err
		}
		// Merge into the row already on the clone-free key: the earliest first
		// sighting wins, and the latest sighting's data and run.
		if _, err := tx.Exec(`UPDATE assets AS k SET
				first_run_id = CASE WHEN o.first_seen < k.first_seen THEN o.first_run_id ELSE k.first_run_id END,
				first_seen   = MIN(k.first_seen, o.first_seen),
				data         = CASE WHEN o.last_seen > k.last_seen THEN o.data ELSE k.data END,
				last_run_id  = CASE WHEN o.last_seen > k.last_seen THEN o.last_run_id ELSE k.last_run_id END,
				last_seen    = MAX(k.last_seen, o.last_seen)
			FROM (SELECT * FROM assets WHERE id = ?) AS o WHERE k.id = ?`, a.id, keep); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM assets WHERE id = ?`, a.id); err != nil {
			return err
		}
	}
	return tx.Commit()
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
	if err != nil || len(f.Evidence) == 0 {
		return err
	}
	_, err = s.db.Exec(`INSERT OR IGNORE INTO finding_evidence (run_id, finding_id, evidence) VALUES (?,?,?)`,
		runID, f.ID, toJSON(f.Evidence))
	return err
}

// AddTraffic records every exchange one step had with the target, under its intent node.
func (s *Store) AddTraffic(runID string, node int64, ex []model.Exchange) error {
	for _, e := range ex {
		if _, err := s.db.Exec(`INSERT INTO traffic (run_id, node_id, proto, target, request, response) VALUES (?,?,?,?,?,?)`,
			runID, nullID(node), e.Proto, e.Target, e.Request, e.Response); err != nil {
			return err
		}
	}
	return nil
}

// UpsertAsset adds an asset under its clone-free key, or refreshes its last_seen
// and data. first_seen and first_run_id stay those of the first sighting.
func (s *Store) UpsertAsset(runID string, a model.Asset, seen time.Time) error {
	data := "{}"
	if len(a.Data) > 0 {
		data = toJSON(a.Data)
	}
	_, err := s.db.Exec(`INSERT INTO assets (kind, key, data, first_seen, last_seen, last_run_id, first_run_id) VALUES (?,?,?,?,?,?,?)
		ON CONFLICT (kind, key) DO UPDATE SET data = excluded.data, last_seen = excluded.last_seen, last_run_id = excluded.last_run_id`,
		a.Kind, model.StableAsset(a.Key), data, stamp(seen), stamp(seen), runID, runID)
	return err
}

// EarlierRuns counts the other finished runs on this database (each one a check or
// a retest of the same server) and when the latest of them started; 0 = first run.
func (s *Store) EarlierRuns(runID string) (n int, since string, err error) {
	var last sql.NullString
	err = s.db.QueryRow(`SELECT COUNT(*), MAX(started_at) FROM runs WHERE id <> ? AND finished_at IS NOT NULL`, runID).Scan(&n, &last)
	return n, last.String, err
}

// NewAssets lists the assets this run was the first to see, in key order.
func (s *Store) NewAssets(runID string) ([]model.Asset, error) {
	rows, err := s.db.Query(`SELECT kind, key, data FROM assets WHERE first_run_id = ? ORDER BY kind, key`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Asset{}
	for rows.Next() {
		var a model.Asset
		var data string
		if err := rows.Scan(&a.Kind, &a.Key, &data); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(data), &a.Data); err != nil {
			return nil, err
		}
		if len(a.Data) == 0 {
			a.Data = nil
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// EarlierFindings is the model.FindingKey of every finding any other run reported.
func (s *Store) EarlierFindings(runID string) (map[string]bool, error) {
	rows, err := s.db.Query(`SELECT finding_id, asset FROM findings WHERE run_id <> ?`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id, asset string
		if err := rows.Scan(&id, &asset); err != nil {
			return nil, err
		}
		out[model.FindingKey(id, asset)] = true
	}
	return out, rows.Err()
}

// AssetRow is an asset as stored. FirstRunID is empty for an asset first seen
// by an engine older than first_run_id.
type AssetRow struct {
	Kind, Key, Data, FirstSeen, LastSeen, LastRunID, FirstRunID string
}

// Assets lists every asset.
func (s *Store) Assets() ([]AssetRow, error) {
	rows, err := s.db.Query(`SELECT kind, key, data, first_seen, last_seen, last_run_id, COALESCE(first_run_id, '') FROM assets ORDER BY kind, key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AssetRow
	for rows.Next() {
		var a AssetRow
		if err := rows.Scan(&a.Kind, &a.Key, &a.Data, &a.FirstSeen, &a.LastSeen, &a.LastRunID, &a.FirstRunID); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DB exposes the handle for tests and ad-hoc reads.
func (s *Store) DB() *sql.DB { return s.db }
