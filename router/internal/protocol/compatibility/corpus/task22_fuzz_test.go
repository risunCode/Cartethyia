package corpus

import (
	"bytes"
	"testing"
)

func FuzzTask22ManifestAndFixtureDecodersNoPanic(f *testing.F) {
	f.Add([]byte(`{"schema_version":1,"generation":1,"fixtures":[]}`), []byte(`{"id":"fixture-id","source_surface":"openai-chat","target":{"surface":"openai-chat","provider":"fixture-provider","model":"fixture-model"},"operation":{"kind":"generate"},"features":["text"],"weight":1,"tier":1,"expected":{"semantic":{"text":"ok"}}}`))
	f.Add([]byte("not-json"), []byte("{}"))
	f.Fuzz(func(t *testing.T, manifestBody, fixtureBody []byte) {
		if len(manifestBody) > 64*1024 {
			manifestBody = manifestBody[:64*1024]
		}
		if len(fixtureBody) > 64*1024 {
			fixtureBody = fixtureBody[:64*1024]
		}
		manifest, manifestErr := DecodeManifest(bytes.NewReader(manifestBody))
		if manifestErr == nil {
			_ = ValidateManifest(manifest)
			_, _ = ManifestDigest(manifest)
		}
		_, _ = DecodeFixture(bytes.NewReader(fixtureBody))
	})
}
