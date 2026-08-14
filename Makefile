.PHONY: daemon daemon-test test run dev

daemon:
	cd daemon && go build -o ../bin/cartethyia ./cmd/cartethyia

test:
	cd daemon && go test ./...

daemon-test: test

run:
	cd daemon && go run ./cmd/cartethyia

dev:
	cd daemon && air -c .air.toml
