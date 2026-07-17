# Error Prone + NullAway + jSpecify (task d4n.8)

Static null-safety and bug-pattern analysis for the Java reactor, running at
compile time as a javac plugin on the devenv **JDK 25** toolchain.

## Verdict: GO

Error Prone runs clean on JDK 25 and coexists with every existing annotation
processor. Adopted across both Maven modules.

## Versions (verified GA on Maven Central, 2026-07)

| Component          | Version | Notes                                                        |
| ------------------ | ------- | ------------------------------------------------------------ |
| `error_prone_core` | 2.50.0  | Current GA. Requires JDK 21+; runs on JDK 25.                |
| `nullaway`         | 0.13.7  | Requires Error Prone >= 2.36 and JDK 17+. JSpecify mode needs JDK 22+ (JDK 25 ok). |
| `jspecify`         | 1.0.0   | Supplies `@NullMarked` / `@Nullable`.                        |

Version properties live once in the root `pom.xml` (`version.errorprone`,
`version.nullaway`, `version.jspecify`).

## Wiring

1. **`.mvn/jvm.config`** — the ten `add-exports` / `add-opens` flags for
   `jdk.compiler` that Error Prone needs on JDK 16+. javac runs **in-process**
   (`fork=false`, the default), so these apply to the Maven JVM that hosts it.
   Interactive devenv shells and CI must run Maven from the worktree root so the
   file is picked up.

2. **Root `pom.xml` compiler `pluginManagement`** — shared `compilerArgs`
   inherited by both modules:
   - `-XDcompilePolicy=simple` (mandatory for Error Prone)
   - `--should-stop=ifError=FLOW` (Error Prone 2.50 refuses the default `INIT`
     policy on JDK 25)
   - `-XDaddTypeAnnotationsToSymbol=true` (JDK 21+; lets NullAway read use-site
     `@Nullable` in JSpecify mode)
   - `-Xplugin:ErrorProne -XepExcludedPaths:.*/generated-sources/.* -Xep:NullAway:ERROR -XepOpt:NullAway:OnlyNullMarked -XepOpt:NullAway:JSpecifyMode=true`

3. **Per-module `annotationProcessorPaths`** — `error_prone_core` + `nullaway`
   are listed **explicitly in each module** (not in `pluginManagement`): the
   service module also lists avaje-inject / avaje-validator / MapStruct, and a
   `pluginManagement` processor list would be *replaced*, not merged, by the
   module's list. Spelling the full set out per module keeps processor discovery
   drop-proof (a silently-missing DI processor would only explode at runtime).

## Configuration decisions

- **Generated code is never analysed.** `-XepExcludedPaths` drops the buf
  protobuf/grpc trees (`<module>/generated-sources/…`) and the jOOQ + avaje +
  MapStruct output (`target/generated-sources/…`) — the same by-construction
  exclusion PMD and Checkstyle already apply.
- **NullAway JSpecify `OnlyNullMarked` mode.** NullAway only checks code inside
  an `@NullMarked` scope. Each hand-written package carries a `package-info.java`
  with `@NullMarked`; everything is non-null by default and genuine nullability
  is annotated `@Nullable`. `@NullMarked` also covers same-package *test* sources,
  so test code is null-checked too.
- **No Error Prone checks disabled.** The default check set produces zero
  ERROR-severity findings on this codebase. If a check ever needs suppressing,
  do it narrowly (`-Xep:Check:OFF` or `@SuppressWarnings`) with a documented
  reason — same discipline as the PMD ruleset exclusions.

## Known warnings (non-blocking)

A full `mvn verify` currently emits **six** Error Prone WARNING-severity
findings. Warnings never fail the build; all six were reviewed and left as-is:

| Check | Location(s) | Why acceptable |
| ----- | ----------- | -------------- |
| `ReferenceEquality` | `ConnectUnaryHandler.java:159` (main) | `req.prologue().method() == Method.GET` — safe: Helidon interns `Method` constants, so reference equality is correct here; switching to `.equals` would be cosmetic. |
| `BooleanLiteral` ×2 | `TodoMapperTest.java:103,116` (test) | Style nit: an assertion expression could use a boolean literal more directly. Harmless in tests; candidate for an opportunistic later cleanup. |
| `JavaInstantGetSecondsGetNano` ×3 | `TodoGrpcBridgeTest.java:368,372,377` (test) | The tests intentionally compare `getEpochSecond()` and `getNano()` **as a pair** against the proto `Timestamp` seconds/nanos fields, which is exactly the pattern the check asks for; the warning fires per call site. Candidate for a later `@SuppressWarnings` with comment or assertion restructure. |

## Upgrade protocol

Error Prone's javac handshake is **version-coupled** (e.g. 2.50 requires
`--should-stop=ifError=FLOW` where older javac defaults sufficed before). On
every future Error Prone (or JDK) version bump, re-run a **tooth mutation** as
the compatibility re-check: plant a self-assignment (`x = x;`) and a
null-to-`@NonNull` call in `@NullMarked` code, confirm the build FAILS naming
`SelfAssignment` and `NullAway` respectively, then revert. A build that merely
*passes* after a bump proves nothing — the plugin may have silently stopped
running.

## What NullAway verified

The `details` field is nullable by the repository's plain-String convention
(`null` = "no details"). It — and the other genuinely-nullable domain fields
(`UpdateTodo.title/details/completed`) and the adapter's Connect/gRPC interop
seams — are now annotated `@Nullable`, and NullAway enforces the contract end to
end at compile time.
