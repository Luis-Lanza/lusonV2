package inventory

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/auth/testpg"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"strings"
	"testing"
)

func TestInventoryPostgres(t *testing.T) {
	p := testpg.Open(t)
	ctx := context.Background()
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("initialize fixture failed")
	}
	s := New(p)
	actor := auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
	metadata, err := s.Metadata(ctx, actor)
	if err != nil || len(metadata.Locations) != 3 || len(metadata.Brands) != 11 {
		t.Fatal("PostgreSQL metadata counts")
	}
	source, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range catalog.Locations() {
		if metadata.Locations[l.ID-1] != (Location{l.ID, l.Name}) {
			t.Fatal("protected location spelling")
		}
	}
	for _, size := range []int{10, 25, 50} {
		ids := map[int]bool{}
		for page := 1; (page-1)*size < 190; page++ {
			result, err := s.List(ctx, actor, Query{LocationID: 2, Page: page, PageSize: size})
			if err != nil || result.TotalVariants != 190 || result.Page != page || result.PageSize != size || result.Location != metadata.Locations[1] {
				t.Fatal("pagination contract")
			}
			expected := size
			if 190-(page-1)*size < size {
				expected = 190 - (page-1)*size
			}
			if len(result.Items) != expected {
				t.Fatal("page length")
			}
			for i, item := range result.Items {
				id := (page-1)*size + i + 1
				entry := source.Entries[(id-1)/2]
				polarity := "L"
				if id%2 == 0 {
					polarity = "R"
				}
				if ids[id] || item.VariantID != id || item.CatalogEntryID != entry.ID || item.Brand != entry.Brand || item.Model != entry.Model || item.Capacity != entry.Capacity || item.Polarity != polarity || item.Existing != int64((id*7+2*11)%31) || item.Reserved != 0 || item.Available != item.Existing {
					t.Fatal("exact stable variant/balance/source contract")
				}
				ids[id] = true
			}
		}
		if len(ids) != 190 {
			t.Fatal("missing variants")
		}
	}
	for _, q := range []Query{
		{Search: "moto"}, {Search: "6,5"}, {Search: "6.5"}, {Search: "%"}, {Search: "_"}, {Search: `\`}, {Search: "' OR 1=1 --"},
		{Brand: source.Entries[0].Brand}, {Polarity: "R"}, {Search: strings.ToLower(source.Entries[0].Model), Brand: source.Entries[0].Brand, Polarity: "L"},
	} {
		q.LocationID, q.Page, q.PageSize = 3, 1, 50
		expected := []int{}
		for _, e := range source.Entries {
			if q.Brand != "" && q.Brand != e.Brand || q.Search != "" && !strings.Contains(strings.ToLower(e.Brand), strings.ToLower(q.Search)) && !strings.Contains(strings.ToLower(e.Model), strings.ToLower(q.Search)) {
				continue
			}
			for _, v := range []struct {
				id int
				p  string
			}{{e.ID*2 - 1, "L"}, {e.ID * 2, "R"}} {
				if q.Polarity == "" || q.Polarity == v.p {
					expected = append(expected, v.id)
				}
			}
		}
		result, err := s.List(ctx, actor, q)
		if err != nil || result.TotalVariants != len(expected) {
			t.Fatal("literal AND count mismatch")
		}
		count := len(expected)
		if count > 50 {
			count = 50
		}
		if len(result.Items) != count {
			t.Fatal("literal result length")
		}
		for i, item := range result.Items {
			if item.VariantID != expected[i] {
				t.Fatal("literal filter order")
			}
		}
	}
	for _, q := range []Query{{LocationID: 1, Page: 1000000, PageSize: 50}, {LocationID: 1, Search: "no matching model", Page: 1, PageSize: 10}} {
		result, err := s.List(ctx, actor, q)
		if err != nil || result.Items == nil || len(result.Items) != 0 {
			t.Fatal("empty non-null items")
		}
		want := 190
		if q.Search != "" {
			want = 0
		}
		if result.TotalVariants != want {
			t.Fatal("empty page count")
		}
	}
	result, err := s.List(ctx, actor, Query{LocationID: 1, Search: "6,5", Page: 1, PageSize: 10})
	b, _ := json.Marshal(result)
	if err != nil || len(result.Items) != 4 || strings.Count(string(b), `"capacity_ah":6.5`) != 4 {
		t.Fatal("exact fractional numeric JSON")
	}
	// Test-owned holds only: no production or initializer hold seed is added.
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET existing=7,reserved=7 WHERE location_id=1`); err != nil {
		t.Fatal("test balance update")
	}
	result, err = s.List(ctx, actor, Query{LocationID: 1, Page: 1, PageSize: 50})
	if err != nil {
		t.Fatal("read zero availability")
	}
	for _, item := range result.Items {
		if item.Existing != 7 || item.Reserved != 7 || item.Available != 0 {
			t.Fatal("generated availability")
		}
	}
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("replay failed")
	}
	var changed int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM inventory_balances WHERE location_id=1 AND (existing<>7 OR reserved<>7 OR available<>0)`).Scan(&changed); err != nil || changed != 0 {
		t.Fatal("reads/replay mutated holds")
	}
	if _, err := s.List(ctx, auth.Identity{}, Query{LocationID: 1, Page: 1, PageSize: 10}); !errors.Is(err, ErrInvalid) {
		t.Fatal("unresolved identity accepted")
	}
	// Force a committed stock update precisely between count and item queries.
	// The consulted items must still see the snapshot established by count/location.
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET existing=5,reserved=0 WHERE location_id=3`); err != nil {
		t.Fatal("snapshot setup")
	}
	trace := &snapshotUpdate{pool: p}
	tracedConfig := p.Config()
	tracedConfig.ConnConfig.Tracer = trace
	tracedPool, err := pgxpool.NewWithConfig(ctx, tracedConfig)
	if err != nil {
		t.Fatal("traced pool configuration")
	}
	defer tracedPool.Close()
	result, err = New(tracedPool).List(ctx, actor, Query{LocationID: 3, Page: 1, PageSize: 50})
	if err != nil || trace.err != nil || !trace.updated || result.TotalVariants != 190 {
		t.Fatal("concurrent read snapshot")
	}
	for _, item := range result.Items {
		if item.Existing != 5 || item.Reserved != 0 || item.Available != 5 {
			t.Fatal("mixed snapshots across count/items")
		}
	}
	after, err := s.List(ctx, actor, Query{LocationID: 3, Page: 1, PageSize: 10})
	if err != nil {
		t.Fatal("post-update read")
	}
	for _, item := range after.Items {
		if item.Existing != 9 || item.Reserved != 2 || item.Available != 7 {
			t.Fatal("committed update absent from next snapshot")
		}
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.List(canceled, actor, Query{LocationID: 1, Page: 1, PageSize: 10}); err == nil {
		t.Fatal("cancellation ignored")
	}
	p.Close()
	if _, err := s.Metadata(ctx, actor); err == nil {
		t.Fatal("closed pool succeeded")
	}
}

// Query tracing is test-only orchestration: no production hook or stock writer.
type snapshotKey struct{}
type snapshotUpdate struct {
	pool    *pgxpool.Pool
	updated bool
	err     error
}

func (s *snapshotUpdate) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, snapshotKey{}, strings.HasPrefix(data.SQL, "SELECT count(*) FROM inventory_balances b"))
}
func (s *snapshotUpdate) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if count, _ := ctx.Value(snapshotKey{}).(bool); count && data.Err == nil && !s.updated {
		s.updated = true
		_, s.err = s.pool.Exec(ctx, `UPDATE inventory_balances SET existing=9,reserved=2 WHERE location_id=3`)
	}
}
