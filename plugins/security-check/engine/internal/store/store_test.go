package store

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/lodar/5dive-plugins/plugins/security-check/engine/internal/model"
)

func TestAssetUpsertAcrossTwoRuns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "e.sqlite")
	t1 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	t2 := t1.Add(30 * 24 * time.Hour)
	port := model.Asset{Kind: "port", Key: "203.0.113.7:22/tcp"}

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.StartRun("run-1", "v", "auto-safe", map[string]string{}, t1); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertAsset("run-1", port, t1); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertAsset("run-1", model.Asset{Kind: "port", Key: "203.0.113.7:6379/tcp"}, t1); err != nil {
		t.Fatal(err)
	}
	s.Close()

	// Second run, second process: schema creation is idempotent.
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.StartRun("run-2", "v", "auto-safe", map[string]string{}, t2); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertAsset("run-2", model.Asset{Kind: "port", Key: port.Key, Data: map[string]string{"banner": "SSH-2.0-x"}}, t2); err != nil {
		t.Fatal(err)
	}
	rows, err := s.Assets()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 assets, got %+v", rows)
	}
	for _, a := range rows {
		switch a.Key {
		case "server:22/tcp": // stored clone-free (DIVE-8925)
			if a.FirstSeen != stamp(t1) || a.LastSeen != stamp(t2) || a.LastRunID != "run-2" || a.Data != `{"banner":"SSH-2.0-x"}` {
				t.Errorf("ssh port not refreshed: %+v", a)
			}
		default: // closed since run 1: last_seen stays at run 1, which is how a later run sees it is gone
			if a.LastSeen != stamp(t1) || a.LastRunID != "run-1" {
				t.Errorf("redis port touched: %+v", a)
			}
		}
	}
}

func TestRunRetryReplacesEarlierAttempt(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "e.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 2; i++ {
		if err := s.StartRun("r", "v", "auto-safe", nil, time.Now()); err != nil {
			t.Fatal(err)
		}
		g, err := s.AddNode("r", 0, "goal", "g")
		if err != nil {
			t.Fatal(err)
		}
		n, err := s.AddNode("r", g, "intent", "i")
		if err != nil {
			t.Fatal(err)
		}
		if err := s.AddApproval("r", 1, "port_scan", "127.0.0.1", "approved", "ok", n); err != nil {
			t.Fatal(err)
		}
		if err := s.AddFinding("r", model.Finding{ID: "x", Severity: "low"}, 0); err != nil {
			t.Fatal(err)
		}
	}
	for table, want := range map[string]int{"runs": 1, "nodes": 2, "approvals": 1, "findings": 1} {
		var n int
		if err := s.DB().QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != want {
			t.Errorf("%s: %d rows, want %d", table, n, want)
		}
	}
	if _, err := s.AddNode("r", 0, "banana", "x"); err == nil {
		t.Error("node kind outside goal|intent|fact|finding accepted")
	}
}

// DIVE-8925: a database an older engine wrote keys its assets on each clone's IP
// and has no first_run_id. Opening it re-keys every asset clone-free, merges the
// copies each clone left (earliest first sighting, latest data), and marks none
// of them as first seen by any run, so the next check does not call them «new».
func TestOpenRekeysAnOlderEnginesAssets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.sqlite")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE assets (
		id INTEGER PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
		first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, last_run_id TEXT NOT NULL, UNIQUE (kind, key));
	INSERT INTO assets (kind, key, data, first_seen, last_seen, last_run_id) VALUES
		('port', '203.0.113.10:22/tcp', '{"v":"old"}', '2026-09-01', '2026-09-01', 'run-a'),
		('port', '203.0.113.77:22/tcp', '{"v":"new"}', '2026-10-01', '2026-10-01', 'run-b'),
		('host', '203.0.113.77', '{}', '2026-10-01', '2026-10-01', 'run-b'),
		('url', 'https://box.example.com (203.0.113.77:443)', '{}', '2026-10-01', '2026-10-01', 'run-b'),
		('cert', 'ab12cd', '{}', '2026-10-01', '2026-10-01', 'run-b');`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	for pass := 0; pass < 2; pass++ { // the second Open must change nothing
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := s.Assets()
		s.Close()
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]AssetRow{}
		for _, a := range rows {
			got[a.Kind+" "+a.Key] = a
		}
		if len(got) != 4 {
			t.Fatalf("pass %d: want 4 assets, got %+v", pass, rows)
		}
		ssh := got["port server:22/tcp"]
		if ssh.FirstSeen != "2026-09-01" || ssh.LastSeen != "2026-10-01" || ssh.LastRunID != "run-b" || ssh.Data != `{"v":"new"}` {
			t.Errorf("pass %d: ssh port merged wrong: %+v", pass, ssh)
		}
		for _, k := range []string{"host server", "url https://box.example.com (server:443)", "cert ab12cd"} {
			if _, ok := got[k]; !ok {
				t.Errorf("pass %d: missing %q in %v", pass, k, got)
			}
		}
		for k, a := range got {
			if a.FirstRunID != "" {
				t.Errorf("pass %d: %s claims a first run %q", pass, k, a.FirstRunID)
			}
		}
	}
}

// DIVE-8925: what is new since the earlier runs. Findings match by check and
// clone-free asset, so an older engine's IP-hashed id still counts as seen.
func TestWhatIsNewSinceEarlierRuns(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "e.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	t1 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	if n, _, err := s.EarlierRuns("run-1"); err != nil || n != 0 {
		t.Fatalf("empty db: %d earlier runs, %v", n, err)
	}
	if err := s.StartRun("run-1", "v", "auto-safe", nil, t1); err != nil {
		t.Fatal(err)
	}
	_ = s.UpsertAsset("run-1", model.Asset{Kind: "port", Key: "203.0.113.10:22/tcp"}, t1)
	_ = s.AddFinding("run-1", model.Finding{ID: "open-risky-port-0badc0de", Severity: "high", Asset: "203.0.113.10:5432"}, 0)
	_ = s.FinishRun("run-1", "done", 0, t1)

	t2 := t1.Add(time.Hour)
	if err := s.StartRun("run-2", "v", "auto-safe", nil, t2); err != nil {
		t.Fatal(err)
	}
	_ = s.UpsertAsset("run-2", model.Asset{Kind: "port", Key: "203.0.113.77:22/tcp"}, t2)
	_ = s.UpsertAsset("run-2", model.Asset{Kind: "port", Key: "203.0.113.77:6379/tcp", Data: map[string]string{"p": "redis"}}, t2)

	n, since, err := s.EarlierRuns("run-2")
	if err != nil || n != 1 || since != stamp(t1) {
		t.Fatalf("earlier runs: %d since %q, %v", n, since, err)
	}
	fresh, err := s.NewAssets("run-2")
	if err != nil || len(fresh) != 1 || fresh[0].Key != "server:6379/tcp" || fresh[0].Data["p"] != "redis" {
		t.Fatalf("new assets: %+v, %v", fresh, err)
	}
	seen, err := s.EarlierFindings("run-2")
	if err != nil {
		t.Fatal(err)
	}
	if !seen[model.FindingKey("open-risky-port-12345678", "203.0.113.77:5432")] {
		t.Errorf("the same check on the same port at another clone IP reads as new: %v", seen)
	}
	if seen[model.FindingKey("open-risky-port-12345678", "203.0.113.77:6379")] {
		t.Errorf("another port reads as seen")
	}
}
