package transfers

import (
	"fmt"
	"time"
)

// Old current-state getters cannot label historical accounting as live after
// ownership. This explicit conflict is also recognizable as ErrDecisionConflict.
var ErrUnifiedReconciliationRequired = fmt.Errorf("%w: coordinated unified snapshot required", ErrDecisionConflict)

// Inputs contain intent only; actor identity and accounting baselines are server owned.
type UnifiedReconciliationProposalInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	DispatchQuantity int64
	ArrivalQuantity  int64
	RetainedQuantity int64
	RetainedAtOrigin bool
	Reason           string
}

type UnifiedReconciliationDecisionInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	Accept           bool
	RetainedAtOrigin bool
	Reason           string
}

type UnifiedReconciliationOperation struct {
	OperationKey              string    `json:"operation_key"`
	RequestID                 int64     `json:"request_id"`
	VariantID                 int64     `json:"variant_id"`
	ActorLocationID           int       `json:"actor_location_id"`
	Action                    string    `json:"action"`
	ExpectedRevision          int64     `json:"expected_revision"`
	DispatchQuantity          *int64    `json:"dispatch_quantity"`
	ArrivalQuantity           *int64    `json:"arrival_quantity"`
	RetainedQuantity          *int64    `json:"retained_quantity"`
	RetainedAtOrigin          bool      `json:"retained_at_origin"`
	Reason                    string    `json:"reason"`
	Revision                  int64     `json:"revision"`
	SourceExistingBefore      *int64    `json:"source_existing_before"`
	SourceExistingAfter       *int64    `json:"source_existing_after"`
	DestinationExistingBefore *int64    `json:"destination_existing_before"`
	DestinationExistingAfter  *int64    `json:"destination_existing_after"`
	RecordedAt                time.Time `json:"recorded_at"`
}

type UnifiedReconciliationApplication struct {
	OperationKey     string `json:"operation_key"`
	SourceDelta      int64  `json:"source_delta"`
	DestinationDelta int64  `json:"destination_delta"`
}

type UnifiedReconciliationDecision struct {
	OperationKey     string    `json:"operation_key"`
	ActorLocationID  int       `json:"actor_location_id"`
	Accepted         bool      `json:"accepted"`
	RetainedAtOrigin bool      `json:"retained_at_origin"`
	Reason           string    `json:"reason"`
	RecordedAt       time.Time `json:"recorded_at"`
}

type UnifiedReconciliationProposal struct {
	Revision                 int64                             `json:"revision"`
	OperationKey             string                            `json:"operation_key"`
	InitiatorLocationID      int                               `json:"initiator_location_id"`
	DispatchQuantity         int64                             `json:"dispatch_quantity"`
	ArrivalQuantity          int64                             `json:"arrival_quantity"`
	RetainedQuantity         int64                             `json:"retained_quantity"`
	RetainedAtOrigin         bool                              `json:"retained_at_origin"`
	BaseSourceDebit          int64                             `json:"base_source_debit"`
	BaseDestinationCredit    int64                             `json:"base_destination_credit"`
	CountGeneration          int64                             `json:"count_generation"`
	RestitutionGeneration    int64                             `json:"restitution_generation"`
	ReconciliationGeneration int64                             `json:"reconciliation_generation"`
	UnifiedGeneration        int64                             `json:"unified_generation"`
	Reason                   string                            `json:"reason"`
	RecordedAt               time.Time                         `json:"recorded_at"`
	State                    string                            `json:"state"`
	Decision                 *UnifiedReconciliationDecision    `json:"decision"`
	Application              *UnifiedReconciliationApplication `json:"application"`
}

type UnifiedReconciliationLineState struct {
	VariantID         int64                           `json:"variant_id"`
	ExpectedQuantity  int64                           `json:"expected_quantity"`
	OriginalActual    int64                           `json:"actual_quantity"`
	OriginalCredit    int64                           `json:"available_quantity"`
	WorkflowRevision  int64                           `json:"workflow_revision"`
	AppliedRevision   int64                           `json:"applied_revision"`
	UnifiedGeneration int64                           `json:"unified_generation"`
	Proposals         []UnifiedReconciliationProposal `json:"proposals"`
}

// Generations count operations, not proposal/application revisions. They are
// independent per variant and never compared across workflow namespaces.
type UnifiedGenerations struct {
	Count       int64 `json:"count"`
	Restitution int64 `json:"restitution"`
	Dispatch    int64 `json:"dispatch"`
	Unified     int64 `json:"unified"`
}

type UnifiedOriginalLine struct {
	VariantID         int64 `json:"variant_id"`
	ExpectedQuantity  int64 `json:"expected_quantity"`
	ActualQuantity    int64 `json:"actual_quantity"`
	AvailableQuantity int64 `json:"available_quantity"`
}

type UnifiedCurrentLine struct {
	VariantID               int64              `json:"variant_id"`
	Owner                   string             `json:"owner"`
	Source                  string             `json:"source"`
	ApplicationOperationKey *string            `json:"application_operation_key"`
	AppliedRevision         int64              `json:"applied_revision"`
	Version                 UnifiedGenerations `json:"version"`
	EffectiveDispatch       int64              `json:"effective_dispatch"`
	EffectiveActual         int64              `json:"effective_actual"`
	EffectiveCredit         int64              `json:"effective_credit"`
	SourceDebit             int64              `json:"source_debit"`
	// Null until an actual unified agreement exists: legacy credit/restoration
	// must not be misrepresented as newly agreed physical facts.
	RetainedQuantity *int64 `json:"retained_quantity"`
	OriginUnknown    *int64 `json:"origin_unknown"`
	TransitUnknown   *int64 `json:"transit_unknown"`
	Excess           *int64 `json:"excess"`
}

type UnifiedLegacyHistory struct {
	Count       CountCorrections
	Restitution Restitutions
	Dispatch    DispatchReconciliations
}

// Internal coordinated contract, not an HTTP DTO. Every member is read in one
// repeatable-read transaction; legacy fields retain exclusively legacy meaning.
type UnifiedReconciliations struct {
	Schema                string
	RequestID             int64
	OriginLocationID      int
	DestinationLocationID int
	ReceivedAt            time.Time
	Original              []UnifiedOriginalLine
	Legacy                UnifiedLegacyHistory
	Current               []UnifiedCurrentLine
	Lines                 []UnifiedReconciliationLineState
	Operations            []UnifiedReconciliationOperation
}
