package app

// BuildVersion is the binary build stamp. Release builds set it with
// -ldflags "-X echo/internal/app.BuildVersion=YYYYMMDD-HHMMSS".
var BuildVersion = "dev"
