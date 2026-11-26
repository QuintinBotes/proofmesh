# A sentinel (FR079, SC015): it would write a marker file if setuptools ran it.
open("MARKER-setup-py", "w").write("ran")
