package closings

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/jpeg"
	"image/png"
	"io"
)

// The receipt of a pay-out (S1-S9) is one optional photograph of the ticket the branch paid for. It
// is stored in the movement's own row (S3), written by the same statement as the movement (S4),
// immutable because the row is (S5), and published by every read as its metadata and never as its
// bytes (S7). This file is the one place that decides whether a file is a receipt: what the caller
// declares about it is never trusted (S6).

// The two caps of one receipt (S6). They are the ones the contract documents, and the database states
// the byte cap again for what a row keeps (migration 062).
const (
	// MaxEvidenceBytes is the largest receipt the contract accepts: 8 MB of bytes.
	MaxEvidenceBytes = 8 << 20
	// MaxEvidenceSide is the largest side of the image, in pixels: 6000 by 6000. A receipt photo of a
	// phone fits comfortably, and the largest image this cap admits reserves about a third of what the
	// former 10000 by 10000 cap did.
	MaxEvidenceSide = 6000
	// MaxConcurrentEvidenceDecodes is how many receipts this process reads and decodes at the same
	// time: the rest of the uploads queue for a slot respecting their request's context instead of
	// multiplying what their images reserve.
	MaxConcurrentEvidenceDecodes = 2
)

// evidenceSlots is the bound above as the counter that enforces it (S6). A receipt holds one slot
// from the first byte it reads to the last byte it stores, so the buffers of a slow upload and the
// fully decoded image of a fast one can never add up past two of either.
var evidenceSlots = make(chan struct{}, MaxConcurrentEvidenceDecodes)

// The two formats the product accepts (S6). They are the values the database admits and the values
// the image route serves as its own `Content-Type`, so one spelling is the whole contract.
const (
	evidenceJPEG = "image/jpeg"
	evidencePNG  = "image/png"
)

var (
	// jpegSignature is the start of every JPEG: the magic bytes the decoder is chosen by, before any
	// decode proves the file is one.
	jpegSignature = []byte{0xFF, 0xD8, 0xFF}
	// pngSignature is the eight bytes every PNG starts with.
	pngSignature = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'}
)

// Evidence is the receipt of one movement as every read of this contract publishes it (S7): the
// content type the server validated by decoding the bytes, the size of the bytes it stores and their
// SHA-256. It is nil on a movement without a receipt, and the bytes are never part of it, so no book
// and no acta can drag a photograph.
type Evidence struct {
	Type   string `json:"type"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// EvidenceUpload is one receipt that has been read and validated: the bytes exactly as they arrived,
// never re-encoded (S5), the content type the decode proved, their real size and their digest. It is
// built by ReadEvidence and by nothing else, and the store revalidates it against its own bytes before
// writing them.
type EvidenceUpload struct {
	Bytes  []byte
	Type   string
	Size   int64
	SHA256 string
}

// EvidenceImage is the stored receipt of one movement as the image route serves it (S8): the bytes and
// the content type that was validated when the branch uploaded them. It is built by the one read of
// this package that names the bytes of the ledger, and by nothing else.
type EvidenceImage struct {
	Type   string
	Size   int64
	SHA256 string
	Bytes  []byte
}

// ReadEvidence reads one upload through the byte cap and decides the file from its content (S6): the
// magic bytes select the only two formats this product accepts, and a full decode of the image is the
// proof that the bytes are really one -- a renamed script, an SVG and a polyglot all fail it. An empty
// file, a file above the cap, a file that does not decode and an image above the pixel cap are refused
// with their own class, and nothing of what the caller says about the file is read.
//
// The read stops at the cap instead of buffering the body: one byte above the largest admitted receipt
// is enough to refuse it.
func ReadEvidence(source io.Reader) (EvidenceUpload, error) {
	return ReadEvidenceContext(context.Background(), source)
}

// ReadEvidenceContext is ReadEvidence for one request: it waits for a slot of the validator under the
// request's own context, so an upload that is cancelled while it queues is answered by that context
// instead of waiting for the uploads ahead of it, and the slot it never owned is never leaked.
func ReadEvidenceContext(ctx context.Context, source io.Reader) (EvidenceUpload, error) {
	if source == nil {
		return EvidenceUpload{}, ErrEvidenceEmpty
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case evidenceSlots <- struct{}{}:
	case <-ctx.Done():
		return EvidenceUpload{}, ctx.Err()
	}
	defer func() { <-evidenceSlots }()
	body, err := io.ReadAll(io.LimitReader(contextSource{ctx: ctx, source: source}, MaxEvidenceBytes+1))
	if err != nil {
		// A read that stops because the request is gone answers the context, not a refusal: there is
		// nobody left to answer. Any other stop is the truncated file this contract refuses.
		if contextErr := ctx.Err(); contextErr != nil {
			return EvidenceUpload{}, contextErr
		}
		// An upload that stops in the middle is a file that does not decode to its end, which is the
		// refusal this contract states for a truncated receipt.
		return EvidenceUpload{}, ErrEvidenceUnsupported
	}
	if len(body) == 0 {
		return EvidenceUpload{}, ErrEvidenceEmpty
	}
	if len(body) > MaxEvidenceBytes {
		return EvidenceUpload{}, ErrEvidenceTooLarge
	}
	contentType, err := evidenceFormat(body)
	if err != nil {
		return EvidenceUpload{}, err
	}
	digest := sha256.Sum256(body)
	return EvidenceUpload{Bytes: body, Type: contentType, Size: int64(len(body)),
		SHA256: hex.EncodeToString(digest[:])}, nil
}

// contextSource stops the body read of one receipt when the request that owns it is gone, so a
// cancelled upload releases its slot instead of waiting for the rest of a file nobody wants.
type contextSource struct {
	ctx    context.Context
	source io.Reader
}

func (s contextSource) Read(buffer []byte) (int, error) {
	select {
	case <-s.ctx.Done():
		return 0, s.ctx.Err()
	default:
		return s.source.Read(buffer)
	}
}

// evidenceFormat decides the format of one file by sniffing its magic bytes and proves it by decoding
// the image whole (S6): the header is read first, so an image above the pixel cap is refused without
// ever being decoded, and the full decode after it is what tells a JPEG or a PNG from bytes that only
// start like one.
func evidenceFormat(body []byte) (string, error) {
	if bytes.HasPrefix(body, jpegSignature) {
		return evidenceDecoded(body, jpeg.DecodeConfig, jpeg.Decode, evidenceJPEG)
	}
	if bytes.HasPrefix(body, pngSignature) {
		return evidenceDecoded(body, png.DecodeConfig, png.Decode, evidencePNG)
	}
	// SVG is text and so is every other file that is not a JPEG or a PNG: the two signatures above are
	// the whole list (S6).
	return "", ErrEvidenceUnsupported
}

// wholePicture hands one file to a decoder one byte at a time. image/jpeg fills a four kilobyte window
// ahead of the image, so with a chunked read it consumes the whole file before it even reaches the end
// of the image and nothing could tell a photo from a photo with a payload glued behind it; read byte
// by byte, the decoder takes exactly the bytes the image needs and what is left is the payload.
// image/png reads exactly what it needs either way, so the same reader proves both formats the same.
type wholePicture struct{ source *bytes.Reader }

func (w wholePicture) Read(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	return w.source.Read(buffer[:1])
}

// evidenceDecoded proves that one whole file is one whole image of an accepted format (S6). The header
// states the sides, so an image above the cap is refused before it is decoded; the decode then reads
// the file to the end of the image. Both decoders stop at the end of the image and never require the
// file to end there, so the bytes the reader has left are what refuses a polyglot: a real PNG or JPEG
// with a zip header, a script or any other payload glued behind it is not a receipt, whatever the
// bytes before it are.
func evidenceDecoded(body []byte, header func(io.Reader) (image.Config, error),
	decode func(io.Reader) (image.Image, error), contentType string) (string, error) {
	config, err := header(bytes.NewReader(body))
	if err != nil || config.Width < 1 || config.Height < 1 {
		return "", ErrEvidenceUnsupported
	}
	if config.Width > MaxEvidenceSide || config.Height > MaxEvidenceSide {
		return "", ErrEvidenceDimensions
	}
	picture := bytes.NewReader(body)
	if _, err := decode(wholePicture{source: picture}); err != nil || picture.Len() != 0 {
		return "", ErrEvidenceUnsupported
	}
	return contentType, nil
}

// ValidEvidence reports whether one published receipt is the shape this domain writes (S2, S6): only a
// pay-out carries one, and one that is present states an accepted format, a positive size inside the
// cap and a lowercase SHA-256. A row of any other shape is one this domain did not write and is never
// published.
func ValidEvidence(kind string, evidence *Evidence) bool {
	if evidence == nil {
		return true
	}
	if kind != metricsMovementExpense {
		return false
	}
	if !acceptedEvidenceType(evidence.Type) || evidence.Size < 1 || evidence.Size > MaxEvidenceBytes {
		return false
	}
	return canonicalEvidenceDigest(evidence.SHA256)
}

// acceptedEvidenceType admits the two formats of S6 in the one spelling the database stores and the
// route serves.
func acceptedEvidenceType(contentType string) bool {
	return contentType == evidenceJPEG || contentType == evidencePNG
}

// canonicalEvidenceDigest admits a SHA-256 in the spelling the contract publishes: 32 bytes of
// lowercase hexadecimal.
func canonicalEvidenceDigest(digest string) bool {
	if len(digest) != sha256.Size*2 {
		return false
	}
	for _, digit := range digest {
		if (digit < '0' || digit > '9') && (digit < 'a' || digit > 'f') {
			return false
		}
	}
	return true
}

// storedEvidence revalidates one validated upload and returns the four columns a row stores: the bytes
// exactly as they arrived, the format the decode proved, their real length and the digest computed
// here over exactly the bytes the row keeps (S6). An upload whose facts do not agree with its own
// bytes is a shape this domain never wrote and is refused instead of stored.
func storedEvidence(upload *EvidenceUpload) ([]byte, string, int64, string, bool) {
	if upload == nil {
		return nil, "", 0, "", true
	}
	if len(upload.Bytes) == 0 || len(upload.Bytes) > MaxEvidenceBytes {
		return nil, "", 0, "", false
	}
	if !acceptedEvidenceType(upload.Type) {
		return nil, "", 0, "", false
	}
	size := int64(len(upload.Bytes))
	digest := sha256.Sum256(upload.Bytes)
	hexadecimal := hex.EncodeToString(digest[:])
	if upload.Size != size || upload.SHA256 != hexadecimal {
		return nil, "", 0, "", false
	}
	return upload.Bytes, upload.Type, size, hexadecimal, true
}

// storedEvidenceOf reads the three metadata columns of one row as the receipt this contract publishes
// (S7). A row that states none of them publishes no receipt; a row that states only some of them is a
// shape the database refuses and this domain never wrote, so it is refused instead of described.
func storedEvidenceOf(contentType *string, size *int64, digest *string) (*Evidence, bool) {
	if contentType == nil || size == nil || digest == nil {
		return nil, contentType == nil && size == nil && digest == nil
	}
	return &Evidence{Type: *contentType, Size: *size, SHA256: *digest}, true
}

// evidenceOf is the receipt of one upload as a read of the same row would publish it, so the writer can
// compare the row the database kept with the facts the caller stated.
func evidenceOf(upload *EvidenceUpload) *Evidence {
	if upload == nil {
		return nil
	}
	return &Evidence{Type: upload.Type, Size: upload.Size, SHA256: upload.SHA256}
}

// sameEvidence reports whether the row the database wrote carries the receipt the caller offered: a
// caller that uploaded a photo reads the same three facts back, and a movement without one states none.
func sameEvidence(stored, requested *Evidence) bool {
	if stored == nil || requested == nil {
		return stored == nil && requested == nil
	}
	return *stored == *requested
}

// validEvidenceImage revalidates a served receipt before it leaves the store: the format is one of the
// two the contract accepts, the size is the real length of the bytes being served and the digest is
// theirs. A row that disagrees with itself is not a receipt this domain can serve.
func validEvidenceImage(image EvidenceImage) bool {
	if !acceptedEvidenceType(image.Type) || len(image.Bytes) == 0 ||
		len(image.Bytes) > MaxEvidenceBytes || image.Size != int64(len(image.Bytes)) {
		return false
	}
	digest := sha256.Sum256(image.Bytes)
	return image.SHA256 == hex.EncodeToString(digest[:])
}
