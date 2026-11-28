config_setting(name = "linux", values = {"define": "os=linux"})
sh_library(name = "common")
sh_library(name = "linux_impl")
sh_library(name = "macos_impl")
sh_library(
    name = "service",
    deps = [":common"] + select({
        ":linux": [":linux_impl"],
        "//conditions:default": [":macos_impl"],
    }),
)
sh_test(name = "first_test", srcs = ["first.sh"], deps = [":service"])
sh_test(name = "second_test", srcs = ["second.sh"], deps = [":service"])
