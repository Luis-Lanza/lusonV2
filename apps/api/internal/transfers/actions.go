package transfers

// ActionBreakdown counts transfers independently in each required-work category.
// A transfer with both review kinds contributes to both, but only once to
// Totals.ActionCount. These are obligations, not authorization to mutate.
type ActionBreakdown struct {
	Approve           int64
	Dispatch          int64
	Receive           int64
	ReviewCount       int64
	ReviewRestitution int64
}

// requiredActionsSQL projects one row per private header. $1 is the authenticated
// assigned location. Keep membership outside the action OR, including when this
// projection is reused for list filtering. EXISTS avoids multiplying headers.
// Latest-per-line and decision precedence mirror countSnapshotSQL and
// restitutionSnapshotSQL, without loading their full histories.
const requiredActionsSQL = `SELECT h.id,h.status,
 (h.status='pending' AND h.approver_location_id=$1) AS approve,
 (h.status='approved' AND h.origin_location_id=$1) AS dispatch,
 (h.status='in_transit' AND h.destination_location_id=$1) AS receive,
 (h.status='received' AND EXISTS (
   SELECT 1 FROM transfer_receipt_lines r
   JOIN LATERAL (
     SELECT p.revision,p.initiator_location_id FROM transfer_count_proposals p
     WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id
     ORDER BY p.revision DESC LIMIT 1
   ) latest ON true
   WHERE r.request_id=h.id AND latest.initiator_location_id<>$1
   AND NOT EXISTS (SELECT 1 FROM transfer_count_decisions d
     WHERE d.request_id=r.request_id AND d.variant_id=r.variant_id
     AND d.revision=latest.revision)
 )) AS review_count,
 (h.status='received' AND h.destination_location_id=$1 AND EXISTS (
   SELECT 1 FROM transfer_receipt_lines r
   JOIN LATERAL (
     SELECT p.revision FROM transfer_restitution_proposals p
     WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id
     ORDER BY p.revision DESC LIMIT 1
   ) latest ON true
   WHERE r.request_id=h.id AND r.expected_quantity>0
   AND NOT EXISTS (SELECT 1 FROM transfer_restitution_decisions d
     WHERE d.request_id=r.request_id AND d.variant_id=r.variant_id
     AND d.revision=latest.revision)
 )) AS review_restitution
 FROM transfer_requests h
 WHERE $1 IN (h.origin_location_id,h.destination_location_id)`

// Count pins and pending counts deliberately do not gate restitution review:
// they can block acceptance, but rejection remains a valid required response.
const anyRequiredActionSQL = `(approve OR dispatch OR receive OR review_count OR review_restitution)`
