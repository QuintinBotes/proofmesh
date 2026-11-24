module example.com/svc

go 1.22

require example.com/lib v0.0.0

require github.com/spf13/cobra v1.8.1

replace example.com/lib => ../lib
