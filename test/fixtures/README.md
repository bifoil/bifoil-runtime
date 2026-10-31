# Runtime protocol fixtures

These JSON programs were generated from original minimal Bifoil sources using the native Bifoil compiler's
`bifoil-vm.v1` profile, with `legacy.json`, `legacy-enum.json`, and `unicode.json` generated using the current
`bifoil-vm.v2` profile. They
are regression inputs, not third-party game sources or a runtime dependency on a sibling checkout.

`checkpoint.json` comes from the compiler's `examples/checkpoint` project. It exercises module defaults, two function
values sharing a captured mutable binding, a hidden option, escaped interpolation, and suspension in a binary operand.

`ordering.json` records supplied-argument and default-expression ordering. `overflow.json` verifies source diagnostics.
`escaping.json` verifies that a returned closure retains its parent environment across a checkpoint.

The matching `.bfl` sources are included here. `tools/regenerate-fixtures.py` regenerates all fixtures when passed an
explicit compiler executable; regeneration is optional and is not part of the runtime test/build dependency graph.

The runtime's ordinary tests require only this repository and Node.js 24 or newer. The optional engine acceptance test
reads the unmodified engine path supplied explicitly through `CHOICESCRIPT_ENGINE`. It does not vendor or modify that
engine, and remains subject to its original license.

`legacy.json` and `legacy-native.txt` exercise typed external state, a native input suspension, and saved partial
expressions. They use original minimal sources. Its numeric result uses native arithmetic so the strict Int bridge
receives an actual number rather than ChoiceScript's literal numeric text. Regenerate only it with `--names legacy`.

`unicode.json` exercises scalar String traversal through a prepared choice. It verifies cursor preservation across a
fresh restored machine. Regenerate only it with `--names unicode`.

`legacy-enum.json` and `legacy-enum-native.txt` exercise enum state, parameters, checked results, and a native choice.
The typed and native states restore into a fresh host without replay. Its `.bfl` source also declares a different enum
with the same case spelling and a data class for negative boundary tests. Regenerate it with `--names legacy-enum`.
