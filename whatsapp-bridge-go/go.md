# 1. Clean the module cache
go clean -modcache

# 2. Download the latest version of the whatsmeow library
go get -u go.mau.fi/whatsmeow

# 3. Update go.mod and go.sum to accurately reflect used dependencies
go mod tidy