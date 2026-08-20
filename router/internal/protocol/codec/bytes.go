package codec

import "io"

// bytesReader adapts a []byte to io.Reader so json.NewDecoder can use it.
type bytesReader struct {
	b []byte
	i int
}

func newBytesReader(b []byte) io.Reader { return &bytesReader{b: b} }

func (r *bytesReader) Read(p []byte) (int, error) {
	if r.i >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}
