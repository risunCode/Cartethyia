package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/cartethyia/daemon"
)

func main() {
	if err := loadDotEnv(); err != nil {
		log.Fatal(err)
	}
	cfg, err := daemon.LoadConfig()
	if err != nil {
		log.Fatal(err)
	}
	runtime, err := daemon.New(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer func() {
		if err := runtime.Close(context.Background()); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := runtime.Start(ctx); err != nil {
		log.Fatal(err)
	}
}
