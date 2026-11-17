# Capacity-verifier regression stories

These original one-room stories exercise flat and grouped routes, a suspended scene call, and restoration at each
prepared input. Both contain two prose rows. The grouped story deliberately uses one group with one room so the
regression does not require hundreds of fixture modules.

Each directory retains `bifoil.toml`, its authored sources, and `program.json`, compiled with the native compiler. The
runtime tests create disposable lazy code packages from that JSON; normal tests do not invoke or require a compiler.

To refresh either compiled fixture, explicitly select a compiler and build that directory to a temporary `startup.txt`.
Parse the JSON on its `*bifoil ` line into the corresponding `program.json`. Preserve the authored sources, check that
source locations stay relative, and rerun `test/narrative-verifier.test.mjs`.

These small regressions check verifier behavior. They do not establish large-game capacity or resource acceptance.
