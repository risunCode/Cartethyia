.PHONY: router router-test test run dev

router:
	cd router && go build -o ../bin/cartethyia ./cmd/cartethyia

test:
	cd router && go test ./...
	go test ./tests/load/...

router-test: test

run:
	cd router && go run ./cmd/cartethyia

dev:
	cd router && air -c .air.toml
