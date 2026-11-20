package store

import (
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
		case port.Key:
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
