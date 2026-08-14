package backup

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
)

// Encryptor transforms a plaintext stream into a ciphertext stream.
//
// The interface is shaped around the pipeline's needs: the caller hands in a
// reader (the dump) and gets back a reader that, when consumed, returns
// ciphertext bytes suitable for upload or storage. Implementations are
// responsible for emitting any header or framing they require and for
// respecting ctx (typically by aborting on the first read after cancellation).
type Encryptor interface {
	// Encrypt returns a reader that yields the ciphertext encoding of src.
	// The returned closer must release the underlying cipher state once the
	// consumer is done. Calling Encrypt without consuming the result leaves
	// resources allocated until the closer is invoked.
	Encrypt(ctx context.Context, src io.Reader) (io.ReadCloser, error)
	// Extension is the suggested filename suffix (including the leading dot)
	// the caller should append when naming the produced archive.
	Extension() string
}

// AEADEncryptor is an Encryptor backed by chunked AES-GCM.
//
// The key is supplied by the caller; this struct never reads a passphrase,
// environment variable, or file. Each Encrypt call generates a fresh random
// nonce and writes it as a 12-byte header. Plaintext is then split into
// fixed-size chunks; each chunk is sealed independently with the AEAD using a
// per-chunk counter mixed into the additional data so every tag is unique.
//
// Frame format produced by Encrypt:
//
//	[12 bytes nonce][u32be len][sealed chunk]...[u32be len][sealed chunk]
//
// The receiver reads the nonce, then repeatedly reads a 4-byte big-endian
// length, that many ciphertext bytes, and unseals them with the same nonce
// and the same counter derived from the chunk index.
type AEADEncryptor struct {
	// Key is the symmetric key. Must be 16, 24, or 32 bytes (AES-128/192/256).
	// Leaving it empty makes Encrypt return an error.
	Key []byte
	// AdditionalData is bound to every chunk; it is authenticated but not
	// written to the stream. Optional.
	AdditionalData []byte
}

const aeadNonceSize = 12

// Extension reports the suffix for encrypted archives.
func (e *AEADEncryptor) Extension() string { return ".enc" }

// Encrypt returns a reader producing the framed ciphertext.
func (e *AEADEncryptor) Encrypt(ctx context.Context, src io.Reader) (io.ReadCloser, error) {
	if e == nil {
		return nil, errors.New("backup: nil AEADEncryptor")
	}
	if len(e.Key) != 16 && len(e.Key) != 24 && len(e.Key) != 32 {
		return nil, fmt.Errorf("backup: invalid AES key length %d", len(e.Key))
	}
	if src == nil {
		return nil, errors.New("backup: nil source reader")
	}
	block, err := aes.NewCipher(e.Key)
	if err != nil {
		return nil, newStageError(StageEncrypt, 1, fmt.Errorf("aes init: %w", err))
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, newStageError(StageEncrypt, 1, fmt.Errorf("gcm init: %w", err))
	}
	if aead.NonceSize() != aeadNonceSize {
		return nil, newStageError(StageEncrypt, 1, fmt.Errorf("unsupported nonce size %d", aead.NonceSize()))
	}
	nonce := make([]byte, aeadNonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, newStageError(StageEncrypt, 1, fmt.Errorf("nonce: %w", err))
	}

	pipeReader, pipeWriter := io.Pipe()
	go func() {
		if _, err := pipeWriter.Write(nonce); err != nil {
			_ = pipeWriter.CloseWithError(err)
			return
		}
		sealer := newChunkSealer(pipeWriter, aead, nonce, e.AdditionalData)
		if err := copyWithContext(ctx, sealer, src); err != nil {
			_ = pipeWriter.CloseWithError(err)
			return
		}
		if err := sealer.Close(); err != nil {
			_ = pipeWriter.CloseWithError(err)
			return
		}
		_ = pipeWriter.Close()
	}()
	return pipeReader, nil
}

// chunkSealMaxPlaintext bounds the size of plaintext handed to AEAD.Seal per
// chunk. AES-GCM has a 64 GiB limit per (key, nonce) pair; 64 KiB chunks keep
// memory usage small and let the receiver authenticate in O(chunk).
const chunkSealMaxPlaintext = 64 * 1024

// chunkSealer streams AEAD-sealed chunks. Each chunk is framed as a 4-byte
// big-endian length followed by the sealed bytes.
type chunkSealer struct {
	aead    cipher.AEAD
	nonce   []byte
	extra   []byte
	counter uint32
	dst     io.Writer
	closed  bool
}

func newChunkSealer(dst io.Writer, aead cipher.AEAD, nonce, extra []byte) *chunkSealer {
	return &chunkSealer{aead: aead, nonce: nonce, extra: extra, dst: dst}
}

func (c *chunkSealer) Write(p []byte) (int, error) {
	if c.closed {
		return 0, errors.New("backup: chunk sealer is closed")
	}
	written := 0
	for len(p) > 0 {
		n := len(p)
		if n > chunkSealMaxPlaintext {
			n = chunkSealMaxPlaintext
		}
		chunk := p[:n]
		p = p[n:]
		c.counter++
		ad := buildChunkAD(c.extra, c.nonce, c.counter)
		sealed := c.aead.Seal(nil, c.nonce, chunk, ad)
		if err := writeFrame(c.dst, sealed); err != nil {
			return written, err
		}
		written += n
	}
	return written, nil
}

// Close writes an empty terminator frame so the receiver can detect end of
// stream unambiguously. After Close, the sealer is unusable.
func (c *chunkSealer) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	var lenBE [4]byte
	_, err := c.dst.Write(lenBE[:])
	return err
}

func buildChunkAD(extra, nonce []byte, counter uint32) []byte {
	full := make([]byte, 0, len(extra)+len(nonce)+4)
	full = append(full, extra...)
	full = append(full, nonce...)
	var counterBE [4]byte
	counterBE[0] = byte(counter >> 24)
	counterBE[1] = byte(counter >> 16)
	counterBE[2] = byte(counter >> 8)
	counterBE[3] = byte(counter)
	full = append(full, counterBE[:]...)
	return full
}

func writeFrame(dst io.Writer, sealed []byte) error {
	var lenBE [4]byte
	lenBE[0] = byte(len(sealed) >> 24)
	lenBE[1] = byte(len(sealed) >> 16)
	lenBE[2] = byte(len(sealed) >> 8)
	lenBE[3] = byte(len(sealed))
	if _, err := dst.Write(lenBE[:]); err != nil {
		return err
	}
	if _, err := dst.Write(sealed); err != nil {
		return err
	}
	return nil
}

// copyWithContext copies src to dst, aborting with ctx.Err() on cancellation.
func copyWithContext(ctx context.Context, dst io.Writer, src io.Reader) error {
	buf := make([]byte, 32*1024)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}
