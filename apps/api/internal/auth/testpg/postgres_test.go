package testpg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestNetworkManifest(t *testing.T) {
	path, err := manifestPath("odd/evidence/login-inventory/l03-test-network.json")
	if err != nil {
		t.Fatal(err)
	}
	absolute, err := manifestPath(path)
	if err != nil || absolute != path || !filepath.IsAbs(path) {
		t.Fatal("canonical manifest path")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("active descriptor unavailable")
	}
	var valid descriptor
	if json.Unmarshal(data, &valid) != nil {
		t.Fatal("descriptor JSON")
	}
	if err := validateManifest(valid, valid.Name); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*descriptor){
		func(d *descriptor) { d.Schema = "" }, func(d *descriptor) { d.Status = "removed" },
		func(d *descriptor) { d.ID = "short" }, func(d *descriptor) { d.ID = string(make([]byte, 64)) },
		func(d *descriptor) { d.Name = "" }, func(d *descriptor) { d.Labels = nil },
		func(d *descriptor) { d.Labels["luson.owner"] = "other" },
		func(d *descriptor) { d.Labels["luson.task"] = "L02" },
		func(d *descriptor) { delete(d.Labels, "luson.feature") },
		func(d *descriptor) { d.Labels["luson.lifecycle"] = "operational" },
		func(d *descriptor) { d.Labels["extra"] = "unexpected" },
	} {
		var bad descriptor
		_ = json.Unmarshal(data, &bad)
		change(&bad)
		if validateManifest(bad, valid.Name) == nil {
			t.Fatal("invalid manifest accepted")
		}
	}
	if validateManifest(valid, "") == nil || validateManifest(valid, "other") == nil {
		t.Fatal("explicit matching network required")
	}
	if _, err := manifestPath(""); err == nil {
		t.Fatal("missing manifest accepted")
	}
	if _, err := loadManifest(valid.Name, path+".missing"); err == nil {
		t.Fatal("missing file accepted")
	}
	actual := networkInspection{ID: valid.ID, Name: valid.Name, Labels: valid.Labels}
	if compareNetwork(valid, []networkInspection{actual}) != nil {
		t.Fatal("matching network rejected")
	}
	for _, bad := range []networkInspection{{ID: "wrong", Name: valid.Name, Labels: valid.Labels}, {ID: valid.ID, Name: "wrong", Labels: valid.Labels}, {ID: valid.ID, Name: valid.Name}} {
		if compareNetwork(valid, []networkInspection{bad}) == nil {
			t.Fatal("Docker mismatch accepted")
		}
	}
	if compareNetwork(valid, nil) == nil {
		t.Fatal("missing Docker network accepted")
	}
}
