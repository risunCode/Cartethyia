package models

import "time"

// IPBan is an operator-set IP block (ip_bans). Operator-managed, durable.
type IPBan struct {
	IP        string
	Reason    string
	CreatedAt time.Time
}

// SecurityOffense is a rolling window counter per (ip, category). Transient
// counters — excluded from configuration backups.
type SecurityOffense struct {
	IP              string
	Category        string
	StrikeCount     int
	WindowStartedAt time.Time
	LastEventAt     time.Time
}
